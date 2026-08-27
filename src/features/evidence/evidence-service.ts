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

function readAnswers(value: unknown): EvidenceAnswers {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    validationError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !EVIDENCE_SLOTS.includes(key as EvidenceSlot))) {
    validationError();
  }
  const answers: Partial<Record<EvidenceSlot, string>> = {};
  for (const key of keys as EvidenceSlot[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") {
      validationError();
    }
    normalizeEvidence(descriptor.value);
    answers[key] = descriptor.value;
  }
  return answers;
}

function readStoredSlots(value: unknown): ServerInternalEvidenceSlot[] {
  if (!Array.isArray(value) || value.length !== EVIDENCE_SLOTS.length) configurationError();
  const bySlot = new Map<EvidenceSlot, ServerInternalEvidenceSlot>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || !EVIDENCE_SLOTS.includes(entry.slot as EvidenceSlot)) {
      configurationError();
    }
    const slot = entry.slot as EvidenceSlot;
    if (
      bySlot.has(slot)
      || !Buffer.isBuffer(entry.salt)
      || entry.salt.length !== 16
      || !Buffer.isBuffer(entry.digest)
      || entry.digest.length !== 32
    ) configurationError();
    bySlot.set(slot, {
      slot,
      salt: Buffer.from(entry.salt),
      digest: Buffer.from(entry.digest),
    });
  }
  if (bySlot.size !== EVIDENCE_SLOTS.length) configurationError();
  return EVIDENCE_SLOTS.map((slot) => bySlot.get(slot)!);
}

export function verifyEvidence(input: {
  digester: EvidenceDigester;
  demoInstanceId: string;
  itemId: string;
  storedSlots: readonly ServerInternalEvidenceSlot[];
  answers: unknown;
  priorFailedAttempts: number;
}): (typeof OUTCOMES)[keyof typeof OUTCOMES] {
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
  const slots = readStoredSlots(input.storedSlots);
  const answers = readAnswers(input.answers);
  if (input.priorFailedAttempts === 3) return OUTCOMES.locked;

  const matches = slots.map(({ slot, salt, digest }) => {
    const provided = Object.prototype.hasOwnProperty.call(answers, slot);
    const computed = input.digester.digest({
      demoInstanceId: input.demoInstanceId,
      itemId: input.itemId,
      slot,
      salt,
      value: provided ? answers[slot]! : "ClaimGate missing evidence value",
    });
    if (!Buffer.isBuffer(computed) || computed.length !== 32) configurationError();
    return provided && timingSafeEqual(Buffer.from(computed), digest);
  });
  const correct = matches.filter(Boolean).length;
  if (correct >= 2) return OUTCOMES.eligible;
  return input.priorFailedAttempts === 2 ? OUTCOMES.locked : OUTCOMES.insufficient;
}

export function unlockEvidenceLock(input: {
  role: "CLAIMANT" | "STAFF";
  status: string;
  attempts: number;
}): Readonly<{ status: "EVIDENCE_REQUIRED"; attempts: 0 }> {
  if (
    !input
    || input.role !== "STAFF"
    || input.status !== "LOCKED"
    || !Number.isInteger(input.attempts)
    || input.attempts < 0
    || input.attempts > 3
  ) throw new DomainError("INVALID_STATE_TRANSITION");
  return Object.freeze({ status: "EVIDENCE_REQUIRED", attempts: 0 });
}
