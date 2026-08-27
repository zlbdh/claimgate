import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import { normalizeEvidence } from "./normalize-evidence";

export const EVIDENCE_SLOTS = Object.freeze([
  "unique_mark",
  "contents_or_accessory",
  "identifier_suffix",
] as const);
export type EvidenceSlot = (typeof EVIDENCE_SLOTS)[number];

export type EvidenceDigestInput = {
  demoInstanceId: string;
  itemId: string;
  slot: EvidenceSlot;
  salt: Buffer;
  value: string;
};

export type EvidenceDigester = Readonly<{
  digest(input: EvidenceDigestInput): Buffer;
}>;

const PURPOSE = Buffer.from("ClaimGate/evidence/v1", "utf8");
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_CONTEXT_CODE_UNITS = 512;

function configurationError(): never {
  throw new DomainError("CONFIGURATION_ERROR");
}

function contextText(value: unknown): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CONTEXT_CODE_UNITS
    || !value.isWellFormed()
    || /[\p{Cc}\p{Cf}]/u.test(value)
  ) configurationError();
  return Buffer.from(value, "utf8");
}

function lengthPrefix(value: Buffer): Buffer {
  if (value.length > 0xffff_ffff) configurationError();
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

function evidenceMessage(input: EvidenceDigestInput): Buffer {
  if (!input || typeof input !== "object") configurationError();
  if (!EVIDENCE_SLOTS.includes(input.slot)) configurationError();
  if (!Buffer.isBuffer(input.salt) || input.salt.length !== SALT_BYTES) configurationError();
  const fields = [
    PURPOSE,
    contextText(input.demoInstanceId),
    contextText(input.itemId),
    Buffer.from(input.slot, "utf8"),
    Buffer.from(input.salt),
    Buffer.from(normalizeEvidence(input.value), "utf8"),
  ];
  return Buffer.concat(fields.map(lengthPrefix));
}

/**
 * Resists offline guessing from a copied database only while the server key remains secret.
 * This is not password hashing, database encryption, or protection after server-key compromise.
 */
export function createEvidenceDigester(evidenceKey: unknown): EvidenceDigester {
  if (!Buffer.isBuffer(evidenceKey) || evidenceKey.length !== KEY_BYTES) configurationError();
  const privateKey = Buffer.from(evidenceKey);
  return Object.freeze({
    digest(input: EvidenceDigestInput): Buffer {
      return Buffer.from(createHmac("sha256", privateKey).update(evidenceMessage(input)).digest());
    },
  });
}
