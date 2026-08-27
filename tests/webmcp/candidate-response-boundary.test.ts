import { describe, expect, it, vi } from "vitest";
import { createClaimGateTools } from "@/features/webmcp/tool-contracts";
import { createToolExecutor } from "@/features/webmcp/tool-executor";
import { completeTestExecutor } from "./test-executor";

const candidate = {
  candidateHandle: `cgch1.1.2.${"A".repeat(43)}`,
  category: "earbuds",
  timeBand: "same window",
  area: "library",
  color: "black",
  confidence: "strong" as const,
  reasons: ["category match"],
  expiresAt: 2,
};

const legal = { reportVersion: 2, candidates: [candidate], message: "One candidate." };

function response(value: unknown) {
  return Response.json(value);
}

describe("shared find response side-effect boundary", () => {
  it.each([
    [{ ...legal, candidates: [{ ...candidate, candidateHandle: `cgch1.1.2.${"A".repeat(42)}B` }] }, "noncanonical handle"],
    [{ ...legal, candidates: [{ ...candidate, candidateHandle: `cgch1.1.2.${"A".repeat(1_040)}` }] }, "oversized handle"],
    [{ ...legal, reportVersion: Number.MAX_SAFE_INTEGER + 1 }, "unsafe reportVersion"],
    [{ ...legal, extra: true }, "extra response field"],
    [{ ...legal, candidates: [{ ...candidate, extra: true }] }, "extra candidate field"],
    [{ ...legal, candidates: [candidate, candidate, candidate, candidate] }, "too many candidates"],
    [{ ...legal, candidates: [{ ...candidate, reasons: ["x".repeat(161)] }] }, "oversized reason"],
    [{ ...legal, message: "x".repeat(257) }, "oversized message"],
  ])("rejects %s with zero publish side effects (%s)", async (payload, _label) => {
    void _label;
    const publishCandidates = vi.fn();
    const executor = createToolExecutor({
      fetcher: vi.fn(async () => response(payload)),
      defer: (callback) => callback(),
      publishCandidates,
    });
    await expect(executor.findCandidates({ reportId: "report-public", limit: 1 })).resolves.toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    });
    expect(publishCandidates).not.toHaveBeenCalled();
  });

  it("uses the same boundary again before final tool output", async () => {
    const target = completeTestExecutor({
      findCandidates: vi.fn(async () => ({
        ok: true,
        data: { ...legal, candidates: [{ ...candidate, candidateHandle: `cgch1.1.2.${"A".repeat(42)}B` }] },
      })) as never,
    });
    await expect(createClaimGateTools(target).find_candidate_matches.execute({ reportId: "report-public" }))
      .resolves.toEqual({ ok: false, error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
  });

  it("publishes one legal fully parsed response exactly once", async () => {
    const publishCandidates = vi.fn();
    const executor = createToolExecutor({
      fetcher: vi.fn(async () => response(legal)),
      defer: (callback) => callback(),
      publishCandidates,
    });
    await expect(executor.findCandidates({ reportId: "report-public", limit: 1 }))
      .resolves.toEqual({ ok: true, data: legal });
    expect(publishCandidates).toHaveBeenCalledOnce();
  });
});
