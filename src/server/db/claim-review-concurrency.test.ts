import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

const NOW = Date.UTC(2026, 7, 26, 12);
const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
let testDatabase: TestDatabase | undefined;
const children = new Set<ChildProcess>();

afterEach(() => {
  for (const child of children) if (child.exitCode === null) child.kill();
  children.clear();
  testDatabase?.close();
  testDatabase = undefined;
});

type Operation =
  | { kind: "evidence"; claimId: string; version: number; key: string }
  | { kind: "approve"; claimId: string; version: number; itemVersion: number; key: string }
  | { kind: "unlock"; claimId: string; version: number; key: string };

type WorkerResult = { ok: true; result: unknown } | { ok: false; code: string };

const urls = {
  connection: pathToFileURL(resolve("src/server/db/connection.ts")).href,
  repository: pathToFileURL(resolve("src/server/db/repository.ts")).href,
  keyring: pathToFileURL(resolve("src/server/security/keyring.ts")).href,
  evidence: pathToFileURL(resolve("src/features/evidence/evidence-digester.ts")).href,
  service: pathToFileURL(resolve("src/features/claims/claim-service.ts")).href,
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
  const { createClaimService } = serviceModule;
  const config = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
  const database = openDatabaseConnection(config.databasePath);
  const keyring = createKeyring(config.masterKey);
  const repository = createRepository({
    database, now: () => config.now, randomId: randomUUID,
    evidenceDigester: createEvidenceDigester(keyring.getKey("evidence")), randomBytes,
  });
  const service = createClaimService({ repository, keyring, now: () => config.now });
  process.stdout.write("READY\\n");
  while (!existsSync(config.barrierPath)) await new Promise((resolve) => setTimeout(resolve, 2));
  try {
    const claimant = { demoInstanceId: config.instanceId, actorId: "claimant-demo", sessionExpiresAt: config.expiresAt };
    const staff = { ...claimant, actorId: "staff-demo" };
    const op = config.operation;
    const result = op.kind === "evidence"
      ? service.submitEvidence(claimant, op.claimId, { expectedVersion: op.version, idempotencyKey: op.key, answers: {} })
      : op.kind === "approve"
        ? service.approve(staff, op.claimId, { expectedClaimVersion: op.version, expectedItemVersion: op.itemVersion, idempotencyKey: op.key })
        : service.unlock(staff, op.claimId, { expectedClaimVersion: op.version, idempotencyKey: op.key });
    process.stdout.write("RESULT:" + JSON.stringify({ ok: true, result }) + "\\n");
  } catch (error) {
    process.stdout.write("RESULT:" + JSON.stringify({ ok: false, code: error?.code ?? "UNBOUNDED" }) + "\\n");
  } finally {
    database.close();
  }
`;

function launch(config: object) {
  const encoded = Buffer.from(JSON.stringify(config)).toString("base64url");
  const child = spawn(process.execPath, [
    "--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", WORKER, encoded,
  ], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  });
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
      if (!stdout.includes("READY\n")) readyReject(new Error(`worker failed before READY: ${stderr}`));
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
    (testDatabase!.database.prepare("SELECT id FROM demo_instances LIMIT 1").get() as { id: string }).id,
  );
  const workers = operations.map((operation) => launch({
    databasePath: testDatabase!.databasePath, barrierPath, operation,
    masterKey: MASTER_KEY, now: NOW, instanceId: instance.demoInstanceId, expiresAt: instance.expiresAtMs,
  }));
  try {
    await Promise.all(workers.map(({ ready }) => ready));
    writeFileSync(barrierPath, "go", "utf8");
    const results = await Promise.all(workers.map(({ done }) => done));
    for (const value of results) expect(value.output).not.toMatch(/SQLITE_BUSY|database is locked/i);
    return results.map(({ result }) => result);
  } finally {
    rmSync(barrierPath, { force: true });
    for (const { child } of workers) if (child.exitCode === null) child.kill();
  }
}

function createClaim(instanceId: string, itemId: string, suffix: string) {
  const repository = testDatabase!.repository;
  const report = repository.createLostReport({
    demoInstanceId: instanceId, ownerActorId: "claimant-demo", category: "earbuds",
    timeWindow: { from: `from-${suffix}`, to: `to-${suffix}` }, area: "library", color: "black",
    publicTags: [], publicDescription: `real concurrency ${suffix}`,
  });
  repository.publishLostReport({
    demoInstanceId: instanceId, reportId: report.reportId,
    expectedVersion: report.version, actorId: "claimant-demo",
  });
  return repository.createClaim({
    demoInstanceId: instanceId, reportId: report.reportId,
    inventoryItemId: itemId, claimantActorId: "claimant-demo",
  });
}

function setup() {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const item = testDatabase.repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  return { instance, item, claims: [
    createClaim(instance.demoInstanceId, item.inventoryItemId, "a"),
    createClaim(instance.demoInstanceId, item.inventoryItemId, "b"),
  ] };
}

function review(claimId: string, version = 1): number {
  testDatabase!.database.prepare(`UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1,
    version = version + 1 WHERE id = ? AND version = ?`).run(claimId, version);
  return version + 1;
}

function lock(claimId: string, version = 1): number {
  for (const attempts of [1, 2]) testDatabase!.database.prepare(`UPDATE claims SET attempts = ?,
    version = version + 1 WHERE id = ?`).run(attempts, claimId);
  testDatabase!.database.prepare(`UPDATE claims SET status = 'LOCKED', attempts = 3,
    version = version + 1 WHERE id = ?`).run(claimId);
  return version + 3;
}

function assertHeldFinal(itemId: string, expectedEvents: number[]) {
  expect(testDatabase!.database.prepare("SELECT status, version FROM found_items WHERE id = ?").get(itemId))
    .toEqual({ status: "HELD", version: 2 });
  expect(testDatabase!.database.prepare(`SELECT COUNT(*) AS count FROM claims WHERE found_item_id = ?
    AND status IN ('EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'LOCKED')`).get(itemId)).toEqual({ count: 0 });
  const count = (testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get() as { count: number }).count;
  expect(expectedEvents).toContain(count);
}

describe("real overlapping Task 7 writers", () => {
  it("serializes same-version evidence and same-key duplicate workers", async () => {
    let value = setup();
    let results = await race([
      { kind: "evidence", claimId: value.claims[0]!.claimId, version: 1, key: "worker-evidence-a" },
      { kind: "evidence", claimId: value.claims[0]!.claimId, version: 1, key: "worker-evidence-b" },
    ]);
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toEqual([expect.objectContaining({ code: "STATE_CHANGED" })]);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get()).toEqual({ count: 1 });
    testDatabase!.close(); testDatabase = undefined;

    value = setup();
    results = await race([
      { kind: "evidence", claimId: value.claims[0]!.claimId, version: 1, key: "worker-same-key-01" },
      { kind: "evidence", claimId: value.claims[0]!.claimId, version: 1, key: "worker-same-key-01" },
    ]);
    expect(results.every(({ ok }) => ok)).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get()).toEqual({ count: 1 });
  }, 30_000);

  it("chooses one competing approval winner with exact aggregate counts", async () => {
    const value = setup();
    const versions = value.claims.map((claim) => review(claim.claimId));
    const results = await race(value.claims.map((claim, index) => ({
      kind: "approve" as const, claimId: claim.claimId, version: versions[index]!,
      itemVersion: 1, key: `worker-approve-${index}`,
    })));
    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter(({ ok }) => !ok)).toHaveLength(1);
    assertHeldFinal(value.item.inventoryItemId, [2]);
    expect(testDatabase!.database.prepare("SELECT catalog_version AS version FROM demo_instances").get())
      .toEqual({ version: 2 });
  }, 30_000);

  it.each(["evidence", "unlock"] as const)("keeps approve-vs-%s final state coherent", async (other) => {
    const value = setup();
    const winnerVersion = review(value.claims[0]!.claimId);
    const otherVersion = other === "unlock" ? lock(value.claims[1]!.claimId) : value.claims[1]!.version;
    const operation: Operation = other === "unlock"
      ? { kind: "unlock", claimId: value.claims[1]!.claimId, version: otherVersion, key: "worker-unlock-0001" }
      : { kind: "evidence", claimId: value.claims[1]!.claimId, version: otherVersion, key: "worker-race-evidence" };
    const results = await race([
      { kind: "approve", claimId: value.claims[0]!.claimId, version: winnerVersion,
        itemVersion: 1, key: `worker-approve-vs-${other}` },
      operation,
    ]);
    expect(results[0]).toMatchObject({ ok: true });
    if (!results[1]!.ok) expect(results[1]).toMatchObject({ code: "STATE_CHANGED" });
    assertHeldFinal(value.item.inventoryItemId, [2, 3]);
  }, 30_000);
});
