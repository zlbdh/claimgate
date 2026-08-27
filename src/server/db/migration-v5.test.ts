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

const V4_SCHEMA = readFileSync(resolve("src/server/db/fixtures/schema-v4.sql"), "utf8");
const V4_FIXTURE_SHA256 = "c1875b8e1b08d8aa5b7b216fe53b291d54c291bdbe1f72655df34d3b83440feb";
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

function makeAuthenticator(version: number, databaseUuid: string, salt: Buffer, key = TEST_MASTER_KEY) {
  return createHmac("sha256", createKeyring(key).getKey("database-key-check"))
    .update(authenticatorInput(version, databaseUuid, salt))
    .digest();
}

function createV4Database(options: {
  invalidClaim?: boolean;
  injectFailure?: boolean;
  metadataVersion?: number;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-v4-v5-"));
  directories.push(directory);
  const databasePath = join(directory, "v4.sqlite");
  const databaseUuid = randomUUID();
  const salt = Buffer.alloc(32, 55);
  const version = options.metadataVersion ?? 4;
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.exec(V4_SCHEMA);
  database.prepare(`
    INSERT INTO database_metadata (
      singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
    ) VALUES (1, ?, ?, ?, ?)
  `).run(version, databaseUuid, salt, makeAuthenticator(version, databaseUuid, salt));
  database.exec(`
    INSERT INTO demo_instances (id, created_at_ms, expires_at_ms, catalog_version)
    VALUES ('demo-v4-v5', 1, 7200001, 7);
    INSERT INTO found_items (
      demo_instance_id, id, category, found_at, area, color,
      public_tags_json, public_description, status, version
    ) VALUES ('demo-v4-v5', 'item-v4-v5', 'earbuds', '2026-08-25', 'library', 'black',
      '["legacy"]', 'preserved item', 'AVAILABLE', 3);
    INSERT INTO lost_reports (
      demo_instance_id, id, owner_actor_id, category, time_from, time_to, area,
      color, public_tags_json, public_description, status, version
    ) VALUES ('demo-v4-v5', 'report-v4-v5', 'claimant-demo', 'earbuds', 'a', 'b',
      'library', 'black', '["legacy"]', 'preserved report', 'PUBLISHED', 2);
    INSERT INTO claims (
      demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
      status, attempts, evidence_eligible, pass_generation, version
    ) VALUES ('demo-v4-v5', 'claim-v4-v5', 'report-v4-v5', 'item-v4-v5', 'claimant-demo',
      'EVIDENCE_REQUIRED', 0, ${options.invalidClaim ? 1 : 0}, 0, 4);
    INSERT INTO idempotency_records (
      demo_instance_id, actor_id, action, key_digest, request_fingerprint_digest,
      result_json, created_at_ms
    ) VALUES ('demo-v4-v5', 'claimant-demo', 'draft_create', zeroblob(32), randomblob(32),
      '{"kind":"report_ack","reportId":"report-v4-v5","status":"DRAFT","version":1}', 10);
    INSERT INTO application_rate_limit_buckets (
      scope, action, window_start_ms, request_count
    ) VALUES ('public-demo-entry', 'demo_start', 0, 2);
  `);
  if (options.injectFailure) {
    database.exec(`
      CREATE TRIGGER fail_v5_authenticator
      BEFORE UPDATE OF schema_version ON database_metadata
      WHEN NEW.schema_version = 5
      BEGIN SELECT RAISE(ABORT, 'injected v5 final failure'); END;
    `);
  }
  database.close();
  return { databasePath, databaseUuid, salt };
}

function inspectLegacy(path: string) {
  const database = new Database(path, { readonly: true });
  const version = database.prepare(
    "SELECT schema_version AS version FROM database_metadata WHERE singleton_id = 1",
  ).get();
  const columns = database.pragma("table_info(claims)") as Array<{ name: string }>;
  const eventTable = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claim_events'",
  ).get();
  database.close();
  return { version, columns: columns.map(({ name }) => name), eventTable };
}

describe("database schema v4 to v5 exact migration", () => {
  it("pins the exact reviewed v4 fixture bytes", () => {
    expect(createHash("sha256").update(V4_SCHEMA).digest("hex")).toBe(V4_FIXTURE_SHA256);
    expect(V4_SCHEMA).not.toContain("claim_events");
    expect(V4_SCHEMA).toContain("claims_single_approved_item_idx");
  });

  it("preserves supported business/global rows and rebuilds idempotency atomically", () => {
    const legacy = createV4Database();
    const database = initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    expect(database.prepare(`
      SELECT schema_version AS schemaVersion, database_uuid AS databaseUuid,
        key_check_salt AS keyCheckSalt FROM database_metadata WHERE singleton_id = 1
    `).get()).toMatchObject({ schemaVersion: 5, databaseUuid: legacy.databaseUuid, keyCheckSalt: legacy.salt });
    expect(database.prepare(`
      SELECT status, attempts, evidence_eligible AS eligible, unlock_count AS unlockCount,
        rejection_reason AS rejectionReason, version FROM claims
    `).get()).toEqual({
      status: "EVIDENCE_REQUIRED", attempts: 0, eligible: 0,
      unlockCount: 0, rejectionReason: null, version: 4,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT request_count FROM application_rate_limit_buckets").get())
      .toEqual({ request_count: 2 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
    initializeDatabase({ databasePath: legacy.databasePath, keyring: createKeyring(TEST_MASTER_KEY) }).close();
  });

  it.each([
    { name: "invalid legacy claim", options: { invalidClaim: true } },
    { name: "injected final write", options: { injectFailure: true } },
    { name: "unknown version", options: { metadataVersion: 99 } },
  ])("rolls back DDL/data/version for $name", ({ options }) => {
    const legacy = createV4Database(options);
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(inspectLegacy(legacy.databasePath)).toEqual({
      version: { version: options.metadataVersion ?? 4 },
      columns: expect.not.arrayContaining(["unlock_count", "rejection_reason"]),
      eventTable: undefined,
    });
  });

  it("rejects a wrong key without touching the v4 database", () => {
    const legacy = createV4Database();
    expect(() => initializeDatabase({
      databasePath: legacy.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 99).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(inspectLegacy(legacy.databasePath).version).toEqual({ version: 4 });
  });
});
