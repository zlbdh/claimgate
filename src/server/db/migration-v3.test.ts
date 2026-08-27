import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { initializeDatabase } from "./migrate";
import { TEST_MASTER_KEY } from "./test-harness";

const V2_SCHEMA = readFileSync(resolve("src/server/db/fixtures/schema-v2.sql"), "utf8");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
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

function createV2Database(injectFailure = false) {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-v2-"));
  directories.push(directory);
  const databasePath = join(directory, "v2.sqlite");
  const databaseUuid = randomUUID();
  const salt = Buffer.alloc(32, 29);
  const keyring = createKeyring(TEST_MASTER_KEY);
  const authenticator = createHmac("sha256", keyring.getKey("database-key-check"))
    .update(authenticatorInput(2, databaseUuid, salt))
    .digest();
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.exec(V2_SCHEMA);
  database.prepare(`
    INSERT INTO database_metadata (
      singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
    ) VALUES (1, 2, ?, ?, ?)
  `).run(databaseUuid, salt, authenticator);
  database.exec(`
    INSERT INTO demo_instances (id, created_at_ms, expires_at_ms, catalog_version)
    VALUES ('demo-v2', 1, 7200001, 7);
    INSERT INTO found_items (
      demo_instance_id, id, category, found_at, area, color,
      public_tags_json, public_description, status, version
    ) VALUES ('demo-v2', 'item-v2', 'earbuds', '2026-08-25', 'library', 'black',
      '["legacy"]', 'kept item', 'AVAILABLE', 3);
    INSERT INTO item_evidence_slots (demo_instance_id, found_item_id, slot)
    VALUES ('demo-v2', 'item-v2', 'unique_mark');
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to, area,
      color, public_tags_json, public_description, status, version
    ) VALUES ('demo-v2', 'report-v2', 'claimant-demo', 'earbuds', '2026-08-25T01:00:00Z',
      '2026-08-25T02:00:00Z', 'library', 'black', '["legacy"]', 'kept report', 'PUBLISHED', 2);
    INSERT INTO claims (
      demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
      status, attempts, evidence_eligible, pass_generation, version
    ) VALUES ('demo-v2', 'claim-v2', 'report-v2', 'item-v2', 'claimant-demo',
      'EVIDENCE_REQUIRED', 0, 0, 0, 4);
    INSERT INTO audit_events (
      demo_instance_id, id, resource_type, report_id, claim_id,
      action, actor_id, result, occurred_at_ms
    ) VALUES ('demo-v2', 'audit-v2', 'REPORT', 'report-v2', NULL,
      'REPORT_CREATED', 'claimant-demo', 'SUCCEEDED', 10);
    INSERT INTO idempotency_records (
      demo_instance_id, actor_id, action, key_digest, request_fingerprint_digest,
      result_json, created_at_ms
    ) VALUES ('demo-v2', 'claimant-demo', 'draft_create', zeroblob(32),
      randomblob(32), '{"kind":"report_ack","reportId":"report-v2","status":"DRAFT","version":1}', 10);
    INSERT INTO rate_limit_buckets (
      demo_instance_id, actor_id, action, window_start_ms, request_count
    ) VALUES ('demo-v2', 'claimant-demo', 'role_switch', 0, 2);
    INSERT INTO rate_limit_high_water (
      demo_instance_id, actor_id, action, high_water_time_ms, limit_value, window_ms
    ) VALUES ('demo-v2', 'claimant-demo', 'role_switch', 10, 10, 60000);
    INSERT INTO consumed_action_nonces (
      demo_instance_id, nonce_digest, action, consumed_at_ms
    ) VALUES ('demo-v2', randomblob(32), 'role_switch', 10);
  `);
  if (injectFailure) {
    database.exec(`
      CREATE TRIGGER fail_v4_authenticator
      BEFORE UPDATE OF schema_version ON database_metadata
      WHEN NEW.schema_version = 5
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;
    `);
  }
  const before = Object.fromEntries([
    "demo_instances", "found_items", "item_evidence_slots", "lost_reports", "claims",
    "audit_events", "idempotency_records", "rate_limit_buckets", "rate_limit_high_water",
    "consumed_action_nonces",
  ].map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()]));
  database.close();
  return { databasePath, databaseUuid, salt, before };
}

describe("数据库 schema v2 到 v5 preserving migration", () => {
  it("验证 v2 authenticator 后保留全部业务行、UUID/salt，仅新增全局 limiter", () => {
    const legacy = createV2Database();
    const database = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    const metadata = database.prepare(`
      SELECT schema_version AS schemaVersion, database_uuid AS databaseUuid,
        key_check_salt AS keyCheckSalt
      FROM database_metadata WHERE singleton_id = 1
    `).get() as { schemaVersion: number; databaseUuid: string; keyCheckSalt: Buffer };
    expect(metadata).toMatchObject({ schemaVersion: 6, databaseUuid: legacy.databaseUuid });
    expect(metadata.keyCheckSalt.equals(legacy.salt)).toBe(true);
    for (const [table, count] of Object.entries(legacy.before)) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual(count);
    }
    expect(database.prepare("SELECT id, catalog_version FROM demo_instances").get())
      .toEqual({ id: "demo-v2", catalog_version: 7 });
    expect(database.prepare(`SELECT type FROM sqlite_master WHERE name = 'application_rate_limit_buckets'`).get())
      .toEqual({ type: "table" });
    expect(database.prepare(`SELECT type FROM sqlite_master WHERE name = 'application_rate_limit_high_water'`).get())
      .toEqual({ type: "table" });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();

    const reopened = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    reopened.close();
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 99).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it("迁移失败回滚新增表、业务行与 v2 metadata", () => {
    const legacy = createV2Database(true);
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));

    const database = new Database(legacy.databasePath, { readonly: true });
    expect(database.prepare("SELECT schema_version AS schemaVersion FROM database_metadata").get())
      .toEqual({ schemaVersion: 2 });
    expect(database.prepare(`SELECT type FROM sqlite_master WHERE name = 'application_rate_limit_buckets'`).get())
      .toBeUndefined();
    expect(database.prepare("SELECT id, catalog_version FROM demo_instances").get())
      .toEqual({ id: "demo-v2", catalog_version: 7 });
    database.close();
  });

  it("v2 错钥与未知版本都 fail closed 且不写入 v4 表", () => {
    const wrongKey = createV2Database();
    expect(() => initializeDatabase({
      databasePath: wrongKey.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 101).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    let database = new Database(wrongKey.databasePath);
    expect(database.prepare("SELECT schema_version AS version FROM database_metadata").get())
      .toEqual({ version: 2 });
    expect(database.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'application_rate_limit_buckets'`).get())
      .toBeUndefined();
    database.close();

    const unknown = createV2Database();
    database = new Database(unknown.databasePath);
    database.prepare("UPDATE database_metadata SET schema_version = 99 WHERE singleton_id = 1").run();
    database.close();
    expect(() => initializeDatabase({
      databasePath: unknown.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    database = new Database(unknown.databasePath, { readonly: true });
    expect(database.prepare("SELECT schema_version AS version FROM database_metadata").get())
      .toEqual({ version: 99 });
    database.close();
  });
});
