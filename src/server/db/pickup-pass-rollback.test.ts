import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import { createKeyring } from "@/server/security/keyring";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup(issue = false) {
  testDatabase = createTestDatabase(100_000);
  const { repository, database } = testDatabase;
  const instance = repository.createDemoInstance();
  const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  database.prepare(`INSERT INTO lost_reports (
    demo_instance_id, id, owner_actor_id, category, time_from, time_to,
    area, color, public_tags_json, public_description, status, version
  ) VALUES (?, 'report-rollback-pickup', 'claimant-demo', 'earbuds', 'a', 'b',
    'library', 'black', '[]', 'rollback', 'PUBLISHED', 3)`).run(instance.demoInstanceId);
  database.prepare(`UPDATE found_items SET status = 'HELD', version = 4
    WHERE demo_instance_id = ? AND id = ?`).run(instance.demoInstanceId, item.inventoryItemId);
  database.prepare(`INSERT INTO claims (
    demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
    status, attempts, evidence_eligible, reviewer_actor_id, unlock_count, pass_generation, version
  ) VALUES (?, 'claim-rollback-pickup', 'report-rollback-pickup', ?, 'claimant-demo',
    'APPROVED', 1, 1, 'staff-demo', 0, 0, 5)`).run(instance.demoInstanceId, item.inventoryItemId);
  const service = createPickupPassService({
    repository, keyring: createKeyring(TEST_MASTER_KEY), now: () => 100_000,
    randomBytes: (size) => Buffer.alloc(size, size),
  });
  const claimant = {
    demoInstanceId: instance.demoInstanceId,
    actorId: "claimant-demo" as const,
    sessionExpiresAt: instance.expiresAtMs,
  };
  const staff = { ...claimant, actorId: "staff-demo" as const };
  const issued = issue ? service.issue(claimant, "claim-rollback-pickup", {
    expectedClaimVersion: 5, idempotencyKey: "pickup-rollback-primer",
  }) : undefined;
  if (issued && issued.issuance !== "ISSUED") throw new Error("expected primer token");
  return { instance, item, service, claimant, staff, token: issued?.token };
}

function snapshot() {
  const database = testDatabase!.database;
  return {
    instance: database.prepare("SELECT id, catalog_version FROM demo_instances").all(),
    item: database.prepare("SELECT id, status, version FROM found_items ORDER BY id").all(),
    report: database.prepare("SELECT id, status, version FROM lost_reports").all(),
    claim: database.prepare(`SELECT id, status, version, pass_generation,
      pickup_pass_expires_at_ms, pickup_pass_consumed_at_ms,
      pickup_pass_salt, pickup_pass_digest FROM claims`).all(),
    events: database.prepare("SELECT claim_id, event_type, actor_id, result FROM claim_events").all(),
    idempotency: database.prepare("SELECT action, result_json FROM idempotency_records ORDER BY action").all(),
  };
}

const ISSUE_FAILURES = {
  claim: `CREATE TRIGGER fail_issue_claim BEFORE UPDATE ON claims
    WHEN NEW.status = 'PICKUP_READY' BEGIN SELECT RAISE(ABORT, 'issue claim'); END`,
  event: `CREATE TRIGGER fail_issue_event BEFORE INSERT ON claim_events
    WHEN NEW.event_type = 'PASS_ISSUED' BEGIN SELECT RAISE(ABORT, 'issue event'); END`,
  idempotency: `CREATE TRIGGER fail_issue_idempotency BEFORE INSERT ON idempotency_records
    WHEN NEW.action = 'pickup_issue' BEGIN SELECT RAISE(ABORT, 'issue idempotency'); END`,
} as const;

const HANDOFF_FAILURES = {
  claim: `CREATE TRIGGER fail_handoff_claim BEFORE UPDATE ON claims
    WHEN NEW.status = 'COLLECTED' BEGIN SELECT RAISE(ABORT, 'handoff claim'); END`,
  item: `CREATE TRIGGER fail_handoff_item BEFORE UPDATE ON found_items
    WHEN NEW.status = 'RETURNED' BEGIN SELECT RAISE(ABORT, 'handoff item'); END`,
  item_ignore: `CREATE TRIGGER ignore_handoff_item BEFORE UPDATE ON found_items
    WHEN NEW.status = 'RETURNED' BEGIN SELECT RAISE(IGNORE); END`,
  report: `CREATE TRIGGER fail_handoff_report BEFORE UPDATE ON lost_reports
    WHEN NEW.status = 'RESOLVED' BEGIN SELECT RAISE(ABORT, 'handoff report'); END`,
  catalog: `CREATE TRIGGER fail_handoff_catalog BEFORE UPDATE OF catalog_version ON demo_instances
    BEGIN SELECT RAISE(ABORT, 'handoff catalog'); END`,
  event: `CREATE TRIGGER fail_handoff_event BEFORE INSERT ON claim_events
    WHEN NEW.event_type = 'HANDOFF_COMPLETED' BEGIN SELECT RAISE(ABORT, 'handoff event'); END`,
  idempotency: `CREATE TRIGGER fail_handoff_idempotency BEFORE INSERT ON idempotency_records
    WHEN NEW.action = 'handoff' BEGIN SELECT RAISE(ABORT, 'handoff idempotency'); END`,
} as const;

describe("pickup aggregate rollback", () => {
  it.each(Object.entries(ISSUE_FAILURES))("rolls issuance back after injected %s", (name, sql) => {
    const value = setup();
    const before = snapshot();
    testDatabase!.database.exec(sql);
    expect(() => value.service.issue(value.claimant, "claim-rollback-pickup", {
      expectedClaimVersion: 5, idempotencyKey: `pickup-rollback-${name}`,
    })).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it.each(Object.entries(HANDOFF_FAILURES))("rolls handoff back after injected %s", (name, sql) => {
    const value = setup(true);
    const before = snapshot();
    testDatabase!.database.exec(sql);
    expect(() => value.service.handoff(value.staff, "claim-rollback-pickup", {
      token: value.token!, expectedClaimVersion: 6, expectedItemVersion: 4,
      expectedReportVersion: 3, expectedGeneration: 1,
      idempotencyKey: `handoff-rollback-${name}`,
    })).toThrow();
    expect(snapshot()).toEqual(before);
  });
});
