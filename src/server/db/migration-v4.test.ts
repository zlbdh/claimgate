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

const V3_SCHEMA = readFileSync(resolve("src/server/db/fixtures/schema-v3.sql"), "utf8");
const V3_FIXTURE_SHA256 = "3380784f57135ce58b596f50ca3e9def349ac36a9d4b32463db6ed907ceceba6";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function authenticatorInput(version: number, databaseUuid: string, salt: Buffer): Buffer {
  const uuid = Buffer.from(databaseUuid, "utf8");
  const versionBytes = Buffer.alloc(4);
  const uuidLength = Buffer.alloc(4);
  const saltLength = Buffer.alloc(4);
  versionBytes.writeUInt32BE(version);
  uuidLength.writeUInt32BE(uuid.length);
  saltLength.writeUInt32BE(salt.length);
  return Buffer.concat([versionBytes, uuidLength, uuid, saltLength, salt]);
}

function createV3Database(options: { nonNullEvidence?: boolean; injectFailure?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-v3-"));
  directories.push(directory);
  const databasePath = join(directory, "v3.sqlite");
  const databaseUuid = randomUUID();
  const salt = Buffer.alloc(32, 37);
  const keyring = createKeyring(TEST_MASTER_KEY);
  const authenticator = createHmac("sha256", keyring.getKey("database-key-check"))
    .update(authenticatorInput(3, databaseUuid, salt))
    .digest();
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.exec(V3_SCHEMA);
  database.prepare(`
    INSERT INTO database_metadata (
      singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
    ) VALUES (1, 3, ?, ?, ?)
  `).run(databaseUuid, salt, authenticator);
  database.exec(`
    INSERT INTO demo_instances (id, created_at_ms, expires_at_ms, catalog_version)
    VALUES ('demo-v3', 1, 7200001, 9);
    INSERT INTO found_items (
      demo_instance_id, id, category, found_at, area, color,
      public_tags_json, public_description, status, version
    ) VALUES ('demo-v3', 'item-v3', 'earbuds', '2026-08-25', 'library', 'black',
      '["legacy"]', 'kept v3 item', 'AVAILABLE', 3);
    INSERT INTO application_rate_limit_buckets (
      scope, action, window_start_ms, request_count
    ) VALUES ('public-demo-entry', 'demo_start', 0, 2);
    INSERT INTO application_rate_limit_high_water (
      scope, action, high_water_time_ms, limit_value, window_ms
    ) VALUES ('public-demo-entry', 'demo_start', 10, 30, 60000);
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to, area,
      color, public_tags_json, public_description, status, version
    ) VALUES ('demo-v3', 'report-v3', 'claimant-demo', 'earbuds', '2026-08-25T01:00:00Z',
      '2026-08-25T02:00:00Z', 'library', 'black', '["legacy"]', 'kept report', 'PUBLISHED', 2);
    INSERT INTO claims (
      demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
      status, attempts, evidence_eligible, pass_generation, version
    ) VALUES ('demo-v3', 'claim-v3', 'report-v3', 'item-v3', 'claimant-demo',
      'EVIDENCE_REQUIRED', 0, 1, 0, 4);
    INSERT INTO audit_events (
      demo_instance_id, id, resource_type, report_id, claim_id,
      action, actor_id, result, occurred_at_ms
    ) VALUES ('demo-v3', 'audit-v3', 'REPORT', 'report-v3', NULL,
      'REPORT_CREATED', 'claimant-demo', 'SUCCEEDED', 10);
    INSERT INTO idempotency_records (
      demo_instance_id, actor_id, action, key_digest, request_fingerprint_digest,
      result_json, created_at_ms
    ) VALUES ('demo-v3', 'claimant-demo', 'draft_create', zeroblob(32), randomblob(32),
      '{"kind":"report_ack","reportId":"report-v3","status":"DRAFT","version":1}', 10);
    INSERT INTO rate_limit_buckets (
      demo_instance_id, actor_id, action, window_start_ms, request_count
    ) VALUES ('demo-v3', 'claimant-demo', 'role_switch', 0, 2);
    INSERT INTO rate_limit_high_water (
      demo_instance_id, actor_id, action, high_water_time_ms, limit_value, window_ms
    ) VALUES ('demo-v3', 'claimant-demo', 'role_switch', 10, 10, 60000);
    INSERT INTO consumed_action_nonces (
      demo_instance_id, nonce_digest, action, consumed_at_ms
    ) VALUES ('demo-v3', randomblob(32), 'role_switch', 10);
  `);
  const insertSlot = database.prepare(`
    INSERT INTO item_evidence_slots (demo_instance_id, found_item_id, slot, salt, digest)
    VALUES ('demo-v3', 'item-v3', ?, ?, ?)
  `);
  for (const slot of ["unique_mark", "contents_or_accessory", "identifier_suffix"]) {
    insertSlot.run(
      slot,
      options.nonNullEvidence ? Buffer.alloc(32, 1) : null,
      options.nonNullEvidence ? Buffer.alloc(32, 2) : null,
    );
  }
  if (options.injectFailure) {
    database.exec(`
      CREATE TRIGGER fail_v4_authenticator
      BEFORE UPDATE OF schema_version ON database_metadata
      WHEN NEW.schema_version = 4
      BEGIN SELECT RAISE(ABORT, 'injected v4 failure'); END;
    `);
  }
  const before = Object.fromEntries([
    "demo_instances", "found_items", "item_evidence_slots", "lost_reports", "claims",
    "audit_events", "idempotency_records", "rate_limit_buckets", "rate_limit_high_water",
    "consumed_action_nonces", "application_rate_limit_buckets", "application_rate_limit_high_water",
  ].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()]));
  database.close();
  return { databasePath, databaseUuid, salt, before };
}

function evidenceTableSql(database: Database.Database): string {
  return (database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'item_evidence_slots'
  `).get() as { sql: string }).sql;
}

describe("数据库 schema v3 到 v4 evidence rebuild", () => {
  it("固定 v3 fixture blob，避免测试随 current schema 漂移", () => {
    expect(createHash("sha256").update(V3_SCHEMA).digest("hex")).toBe(V3_FIXTURE_SHA256);
    expect(V3_SCHEMA).toContain("length(salt) = 32");
    expect(V3_SCHEMA).not.toContain("application evidence v4");
  });

  it("原子保留 v3 业务/global limiter/UUID/salt，并重建 16-byte evidence schema", () => {
    const legacy = createV3Database();
    const database = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    const metadata = database.prepare(`
      SELECT schema_version AS schemaVersion, database_uuid AS databaseUuid,
        key_check_salt AS keyCheckSalt FROM database_metadata WHERE singleton_id = 1
    `).get() as { schemaVersion: number; databaseUuid: string; keyCheckSalt: Buffer };
    expect(metadata).toMatchObject({ schemaVersion: 4, databaseUuid: legacy.databaseUuid });
    expect(metadata.keyCheckSalt).toEqual(legacy.salt);
    expect(database.prepare("SELECT id, catalog_version FROM demo_instances").get())
      .toEqual({ id: "demo-v3", catalog_version: 9 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM item_evidence_slots").get())
      .toEqual({ count: 3 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM item_evidence_slots WHERE salt IS NULL AND digest IS NULL
    `).get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT request_count FROM application_rate_limit_buckets").get())
      .toEqual({ request_count: 2 });
    for (const [table, count] of Object.entries(legacy.before)) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual(count);
    }
    expect(evidenceTableSql(database)).toContain("length(salt) = 16");
    expect(database.prepare(`
      SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'item_evidence_slots_item_idx'
    `).get()).toEqual({ tbl_name: "item_evidence_slots" });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();

    const reopened = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    reopened.close();
  });

  it("v3 非空 legacy digest fail closed，不猜测 32→16 salt 迁移", () => {
    const legacy = createV3Database({ nonNullEvidence: true });
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    const database = new Database(legacy.databasePath, { readonly: true });
    expect(database.prepare("SELECT schema_version AS version FROM database_metadata").get())
      .toEqual({ version: 3 });
    expect(evidenceTableSql(database)).toContain("length(salt) = 32");
    expect(database.prepare("SELECT COUNT(*) AS count FROM item_evidence_slots").get())
      .toEqual({ count: 3 });
    database.close();
  });

  it("错钥或末端注入失败回滚 DDL、行、version 与 authenticator", () => {
    const wrongKey = createV3Database();
    expect(() => initializeDatabase({
      databasePath: wrongKey.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 99).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    const injected = createV3Database({ injectFailure: true });
    expect(() => initializeDatabase({
      databasePath: injected.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    for (const path of [wrongKey.databasePath, injected.databasePath]) {
      const database = new Database(path, { readonly: true });
      expect(database.prepare("SELECT schema_version AS version FROM database_metadata").get())
        .toEqual({ version: 3 });
      expect(evidenceTableSql(database)).toContain("length(salt) = 32");
      expect(database.prepare("SELECT COUNT(*) AS count FROM item_evidence_slots").get())
        .toEqual({ count: 3 });
      database.close();
    }
  });
});
