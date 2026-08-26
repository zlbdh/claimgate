import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Keyring } from "@/server/security/keyring";
import { DomainError } from "@/shared/domain-error";
import { openDatabaseConnection } from "./connection";

const SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 1;
const PREVIOUS_SCHEMA_VERSION = 2;
const SCHEMA_SQL = readFileSync(join(process.cwd(), "src/server/db/schema.sql"), "utf8");
const APPLICATION_GLOBAL_LIMITER_SQL = `
  CREATE TABLE application_rate_limit_buckets (
    scope TEXT NOT NULL CHECK (scope = 'public-demo-entry'),
    action TEXT NOT NULL CHECK (action = 'demo_start'),
    window_start_ms INTEGER NOT NULL CHECK (
      typeof(window_start_ms) = 'integer' AND window_start_ms >= 0
      AND window_start_ms <= 9007199254740991
    ),
    request_count INTEGER NOT NULL CHECK (
      typeof(request_count) = 'integer' AND request_count >= 1 AND request_count <= 1000
    ),
    PRIMARY KEY (scope, action, window_start_ms)
  );
  CREATE TABLE application_rate_limit_high_water (
    scope TEXT NOT NULL CHECK (scope = 'public-demo-entry'),
    action TEXT NOT NULL CHECK (action = 'demo_start'),
    high_water_time_ms INTEGER NOT NULL CHECK (
      typeof(high_water_time_ms) = 'integer' AND high_water_time_ms >= 0
      AND high_water_time_ms <= 9007199254740991
    ),
    limit_value INTEGER NOT NULL CHECK (
      typeof(limit_value) = 'integer' AND limit_value = 30
    ),
    window_ms INTEGER NOT NULL CHECK (
      typeof(window_ms) = 'integer' AND window_ms = 60000
    ),
    PRIMARY KEY (scope, action)
  );
`;

type MetadataRow = {
  schemaVersion: number;
  databaseUuid: string;
  keyCheckSalt: Buffer;
  keyCheckAuthenticator: Buffer;
};

function metadataExists(database: Database.Database): boolean {
  return database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'database_metadata'
  `).get() !== undefined;
}

function readMetadata(database: Database.Database): MetadataRow | undefined {
  if (!metadataExists(database)) return undefined;
  return database.prepare(`
    SELECT schema_version AS schemaVersion, database_uuid AS databaseUuid,
      key_check_salt AS keyCheckSalt, key_check_authenticator AS keyCheckAuthenticator
    FROM database_metadata WHERE singleton_id = 1
  `).get() as MetadataRow | undefined;
}

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

function makeAuthenticator(keyring: Keyring, version: number, databaseUuid: string, salt: Buffer): Buffer {
  return createHmac("sha256", keyring.getKey("database-key-check"))
    .update(authenticatorInput(version, databaseUuid, salt))
    .digest();
}

function verifyMetadata(
  metadata: MetadataRow | undefined,
  keyring: Keyring,
  expectedVersion: number,
): asserts metadata is MetadataRow {
  if (
    !metadata ||
    metadata.schemaVersion !== expectedVersion ||
    typeof metadata.databaseUuid !== "string" ||
    !Buffer.isBuffer(metadata.keyCheckSalt) ||
    metadata.keyCheckSalt.length !== 32 ||
    !Buffer.isBuffer(metadata.keyCheckAuthenticator) ||
    metadata.keyCheckAuthenticator.length !== 32
  ) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  const expected = makeAuthenticator(
    keyring,
    metadata.schemaVersion,
    metadata.databaseUuid,
    metadata.keyCheckSalt,
  );
  if (!timingSafeEqual(expected, metadata.keyCheckAuthenticator)) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

function assertForeignKeysClean(database: Database.Database): void {
  if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

function dropDisposableBusinessSchema(database: Database.Database): void {
  database.exec(`
    DROP TABLE IF EXISTS consumed_action_nonces;
    DROP TABLE IF EXISTS application_rate_limit_high_water;
    DROP TABLE IF EXISTS application_rate_limit_buckets;
    DROP TABLE IF EXISTS rate_limit_high_water;
    DROP TABLE IF EXISTS rate_limit_buckets;
    DROP TABLE IF EXISTS idempotency_records;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS claims;
    DROP TABLE IF EXISTS lost_reports;
    DROP TABLE IF EXISTS item_evidence_slots;
    DROP TABLE IF EXISTS found_items;
    DROP TABLE IF EXISTS demo_instances;
  `);
}

function migrateV1ToV3(
  database: Database.Database,
  keyring: Keyring,
  metadata: MetadataRow,
): void {
  verifyMetadata(metadata, keyring, LEGACY_SCHEMA_VERSION);
  dropDisposableBusinessSchema(database);
  database.exec("ALTER TABLE database_metadata RENAME TO database_metadata_v1");
  database.exec(SCHEMA_SQL);
  assertForeignKeysClean(database);
  const authenticator = makeAuthenticator(
    keyring,
    SCHEMA_VERSION,
    metadata.databaseUuid,
    metadata.keyCheckSalt,
  );
  database.prepare(`
    INSERT INTO database_metadata (
      singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
    ) VALUES (1, ?, ?, ?, ?)
  `).run(
    SCHEMA_VERSION,
    metadata.databaseUuid,
    metadata.keyCheckSalt,
    authenticator,
  );
  database.exec("DROP TABLE database_metadata_v1");
}

function migrateV2ToV3(
  database: Database.Database,
  keyring: Keyring,
  metadata: MetadataRow,
): void {
  verifyMetadata(metadata, keyring, PREVIOUS_SCHEMA_VERSION);
  database.exec(APPLICATION_GLOBAL_LIMITER_SQL);
  assertForeignKeysClean(database);
  const authenticator = makeAuthenticator(
    keyring,
    SCHEMA_VERSION,
    metadata.databaseUuid,
    metadata.keyCheckSalt,
  );
  database.prepare(`
    UPDATE database_metadata
    SET schema_version = ?, key_check_authenticator = ?
    WHERE singleton_id = 1 AND schema_version = ?
  `).run(SCHEMA_VERSION, authenticator, PREVIOUS_SCHEMA_VERSION);
}

function migrateDatabase(
  database: Database.Database,
  keyring: Keyring,
  allowCreateMetadata: boolean,
): void {
  database.transaction(() => {
    const existing = readMetadata(database);
    if (existing) {
      if (existing.schemaVersion === LEGACY_SCHEMA_VERSION) {
        migrateV1ToV3(database, keyring, existing);
        return;
      }
      if (existing.schemaVersion === PREVIOUS_SCHEMA_VERSION) {
        migrateV2ToV3(database, keyring, existing);
        return;
      }
      verifyMetadata(existing, keyring, SCHEMA_VERSION);
      database.exec(SCHEMA_SQL);
      assertForeignKeysClean(database);
      return;
    }
    if (!allowCreateMetadata) throw new DomainError("CONFIGURATION_ERROR");
    database.exec(SCHEMA_SQL);
    const databaseUuid = randomUUID();
    const salt = randomBytes(32);
    const authenticator = makeAuthenticator(keyring, SCHEMA_VERSION, databaseUuid, salt);
    database.prepare(`
      INSERT INTO database_metadata (
        singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
      ) VALUES (1, ?, ?, ?, ?)
    `).run(SCHEMA_VERSION, databaseUuid, salt, authenticator);
    assertForeignKeysClean(database);
  }).immediate();
}

function waitForInitializer(lockPath: string): void {
  const deadline = Date.now() + 5_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (existsSync(lockPath)) {
    if (Date.now() >= deadline) throw new DomainError("CONFIGURATION_ERROR");
    Atomics.wait(sleeper, 0, 0, 10);
  }
}

export function initializeDatabase(options: {
  databasePath: string;
  keyring: Keyring;
}): Database.Database {
  const lockPath = `${options.databasePath}.initialize.lock`;
  let ownsInitializationLock = false;
  if (!existsSync(options.databasePath)) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      closeSync(descriptor);
      ownsInitializationLock = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new DomainError("CONFIGURATION_ERROR");
      }
      waitForInitializer(lockPath);
    }
  } else if (existsSync(lockPath)) {
    waitForInitializer(lockPath);
  }

  let database: Database.Database | undefined;
  try {
    database = openDatabaseConnection(options.databasePath);
    migrateDatabase(database, options.keyring, ownsInitializationLock);
    assertForeignKeysClean(database);
    return database;
  } catch (error) {
    database?.close();
    if (error instanceof DomainError) throw error;
    throw new DomainError("CONFIGURATION_ERROR");
  } finally {
    if (ownsInitializationLock) rmSync(lockPath, { force: true });
  }
}

export function readSqliteVersion(database: Database.Database): string {
  const row = database.prepare("SELECT sqlite_version() AS version").get() as { version: string };
  return row.version;
}
