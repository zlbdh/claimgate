import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function seedApproved() {
  testDatabase = createTestDatabase(100_000);
  const { repository, database } = testDatabase;
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  database.prepare(`
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to,
      area, color, public_tags_json, public_description, status, version
    ) VALUES (?, 'report-pickup', 'claimant-demo', 'earbuds', 'a', 'b',
      'library', 'black', '[]', 'pickup fixture', 'PUBLISHED', 3)
  `).run(instance.demoInstanceId);
  database.prepare(`
    UPDATE found_items SET status = 'HELD', version = 4
    WHERE demo_instance_id = ? AND id = ?
  `).run(instance.demoInstanceId, item.inventoryItemId);
  database.prepare(`
    INSERT INTO claims (
      demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
      status, attempts, evidence_eligible, reviewer_actor_id,
      rejection_reason, unlock_count, pass_generation, version
    ) VALUES (?, 'claim-pickup', 'report-pickup', ?, 'claimant-demo',
      'APPROVED', 1, 1, 'staff-demo', NULL, 0, 0, 5)
  `).run(instance.demoInstanceId, item.inventoryItemId);
  return { instance, item };
}

function issue(generation = 1, expectedClaimVersion = 5) {
  const instanceId = testDatabase!.repository.getDemoInstance(
    (testDatabase!.database.prepare("SELECT id FROM demo_instances").get() as { id: string }).id,
  ).demoInstanceId;
  return testDatabase!.repository.issuePickupPass({
    demoInstanceId: instanceId,
    claimId: "claim-pickup",
    claimantActorId: "claimant-demo",
    action: generation === 1 ? "pickup_issue" : "pickup_reissue",
    expectedClaimVersion,
    generation,
    expiresAtMs: 600_000 + generation,
    salt: Buffer.alloc(32, generation),
    digest: Buffer.alloc(32, generation + 10),
  });
}

describe("pickup pass repository transactions", () => {
  it("issues then explicitly reissues with exact generation, metadata and one event", () => {
    const { instance } = seedApproved();
    const context = testDatabase!.repository.getServerInternalPickupContext(
      instance.demoInstanceId,
      "claim-pickup",
    );
    expect(context).toMatchObject({
      claimStatus: "APPROVED", claimVersion: 5, claimantActorId: "claimant-demo",
      itemStatus: "HELD", itemVersion: 4, reportStatus: "PUBLISHED", reportVersion: 3,
      generation: 0, consumedAtMs: null, instanceExpiresAtMs: instance.expiresAtMs,
    });
    expect(issue()).toEqual({
      kind: "pickup_pass_ack", claimId: "claim-pickup", status: "PICKUP_READY",
      claimVersion: 6, generation: 1, expiresAtMs: 600_001,
    });
    expect(issue(2, 6)).toEqual({
      kind: "pickup_pass_ack", claimId: "claim-pickup", status: "PICKUP_READY",
      claimVersion: 7, generation: 2, expiresAtMs: 600_002,
    });
    expect(testDatabase!.database.prepare(`
      SELECT pass_generation AS generation, length(pickup_pass_salt) AS saltLength,
        length(pickup_pass_digest) AS digestLength, pickup_pass_consumed_at_ms AS consumedAt
      FROM claims WHERE id = 'claim-pickup'
    `).get()).toEqual({ generation: 2, saltLength: 32, digestLength: 32, consumedAt: null });
    expect(testDatabase!.database.prepare(`
      SELECT event_type AS eventType, result FROM claim_events ORDER BY occurred_at_ms, id
    `).all()).toEqual([
      { eventType: "PASS_ISSUED", result: "ISSUED" },
      { eventType: "PASS_REISSUED", result: "REISSUED" },
    ]);
  });

  it("rejects role, stale version, wrong generation, expiry and item state without partial writes", () => {
    seedApproved();
    const base = {
      demoInstanceId: (testDatabase!.database.prepare("SELECT id FROM demo_instances").get() as { id: string }).id,
      claimId: "claim-pickup", claimantActorId: "claimant-demo", action: "pickup_issue" as const,
      expectedClaimVersion: 5, generation: 1, expiresAtMs: 600_001,
      salt: Buffer.alloc(32, 1), digest: Buffer.alloc(32, 2),
    };
    for (const [patch, code] of [
      [{ claimantActorId: "staff-demo" }, "FORBIDDEN"],
      [{ expectedClaimVersion: 4 }, "STATE_CHANGED"],
      [{ generation: 2 }, "INVALID_STATE_TRANSITION"],
      [{ expiresAtMs: 100_000 }, "VALIDATION_FAILED"],
      [{ expiresAtMs: 9_999_999_999_999 }, "VALIDATION_FAILED"],
    ] as const) expect(() => testDatabase!.repository.issuePickupPass({ ...base, ...patch }))
      .toThrow(expect.objectContaining({ code }));
    expect(testDatabase!.database.prepare(`
      SELECT status, version, pass_generation AS generation FROM claims WHERE id = 'claim-pickup'
    `).get()).toEqual({ status: "APPROVED", version: 5, generation: 0 });
    expect(testDatabase!.database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 0 });
  });

  it("rolls issuance back when the redacted event write fails", () => {
    seedApproved();
    testDatabase!.database.exec(`
      CREATE TRIGGER fail_pickup_event BEFORE INSERT ON claim_events
      WHEN NEW.event_type = 'PASS_ISSUED'
      BEGIN SELECT RAISE(ABORT, 'injected pickup event failure'); END;
    `);
    expect(() => issue()).toThrow(/injected pickup event failure/);
    expect(testDatabase!.database.prepare(`
      SELECT status, version, pass_generation AS generation FROM claims WHERE id = 'claim-pickup'
    `).get()).toEqual({ status: "APPROVED", version: 5, generation: 0 });
  });

  it("atomically collects the claim, returns the item, resolves the report and bumps catalog once", () => {
    const { instance, item } = seedApproved();
    issue();
    testDatabase!.setNow(200_000);
    const result = testDatabase!.repository.completePickupHandoff({
      demoInstanceId: instance.demoInstanceId, claimId: "claim-pickup", staffActorId: "staff-demo",
      expectedClaimVersion: 6, expectedItemVersion: 4, expectedReportVersion: 3,
      expectedGeneration: 1,
    });
    expect(result).toEqual({
      kind: "handoff_ack", claimId: "claim-pickup", completion: "COLLECTED",
      claimStatus: "COLLECTED", claimVersion: 7, itemStatus: "RETURNED", itemVersion: 5,
      reportStatus: "RESOLVED", reportVersion: 4, generation: 1,
    });
    expect(testDatabase!.database.prepare(`
      SELECT status, pickup_pass_consumed_at_ms AS consumedAt,
        length(pickup_pass_digest) AS digestLength FROM claims WHERE id = 'claim-pickup'
    `).get()).toEqual({ status: "COLLECTED", consumedAt: 200_000, digestLength: 32 });
    expect(testDatabase!.database.prepare(
      "SELECT status, version FROM found_items WHERE id = ?",
    ).get(item.inventoryItemId)).toEqual({ status: "RETURNED", version: 5 });
    expect(testDatabase!.database.prepare(
      "SELECT status, version FROM lost_reports WHERE id = 'report-pickup'",
    ).get()).toEqual({ status: "RESOLVED", version: 4 });
    expect(testDatabase!.database.prepare(
      "SELECT catalog_version AS catalogVersion FROM demo_instances WHERE id = ?",
    ).get(instance.demoInstanceId)).toEqual({ catalogVersion: instance.catalogVersion + 1 });
    expect(testDatabase!.database.prepare(`
      SELECT event_type AS eventType, result FROM claim_events WHERE event_type = 'HANDOFF_COMPLETED'
    `).get()).toEqual({ eventType: "HANDOFF_COMPLETED", result: "COLLECTED" });
  });

  it("rolls every handoff row back when report resolution fails", () => {
    const { instance, item } = seedApproved();
    issue();
    testDatabase!.setNow(200_000);
    testDatabase!.database.exec(`
      CREATE TRIGGER fail_report_resolution BEFORE UPDATE ON lost_reports
      WHEN NEW.status = 'RESOLVED'
      BEGIN SELECT RAISE(ABORT, 'injected report failure'); END;
    `);
    expect(() => testDatabase!.repository.completePickupHandoff({
      demoInstanceId: instance.demoInstanceId, claimId: "claim-pickup", staffActorId: "staff-demo",
      expectedClaimVersion: 6, expectedItemVersion: 4, expectedReportVersion: 3,
      expectedGeneration: 1,
    })).toThrow(/injected report failure/);
    expect(testDatabase!.database.prepare(
      "SELECT status, version FROM claims WHERE id = 'claim-pickup'",
    ).get()).toEqual({ status: "PICKUP_READY", version: 6 });
    expect(testDatabase!.database.prepare(
      "SELECT status, version FROM found_items WHERE id = ?",
    ).get(item.inventoryItemId)).toEqual({ status: "HELD", version: 4 });
    expect(testDatabase!.database.prepare(
      "SELECT status, version FROM lost_reports WHERE id = 'report-pickup'",
    ).get()).toEqual({ status: "PUBLISHED", version: 3 });
  });
});
