import { DomainError } from "@/shared/domain-error";

export type ReportStatus = "DRAFT" | "PUBLISHED" | "RESOLVED" | "ARCHIVED";
export type ItemStatus = "AVAILABLE" | "HELD" | "RETURNED";
export type ClaimStatus =
  | "EVIDENCE_REQUIRED"
  | "UNDER_REVIEW"
  | "REJECTED"
  | "LOCKED"
  | "APPROVED"
  | "PICKUP_READY"
  | "COLLECTED";

function freezeTransitionTable<T extends string>(
  transitions: Record<T, T[]>,
): Readonly<Record<T, readonly T[]>> {
  for (const nextStates of Object.values(transitions)) Object.freeze(nextStates);
  return Object.freeze(transitions);
}

export const allowedReportTransitions = freezeTransitionTable<ReportStatus>({
  DRAFT: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["RESOLVED", "ARCHIVED"],
  RESOLVED: [],
  ARCHIVED: [],
});

export const allowedItemTransitions = freezeTransitionTable<ItemStatus>({
  AVAILABLE: ["HELD"],
  HELD: ["RETURNED"],
  RETURNED: [],
});

export const allowedClaimTransitions = freezeTransitionTable<ClaimStatus>({
  EVIDENCE_REQUIRED: ["UNDER_REVIEW", "REJECTED", "LOCKED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  REJECTED: [],
  LOCKED: ["EVIDENCE_REQUIRED"],
  APPROVED: ["PICKUP_READY"],
  PICKUP_READY: ["COLLECTED"],
  COLLECTED: [],
});

function assertTransition(
  allowedTransitions: Readonly<Record<string, readonly string[]>>,
  from: string,
  to: string,
): void {
  if (!allowedTransitions[from]?.includes(to)) {
    throw new DomainError("INVALID_STATE_TRANSITION");
  }
}

export function assertReportTransition(from: ReportStatus, to: ReportStatus): void {
  assertTransition(allowedReportTransitions, from, to);
}

export function assertItemTransition(from: ItemStatus, to: ItemStatus): void {
  assertTransition(allowedItemTransitions, from, to);
}

export function assertClaimTransition(from: ClaimStatus, to: ClaimStatus): void {
  assertTransition(allowedClaimTransitions, from, to);
}
