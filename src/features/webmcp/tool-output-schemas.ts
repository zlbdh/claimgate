import { z } from "zod";
import { candidateSearchSchema } from "@/features/reports/candidate-response-schema";
import { TOOL_ERROR_CODES, TOOL_ERROR_MESSAGES } from "./tool-errors";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const publicText = z.string().min(1).max(64);
const publicDescription = z.string().min(1).max(256);
const version = z.number().int().safe().positive();
const nonnegative = z.number().int().safe().nonnegative();
const claimStatus = z.enum([
  "EVIDENCE_REQUIRED", "UNDER_REVIEW", "REJECTED", "LOCKED",
  "APPROVED", "PICKUP_READY", "COLLECTED",
]);
const isoTimestamp = z.string().min(1).max(64).refine((value) => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});
const errorSchema = z.strictObject({
  code: z.enum(TOOL_ERROR_CODES),
  message: z.string().min(1).max(256),
  retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
}).superRefine((value, context) => {
  if (value.message !== TOOL_ERROR_MESSAGES[value.code]) {
    context.addIssue({ code: "custom", path: ["message"], message: "Noncanonical tool message" });
  }
  if (value.code !== "RATE_LIMITED" && value.retryAfterSeconds !== undefined) {
    context.addIssue({ code: "custom", path: ["retryAfterSeconds"], message: "Unexpected retry metadata" });
  }
});

export const reportSummarySchema = z.strictObject({
  reportId: id, category: publicText,
  timeWindow: z.strictObject({ from: isoTimestamp, to: isoTimestamp }),
  area: publicText, color: publicText,
  status: z.enum(["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"]), version,
});
export const claimStatusDataSchema = z.strictObject({
  claimId: id, status: claimStatus, version,
  failedAttempts: z.number().int().min(0).max(3),
  remainingAttempts: z.number().int().min(0).max(3),
  evidenceEligible: z.boolean(), unlockCount: z.number().int().min(0).max(1),
  rejectionReason: z.enum(["STAFF_REJECTED", "ITEM_HELD_BY_ANOTHER_CLAIM"]).nullable(),
  nextStep: z.string().min(1).max(128),
});
export const pickupInstructionsDataSchema = z.strictObject({
  claimId: id, deskName: z.string().min(1).max(128), hours: z.string().min(1).max(128),
  passReady: z.boolean(), expiresAtMs: z.number().int().safe().positive().nullable(), generation: nonnegative,
  status: z.enum(["APPROVED", "PICKUP_READY", "COLLECTED"]), claimVersion: version,
});
const pendingClaimSchema = z.strictObject({
  claimId: id, status: z.literal("UNDER_REVIEW"),
  failedAttempts: z.number().int().min(0).max(2), waitingDurationMs: nonnegative,
  hasConflict: z.boolean(),
  item: z.strictObject({ category: publicText, area: publicText, color: publicText }),
});
export const pendingClaimsDataSchema = z.strictObject({ claims: z.array(pendingClaimSchema).max(3) });
const timelineSchema = z.strictObject({
  action: z.enum([
    "CLAIM_CREATED", "EVIDENCE_INSUFFICIENT", "EVIDENCE_ELIGIBLE", "EVIDENCE_LOCKED",
    "UNLOCKED", "APPROVED", "STAFF_REJECTED", "COMPETING_REJECTED",
    "PASS_ISSUED", "PASS_REISSUED", "HANDOFF_COMPLETED",
  ]),
  actor: z.enum(["claimant", "staff"]),
  result: z.enum([
    "CREATED", "INSUFFICIENT", "ELIGIBLE", "LOCKED", "UNLOCKED", "APPROVED",
    "REJECTED", "ISSUED", "REISSUED", "COLLECTED",
  ]),
  occurredAtMs: nonnegative,
});
export const reviewSummaryDataSchema = z.strictObject({
  claim: z.strictObject({
    claimId: id, status: z.enum(["UNDER_REVIEW", "APPROVED", "PICKUP_READY"]), version,
    failedAttempts: z.number().int().min(0).max(3),
    remainingAttempts: z.number().int().min(0).max(3), evidenceEligible: z.boolean(),
    unlockCount: z.number().int().min(0).max(1), generation: nonnegative,
  }),
  item: z.strictObject({
    category: publicText, area: publicText, color: publicText, publicDescription,
  }),
  report: z.strictObject({ publicDescription, version }),
  conflict: z.strictObject({ hasConflict: z.boolean(), conflictCount: nonnegative }),
  timeline: z.array(timelineSchema).max(5),
});

const failure = z.strictObject({ ok: z.literal(false), error: errorSchema });
const success = <T extends z.ZodTypeAny>(data: T, nextPath?: z.ZodTypeAny) => z.strictObject({
  ok: z.literal(true), data,
  nextPath: nextPath ? nextPath.optional() : z.never().optional(),
});
const successWithPath = <T extends z.ZodTypeAny>(data: T, nextPath: z.ZodTypeAny) => z.strictObject({
  ok: z.literal(true), data, nextPath,
});

export const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  create_lost_report_draft: z.union([successWithPath(z.strictObject({
    reportId: id, status: z.literal("DRAFT"), version,
  }), z.string().startsWith("/claimant/reports/").max(256)), failure]),
  update_lost_report_draft: z.union([success(z.strictObject({
    reportId: id, status: z.literal("DRAFT"), version,
  })), failure]),
  list_my_reports: z.union([success(z.strictObject({ reports: z.array(reportSummarySchema).max(20) })), failure]),
  find_candidate_matches: z.union([success(candidateSearchSchema), failure]),
  stage_claim_candidate: z.union([successWithPath(z.strictObject({
    claimId: id, status: z.literal("EVIDENCE_REQUIRED"), version, remainingAttempts: z.literal(3),
  }), z.string().startsWith("/claimant/claims/").max(256)), failure]),
  get_claim_status: z.union([success(claimStatusDataSchema), failure]),
  get_pickup_instructions: z.union([success(pickupInstructionsDataSchema), failure]),
  list_pending_claims: z.union([success(pendingClaimsDataSchema), failure]),
  get_claim_review_summary: z.union([success(reviewSummaryDataSchema), failure]),
});
