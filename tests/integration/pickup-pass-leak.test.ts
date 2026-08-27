import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import { createKeyring } from "@/server/security/keyring";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "@/server/db/test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
  vi.restoreAllMocks();
});

function contains(value: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (Buffer.isBuffer(value)) return value.includes(Buffer.from(needle));
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => contains(key, needle, seen)
    || contains(Reflect.get(value, key), needle, seen));
}

describe("pickup pass raw token leak canary", () => {
  it("allows the token only in first issuance/client credential and nowhere durable or safe", () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    testDatabase = createTestDatabase(100_000);
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    database.prepare(`
      INSERT INTO lost_reports (
        demo_instance_id, id, owner_actor_id, category, time_from, time_to,
        area, color, public_tags_json, public_description, status, version
      ) VALUES (?, 'report-leak', 'claimant-demo', 'earbuds', 'a', 'b',
        'library', 'black', '[]', 'leak fixture', 'PUBLISHED', 3)
    `).run(instance.demoInstanceId);
    database.prepare(`UPDATE found_items SET status = 'HELD', version = 4
      WHERE demo_instance_id = ? AND id = ?`).run(instance.demoInstanceId, item.inventoryItemId);
    database.prepare(`
      INSERT INTO claims (
        demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
        status, attempts, evidence_eligible, reviewer_actor_id,
        rejection_reason, unlock_count, pass_generation, version
      ) VALUES (?, 'claim-leak', 'report-leak', ?, 'claimant-demo',
        'APPROVED', 1, 1, 'staff-demo', NULL, 0, 0, 5)
    `).run(instance.demoInstanceId, item.inventoryItemId);
    let sequence = 0;
    const service = createPickupPassService({
      repository, keyring: createKeyring(TEST_MASTER_KEY), now: () => 100_000,
      randomBytes: (size) => Buffer.alloc(size, ++sequence),
    });
    const claimant = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo" as const,
      sessionExpiresAt: instance.expiresAtMs,
    };
    const staff = { ...claimant, actorId: "staff-demo" as const };
    const first = service.issue(claimant, "claim-leak", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-leak-first-key",
    });
    if (first.issuance !== "ISSUED") throw new Error("expected first issuance");
    const token = first.token;
    const replay = service.issue(claimant, "claim-leak", {
      expectedClaimVersion: 5, idempotencyKey: "pickup-leak-first-key",
    });
    const instructions = service.getInstructions(claimant, "claim-leak");
    const timeline = repository.listClaimTimeline(instance.demoInstanceId, "claim-leak", 50);

    const tables = (database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all() as Array<{ name: string }>).map(({ name }) => ({
      name, rows: database.prepare(`SELECT * FROM "${name}"`).all(),
    }));
    expect(contains(tables, token)).toBe(false);
    expect(contains([replay, instructions, timeline, logs.mock.calls, errors.mock.calls], token)).toBe(false);
    expect(JSON.stringify(first).match(new RegExp(token, "g"))).toHaveLength(1);

    const handoff = service.handoff(staff, "claim-leak", {
      token, expectedClaimVersion: 6, expectedItemVersion: 4,
      expectedReportVersion: 3, expectedGeneration: 1,
      idempotencyKey: "pickup-leak-handoff-key",
    });
    const after = (database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>).map(({ name }) => database.prepare(`SELECT * FROM "${name}"`).all());
    expect(handoff).not.toHaveProperty("token");
    expect(contains(after, token)).toBe(false);
    expect(contains([logs.mock.calls, errors.mock.calls], token)).toBe(false);
  });
});
