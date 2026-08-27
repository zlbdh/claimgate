import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Keyring } from "@/server/security/keyring";
import { DomainError } from "@/shared/domain-error";
import { openDatabaseConnection } from "./connection";
import { addV5ClaimAndIdempotencySchema } from "./migration-v5-schema";
import { addV6PickupSchema } from "./migration-v6-schema";
import {
  makeAuthenticator,
  verifyMetadata,
  type MetadataRow,
} from "./database-metadata-authenticator";

const SCHEMA_VERSION = 6;
const LEGACY_SCHEMA_VERSION = 1;
const PRESERVED_SCHEMA_VERSIONS = Object.freeze([2, 3] as const);
const V4_SCHEMA_VERSION = 4;
const V5_SCHEMA_VERSION = 5;
const SCHEMA_SQL = readFileSync(join(process.cwd(), "src/server/db/schema.sql"), "utf8");
const V5_SCHEMA_SQL = readFileSync(
  join(process.cwd(), "src/server/db/fixtures/schema-v5.sql"),
  "utf8",
);

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
    DROP TABLE IF EXISTS claim_events;
    DROP TABLE IF EXISTS audit_events;
    DROP TABLE IF EXISTS claims;
    DROP TABLE IF EXISTS lost_reports;
    DROP TABLE IF EXISTS item_evidence_slots;
    DROP TABLE IF EXISTS found_items;
    DROP TABLE IF EXISTS demo_instances;
  `);
}

function migrateV1ToV5(
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

function migratePreservingToV5(
  database: Database.Database,
  keyring: Keyring,
  metadata: MetadataRow,
): void {
  if (!PRESERVED_SCHEMA_VERSIONS.includes(metadata.schemaVersion as 2 | 3)) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  verifyMetadata(metadata, keyring, metadata.schemaVersion);
  const populated = database.prepare(`
    SELECT 1 FROM item_evidence_slots
    WHERE salt IS NOT NULL OR digest IS NOT NULL LIMIT 1
  `).get();
  if (populated) throw new DomainError("CONFIGURATION_ERROR");
  database.exec(`
    ALTER TABLE item_evidence_slots RENAME TO item_evidence_slots_legacy;
    DROP INDEX item_evidence_slots_item_idx;
  `);
  addV5ClaimAndIdempotencySchema(database, V5_SCHEMA_SQL);
  database.exec(`
    INSERT INTO item_evidence_slots (
      demo_instance_id, found_item_id, slot, salt, digest
    )
    SELECT demo_instance_id, found_item_id, slot, NULL, NULL
    FROM item_evidence_slots_legacy
    WHERE salt IS NULL AND digest IS NULL;
    DROP TABLE item_evidence_slots_legacy;
  `);
  assertForeignKeysClean(database);
  const authenticator = makeAuthenticator(
    keyring,
    V5_SCHEMA_VERSION,
    metadata.databaseUuid,
    metadata.keyCheckSalt,
  );
  database.prepare(`
    UPDATE database_metadata
    SET schema_version = ?, key_check_authenticator = ?
    WHERE singleton_id = 1 AND schema_version = ?
  `).run(V5_SCHEMA_VERSION, authenticator, metadata.schemaVersion);
}

function migrateV4ToV5(
  database: Database.Database,
  keyring: Keyring,
  metadata: MetadataRow,
): void {
  verifyMetadata(metadata, keyring, V4_SCHEMA_VERSION);
  addV5ClaimAndIdempotencySchema(database, V5_SCHEMA_SQL);
  assertForeignKeysClean(database);
  const authenticator = makeAuthenticator(
    keyring,
    V5_SCHEMA_VERSION,
    metadata.databaseUuid,
    metadata.keyCheckSalt,
  );
  database.prepare(`
    UPDATE database_metadata
    SET schema_version = ?, key_check_authenticator = ?
    WHERE singleton_id = 1 AND schema_version = ?
  `).run(V5_SCHEMA_VERSION, authenticator, V4_SCHEMA_VERSION);
}

function migrateV5ToV6(
  database: Database.Database,
  keyring: Keyring,
  metadata: MetadataRow,
): void {
  verifyMetadata(metadata, keyring, V5_SCHEMA_VERSION);
  addV6PickupSchema(database, SCHEMA_SQL);
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
  `).run(SCHEMA_VERSION, authenticator, V5_SCHEMA_VERSION);
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
        migrateV1ToV5(database, keyring, existing);
        return;
      }
      if (PRESERVED_SCHEMA_VERSIONS.includes(existing.schemaVersion as 2 | 3)) {
        migratePreservingToV5(database, keyring, existing);
        const upgraded = readMetadata(database)!;
        migrateV5ToV6(database, keyring, upgraded);
        return;
      }
      if (existing.schemaVersion === V4_SCHEMA_VERSION) {
        migrateV4ToV5(database, keyring, existing);
        const upgraded = readMetadata(database)!;
        migrateV5ToV6(database, keyring, upgraded);
        return;
      }
      if (existing.schemaVersion === V5_SCHEMA_VERSION) {
        migrateV5ToV6(database, keyring, existing);
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
