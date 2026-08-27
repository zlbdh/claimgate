import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { createEvidenceDigester } from "@/features/evidence/evidence-digester";
import { createRepository } from "./repository";
import { initializeDatabase } from "./migrate";
import { TEST_MASTER_KEY } from "./test-harness";

const V1_SCHEMA = readFileSync(resolve("src/server/db/fixtures/schema-v1.sql"), "utf8");
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

function createV1Database(injectMigrationFailure = false) {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-v1-"));
  directories.push(directory);
  const databasePath = join(directory, "v1.sqlite");
  const databaseUuid = randomUUID();
  const salt = Buffer.alloc(32, 23);
  const keyring = createKeyring(TEST_MASTER_KEY);
  const authenticator = createHmac("sha256", keyring.getKey("database-key-check"))
    .update(authenticatorInput(1, databaseUuid, salt))
    .digest();
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.exec(V1_SCHEMA);
  database.prepare(`
    INSERT INTO database_metadata (
      singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
    ) VALUES (1, 1, ?, ?, ?)
  `).run(databaseUuid, salt, authenticator);
  database.prepare(`
    INSERT INTO demo_instances (id, created_at_ms, expires_at_ms, catalog_version)
    VALUES ('legacy-demo', 1, 7200001, 1)
  `).run();
  database.prepare(`
    INSERT INTO found_items (
      demo_instance_id, id, category, found_at, area, color,
      public_tags_json, public_description, status, version
    ) VALUES ('legacy-demo', 'legacy-internal-item', 'earbuds', '2026-08-25',
      'library', 'black', '["legacy"]', 'legacy row', 'AVAILABLE', 1)
  `).run();
  database.prepare(`
    INSERT INTO audit_events (
      demo_instance_id, id, resource_type, resource_public_id,
      action, actor_id, result, occurred_at_ms
    ) VALUES ('legacy-demo', 'legacy-audit', 'INSTANCE', 'legacy-demo',
      'DEMO_CREATED', 'system', 'SUCCEEDED', 1)
  `).run();
  if (injectMigrationFailure) {
    database.exec(`
      CREATE VIEW rate_limit_high_water AS
      SELECT id AS demo_instance_id FROM demo_instances;
    `);
  }
  database.close();
  return { databasePath, databaseUuid, salt };
}

describe("数据库 schema v1 到 v5 升级", () => {
  it("验证 v1 密钥后原子重建业务表，保留数据库身份并失效旧 demo", () => {
    const legacy = createV1Database();
    const database = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    const metadata = database.prepare(`
      SELECT schema_version AS schemaVersion, database_uuid AS databaseUuid,
        key_check_salt AS keyCheckSalt
      FROM database_metadata WHERE singleton_id = 1
    `).get() as { schemaVersion: number; databaseUuid: string; keyCheckSalt: Buffer };
    expect(metadata).toMatchObject({ schemaVersion: 5, databaseUuid: legacy.databaseUuid });
    expect(metadata.keyCheckSalt.equals(legacy.salt)).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get()).toEqual({ count: 0 });
    const auditColumns = database.pragma("table_info(audit_events)") as Array<{ name: string }>;
    expect(auditColumns.map(({ name }) => name)).toContain("report_id");
    expect(auditColumns.map(({ name }) => name)).not.toContain("resource_public_id");
    expect(database.prepare(`
      SELECT type FROM sqlite_master WHERE name = 'rate_limit_high_water'
    `).get()).toEqual({ type: "table" });
    expect(database.pragma("foreign_key_check")).toEqual([]);

    const repository = createRepository({
      database,
      now: () => 10_000_000,
      evidenceDigester: createEvidenceDigester(createKeyring(TEST_MASTER_KEY).getKey("evidence")),
      randomBytes,
    });
    expect(repository.createDemoInstance().catalogVersion).toBe(1);
    database.close();

    const reopened = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    reopened.close();
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 91).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it("迁移末端失败时回滚 DDL、旧业务行和 v1 metadata", () => {
    const legacy = createV1Database(true);
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));

    const database = new Database(legacy.databasePath, { readonly: true });
    expect(database.prepare("SELECT schema_version AS schemaVersion FROM database_metadata").get())
      .toEqual({ schemaVersion: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get()).toEqual({ count: 1 });
    const auditColumns = database.pragma("table_info(audit_events)") as Array<{ name: string }>;
    expect(auditColumns.map(({ name }) => name)).toContain("resource_public_id");
    expect(auditColumns.map(({ name }) => name)).not.toContain("report_id");
    database.close();
  });
});
