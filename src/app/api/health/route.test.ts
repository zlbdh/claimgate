import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestDatabase,
  TEST_MASTER_KEY,
  type TestDatabase,
} from "@/server/db/test-harness";
import { createHealthRouteHandler } from "./route";

const REQUIRED_RUNTIME_ENV = [
  "CLAIMGATE_HMAC_KEY",
  "CLAIMGATE_SESSION_KEY",
  "CLAIMGATE_CSRF_KEY",
  "CLAIMGATE_DATABASE_PATH",
  "CLAIMGATE_APP_ORIGIN",
] as const;
const CHILD_SOURCE = `
(async () => {
  const imported = await import("./src/app/api/health/route.ts");
  const GET = imported.GET ?? imported.default?.GET;
  const response = await GET();
  process.stdout.write(JSON.stringify({
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  }));
})().catch(() => { process.exitCode = 23; });
`;

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
  vi.unstubAllEnvs();
});

function setup(): TestDatabase {
  testDatabase = createTestDatabase();
  return testDatabase;
}

function runtimeEnvironment(databasePath: string, missing?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REQUIRED_RUNTIME_ENV) delete env[name];
  Object.assign(env, {
    CLAIMGATE_HMAC_KEY: TEST_MASTER_KEY,
    CLAIMGATE_SESSION_KEY: Buffer.alloc(32, 61).toString("base64"),
    CLAIMGATE_CSRF_KEY: Buffer.alloc(32, 62).toString("base64"),
    CLAIMGATE_DATABASE_PATH: databasePath,
    CLAIMGATE_APP_ORIGIN: "https://health.example.test",
    NODE_ENV: "production",
  });
  if (missing) delete env[missing];
  return env;
}

function runProductionHealth(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    "--conditions=react-server",
    "--import=tsx",
    "--eval",
    CHILD_SOURCE,
  ], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

function expectProductionHealth(
  result: ReturnType<typeof runProductionHealth>,
  status: number,
  body: "healthy" | "unavailable",
): void {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    status,
    cacheControl: "private, no-store",
    contentType: "application/json",
    body: `{"status":"${body}"}`,
  });
}

async function expectFixedResponse(
  response: Response,
  status: number,
  body: "healthy" | "unavailable",
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("application/json");
  expect(await response.text()).toBe(`{"status":"${body}"}`);
}

describe("GET /api/health", () => {
  it("returns the exact healthy body only after a real SQLite query succeeds", async () => {
    const { database } = setup();
    const response = await createHealthRouteHandler(() => database)();

    await expectFixedResponse(response, 200, "healthy");
  });

  it("constructs the complete production runtime and queries its real database", () => {
    const { databasePath } = setup();

    expectProductionHealth(runProductionHealth(runtimeEnvironment(databasePath)), 200, "healthy");
  });

  it("returns a bounded generic 503 when the database is unavailable", async () => {
    const { database } = setup();
    database.close();

    const response = await createHealthRouteHandler(() => database)();

    await expectFixedResponse(response, 503, "unavailable");
  });

  it("does not disclose thrown database details", async () => {
    const response = await createHealthRouteHandler(() => {
      throw new Error("secret=/srv/claimgate/private.sqlite version=3.50 rows=72");
    })();

    await expectFixedResponse(response, 503, "unavailable");
  });

  it.each(REQUIRED_RUNTIME_ENV)(
    "fails closed with the same bounded body when %s is absent",
    (missing) => {
      const { databasePath } = setup();
      expectProductionHealth(
        runProductionHealth(runtimeEnvironment(databasePath, missing)),
        503,
        "unavailable",
      );
    },
  );

  it("does not export any mutating HTTP method", async () => {
    const route = await import("./route");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(route).not.toHaveProperty(method);
    }
  });
});
