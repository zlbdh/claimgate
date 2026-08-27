import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { DomainError } from "@/shared/domain-error";
import {
  EVIDENCE_SLOTS,
  type EvidenceDigester,
  type EvidenceSlot,
} from "./evidence-digester";
import { normalizeEvidence } from "./normalize-evidence";

export type ServerInternalEvidenceSlot = Readonly<{
  slot: EvidenceSlot;
  salt: Buffer;
  digest: Buffer;
}>;

export type EvidenceAnswers = Partial<Record<EvidenceSlot, string>>;
export type EvidenceComparator = Readonly<{
  equal(left: Buffer, right: Buffer): boolean;
}>;

type VerifyEvidenceInput = {
  digester: EvidenceDigester;
  demoInstanceId: string;
  itemId: string;
  storedSlots: readonly ServerInternalEvidenceSlot[];
  answers: unknown;
  priorFailedAttempts: number;
};

const OUTCOMES = Object.freeze({
  eligible: Object.freeze({ outcome: "ELIGIBLE_FOR_REVIEW" as const }),
  insufficient: Object.freeze({ outcome: "INSUFFICIENT_EVIDENCE" as const }),
  locked: Object.freeze({ outcome: "LOCKED" as const }),
});

function validationError(): never {
  throw new DomainError("VALIDATION_FAILED");
}

function configurationError(): never {
  throw new DomainError("CONFIGURATION_ERROR");
}

function requireContext(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || !value.isWellFormed()
  ) validationError();
}

function readAnswers(value: unknown): Map<EvidenceSlot, string> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    validationError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !EVIDENCE_SLOTS.includes(key as EvidenceSlot))) {
    validationError();
  }
  const answers = new Map<EvidenceSlot, string>();
  for (const key of keys as EvidenceSlot[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
    ) {
      validationError();
    }
    normalizeEvidence(descriptor.value);
    answers.set(key, descriptor.value);
  }
  return answers;
}

function readPlainEntry(value: unknown): ServerInternalEvidenceSlot {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    configurationError();
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 3
    || keys.some((key) => typeof key !== "string" || !["slot", "salt", "digest"].includes(key))
  ) configurationError();
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]));
  if (["slot", "salt", "digest"].some((key) => {
    const descriptor = descriptors.get(key);
    return !descriptor || !("value" in descriptor) || descriptor.enumerable !== true;
  })) configurationError();
  const slot = descriptors.get("slot")!.value as unknown;
  const salt = descriptors.get("salt")!.value as unknown;
  const digest = descriptors.get("digest")!.value as unknown;
  if (
    typeof slot !== "string"
    || !EVIDENCE_SLOTS.includes(slot as EvidenceSlot)
    || !Buffer.isBuffer(salt)
    || salt.length !== 16
    || !Buffer.isBuffer(digest)
    || digest.length !== 32
  ) configurationError();
  return { slot: slot as EvidenceSlot, salt: Buffer.from(salt), digest: Buffer.from(digest) };
}

function readStoredSlots(value: unknown): ServerInternalEvidenceSlot[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) configurationError();
  const keys = Reflect.ownKeys(value);
  const expectedKeys = ["0", "1", "2", "length"];
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key as string))) {
    configurationError();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor
    || !("value" in lengthDescriptor)
    || lengthDescriptor.value !== EVIDENCE_SLOTS.length
    || lengthDescriptor.enumerable !== false
  ) configurationError();
  const bySlot = new Map<EvidenceSlot, ServerInternalEvidenceSlot>();
  for (const index of ["0", "1", "2"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      configurationError();
    }
    const entry = readPlainEntry(descriptor.value);
    if (bySlot.has(entry.slot)) configurationError();
    bySlot.set(entry.slot, entry);
  }
  if (bySlot.size !== EVIDENCE_SLOTS.length) configurationError();
  return EVIDENCE_SLOTS.map((slot) => bySlot.get(slot)!);
}

function verifyWithComparator(
  input: VerifyEvidenceInput,
  comparator: EvidenceComparator,
): (typeof OUTCOMES)[keyof typeof OUTCOMES] {
  if (!input || typeof input !== "object") validationError();
  requireContext(input.demoInstanceId);
  requireContext(input.itemId);
  if (
    !input.digester
    || typeof input.digester.digest !== "function"
    || !Object.isFrozen(input.digester)
  ) configurationError();
  if (
    !Number.isInteger(input.priorFailedAttempts)
    || input.priorFailedAttempts < 0
    || input.priorFailedAttempts > 3
  ) validationError();
  if (input.priorFailedAttempts === 3) return OUTCOMES.locked;
  const slots = readStoredSlots(input.storedSlots);
  const answers = readAnswers(input.answers);
  const computed = slots.map(({ slot, salt }) => input.digester.digest({
      demoInstanceId: input.demoInstanceId,
      itemId: input.itemId,
      slot,
      salt,
      value: answers.get(slot) ?? "ClaimGate missing evidence value",
    }));
  if (computed.some((digest) => !Buffer.isBuffer(digest) || digest.length !== 32)) {
    configurationError();
  }
  const matches = slots.map(({ slot, digest }, index) => {
    const equal = comparator.equal(Buffer.from(computed[index]!), digest);
    if (typeof equal !== "boolean") configurationError();
    return answers.has(slot) && equal;
  });
  const correct = matches.filter(Boolean).length;
  if (correct >= 2) return OUTCOMES.eligible;
  return input.priorFailedAttempts === 2 ? OUTCOMES.locked : OUTCOMES.insufficient;
}

const NATIVE_COMPARATOR = Object.freeze({
  equal(left: Buffer, right: Buffer): boolean {
    return timingSafeEqual(left, right);
  },
});

export function createEvidenceVerifier(
  comparator: EvidenceComparator = NATIVE_COMPARATOR,
): (input: VerifyEvidenceInput) => (typeof OUTCOMES)[keyof typeof OUTCOMES] {
  if (!comparator || typeof comparator.equal !== "function" || !Object.isFrozen(comparator)) {
    configurationError();
  }
  return Object.freeze((input: VerifyEvidenceInput) => verifyWithComparator(input, comparator));
}

export const verifyEvidence = createEvidenceVerifier();

export function unlockEvidenceLock(input: {
  role: "CLAIMANT" | "STAFF";
  status: string;
  attempts: number;
}): Readonly<{ status: "EVIDENCE_REQUIRED"; attempts: 0 }> {
  if (
    !input
    || input.role !== "STAFF"
    || input.status !== "LOCKED"
    || input.attempts !== 3
  ) throw new DomainError("INVALID_STATE_TRANSITION");
  return Object.freeze({ status: "EVIDENCE_REQUIRED", attempts: 0 });
}
