import { Buffer } from "node:buffer";
import { hkdfSync } from "node:crypto";
import { DomainError } from "@/shared/domain-error";

export const KEY_PURPOSES = ["evidence", "pickup-pass", "candidate-handle", "database-key-check"] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

const KEY_LENGTH_BYTES = 32;
const HKDF_SALT = Buffer.from("ClaimGate/keyring/v1", "utf8");

export type Keyring = {
  getKey(purpose: KeyPurpose): Buffer;
};

function decodeMasterKey(masterKey: string | undefined): Buffer {
  if (
    !masterKey ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(masterKey) ||
    masterKey.length % 4 !== 0
  ) {
    throw new DomainError("CONFIGURATION_ERROR");
  }

  const decoded = Buffer.from(masterKey, "base64");
  if (decoded.length < KEY_LENGTH_BYTES || decoded.toString("base64") !== masterKey) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  return decoded;
}

export function createKeyring(masterKey = process.env.CLAIMGATE_HMAC_KEY): Keyring {
  const decodedMasterKey = decodeMasterKey(masterKey);
  const keys = new Map<KeyPurpose, Buffer>();

  for (const purpose of KEY_PURPOSES) {
    // Versioned, purpose-specific context prevents cross-purpose key reuse.
    const info = Buffer.from(`ClaimGate/${purpose}/v1`, "utf8");
    keys.set(purpose, Buffer.from(hkdfSync("sha256", decodedMasterKey, HKDF_SALT, info, KEY_LENGTH_BYTES)));
  }

  return {
    getKey(purpose) {
      return Buffer.from(keys.get(purpose)!);
    },
  };
}
