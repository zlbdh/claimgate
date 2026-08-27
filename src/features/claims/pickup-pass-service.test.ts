import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "@/server/db/test-harness";
import { createPickupPassService } from "./pickup-pass-service";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function seedApproved(now = 100_000) {
  testDatabase = createTestDatabase(now);
  const { repository, database } = testDatabase;
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  database.prepare(`
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to,
      area, color, public_tags_json, public_description, status, version
    ) VALUES (?, 'report-service', 'claimant-demo', 'earbuds', 'a', 'b',
      'library', 'black', '[]', 'service fixture', 'PUBLISHED', 3)
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
    ) VALUES (?, 'claim-service', 'report-service', ?, 'claimant-demo',
      'APPROVED', 1, 1, 'staff-demo', NULL, 0, 0, 5)
  `).run(instance.demoInstanceId, item.inventoryItemId);
  let randomValue = 0;
  const service = createPickupPassService({
    repository,
    keyring: createKeyring(TEST_MASTER_KEY),
    now: () => (testDatabase!.database.prepare("SELECT 100000 AS now").get() as { now: number }).now,
    randomBytes: (size) => Buffer.alloc(size, ++randomValue),
  });
  const claimant = {
    demoInstanceId: instance.demoInstanceId,
    actorId: "claimant-demo" as const,
    sessionExpiresAt: instance.expiresAtMs,
  };
  const staff = { ...claimant, actorId: "staff-demo" as const };
  return { instance, item, service, claimant, staff };
}

describe("pickup pass service", () => {
  it("returns the initial token once and recovers a lost response without regenerating", () => {
    const { service, claimant } = seedApproved();
    const command = { expectedClaimVersion: 5, idempotencyKey: "pickup-service-issue" };
    const first = service.issue(claimant, "claim-service", command);
    const replay = service.issue(claimant, "claim-service", command);
    if (first.issuance !== "ISSUED") throw new Error("expected first issuance");
    expect(first).toMatchObject({
      issuance: "ISSUED", status: "PICKUP_READY", claimVersion: 6,
      generation: 1, expiresAtMs: 700_000,
    });
    expect(first).toHaveProperty("token");
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(replay).toEqual({
      issuance: "ALREADY_ISSUED", claimId: "claim-service", status: "PICKUP_READY",
      claimVersion: 6, generation: 1, expiresAtMs: 700_000,
    });
    expect(testDatabase!.database.prepare(
      "SELECT COUNT(*) AS count FROM claim_events WHERE event_type = 'PASS_ISSUED'",
    ).get()).toEqual({ count: 1 });
    expect(JSON.stringify(testDatabase!.database.prepare(
      "SELECT * FROM idempotency_records",
    ).all())).not.toContain(first.token);
  });

  it("keeps issue and reissue independent and invalidates the old generation", () => {
    const { service, claimant, staff } = seedApproved();
    const first = service.issue(claimant, "claim-service", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-first-generation",
    });
    const second = service.reissue(claimant, "claim-service", {
      expectedClaimVersion: 6, idempotencyKey: "pickup-second-generation",
    });
    if (first.issuance !== "ISSUED" || second.issuance !== "ISSUED") {
      throw new Error("expected issued generations");
    }
    expect(second).toMatchObject({ issuance: "ISSUED", generation: 2, claimVersion: 7 });
    expect(second.token).not.toBe(first.token);
    expect(() => service.handoff(staff, "claim-service", {
      token: first.token!, expectedClaimVersion: 7, expectedItemVersion: 4,
      expectedReportVersion: 3, expectedGeneration: 1, idempotencyKey: "handoff-old-generation",
    })).toThrow();
    expect(testDatabase!.database.prepare(
      "SELECT status FROM claims WHERE id = 'claim-service'",
    ).get()).toEqual({ status: "PICKUP_READY" });
  });

  it("hands off once and supports same-key and token-authenticated different-key repeats", () => {
    const { service, claimant, staff } = seedApproved();
    const issued = service.issue(claimant, "claim-service", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-for-handoff",
    });
    if (issued.issuance !== "ISSUED") throw new Error("expected issued credential");
    const command = {
      token: issued.token!, expectedClaimVersion: 6, expectedItemVersion: 4,
      expectedReportVersion: 3, expectedGeneration: 1, idempotencyKey: "handoff-first-key",
    };
    const first = service.handoff(staff, "claim-service", command);
    const replay = service.handoff(staff, "claim-service", command);
    const differentKey = service.handoff(staff, "claim-service", {
      ...command, idempotencyKey: "handoff-second-key",
    });
    expect(first).toMatchObject({ completion: "COLLECTED", claimStatus: "COLLECTED" });
    expect(replay).toEqual(first);
    expect(differentKey).toMatchObject({ completion: "ALREADY_COLLECTED", claimStatus: "COLLECTED" });
    expect(testDatabase!.database.prepare(
      "SELECT COUNT(*) AS count FROM claim_events WHERE event_type = 'HANDOFF_COMPLETED'",
    ).get()).toEqual({ count: 1 });
    expect(testDatabase!.database.prepare(
      "SELECT catalog_version AS version FROM demo_instances",
    ).get()).toEqual({ version: 2 });
    expect(() => service.handoff(staff, "claim-service", {
      ...command, token: "AAAAAAAAAAAAAAAAAAAAAA", idempotencyKey: "handoff-wrong-token",
    })).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("uses the earlier of ten minutes and instance expiry and requires positive lifetime", () => {
    const { service, claimant, instance } = seedApproved();
    testDatabase!.database.prepare(
      "UPDATE demo_instances SET expires_at_ms = 650000 WHERE id = ?",
    ).run(instance.demoInstanceId);
    expect(service.issue(claimant, "claim-service", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-short-instance",
    })).toMatchObject({ expiresAtMs: 650_000 });
  });

  it("makes a second key at the same version stale without another token or event", () => {
    const { service, claimant } = seedApproved();
    service.issue(claimant, "claim-service", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-winning-key",
    });
    expect(() => service.issue(claimant, "claim-service", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-stale-key",
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(testDatabase!.database.prepare(
      "SELECT COUNT(*) AS count FROM claim_events WHERE event_type = 'PASS_ISSUED'",
    ).get()).toEqual({ count: 1 });
  });
});
