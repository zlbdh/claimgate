import { z } from "zod";
import { EVIDENCE_SLOTS, type EvidenceSlot } from "@/features/evidence/evidence-digester";
import { normalizeEvidence } from "@/features/evidence/normalize-evidence";
import { DomainError } from "@/shared/domain-error";

const version = z.number().int().safe().positive();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/);
const rawAnswer = z.string().max(512);
const evidenceCommand = z.strictObject({
  expectedVersion: version,
  idempotencyKey,
  answers: z.strictObject({
    unique_mark: rawAnswer.optional(),
    contents_or_accessory: rawAnswer.optional(),
    identifier_suffix: rawAnswer.optional(),
  }),
});
const staffCommand = z.strictObject({
  expectedClaimVersion: version,
  idempotencyKey,
});
const approveCommand = staffCommand.extend({ expectedItemVersion: version });

export type EvidenceSubmissionCommand = Readonly<{
  expectedVersion: number;
  idempotencyKey: string;
  answers: Partial<Record<EvidenceSlot, string>>;
}>;
export type StaffClaimCommand = z.infer<typeof staffCommand>;
export type ApproveClaimCommand = z.infer<typeof approveCommand>;

export function validateEvidenceSubmission(value: unknown): EvidenceSubmissionCommand {
  const parsed = evidenceCommand.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  const answers: Partial<Record<EvidenceSlot, string>> = {};
  for (const slot of EVIDENCE_SLOTS) {
    const raw = parsed.data.answers[slot];
    if (raw === undefined || raw.length === 0) continue;
    normalizeEvidence(raw);
    answers[slot] = raw;
  }
  return Object.freeze({
    expectedVersion: parsed.data.expectedVersion,
    idempotencyKey: parsed.data.idempotencyKey,
    answers: Object.freeze(answers),
  });
}

export function validateStaffClaimCommand(value: unknown): StaffClaimCommand {
  const parsed = staffCommand.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return parsed.data;
}

export function validateApproveClaimCommand(value: unknown): ApproveClaimCommand {
  const parsed = approveCommand.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return parsed.data;
}
