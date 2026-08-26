import { Buffer } from "node:buffer";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Keyring } from "@/server/security/keyring";
import { DomainError } from "@/shared/domain-error";
import { openDatabaseConnection } from "./connection";

const SCHEMA_VERSION = 1;
const SCHEMA_SQL = readFileSync(join(process.cwd(), "src/server/db/schema.sql"), "utf8");

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

function verifyMetadata(metadata: MetadataRow | undefined, keyring: Keyring): void {
  if (
    !metadata ||
    metadata.schemaVersion !== SCHEMA_VERSION ||
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

function migrateNewDatabase(database: Database.Database, keyring: Keyring): void {
  database.transaction(() => {
    database.exec(SCHEMA_SQL);
    const existing = readMetadata(database);
    if (existing) {
      verifyMetadata(existing, keyring);
      return;
    }
    const databaseUuid = randomUUID();
    const salt = randomBytes(32);
    const authenticator = makeAuthenticator(keyring, SCHEMA_VERSION, databaseUuid, salt);
    database.prepare(`
      INSERT INTO database_metadata (
        singleton_id, schema_version, database_uuid, key_check_salt, key_check_authenticator
      ) VALUES (1, ?, ?, ?, ?)
    `).run(SCHEMA_VERSION, databaseUuid, salt, authenticator);
  }).immediate();
}

export function initializeDatabase(options: {
  databasePath: string;
  keyring: Keyring;
}): Database.Database {
  const isBrandNew = !existsSync(options.databasePath);
  const database = openDatabaseConnection(options.databasePath);
  try {
    if (isBrandNew) {
      migrateNewDatabase(database, options.keyring);
    } else {
      verifyMetadata(readMetadata(database), options.keyring);
      database.transaction(() => database.exec(SCHEMA_SQL)).immediate();
    }
    if ((database.pragma("foreign_key_check") as unknown[]).length !== 0) {
      throw new DomainError("CONFIGURATION_ERROR");
    }
    return database;
  } catch (error) {
    database.close();
    if (error instanceof DomainError) throw error;
    throw new DomainError("CONFIGURATION_ERROR");
  }
}

export function readSqliteVersion(database: Database.Database): string {
  const row = database.prepare("SELECT sqlite_version() AS version").get() as { version: string };
  return row.version;
}
