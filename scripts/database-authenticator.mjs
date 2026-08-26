import { Buffer } from "node:buffer";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH_BYTES = 32;
const HKDF_SALT = Buffer.from("ClaimGate/keyring/v1", "utf8");

function decodeMasterKey(masterKey) {
  if (!masterKey || !/^[A-Za-z0-9+/]+={0,2}$/.test(masterKey) || masterKey.length % 4 !== 0) {
    throw new Error("invalid key");
  }
  const decoded = Buffer.from(masterKey, "base64");
  if (decoded.length < KEY_LENGTH_BYTES || decoded.toString("base64") !== masterKey) {
    throw new Error("invalid key");
  }
  return decoded;
}

function authenticatorInput(version, databaseUuid, salt) {
  const uuid = Buffer.from(databaseUuid, "utf8");
  const versionBytes = Buffer.alloc(4);
  const uuidLength = Buffer.alloc(4);
  const saltLength = Buffer.alloc(4);
  versionBytes.writeUInt32BE(version);
  uuidLength.writeUInt32BE(uuid.length);
  saltLength.writeUInt32BE(salt.length);
  return Buffer.concat([versionBytes, uuidLength, uuid, saltLength, salt]);
}

export function verifyConfiguredDatabaseKey(database, masterKey) {
  const metadata = database.prepare(`
    SELECT schema_version AS schemaVersion, database_uuid AS databaseUuid,
      key_check_salt AS keyCheckSalt, key_check_authenticator AS keyCheckAuthenticator
    FROM database_metadata WHERE singleton_id = 1
  `).get();
  if (
    metadata?.schemaVersion !== 2
    || typeof metadata.databaseUuid !== "string"
    || !Buffer.isBuffer(metadata.keyCheckSalt)
    || metadata.keyCheckSalt.length !== KEY_LENGTH_BYTES
    || !Buffer.isBuffer(metadata.keyCheckAuthenticator)
    || metadata.keyCheckAuthenticator.length !== KEY_LENGTH_BYTES
  ) {
    throw new Error("invalid metadata");
  }
  const derivedKey = Buffer.from(hkdfSync(
    "sha256",
    decodeMasterKey(masterKey),
    HKDF_SALT,
    Buffer.from("ClaimGate/database-key-check/v1", "utf8"),
    KEY_LENGTH_BYTES,
  ));
  const expected = createHmac("sha256", derivedKey)
    .update(authenticatorInput(metadata.schemaVersion, metadata.databaseUuid, metadata.keyCheckSalt))
    .digest();
  if (!timingSafeEqual(expected, metadata.keyCheckAuthenticator)) {
    throw new Error("database key mismatch");
  }
}
