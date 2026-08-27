import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createClaimService } from "@/features/claims/claim-service";
import { createKeyring } from "@/server/security/keyring";
import { createTestDatabase, type TestDatabase } from "./test-harness";

const NOW = Date.UTC(2026, 7, 26, 12);
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function createClaim(instanceId: string, itemId: string, suffix: string) {
  const repository = testDatabase!.repository;
  const report = repository.createLostReport({
    demoInstanceId: instanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: { from: `from-${suffix}`, to: `to-${suffix}` },
    area: "library",
    color: "black",
    publicTags: [],
    publicDescription: `rollback report ${suffix}`,
  });
  repository.publishLostReport({
    demoInstanceId: instanceId,
    reportId: report.reportId,
    expectedVersion: report.version,
    actorId: "claimant-demo",
  });
  return repository.createClaim({
    demoInstanceId: instanceId,
    reportId: report.reportId,
    inventoryItemId: itemId,
    claimantActorId: "claimant-demo",
  });
}

function setup() {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const item = testDatabase.repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
  const stagedWinner = createClaim(instance.demoInstanceId, item.inventoryItemId, "winner");
  const loser = createClaim(instance.demoInstanceId, item.inventoryItemId, "loser");
  testDatabase.database.prepare(`
    UPDATE claims SET status = 'UNDER_REVIEW', evidence_eligible = 1, version = version + 1
    WHERE id = ?
  `).run(stagedWinner.claimId);
  const winner = { ...stagedWinner, version: stagedWinner.version + 1 };
  const keyring = createKeyring(Buffer.alloc(32, 7).toString("base64"));
  return {
    instance,
    item,
    winner,
    loser,
    service: createClaimService({ repository: testDatabase.repository, keyring, now: () => NOW }),
    staff: {
      demoInstanceId: instance.demoInstanceId,
      actorId: "staff-demo" as const,
      sessionExpiresAt: instance.expiresAtMs,
    },
  };
}

function snapshot() {
  const database = testDatabase!.database;
  return {
    instance: database.prepare("SELECT id, catalog_version FROM demo_instances ORDER BY id").all(),
    items: database.prepare("SELECT id, status, version FROM found_items ORDER BY id").all(),
    claims: database.prepare(`
      SELECT id, status, attempts, evidence_eligible, reviewer_actor_id,
        rejection_reason, unlock_count, version FROM claims ORDER BY id
    `).all(),
    reports: database.prepare("SELECT id, status, version FROM lost_reports ORDER BY id").all(),
    events: database.prepare("SELECT claim_id, event_type, actor_id, result FROM claim_events ORDER BY id").all(),
    idempotency: database.prepare("SELECT action, result_json FROM idempotency_records ORDER BY action").all(),
  };
}

const INJECTIONS = {
  item: `CREATE TRIGGER injected_item BEFORE UPDATE OF status ON found_items
    WHEN NEW.status = 'HELD' BEGIN SELECT RAISE(ABORT, 'injected item'); END`,
  catalog: `CREATE TRIGGER injected_catalog BEFORE UPDATE OF catalog_version ON demo_instances
    BEGIN SELECT RAISE(ABORT, 'injected catalog'); END`,
  winner: `CREATE TRIGGER injected_winner BEFORE UPDATE OF status ON claims
    WHEN NEW.status = 'APPROVED' BEGIN SELECT RAISE(ABORT, 'injected winner'); END`,
  loser: `CREATE TRIGGER injected_loser BEFORE UPDATE OF rejection_reason ON claims
    WHEN NEW.rejection_reason = 'ITEM_HELD_BY_ANOTHER_CLAIM'
    BEGIN SELECT RAISE(ABORT, 'injected loser'); END`,
  loser_ignore: `CREATE TRIGGER injected_loser_ignore BEFORE UPDATE OF rejection_reason ON claims
    WHEN NEW.rejection_reason = 'ITEM_HELD_BY_ANOTHER_CLAIM'
    BEGIN SELECT RAISE(IGNORE); END`,
  event: `CREATE TRIGGER injected_event BEFORE INSERT ON claim_events
    BEGIN SELECT RAISE(ABORT, 'injected event'); END`,
  event_ignore: `CREATE TRIGGER injected_event_ignore BEFORE INSERT ON claim_events
    BEGIN SELECT RAISE(IGNORE); END`,
  idempotency: `CREATE TRIGGER injected_idempotency BEFORE INSERT ON idempotency_records
    WHEN NEW.action = 'claim_approve' BEGIN SELECT RAISE(ABORT, 'injected idempotency'); END`,
  idempotency_ignore: `CREATE TRIGGER injected_idempotency_ignore BEFORE INSERT ON idempotency_records
    WHEN NEW.action = 'claim_approve' BEGIN SELECT RAISE(IGNORE); END`,
} as const;

describe("claim approval aggregate rollback", () => {
  it.each(Object.entries(INJECTIONS))("rolls back every business row after injected %s failure", (name, sql) => {
    const value = setup();
    const before = snapshot();
    testDatabase!.database.exec(sql);
    expect(() => value.service.approve(value.staff, value.winner.claimId, {
      expectedClaimVersion: value.winner.version,
      expectedItemVersion: value.item.version,
      idempotencyKey: `rollback-approve-${name}`,
    })).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it.each([INJECTIONS.event, INJECTIONS.event_ignore])(
    "rolls back evidence Claim mutation and idempotency when the final event insert fails",
    (injection) => {
    const value = setup();
    const before = snapshot();
    testDatabase!.database.exec(injection);
    expect(() => value.service.submitEvidence({
      demoInstanceId: value.instance.demoInstanceId,
      actorId: "claimant-demo",
      sessionExpiresAt: value.instance.expiresAtMs,
    }, value.loser.claimId, {
      expectedVersion: 1,
      idempotencyKey: "rollback-evidence-event",
      answers: {},
    })).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("rolls back when a trigger creates a new active Claim after the loser snapshot update", () => {
    const value = setup();
    const before = snapshot();
    testDatabase!.database.exec(`
      CREATE TRIGGER injected_active_after_loser
      AFTER UPDATE OF rejection_reason ON claims
      WHEN NEW.rejection_reason = 'ITEM_HELD_BY_ANOTHER_CLAIM'
      BEGIN
        INSERT INTO claims (
          demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
          status, attempts, evidence_eligible, unlock_count, pass_generation, version
        ) VALUES (
          OLD.demo_instance_id, OLD.id || '-active', OLD.report_id, OLD.found_item_id,
          OLD.claimant_actor_id, 'EVIDENCE_REQUIRED', 0, 0, OLD.unlock_count, 0, 1
        );
      END;
    `);
    expect(() => value.service.approve(value.staff, value.winner.claimId, {
      expectedClaimVersion: value.winner.version,
      expectedItemVersion: value.item.version,
      idempotencyKey: "rollback-final-active",
    })).toThrow();
    expect(snapshot()).toEqual(before);
  });
});
