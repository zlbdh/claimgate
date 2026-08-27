import { describe, expect, it, vi } from "vitest";
import {
  CLAIMGATE_TOOL_NAMES,
  createClaimGateTools,
  type ClaimGateToolExecutor,
} from "@/features/webmcp/tool-contracts";
import { toolNamesForScope } from "@/features/webmcp/tool-registry";

const VALID_CREATE = {
  category: "earbuds",
  timeWindow: {
    from: "2026-08-25T17:00:00.000Z",
    to: "2026-08-25T19:00:00.000Z",
  },
  area: "library",
  color: "black",
  publicTags: ["wireless", "charging-case"],
  publicDescription: "Black wireless earbud case.",
  idempotencyKey: "tool-create-00000001",
};

function executor(): ClaimGateToolExecutor {
  return {
    createDraft: vi.fn<ClaimGateToolExecutor["createDraft"]>(async () => ({
      ok: true,
      data: { reportId: "report-public", status: "DRAFT", version: 1 },
      nextPath: "/claimant/reports/report-public",
    })),
    listReports: vi.fn<ClaimGateToolExecutor["listReports"]>(async () => ({ ok: true, data: { reports: [] } })),
    findCandidates: vi.fn<ClaimGateToolExecutor["findCandidates"]>(async () => ({
      ok: true,
      data: { reportVersion: 2, candidates: [], message: "No close candidates yet." },
    })),
    stageClaim: vi.fn<ClaimGateToolExecutor["stageClaim"]>(async () => ({
      ok: true,
      data: {
        claimId: "claim-public",
        status: "EVIDENCE_REQUIRED",
        version: 1,
        remainingAttempts: 3,
      },
      nextPath: "/claimant/claims/claim-public",
    })),
  };
}

describe("Task 6A exact WebMCP contracts", () => {
  it("declares the exact four names, explicit annotations, and strict schemas", () => {
    const tools = createClaimGateTools(executor());
    expect(CLAIMGATE_TOOL_NAMES).toEqual([
      "create_lost_report_draft",
      "list_my_reports",
      "find_candidate_matches",
      "stage_claim_candidate",
    ]);
    expect(Object.keys(tools)).toEqual(CLAIMGATE_TOOL_NAMES);
    expect(tools.create_lost_report_draft.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    });
    expect(tools.list_my_reports.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(tools.find_candidate_matches.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(tools.stage_claim_candidate.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: false,
    });

    const createSchema = tools.create_lost_report_draft.inputSchema;
    expect(createSchema).toMatchObject({
      type: "object",
      required: [
        "category", "timeWindow", "area", "color", "publicTags",
        "publicDescription", "idempotencyKey",
      ],
      additionalProperties: false,
      properties: {
        timeWindow: {
          type: "object",
          required: ["from", "to"],
          additionalProperties: false,
        },
      },
    });
    expect(tools.list_my_reports.inputSchema).toMatchObject({
      type: "object", required: [], additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
    });
    expect(tools.find_candidate_matches.inputSchema).toMatchObject({
      type: "object", required: ["reportId"], additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 3 } },
    });
    expect(tools.stage_claim_candidate.inputSchema).toMatchObject({
      type: "object",
      required: ["reportId", "candidateHandle", "expectedVersion", "idempotencyKey"],
      additionalProperties: false,
      properties: {
        expectedVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    });
  });

  it("strict-parses every level before delegation and returns bounded validation envelopes", async () => {
    const target = executor();
    const tools = createClaimGateTools(target);
    const invalidCreate = [
      undefined,
      null,
      "bad",
      {},
      { ...VALID_CREATE, extra: true },
      { ...VALID_CREATE, timeWindow: { ...VALID_CREATE.timeWindow, extra: true } },
      { ...VALID_CREATE, publicTags: ["wireless", { nested: true }] },
    ];
    for (const value of invalidCreate) {
      await expect(tools.create_lost_report_draft.execute(value as never)).resolves.toEqual({
        ok: false,
        error: { code: "VALIDATION_FAILED", message: "The submitted data is invalid." },
      });
    }
    await expect(tools.list_my_reports.execute({ limit: 21 })).resolves.toMatchObject({
      ok: false, error: { code: "VALIDATION_FAILED" },
    });
    await expect(tools.find_candidate_matches.execute({ reportId: "r", limit: 1, extra: 1 }))
      .resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    await expect(tools.stage_claim_candidate.execute({
      reportId: "r", candidateHandle: "internal-item", expectedVersion: 1,
      idempotencyKey: "stage-claim-00000001",
    })).resolves.toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });

    expect(target.createDraft).not.toHaveBeenCalled();
    expect(target.listReports).not.toHaveBeenCalled();
    expect(target.findCandidates).not.toHaveBeenCalled();
    expect(target.stageClaim).not.toHaveBeenCalled();
  });

  it("returns only plain JSON-safe envelopes from direct execution", async () => {
    const tools = createClaimGateTools(executor());
    const results = await Promise.all([
      tools.create_lost_report_draft.execute(VALID_CREATE),
      tools.list_my_reports.execute({}),
      tools.find_candidate_matches.execute({ reportId: "report-public", limit: 1 }),
      tools.stage_claim_candidate.execute({
        reportId: "report-public",
        candidateHandle: `cgch1.1.2.${"A".repeat(43)}`,
        expectedVersion: 2,
        idempotencyKey: "stage-claim-00000001",
      }),
    ]);
    for (const result of results) {
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(JSON.stringify(result)).not.toMatch(
        /cookie|csrf|session|instance|inventoryItemId|catalogVersion|foundAt|score|evidenceAnswer|stack/i,
      );
    }
  });
});

describe("Task 6A legal page tool matrix", () => {
  it.each([
    [{ role: "CLAIMANT", page: "WORKSPACE" }, ["create_lost_report_draft", "list_my_reports"]],
    [{ role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "DRAFT", reportVersion: 1 }, ["list_my_reports"]],
    [{ role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "PUBLISHED", reportVersion: 2 }, ["find_candidate_matches", "list_my_reports"]],
    [{ role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "PUBLISHED", reportVersion: 2, candidateReportVersion: 2, candidateCount: 1 }, ["find_candidate_matches", "list_my_reports", "stage_claim_candidate"]],
    [{ role: "CLAIMANT", page: "CLAIM", claimStatus: "EVIDENCE_REQUIRED" }, []],
    [{ role: "STAFF", page: "OTHER" }, []],
    [{ role: "ANONYMOUS", page: "OTHER" }, []],
  ] as const)("exposes only the legal set for %o", (scope, expected) => {
    expect(toolNamesForScope(scope)).toEqual(expected);
  });

  it("does not stage from stale or empty candidate state", () => {
    expect(toolNamesForScope({
      role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "PUBLISHED",
      reportVersion: 3, candidateReportVersion: 2, candidateCount: 1,
    })).not.toContain("stage_claim_candidate");
    expect(toolNamesForScope({
      role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "PUBLISHED",
      reportVersion: 3, candidateReportVersion: 3, candidateCount: 0,
    })).not.toContain("stage_claim_candidate");
  });
});
