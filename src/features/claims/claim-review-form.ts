import { z } from "zod";
import { DomainError } from "@/shared/domain-error";
import type {
  ApproveClaimCommand,
  EvidenceSubmissionCommand,
  StaffClaimCommand,
} from "./claim-review-schema";

const CANONICAL_INTEGER = /^[1-9][0-9]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;

function formRecord(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const keys = entries.map(([key]) => key);
  if (
    entries.some(([key, value]) => typeof key !== "string" || typeof value !== "string")
    || new Set(keys).size !== keys.length
  ) throw new DomainError("VALIDATION_FAILED");
  return Object.fromEntries(entries);
}

function safeVersion(value: string): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version)) throw new DomainError("VALIDATION_FAILED");
  return version;
}

const evidenceForm = z.strictObject({
  expectedVersion: z.string().regex(CANONICAL_INTEGER),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
  unique_mark: z.string().max(512).optional(),
  contents_or_accessory: z.string().max(512).optional(),
  identifier_suffix: z.string().max(512).optional(),
});
const staffForm = z.strictObject({
  expectedClaimVersion: z.string().regex(CANONICAL_INTEGER),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
});
const approveForm = staffForm.extend({ expectedItemVersion: z.string().regex(CANONICAL_INTEGER) });

export function parseEvidenceSubmissionForm(
  entries: ReadonlyArray<readonly [string, string]>,
): EvidenceSubmissionCommand {
  const parsed = evidenceForm.safeParse(formRecord(entries));
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  const answers = Object.fromEntries(
    ["unique_mark", "contents_or_accessory", "identifier_suffix"]
      .flatMap((slot) => parsed.data[slot as keyof typeof parsed.data] === undefined
        ? []
        : [[slot, parsed.data[slot as keyof typeof parsed.data]]]),
  );
  return {
    expectedVersion: safeVersion(parsed.data.expectedVersion),
    idempotencyKey: parsed.data.idempotencyKey,
    answers,
  };
}

export function parseStaffClaimForm(
  entries: ReadonlyArray<readonly [string, string]>,
): StaffClaimCommand {
  const parsed = staffForm.safeParse(formRecord(entries));
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return {
    expectedClaimVersion: safeVersion(parsed.data.expectedClaimVersion),
    idempotencyKey: parsed.data.idempotencyKey,
  };
}

export function parseApproveClaimForm(
  entries: ReadonlyArray<readonly [string, string]>,
): ApproveClaimCommand {
  const parsed = approveForm.safeParse(formRecord(entries));
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return {
    expectedClaimVersion: safeVersion(parsed.data.expectedClaimVersion),
    expectedItemVersion: safeVersion(parsed.data.expectedItemVersion),
    idempotencyKey: parsed.data.idempotencyKey,
  };
}
