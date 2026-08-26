import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("digest-only SQLite 约束", () => {
  it("evidence slots 只接受成对的 32-byte BLOB", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const insert = database.prepare(`
      INSERT INTO item_evidence_slots (demo_instance_id, found_item_id, slot, salt, digest)
      VALUES (?, ?, 'unique_mark', ?, ?)
    `);
    const valid = Buffer.alloc(32, 1);
    expect(() => insert.run(instance.demoInstanceId, item.inventoryItemId, valid, valid)).not.toThrow();
    database.prepare("DELETE FROM item_evidence_slots").run();
    for (const [salt, digest] of [
      ["x".repeat(32), "y".repeat(32)],
      [Buffer.alloc(31), Buffer.alloc(32)],
      [Buffer.alloc(32), Buffer.alloc(33)],
      [Buffer.alloc(32), null],
      [null, Buffer.alloc(32)],
    ]) {
      expect(() => insert.run(instance.demoInstanceId, item.inventoryItemId, salt, digest)).toThrow();
    }
  });

  it("pickup digest/expiry/generation 必须成组且类型、范围一致", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const report = repository.createLostReport({
      demoInstanceId: instance.demoInstanceId,
      ownerActorId: "claimant-demo",
      category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library",
      color: "black",
      publicTags: ["wireless"],
      publicDescription: "Black earbud case.",
    });
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    repository.publishLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: report.version,
      actorId: "claimant-demo",
    });
    const claim = repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    });
    const update = database.prepare(`
      UPDATE claims SET pickup_pass_salt = ?, pickup_pass_digest = ?,
        pickup_pass_expires_at_ms = ?, pass_generation = ?
      WHERE demo_instance_id = ? AND id = ?
    `);
    const valid = Buffer.alloc(32, 2);
    expect(() => update.run(valid, valid, BigInt("1800000000000"), 1, instance.demoInstanceId, claim.claimId))
      .not.toThrow();
    expect(database.prepare(`
      SELECT typeof(pass_generation) AS generationType FROM claims
      WHERE demo_instance_id = ? AND id = ?
    `).get(instance.demoInstanceId, claim.claimId)).toEqual({ generationType: "integer" });
    database.prepare(`
      UPDATE claims SET pickup_pass_salt=NULL, pickup_pass_digest=NULL,
        pickup_pass_expires_at_ms=NULL, pass_generation=0
    `).run();
    for (const values of [
      ["x".repeat(32), "y".repeat(32), 1_800_000_000_000, 1],
      [Buffer.alloc(31), valid, 1_800_000_000_000, 1],
      [valid, valid, "1800000000000", 1],
      [valid, valid, -1, 1],
      [valid, valid, 1_800_000_000_000, 0],
      [valid, valid, BigInt("1800000000000"), "abc"],
      [valid, valid, BigInt("1800000000000"), 1.5],
      [valid, valid, BigInt("1800000000000"), -1],
      [valid, valid, BigInt("1800000000000"), BigInt("9007199254740992")],
      [null, null, null, 1],
      [null, null, null, "abc"],
    ]) {
      expect(() => update.run(...values, instance.demoInstanceId, claim.claimId)).toThrow();
    }
  });

  it("metadata、idempotency 和 nonce digest 拒绝 TEXT 伪装及非 32-byte BLOB", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    expect(() => database.prepare(
      "UPDATE database_metadata SET key_check_authenticator = ?",
    ).run("x".repeat(32))).toThrow();
    expect(() => database.prepare(`
      INSERT INTO consumed_action_nonces (demo_instance_id, nonce_digest, action, consumed_at_ms)
      VALUES (?, ?, 'claim_approve', 1)
    `).run(instance.demoInstanceId, "x".repeat(32))).toThrow();
    expect(() => database.prepare(`
      INSERT INTO idempotency_records (
        demo_instance_id, actor_id, action, key_digest,
        request_fingerprint_digest, result_json, created_at_ms
      ) VALUES (?, 'claimant-demo', 'draft_create', ?, ?, '{}', 1)
    `).run(instance.demoInstanceId, "x".repeat(32), Buffer.alloc(32))).toThrow();
  });
});
