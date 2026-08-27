import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { EVIDENCE_SLOTS } from "@/features/evidence/evidence-digester";
import { normalizeEvidence } from "@/features/evidence/normalize-evidence";
import type { Keyring } from "@/server/security/keyring";
import type {
  ApproveClaimCommand,
  EvidenceSubmissionCommand,
  StaffClaimCommand,
} from "./claim-review-schema";

function canonicalAction(action: string, claimId: string, fields: Record<string, number>): string {
  return JSON.stringify({
    contract: `ClaimGate/${action}/v1`,
    method: "POST",
    claimId,
    ...fields,
  });
}

export function evidenceSubmissionFingerprint(
  keyring: Keyring,
  demoInstanceId: string,
  claimId: string,
  input: EvidenceSubmissionCommand,
): string {
  const answers = EVIDENCE_SLOTS.map((slot) => [
    slot,
    input.answers[slot] === undefined ? null : normalizeEvidence(input.answers[slot]),
  ]);
  const message = JSON.stringify({
    contract: "ClaimGate/evidence-submit-fingerprint/v1",
    demoInstanceId,
    claimId,
    expectedVersion: input.expectedVersion,
    answers,
  });
  return `cgeh1.${createHmac("sha256", keyring.getKey("evidence"))
    .update(Buffer.from("ClaimGate/evidence-idempotency/v1\0", "utf8"))
    .update(message, "utf8")
    .digest("base64url")}`;
}

export function approveFingerprint(claimId: string, input: ApproveClaimCommand): string {
  return canonicalAction("claim-approve", claimId, {
    expectedClaimVersion: input.expectedClaimVersion,
    expectedItemVersion: input.expectedItemVersion,
  });
}

export function rejectFingerprint(claimId: string, input: StaffClaimCommand): string {
  return canonicalAction("claim-reject", claimId, { expectedClaimVersion: input.expectedClaimVersion });
}

export function unlockFingerprint(claimId: string, input: StaffClaimCommand): string {
  return canonicalAction("claim-unlock", claimId, { expectedClaimVersion: input.expectedClaimVersion });
}
