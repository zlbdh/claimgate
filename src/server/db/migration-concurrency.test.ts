import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function startInitializer(databasePath: string, barrierPath: string, masterKey: string) {
  const migrateUrl = pathToFileURL(resolve("src/server/db/migrate.ts")).href;
  const keyringUrl = pathToFileURL(resolve("src/server/security/keyring.ts")).href;
  const worker = `
    import { existsSync } from "node:fs";
    import migrateModule from ${JSON.stringify(migrateUrl)};
    import keyringModule from ${JSON.stringify(keyringUrl)};
    const { initializeDatabase } = migrateModule;
    const { createKeyring } = keyringModule;
    const [databasePath, barrierPath, masterKey] = process.argv.slice(1);
    while (!existsSync(barrierPath)) await new Promise((resolve) => setTimeout(resolve, 2));
    try {
      const database = initializeDatabase({ databasePath, keyring: createKeyring(masterKey) });
      database.close();
      process.stdout.write("ok");
    } catch (error) {
      process.stdout.write(error?.code ?? "unknown");
      process.exitCode = 2;
    }
  `;
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", worker, databasePath, barrierPath, masterKey],
    { cwd: process.cwd(), timeout: 30_000 },
  );
}

async function runRace(keys: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-migrate-race-"));
  directories.push(directory);
  const databasePath = join(directory, "race.sqlite");
  const barrierPath = join(directory, "go");
  const calls = keys.map((key) => startInitializer(databasePath, barrierPath, key));
  await new Promise((resolve) => setTimeout(resolve, 500));
  writeFileSync(barrierPath, "go", "utf8");
  return Promise.allSettled(calls);
}

describe("首次建库的跨进程密钥检查", () => {
  it("同一密钥的并发首次打开全部成功，不把初始化中的文件误判成坏库", async () => {
    const key = Buffer.alloc(32, 31).toString("base64");
    const results = await runRace(Array.from({ length: 12 }, () => key));
    expect(results.every((result) => result.status === "fulfilled" && result.value.stdout === "ok"))
      .toBe(true);
  }, 45_000);

  it("混合密钥竞速时只有获胜密钥能够打开，且不会被另一密钥接管", async () => {
    const first = Buffer.alloc(32, 41).toString("base64");
    const second = Buffer.alloc(32, 42).toString("base64");
    const keys = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? first : second);
    const results = await runRace(keys);
    const successfulKeys = results.flatMap((result, index) =>
      result.status === "fulfilled" && result.value.stdout === "ok" ? [keys[index]] : []);

    expect(successfulKeys).toHaveLength(6);
    expect(new Set(successfulKeys).size).toBe(1);
    expect(existsSync(join(directories.at(-1)!, "race.sqlite"))).toBe(true);
  }, 45_000);
});
