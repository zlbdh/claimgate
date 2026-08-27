import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { initializeDatabase } from "./migrate";
import { TEST_MASTER_KEY } from "./test-harness";

const V5_SCHEMA = readFileSync(resolve("src/server/db/fixtures/schema-v5.sql"), "utf8");
const V5_FIXTURE_SHA256 = "089ea0d1637093769d87d734bd7c6980ec81a9aef986d067a77d907434f60a49";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function authenticatorInput(version: number, uuid: string, salt: Buffer): Buffer {
  const uuidBytes = Buffer.from(uuid);
  const versionBytes = Buffer.alloc(4);
  const uuidLength = Buffer.alloc(4);
  const saltLength = Buffer.alloc(4);
  versionBytes.writeUInt32BE(version);
  uuidLength.writeUInt32BE(uuidBytes.length);
  saltLength.writeUInt32BE(salt.length);
  return Buffer.concat([versionBytes, uuidLength, uuidBytes, saltLength, salt]);
}

function authenticator(version: number, uuid: string, salt: Buffer, key = TEST_MASTER_KEY) {
  return createHmac("sha256", createKeyring(key).getKey("database-key-check"))
    .update(authenticatorInput(version, uuid, salt)).digest();
}

function createV5Database(options: {
  invalidPass?: boolean;
  injectFailure?: boolean;
  metadataVersion?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-v5-v6-"));
  directories.push(directory);
  const databasePath = join(directory, "v5.sqlite");
  const databaseUuid = randomUUID();
  const salt = Buffer.alloc(32, 61);
  const version = options.metadataVersion ?? 5;
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.exec(V5_SCHEMA);
  database.prepare(`
    INSERT INTO database_metadata (
      singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
    ) VALUES (1, ?, ?, ?, ?)
  `).run(version, databaseUuid, salt, authenticator(version, databaseUuid, salt));
  database.exec(`
    INSERT INTO demo_instances (id, created_at_ms, expires_at_ms, catalog_version)
    VALUES ('demo-v5-v6', 1, 7200001, 7);
    INSERT INTO found_items (
      demo_instance_id, id, category, found_at, area, color,
      public_tags_json, public_description, status, version
    ) VALUES ('demo-v5-v6', 'item-v5-v6', 'earbuds', '2026-08-25', 'library', 'black',
      '["legacy"]', 'preserved item', 'AVAILABLE', 3);
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to, area,
      color, public_tags_json, public_description, status, version
    ) VALUES ('demo-v5-v6', 'report-v5-v6', 'claimant-demo', 'earbuds', 'a', 'b',
      'library', 'black', '["legacy"]', 'preserved report', 'PUBLISHED', 2);
    INSERT INTO claims (
      demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
      status, attempts, evidence_eligible, pickup_pass_salt, pickup_pass_digest,
      pickup_pass_expires_at_ms, pass_generation, version
    ) VALUES ('demo-v5-v6', 'claim-v5-v6', 'report-v5-v6', 'item-v5-v6', 'claimant-demo',
      'EVIDENCE_REQUIRED', 0, 0,
      ${options.invalidPass ? "randomblob(32), randomblob(32), 1000, 1" : "NULL, NULL, NULL, 0"}, 4);
    INSERT INTO idempotency_records (
      demo_instance_id, actor_id, action, key_digest, request_fingerprint_digest,
      result_json, created_at_ms
    ) VALUES ('demo-v5-v6', 'claimant-demo', 'draft_create', zeroblob(32), randomblob(32),
      '{"kind":"report_ack","reportId":"report-v5-v6","status":"DRAFT","version":1}', 10);
    INSERT INTO claim_events (
      demo_instance_id, id, claim_id, event_type, actor_id, result, occurred_at_ms
    ) VALUES ('demo-v5-v6', 'event-v5-v6', 'claim-v5-v6', 'EVIDENCE_INSUFFICIENT',
      'claimant-demo', 'INSUFFICIENT', 11);
  `);
  if (options.injectFailure) database.exec(`
    CREATE TRIGGER fail_v6_authenticator BEFORE UPDATE OF schema_version ON database_metadata
    WHEN NEW.schema_version = 6 BEGIN SELECT RAISE(ABORT, 'injected v6 final failure'); END;
  `);
  database.close();
  return { databasePath, databaseUuid, salt };
}

function inspectLegacy(path: string) {
  const database = new Database(path, { readonly: true });
  const version = database.prepare(
    "SELECT schema_version AS version FROM database_metadata WHERE singleton_id = 1",
  ).get();
  const columns = (database.pragma("table_info(claims)") as Array<{ name: string }>).map(({ name }) => name);
  const idempotencySql = (database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_records'
  `).get() as { sql: string }).sql;
  database.close();
  return { version, columns, idempotencySql };
}

describe("database schema v5 to v6 exact migration", () => {
  it("pins the exact reviewed v5 fixture bytes", () => {
    expect(createHash("sha256").update(V5_SCHEMA).digest("hex")).toBe(V5_FIXTURE_SHA256);
    expect(V5_SCHEMA).not.toContain("pickup_pass_consumed_at_ms");
    expect(V5_SCHEMA).not.toContain("PASS_ISSUED");
  });

  it("preserves supported rows, UUID, salt, indexes, events and idempotency", () => {
    const legacy = createV5Database();
    const database = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    expect(database.prepare(`
      SELECT schema_version AS schemaVersion, database_uuid AS databaseUuid,
        key_check_salt AS keyCheckSalt FROM database_metadata WHERE singleton_id = 1
    `).get()).toMatchObject({ schemaVersion: 6, databaseUuid: legacy.databaseUuid, keyCheckSalt: legacy.salt });
    expect(database.prepare(`
      SELECT status, pass_generation AS generation, pickup_pass_consumed_at_ms AS consumedAt
      FROM claims
    `).get()).toEqual({ status: "EVIDENCE_REQUIRED", generation: 0, consumedAt: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM claim_events").get())
      .toEqual({ count: 1 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
    initializeDatabase({ databasePath: legacy.databasePath, keyring: createKeyring(TEST_MASTER_KEY) }).close();
  });

  it.each([
    ["invalid legacy pass", { invalidPass: true }],
    ["injected final write", { injectFailure: true }],
    ["unknown version", { metadataVersion: 99 }],
  ])("rolls back DDL, data and authenticator for %s", (_name, options) => {
    const legacy = createV5Database(options);
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath, keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    const inspected = inspectLegacy(legacy.databasePath);
    expect(inspected.version).toEqual({
      version: "metadataVersion" in options ? options.metadataVersion : 5,
    });
    expect(inspected.columns).not.toContain("pickup_pass_consumed_at_ms");
    expect(inspected.idempotencySql).not.toContain("pickup_issue");
  });

  it("rejects a wrong key without touching v5", () => {
    const legacy = createV5Database();
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 99).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(inspectLegacy(legacy.databasePath).version).toEqual({ version: 5 });
  });
});
