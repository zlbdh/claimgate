import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createClaimService } from "@/features/claims/claim-service";
import { createEvidenceDigester } from "@/features/evidence/evidence-digester";
import { createKeyring } from "@/server/security/keyring";
import { createRepository } from "./repository";
import { openDatabaseConnection } from "./connection";
import { createTestDatabase, type TestDatabase } from "./test-harness";

const NOW = Date.UTC(2026, 7, 26, 12);
let testDatabase: TestDatabase | undefined;
let secondary: ReturnType<typeof openDatabaseConnection> | undefined;

afterEach(() => {
  secondary?.close();
  secondary = undefined;
  testDatabase?.close();
  testDatabase = undefined;
});

function createClaimForItem(instanceId: string, itemId: string, suffix: string) {
  const repository = testDatabase!.repository;
  const draft = repository.createLostReport({
    demoInstanceId: instanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: `from-${suffix}`, to: `to-${suffix}` },
    area: "library",
    color: "black",
    publicTags: [],
    publicDescription: `concurrency report ${suffix}`,
  });
  repository.publishLostReport({
    demoInstanceId: instanceId,
    reportId: draft.reportId,
    expectedVersion: draft.version,
    actorId: "claimant-demo",
  });
  return repository.createClaim({
    demoInstanceId: instanceId,
    reportId: draft.reportId,
    inventoryItemId: itemId,
    claimantActorId: "claimant-demo",
  });
}

function setup() {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const item = testDatabase.repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  const claims = [
    createClaimForItem(instance.demoInstanceId, item.inventoryItemId, "a"),
    createClaimForItem(instance.demoInstanceId, item.inventoryItemId, "b"),
  ];
  const keyring = createKeyring(Buffer.alloc(32, 7).toString("base64"));
  secondary = openDatabaseConnection(testDatabase.databasePath);
  const secondRepository = createRepository({
    database: secondary,
    now: () => NOW,
    randomId: () => `second-${crypto.randomUUID()}`,
    evidenceDigester: createEvidenceDigester(keyring.getKey("evidence")),
    randomBytes: (size) => Buffer.alloc(size, 9),
  });
  const claimant = {
    demoInstanceId: instance.demoInstanceId,
    actorId: "claimant-demo" as const,
    sessionExpiresAt: instance.expiresAtMs,
  };
  const staff = { ...claimant, actorId: "staff-demo" as const };
  return {
    instance, item, claims, claimant, staff,
    first: createClaimService({ repository: testDatabase.repository, keyring, now: () => NOW }),
    second: createClaimService({ repository: secondRepository, keyring, now: () => NOW }),
  };
}

describe("claim review writer serialization", () => {
  it("same Claim/version across two connections commits one evidence write", async () => {
    const value = setup();
    const command = (key: string) => ({ expectedVersion: 1, idempotencyKey: key, answers: {} });
    const results = await Promise.allSettled([
      Promise.resolve().then(() => value.first.submitEvidence(
        value.claimant, value.claims[0]!.claimId, command("concurrent-evidence-a"),
      )),
      Promise.resolve().then(() => value.second.submitEvidence(
        value.claimant, value.claims[0]!.claimId, command("concurrent-evidence-b"),
      )),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(testDatabase!.database.prepare(`
      SELECT attempts, version FROM claims WHERE id = ?
    `).get(value.claims[0]!.claimId)).toEqual({ attempts: 1, version: 2 });
    expect(testDatabase!.database.prepare(`
      SELECT COUNT(*) AS count FROM claim_events WHERE claim_id = ?
    `).get(value.claims[0]!.claimId)).toEqual({ count: 1 });
  });

  it("same idempotency key/fingerprint across two connections returns one event/result", async () => {
    const value = setup();
    const command = { expectedVersion: 1, idempotencyKey: "concurrent-same-key", answers: {} };
    const results = await Promise.all([
      Promise.resolve().then(() => value.first.submitEvidence(value.claimant, value.claims[0]!.claimId, command)),
      Promise.resolve().then(() => value.second.submitEvidence(value.claimant, value.claims[0]!.claimId, command)),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(testDatabase!.database.prepare(`
      SELECT COUNT(*) AS count FROM claim_events WHERE claim_id = ?
    `).get(value.claims[0]!.claimId)).toEqual({ count: 1 });
  });

  it("two competing approvals choose one winner and mutate item/catalog exactly once", async () => {
    const value = setup();
    for (const claim of value.claims) testDatabase!.database.prepare(`
      UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1 WHERE id = ?
    `).run(claim.claimId);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => value.first.approve(value.staff, value.claims[0]!.claimId, {
        expectedClaimVersion: 1, expectedItemVersion: 1, idempotencyKey: "concurrent-approve-a",
      })),
      Promise.resolve().then(() => value.second.approve(value.staff, value.claims[1]!.claimId, {
        expectedClaimVersion: 1, expectedItemVersion: 1, idempotencyKey: "concurrent-approve-b",
      })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rows = testDatabase!.database.prepare(`
      SELECT status, rejection_reason AS reason FROM claims ORDER BY id
    `).all() as Array<{ status: string; reason: string | null }>;
    expect(rows.filter(({ status }) => status === "APPROVED")).toHaveLength(1);
    expect(rows.filter(({ reason }) => reason === "ITEM_HELD_BY_ANOTHER_CLAIM")).toHaveLength(1);
    expect(testDatabase!.database.prepare("SELECT status, version FROM found_items WHERE id = ?")
      .get(value.item.inventoryItemId)).toEqual({ status: "HELD", version: 2 });
    expect(testDatabase!.database.prepare("SELECT catalog_version AS version FROM demo_instances WHERE id = ?")
      .get(value.instance.demoInstanceId)).toEqual({ version: 2 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 2 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM lost_reports WHERE status = 'PUBLISHED'").get())
      .toEqual({ count: 2 });
  });

  it("approve versus evidence leaves no active Claim against a held item", async () => {
    const value = setup();
    testDatabase!.database.prepare(`
      UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1 WHERE id = ?
    `).run(value.claims[0]!.claimId);
    await Promise.allSettled([
      Promise.resolve().then(() => value.first.approve(value.staff, value.claims[0]!.claimId, {
        expectedClaimVersion: 1, expectedItemVersion: 1, idempotencyKey: "approve-evidence-race",
      })),
      Promise.resolve().then(() => value.second.submitEvidence(value.claimant, value.claims[1]!.claimId, {
        expectedVersion: 1, idempotencyKey: "evidence-approve-race", answers: {},
      })),
    ]);
    expect(testDatabase!.database.prepare(`
      SELECT COUNT(*) AS count FROM claims
      WHERE found_item_id = ? AND status IN ('EVIDENCE_REQUIRED', 'UNDER_REVIEW', 'LOCKED')
    `).get(value.item.inventoryItemId)).toEqual({ count: 0 });
  });
});
