import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Keyring } from "@/server/security/keyring";
import { DomainError } from "@/shared/domain-error";

export type MetadataRow = {
  schemaVersion: number;
  databaseUuid: string;
  keyCheckSalt: Buffer;
  keyCheckAuthenticator: Buffer;
};

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

export function makeAuthenticator(
  keyring: Keyring,
  version: number,
  databaseUuid: string,
  salt: Buffer,
): Buffer {
  return createHmac("sha256", keyring.getKey("database-key-check"))
    .update(authenticatorInput(version, databaseUuid, salt))
    .digest();
}

export function verifyMetadata(
  metadata: MetadataRow | undefined,
  keyring: Keyring,
  expectedVersion: number,
): asserts metadata is MetadataRow {
  if (
    !metadata
    || metadata.schemaVersion !== expectedVersion
    || typeof metadata.databaseUuid !== "string"
    || !Buffer.isBuffer(metadata.keyCheckSalt)
    || metadata.keyCheckSalt.length !== 32
    || !Buffer.isBuffer(metadata.keyCheckAuthenticator)
    || metadata.keyCheckAuthenticator.length !== 32
  ) throw new DomainError("CONFIGURATION_ERROR");
  const expected = makeAuthenticator(
    keyring, metadata.schemaVersion, metadata.databaseUuid, metadata.keyCheckSalt,
  );
  if (!timingSafeEqual(expected, metadata.keyCheckAuthenticator)) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
}
