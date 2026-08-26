import { describe, expect, it } from "vitest";
import {
  allowedClaimTransitions,
  allowedItemTransitions,
  allowedReportTransitions,
  assertClaimTransition,
  assertItemTransition,
  assertReportTransition,
  type ClaimStatus,
  type ItemStatus,
  type ReportStatus,
} from "./claim-state";

type Guard<T extends string> = (from: T, to: T) => void;
type StatePair<T extends string> = readonly [from: T, to: T, isAllowed: boolean];

function statePairs<T extends string>(states: readonly T[], legalEdges: readonly (readonly [T, T])[]): StatePair<T>[] {
  const legalPairs = new Set(legalEdges.map(([from, to]) => `${from}:${to}`));
  return states.flatMap((from) => states.map((to) => [from, to, legalPairs.has(`${from}:${to}`)] as const));
}

function assertGraph<T extends string>(guard: Guard<T>, from: T, to: T, isAllowed: boolean): void {
  if (isAllowed) {
    expect(() => guard(from, to)).not.toThrow();
    return;
  }
  expect(() => guard(from, to)).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
}

const REPORT_STATES: readonly ReportStatus[] = ["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"];
const ITEM_STATES: readonly ItemStatus[] = ["AVAILABLE", "HELD", "RETURNED"];
const CLAIM_STATES: readonly ClaimStatus[] = [
  "EVIDENCE_REQUIRED",
  "UNDER_REVIEW",
  "REJECTED",
  "LOCKED",
  "APPROVED",
  "PICKUP_READY",
  "COLLECTED",
];

describe("ClaimGate 状态守卫", () => {
  it.each(statePairs(REPORT_STATES, [
    ["DRAFT", "PUBLISHED"],
    ["DRAFT", "ARCHIVED"],
    ["PUBLISHED", "RESOLVED"],
    ["PUBLISHED", "ARCHIVED"],
  ]))("Report 图 %s → %s 的许可为 %s", (from, to, isAllowed) => {
    assertGraph(assertReportTransition, from, to, isAllowed);
  });

  it.each(statePairs(ITEM_STATES, [
    ["AVAILABLE", "HELD"],
    ["HELD", "RETURNED"],
  ]))("Item 图 %s → %s 的许可为 %s", (from, to, isAllowed) => {
    assertGraph(assertItemTransition, from, to, isAllowed);
  });

  it.each(statePairs(CLAIM_STATES, [
    ["EVIDENCE_REQUIRED", "UNDER_REVIEW"],
    ["EVIDENCE_REQUIRED", "REJECTED"],
    ["EVIDENCE_REQUIRED", "LOCKED"],
    ["UNDER_REVIEW", "APPROVED"],
    ["UNDER_REVIEW", "REJECTED"],
    ["LOCKED", "EVIDENCE_REQUIRED"],
    ["APPROVED", "PICKUP_READY"],
    ["PICKUP_READY", "COLLECTED"],
  ]))("Claim 图 %s → %s 的许可为 %s", (from, to, isAllowed) => {
    assertGraph(assertClaimTransition, from, to, isAllowed);
  });

  it("冻结状态表和其内部数组，变异不能改变守卫结果", () => {
    const tables = [allowedReportTransitions, allowedItemTransitions, allowedClaimTransitions];

    for (const table of tables) {
      expect(Object.isFrozen(table)).toBe(true);
      for (const nextStates of Object.values(table)) expect(Object.isFrozen(nextStates)).toBe(true);
    }
    expect(() => {
      (allowedClaimTransitions.APPROVED as unknown as ClaimStatus[]).push("COLLECTED");
    }).toThrow(TypeError);
    expect(() => assertClaimTransition("APPROVED", "COLLECTED")).toThrow(
      expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }),
    );
  });
});
