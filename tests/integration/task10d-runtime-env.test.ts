import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const REQUIRED_ENV = [
  "CLAIMGATE_HMAC_KEY",
  "CLAIMGATE_SESSION_KEY",
  "CLAIMGATE_CSRF_KEY",
  "CLAIMGATE_DATABASE_PATH",
  "CLAIMGATE_APP_ORIGIN",
] as const;
const SECRET_ENV = REQUIRED_ENV.slice(0, 3);
const VALID_ENV = Object.freeze({
  CLAIMGATE_HMAC_KEY: Buffer.alloc(32, 131).toString("base64"),
  CLAIMGATE_SESSION_KEY: Buffer.alloc(32, 132).toString("base64"),
  CLAIMGATE_CSRF_KEY: Buffer.alloc(32, 133).toString("base64"),
  CLAIMGATE_APP_ORIGIN: "https://runtime.example.test",
});
const CHILD_SOURCE = `
let runtime;
(async () => {
  try {
    const imported = await import("./src/server/http/runtime.ts");
    const getHttpRuntime = imported.getHttpRuntime ?? imported.default?.getHttpRuntime;
    runtime = getHttpRuntime();
    const created = runtime.repository.createDemoInstance();
    const reopened = runtime.repository.getDemoInstance(created.demoInstanceId);
    const instances = runtime.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get().count;
    process.stdout.write(JSON.stringify({
      ok: true, catalogVersion: reopened.catalogVersion, instances,
    }));
  } catch (error) {
    process.stderr.write(JSON.stringify(error));
    process.exitCode = 23;
  } finally {
    try { runtime?.database.close(); } catch {}
  }
})();
`;
const temporaryDirectories = new Set<string>();

afterEach(() => {
  const tempRoot = `${resolve(tmpdir())}${sep}`.toLowerCase();
  for (const directory of temporaryDirectories) {
    const target = resolve(directory);
    if (!`${target}${sep}`.toLowerCase().startsWith(tempRoot)) {
      throw new Error("Refusing to clean a non-temporary runtime directory");
    }
    rmSync(target, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function temporaryDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-runtime-env-"));
  temporaryDirectories.add(directory);
  return join(directory, "claimgate.db");
}

function cleanEnvironment(overrides: Record<string, string | undefined>) {
  const env = { ...process.env };
  for (const name of REQUIRED_ENV) delete env[name];
  Object.assign(env, VALID_ENV, overrides, { NODE_ENV: "production" });
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  return env;
}

function runRuntime(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    "--conditions=react-server",
    "--import=tsx",
    "--eval",
    CHILD_SOURCE,
  ], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
}

function redactedDiagnostic(
  result: ReturnType<typeof runRuntime>,
  env: NodeJS.ProcessEnv,
) {
  let diagnostic = `${result.stdout}\n${result.stderr}`;
  for (const name of SECRET_ENV) {
    if (env[name]) diagnostic = diagnostic.replaceAll(env[name], "[redacted-key]");
  }
  if (env.CLAIMGATE_DATABASE_PATH) {
    diagnostic = diagnostic.replaceAll(env.CLAIMGATE_DATABASE_PATH, "[redacted-db-path]");
  }
  return (diagnostic.split(/\r?\n/, 1)[0] ?? "child exited without output")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 500);
}

function expectClosedConfigurationFailure(
  result: ReturnType<typeof runRuntime>,
  env: NodeJS.ProcessEnv,
) {
  expect(result.error).toBeUndefined();
  if (result.status !== 23) {
    throw new Error(`Runtime child did not fail closed: ${redactedDiagnostic(result, env)}`);
  }
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({
    error: {
      code: "CONFIGURATION_ERROR",
      message: "The service is not configured correctly.",
    },
  });
  const surfaces = `${result.stdout}\n${result.stderr}`;
  for (const name of SECRET_ENV) {
    if (env[name]) expect(surfaces).not.toContain(env[name]);
  }
  if (env.CLAIMGATE_DATABASE_PATH) {
    expect(surfaces).not.toContain(env.CLAIMGATE_DATABASE_PATH);
  }
}

describe("Task 10D production runtime environment wiring", () => {
  it.each(REQUIRED_ENV)("fails closed when %s is missing", (missing) => {
    const databasePath = temporaryDatabasePath();
    const env = cleanEnvironment({ CLAIMGATE_DATABASE_PATH: databasePath, [missing]: undefined });
    expectClosedConfigurationFailure(runRuntime(env), env);
    expect(existsSync(databasePath)).toBe(false);
  });

  it.each(SECRET_ENV.flatMap((name, index) => [
    [name, "weak", Buffer.alloc(31, 141 + index).toString("base64")],
    [name, "noncanonical", `${Buffer.alloc(32, 151 + index).toString("base64")}` + "="],
  ] as const))("fails closed for %s with a %s value", (name, _kind, invalid) => {
    const databasePath = temporaryDatabasePath();
    const env = cleanEnvironment({ CLAIMGATE_DATABASE_PATH: databasePath, [name]: invalid });
    expectClosedConfigurationFailure(runRuntime(env), env);
    expect(existsSync(databasePath)).toBe(false);
  });

  it("constructs twice with the same explicit configuration and closes cleanly", () => {
    const databasePath = temporaryDatabasePath();
    const env = cleanEnvironment({ CLAIMGATE_DATABASE_PATH: databasePath });
    for (const expectedInstances of [1, 2]) {
      const result = runRuntime(env);
      expect(result.error).toBeUndefined();
      if (result.status !== 0) {
        throw new Error(`Runtime child did not start: ${redactedDiagnostic(result, env)}`);
      }
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        catalogVersion: 1,
        instances: expectedInstances,
      });
      expect(result.stdout).not.toContain(databasePath);
      for (const name of SECRET_ENV) expect(result.stdout).not.toContain(env[name]);
      expect(existsSync(databasePath), String(expectedInstances)).toBe(true);
    }
    expect(dirname(databasePath)).toMatch(/claimgate-runtime-env-/);
  });
});
