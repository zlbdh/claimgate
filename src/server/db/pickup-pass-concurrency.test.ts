import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "./test-harness";

const NOW = 100_000;
let testDatabase: TestDatabase | undefined;
const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill();
  children.clear();
  testDatabase?.close();
  testDatabase = undefined;
});

type Operation = { kind: "issue" | "reissue" | "handoff"; key: string; token?: string };
type WorkerResult = { ok: true; result: Record<string, unknown> } | { ok: false; code: string };

const urls = {
  connection: pathToFileURL(resolve("src/server/db/connection.ts")).href,
  repository: pathToFileURL(resolve("src/server/db/repository.ts")).href,
  keyring: pathToFileURL(resolve("src/server/security/keyring.ts")).href,
  evidence: pathToFileURL(resolve("src/features/evidence/evidence-digester.ts")).href,
  service: pathToFileURL(resolve("src/features/claims/pickup-pass-service.ts")).href,
};

const WORKER = `
  import { existsSync } from "node:fs";
  import { randomBytes, randomUUID } from "node:crypto";
  import connectionModule from ${JSON.stringify(urls.connection)};
  import repositoryModule from ${JSON.stringify(urls.repository)};
  import keyringModule from ${JSON.stringify(urls.keyring)};
  import evidenceModule from ${JSON.stringify(urls.evidence)};
  import serviceModule from ${JSON.stringify(urls.service)};
  const { openDatabaseConnection } = connectionModule;
  const { createRepository } = repositoryModule;
  const { createKeyring } = keyringModule;
  const { createEvidenceDigester } = evidenceModule;
  const { createPickupPassService } = serviceModule;
  const config = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
  const database = openDatabaseConnection(config.databasePath);
  const keyring = createKeyring(config.masterKey);
  const repository = createRepository({ database, now: () => config.now, randomId: randomUUID,
    evidenceDigester: createEvidenceDigester(keyring.getKey("evidence")), randomBytes });
  const service = createPickupPassService({ repository, keyring, now: () => config.now, randomBytes });
  process.stdout.write("READY\\n");
  while (!existsSync(config.barrierPath)) await new Promise((resolve) => setTimeout(resolve, 2));
  try {
    const claimant = { demoInstanceId: config.instanceId, actorId: "claimant-demo", sessionExpiresAt: config.expiresAt };
    const staff = { ...claimant, actorId: "staff-demo" };
    const op = config.operation;
    const raw = op.kind === "issue"
      ? service.issue(claimant, "claim-concurrent", { expectedClaimVersion: 5, idempotencyKey: op.key })
      : op.kind === "reissue"
        ? service.reissue(claimant, "claim-concurrent", { expectedClaimVersion: 6, idempotencyKey: op.key })
        : service.handoff(staff, "claim-concurrent", { token: op.token, expectedClaimVersion: 6,
            expectedItemVersion: 4, expectedReportVersion: 3, expectedGeneration: 1, idempotencyKey: op.key });
    const result = op.kind !== "handoff"
      ? { issuance: raw.issuance, hasToken: Object.hasOwn(raw, "token") }
      : raw;
    process.stdout.write("RESULT:" + JSON.stringify({ ok: true, result }) + "\\n");
  } catch (error) {
    process.stdout.write("RESULT:" + JSON.stringify({ ok: false, code: error?.code ?? "UNBOUNDED" }) + "\\n");
  } finally { database.close(); }
`;

function launch(config: object) {
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64url");
  const child = spawn(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", WORKER, encoded,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "";
  let stderr = "";
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  child.stdout!.on("data", (chunk) => {
    stdout += String(chunk);
    if (stdout.includes("READY\n")) readyResolve();
  });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const done = new Promise<{ result: WorkerResult; output: string }>((resolveDone, rejectDone) => {
    child.once("error", rejectDone);
    child.once("close", () => {
      children.delete(child);
      if (!stdout.includes("READY\n")) readyReject(new Error(`worker failed: ${stderr}`));
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
      if (!line) return rejectDone(new Error(`worker returned no result: ${stdout} ${stderr}`));
      resolveDone({ result: JSON.parse(line.slice(7)) as WorkerResult, output: `${stdout}\n${stderr}` });
    });
  });
  void ready.catch(() => undefined);
  void done.catch(() => undefined);
  return { child, ready, done };
}

async function race(operations: Operation[]) {
  const barrierPath = `${testDatabase!.databasePath}.${crypto.randomUUID()}.barrier`;
  const instance = testDatabase!.repository.getDemoInstance(
    (testDatabase!.database.prepare("SELECT id FROM demo_instances").get() as { id: string }).id,
  );
  const workers = operations.map((operation) => launch({
    databasePath: testDatabase!.databasePath, barrierPath, operation,
    masterKey: TEST_MASTER_KEY, now: NOW,
    instanceId: instance.demoInstanceId, expiresAt: instance.expiresAtMs,
  }));
  try {
    await Promise.all(workers.map(({ ready }) => ready));
    writeFileSync(barrierPath, "go", "utf8");
    const values = await Promise.all(workers.map(({ done }) => done));
    for (const value of values) expect(value.output).not.toMatch(/SQLITE_BUSY|database is locked/i);
    return values.map(({ result }) => result);
  } finally {
    rmSync(barrierPath, { force: true });
    for (const { child } of workers) if (child.exitCode === null) child.kill();
  }
}

function setup() {
  testDatabase = createTestDatabase(NOW);
  const { repository, database } = testDatabase;
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  database.prepare(`INSERT INTO lost_reports (
    demo_instance_id, id, owner_actor_id, category, time_from, time_to,
    area, color, public_tags_json, public_description, status, version
  ) VALUES (?, 'report-concurrent', 'claimant-demo', 'earbuds', 'a', 'b',
    'library', 'black', '[]', 'concurrent', 'PUBLISHED', 3)`).run(instance.demoInstanceId);
  database.prepare(`UPDATE found_items SET status = 'HELD', version = 4
    WHERE demo_instance_id = ? AND id = ?`).run(instance.demoInstanceId, item.inventoryItemId);
  database.prepare(`INSERT INTO claims (
    demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
    status, attempts, evidence_eligible, reviewer_actor_id, unlock_count, pass_generation, version
  ) VALUES (?, 'claim-concurrent', 'report-concurrent', ?, 'claimant-demo',
    'APPROVED', 1, 1, 'staff-demo', 0, 0, 5)`).run(instance.demoInstanceId, item.inventoryItemId);
  const service = createPickupPassService({
    repository, keyring: createKeyring(TEST_MASTER_KEY), now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, size),
  });
  return { instance, service, claimant: {
    demoInstanceId: instance.demoInstanceId,
    actorId: "claimant-demo" as const,
    sessionExpiresAt: instance.expiresAtMs,
  } };
}

describe("real overlapping pickup writers", () => {
  it("serializes same-key and different-key issuance", async () => {
    setup();
    let results = await race([
      { kind: "issue", key: "pickup-concurrent-same" },
      { kind: "issue", key: "pickup-concurrent-same" },
    ]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(results.map((value) => value.ok && value.result)).toEqual(expect.arrayContaining([
      { issuance: "ISSUED", hasToken: true },
      { issuance: "ALREADY_ISSUED", hasToken: false },
    ]));
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 1 });
    testDatabase!.close(); testDatabase = undefined;

    setup();
    results = await race([
      { kind: "issue", key: "pickup-concurrent-a" },
      { kind: "issue", key: "pickup-concurrent-b" },
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([expect.objectContaining({ code: "STATE_CHANGED" })]);
  }, 30_000);

  it("serializes same-key and different-key reissue across real connections", async () => {
    let value = setup();
    let issued = value.service.issue(value.claimant, "claim-concurrent", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-before-reissue-same",
    });
    if (issued.issuance !== "ISSUED") throw new Error("expected initial token");
    const oldToken = issued.token;
    let results = await race([
      { kind: "reissue", key: "reissue-concurrent-same" },
      { kind: "reissue", key: "reissue-concurrent-same" },
    ]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(results.map((entry) => entry.ok && entry.result)).toEqual(expect.arrayContaining([
      { issuance: "ISSUED", hasToken: true },
      { issuance: "ALREADY_ISSUED", hasToken: false },
    ]));
    expect(testDatabase!.database.prepare(`SELECT pass_generation AS generation FROM claims
      WHERE id = 'claim-concurrent'`).get()).toEqual({ generation: 2 });
    expect(testDatabase!.database.prepare(`SELECT COUNT(*) AS count FROM claim_events
      WHERE event_type = 'PASS_REISSUED'`).get()).toEqual({ count: 1 });
    const staff = { ...value.claimant, actorId: "staff-demo" as const };
    expect(() => value.service.handoff(staff, "claim-concurrent", {
      token: oldToken, expectedClaimVersion: 7, expectedItemVersion: 4,
      expectedReportVersion: 3, expectedGeneration: 2, idempotencyKey: "old-token-after-reissue",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    testDatabase!.close(); testDatabase = undefined;

    value = setup();
    issued = value.service.issue(value.claimant, "claim-concurrent", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-before-reissue-different",
    });
    if (issued.issuance !== "ISSUED") throw new Error("expected initial token");
    results = await race([
      { kind: "reissue", key: "reissue-concurrent-a" },
      { kind: "reissue", key: "reissue-concurrent-b" },
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([expect.objectContaining({ code: "STATE_CHANGED" })]);
    expect(testDatabase!.database.prepare(`SELECT pass_generation AS generation FROM claims
      WHERE id = 'claim-concurrent'`).get()).toEqual({ generation: 2 });
    expect(testDatabase!.database.prepare(`SELECT COUNT(*) AS count FROM claim_events
      WHERE event_type = 'PASS_REISSUED'`).get()).toEqual({ count: 1 });
  }, 30_000);

  it("completes one handoff for same-key and different-key tabs", async () => {
    let value = setup();
    let issued = value.service.issue(value.claimant, "claim-concurrent", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-before-handoff-a",
    });
    if (issued.issuance !== "ISSUED") throw new Error("expected token");
    let results = await race([
      { kind: "handoff", key: "handoff-concurrent-same", token: issued.token },
      { kind: "handoff", key: "handoff-concurrent-same", token: issued.token },
    ]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(testDatabase!.database.prepare(`SELECT COUNT(*) AS count FROM claim_events
      WHERE event_type = 'HANDOFF_COMPLETED'`).get()).toEqual({ count: 1 });
    testDatabase!.close(); testDatabase = undefined;

    value = setup();
    issued = value.service.issue(value.claimant, "claim-concurrent", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-before-handoff-b",
    });
    if (issued.issuance !== "ISSUED") throw new Error("expected token");
    results = await race([
      { kind: "handoff", key: "handoff-concurrent-a", token: issued.token },
      { kind: "handoff", key: "handoff-concurrent-b", token: issued.token },
    ]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(results.map((entry) => entry.ok && entry.result.completion)).toEqual(
      expect.arrayContaining(["COLLECTED", "ALREADY_COLLECTED"]),
    );
    expect(testDatabase!.database.prepare("SELECT catalog_version AS version FROM demo_instances").get())
      .toEqual({ version: 2 });
  }, 30_000);
});
