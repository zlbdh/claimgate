import { describe, expect, it, vi } from "vitest";
import {
  CLAIMGATE_TOOL_NAMES,
  TOOL_INPUT_SCHEMAS,
  createClaimGateTools,
  type ClaimGateToolExecutor,
} from "@/features/webmcp/tool-contracts";
import { toolNamesForScope } from "@/features/webmcp/tool-registry";

const NAMES = [
  "create_lost_report_draft", "update_lost_report_draft", "list_my_reports",
  "find_candidate_matches", "stage_claim_candidate", "get_claim_status",
  "get_pickup_instructions", "list_pending_claims", "get_claim_review_summary",
] as const;

function target() {
  return {
    createDraft: vi.fn(async () => ({ ok: true, data: { reportId: "report", status: "DRAFT", version: 1 }, nextPath: "/claimant/reports/report" })),
    updateDraft: vi.fn(async () => ({ ok: true, data: { reportId: "report", status: "DRAFT", version: 2 } })),
    listReports: vi.fn(async () => ({ ok: true, data: { reports: [] } })),
    findCandidates: vi.fn(async () => ({ ok: true, data: { reportVersion: 2, candidates: [], message: "None." } })),
    stageClaim: vi.fn(async () => ({ ok: true, data: { claimId: "claim", status: "EVIDENCE_REQUIRED", version: 1, remainingAttempts: 3 }, nextPath: "/claimant/claims/claim" })),
    getClaimStatus: vi.fn(async () => ({ ok: true, data: {
      claimId: "claim", status: "APPROVED", version: 5, failedAttempts: 0,
      remainingAttempts: 3, evidenceEligible: true, unlockCount: 0,
      rejectionReason: null, nextStep: "Generate a pickup pass manually.",
    } })),
    getPickupInstructions: vi.fn(async () => ({ ok: true, data: {
      claimId: "claim", deskName: "Desk 04", hours: "09:00-17:00",
      passReady: false, expiresAtMs: null, generation: 0,
      status: "APPROVED", claimVersion: 5,
    } })),
    listPendingClaims: vi.fn(async () => ({ ok: true, data: { claims: [] } })),
    getClaimReviewSummary: vi.fn(async () => ({ ok: true, data: {
      claim: { claimId: "claim", status: "UNDER_REVIEW", version: 2,
        failedAttempts: 0, remainingAttempts: 3, evidenceEligible: true,
        unlockCount: 0, generation: 0 },
      item: { category: "earbuds", area: "library", color: "black", publicDescription: "Black case." },
      report: { publicDescription: "Lost black case.", version: 2 },
      conflict: { hasConflict: false, conflictCount: 0 }, timeline: [],
    } })),
  } as unknown as ClaimGateToolExecutor;
}

function assertStrictObjects(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.type === "object") expect(record.additionalProperties).toBe(false);
  if (typeof record.description === "string") expect(record.description.length).toBeLessThanOrEqual(150);
  for (const child of Object.values(record)) assertStrictObjects(child);
}

describe("Task 9 exact nine-tool contracts", () => {
  it("declares only the nine approved tools with bounded metadata and UGC annotations", () => {
    const tools = createClaimGateTools(target()) as unknown as Record<string, WebMCPTool>;
    expect(CLAIMGATE_TOOL_NAMES).toEqual(NAMES);
    expect(Object.keys(tools)).toEqual(NAMES);
    for (const [name, tool] of Object.entries(tools)) {
      expect(tool.description.length, name).toBeLessThanOrEqual(500);
      assertStrictObjects(tool.inputSchema);
      expect(tool.annotations?.untrustedContentHint).toBe([
        "list_my_reports", "find_candidate_matches", "list_pending_claims",
        "get_claim_review_summary",
      ].includes(name));
      expect(tool.annotations?.readOnlyHint).toBe(![
        "create_lost_report_draft", "update_lost_report_draft", "stage_claim_candidate",
      ].includes(name));
    }
    expect(Object.keys(tools)).not.toEqual(expect.arrayContaining([
      "publish_report", "archive_report", "submit_evidence", "approve_claim",
      "reject_claim", "unlock_claim", "issue_pickup_pass", "handoff",
    ]));
    expect(tools.list_pending_claims.description).toContain("up to three");
    expect(TOOL_INPUT_SCHEMAS.list_pending_claims).toMatchObject({
      properties: { limit: { maximum: 3 } },
    });
  });

  it("strict-parses every new tool before delegation and caps every envelope at 1500", async () => {
    const executor = target();
    const tools = createClaimGateTools(executor) as unknown as Record<string, WebMCPTool>;
    const valid = {
      update_lost_report_draft: { reportId: "report", expectedVersion: 1,
        patch: { color: "black" }, idempotencyKey: "update-draft-000001" },
      get_claim_status: { claimId: "claim" },
      get_pickup_instructions: { claimId: "claim" },
      list_pending_claims: { limit: 3 },
      get_claim_review_summary: { claimId: "claim" },
    } as const;
    for (const [name, input] of Object.entries(valid)) {
      await expect(tools[name]!.execute({ ...input, extra: true })).resolves.toMatchObject({
        ok: false, error: { code: "VALIDATION_FAILED" },
      });
      const result = await tools[name]!.execute(input);
      expect(JSON.stringify(result).length, name).toBeLessThanOrEqual(1_500);
    }
    expect((executor as unknown as { updateDraft: ReturnType<typeof vi.fn> }).updateDraft).toHaveBeenCalledOnce();
  });

  it("publishes strict discovery schemas for all nine names", () => {
    expect(Object.keys(TOOL_INPUT_SCHEMAS)).toEqual(NAMES);
    for (const schema of Object.values(TOOL_INPUT_SCHEMAS)) assertStrictObjects(schema);
  });
});

describe("Task 9 authenticated state matrix", () => {
  it.each([
    [{ role: "CLAIMANT", page: "WORKSPACE" }, ["create_lost_report_draft", "list_my_reports"]],
    [{ role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "DRAFT", reportVersion: 1 }, ["update_lost_report_draft", "list_my_reports"]],
    [{ role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "PUBLISHED", reportVersion: 2 }, ["find_candidate_matches", "list_my_reports"]],
    [{ role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "PUBLISHED", reportVersion: 2, candidateReportVersion: 2, candidateCount: 1 }, ["find_candidate_matches", "list_my_reports", "stage_claim_candidate"]],
    [{ role: "CLAIMANT", page: "CLAIM", claimId: "c", claimStatus: "EVIDENCE_REQUIRED", claimVersion: 1 }, ["get_claim_status"]],
    [{ role: "CLAIMANT", page: "CLAIM", claimId: "c", claimStatus: "APPROVED", claimVersion: 5 }, ["get_claim_status", "get_pickup_instructions"]],
    [{ role: "CLAIMANT", page: "CLAIM", claimId: "c", claimStatus: "PICKUP_READY", claimVersion: 6 }, ["get_claim_status", "get_pickup_instructions"]],
    [{ role: "CLAIMANT", page: "CLAIM", claimId: "c", claimStatus: "COLLECTED", claimVersion: 7 }, ["get_claim_status"]],
    [{ role: "STAFF", page: "STAFF_QUEUE" }, ["list_pending_claims"]],
    [{ role: "STAFF", page: "CLAIM", claimId: "c", claimStatus: "UNDER_REVIEW", claimVersion: 2 }, ["get_claim_status", "get_claim_review_summary"]],
    [{ role: "STAFF", page: "CLAIM", claimId: "c", claimStatus: "PICKUP_READY", claimVersion: 6 }, ["get_claim_status", "get_claim_review_summary"]],
    [{ role: "STAFF", page: "CLAIM", claimId: "c", claimStatus: "COLLECTED", claimVersion: 7 }, ["get_claim_status"]],
    [{ role: "ANONYMOUS", page: "OTHER" }, []],
  ] as const)("registers exact tools for %o", (scope, names) => {
    expect(toolNamesForScope(scope)).toEqual(names);
  });
});
