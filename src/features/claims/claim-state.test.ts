import { describe, expect, it } from "vitest";
import { DomainError } from "@/shared/domain-error";
import {
  assertClaimTransition,
  assertItemTransition,
  assertReportTransition,
  type ClaimStatus,
  type ItemStatus,
  type ReportStatus,
} from "./claim-state";

describe("ClaimGate 状态守卫", () => {
  it.each<readonly [ReportStatus, ReportStatus]>([
    ["DRAFT", "PUBLISHED"],
    ["DRAFT", "ARCHIVED"],
    ["PUBLISHED", "RESOLVED"],
    ["PUBLISHED", "ARCHIVED"],
  ])("允许 Report 的合法边 %s → %s", (from, to) => {
    expect(() => assertReportTransition(from, to)).not.toThrow();
  });

  it.each<readonly [ItemStatus, ItemStatus]>([
    ["AVAILABLE", "HELD"],
    ["HELD", "RETURNED"],
  ])("允许 Item 的合法边 %s → %s", (from, to) => {
    expect(() => assertItemTransition(from, to)).not.toThrow();
  });

  it.each<readonly [ClaimStatus, ClaimStatus]>([
    ["EVIDENCE_REQUIRED", "UNDER_REVIEW"],
    ["EVIDENCE_REQUIRED", "REJECTED"],
    ["EVIDENCE_REQUIRED", "LOCKED"],
    ["UNDER_REVIEW", "APPROVED"],
    ["UNDER_REVIEW", "REJECTED"],
    ["LOCKED", "EVIDENCE_REQUIRED"],
    ["APPROVED", "PICKUP_READY"],
    ["PICKUP_READY", "COLLECTED"],
  ])("允许 Claim 的合法边 %s → %s", (from, to) => {
    expect(() => assertClaimTransition(from, to)).not.toThrow();
  });

  it.each<readonly [() => void]>([
    [() => assertReportTransition("DRAFT", "DRAFT")],
    [() => assertReportTransition("PUBLISHED", "PUBLISHED")],
    [() => assertItemTransition("AVAILABLE", "AVAILABLE")],
    [() => assertItemTransition("HELD", "HELD")],
    [() => assertClaimTransition("EVIDENCE_REQUIRED", "EVIDENCE_REQUIRED")],
    [() => assertClaimTransition("UNDER_REVIEW", "UNDER_REVIEW")],
    [() => assertClaimTransition("LOCKED", "LOCKED")],
    [() => assertClaimTransition("APPROVED", "APPROVED")],
    [() => assertClaimTransition("PICKUP_READY", "PICKUP_READY")],
  ])("拒绝同一状态调用", (transition) => {
    expect(transition).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
  });

  it.each<readonly [() => void]>([
    [() => assertReportTransition("DRAFT", "RESOLVED")],
    [() => assertItemTransition("AVAILABLE", "RETURNED")],
    [() => assertClaimTransition("UNDER_REVIEW", "PICKUP_READY")],
    [() => assertClaimTransition("PICKUP_READY", "APPROVED")],
  ])("拒绝跳过或回退状态", (transition) => {
    expect(transition).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
  });

  it.each<readonly [() => void]>([
    [() => assertReportTransition("RESOLVED", "ARCHIVED")],
    [() => assertReportTransition("ARCHIVED", "PUBLISHED")],
    [() => assertItemTransition("RETURNED", "HELD")],
    [() => assertClaimTransition("REJECTED", "EVIDENCE_REQUIRED")],
    [() => assertClaimTransition("COLLECTED", "PICKUP_READY")],
  ])("拒绝从终态离开", (transition) => {
    expect(transition).toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
  });

  it("序列化 DomainError 时只暴露固定安全元数据", () => {
    const error = new DomainError("INVALID_STATE_TRANSITION");
    Object.assign(error, { cause: new Error("internal-id-123"), requestId: "internal-id-123" });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      error: { code: "INVALID_STATE_TRANSITION", message: "The requested state transition is not allowed." },
    });
    expect(JSON.stringify(error)).not.toContain("internal-id-123");
    expect(JSON.stringify(error)).not.toContain("stack");
  });
});
