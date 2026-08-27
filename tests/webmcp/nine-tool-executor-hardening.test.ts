import { describe, expect, it, vi } from "vitest";
import { createToolExecutor } from "@/features/webmcp/tool-executor";
import { readJson } from "@/features/webmcp/tool-executor-support";

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

const claimStatus = { claimId: "claim", status: "APPROVED", version: 5,
  failedAttempts: 0, remainingAttempts: 3, evidenceEligible: true, unlockCount: 0,
  rejectionReason: null, nextStep: "Generate a pickup pass manually." } as const;
const pickup = { claimId: "claim", deskName: "Desk 04", hours: "09:00-17:00",
  passReady: false, expiresAtMs: null, generation: 0, status: "APPROVED", claimVersion: 5 } as const;
const review = {
  claim: { claimId: "claim", status: "UNDER_REVIEW", version: 2, failedAttempts: 0,
    remainingAttempts: 3, evidenceEligible: true, unlockCount: 0, generation: 0 },
  item: { category: "earbuds", area: "library", color: "black", publicDescription: "Black case." },
  report: { publicDescription: "Lost black case.", version: 2 },
  conflict: { hasConflict: false, conflictCount: 0 },
  timeline: [{ action: "EVIDENCE_ELIGIBLE", actor: "claimant", result: "ELIGIBLE", occurredAtMs: 1000 }],
} as const;
const candidate = { candidateHandle: `cgch1.1.2.${"A".repeat(43)}`, category: "earbuds",
  timeBand: "near", area: "library", color: "black", confidence: "strong" as const,
  reasons: ["same area"], expiresAt: 2 };

describe("Task 9 HTTP executor hardening", () => {
  it("rejects mismatched resource identities before navigation or refresh", async () => {
    const effects: Array<() => void> = [];
    const navigate = vi.fn(); const refresh = vi.fn();
    const create = createToolExecutor({ createCsrfToken: "create", navigate, refresh,
      defer: (effect) => effects.push(effect), fetcher: vi.fn(async () => json({
        reportId: "report-a", status: "DRAFT", version: 1, nextPath: "/claimant/reports/report-b",
      })) });
    await expect(create.createDraft({ category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: [], publicDescription: "Black case.",
      idempotencyKey: "identity-create-00001" })).resolves.toMatchObject({ ok: false });
    const stage = createToolExecutor({ stageCsrfToken: "stage", navigate, refresh,
      defer: (effect) => effects.push(effect), fetcher: vi.fn(async () => json({
        claimId: "claim-a", status: "EVIDENCE_REQUIRED", version: 1, remainingAttempts: 3,
        nextPath: "/claimant/claims/claim-b",
      })) });
    await expect(stage.stageClaim({ reportId: "report-a", candidateHandle: candidate.candidateHandle,
      expectedVersion: 2, idempotencyKey: "identity-stage-000001" })).resolves.toMatchObject({ ok: false });
    for (const [method, body] of [["getClaimStatus", { ...claimStatus, claimId: "other" }],
      ["getPickupInstructions", { ...pickup, claimId: "other" }],
      ["getClaimReviewSummary", { ...review, claim: { ...review.claim, claimId: "other" } }]] as const) {
      await expect(createToolExecutor({ navigate, refresh, defer: (effect) => effects.push(effect),
        fetcher: vi.fn(async () => json(body)) })[method]({ claimId: "claim" }))
        .resolves.toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    }
    effects.forEach((effect) => effect());
    expect(navigate).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["bad/path", "bad%2fpath"])("rejects noncanonical server ID %s", async (unsafeId) => {
    const effects: Array<() => void> = []; const navigate = vi.fn();
    const create = createToolExecutor({ createCsrfToken: "create", navigate,
      defer: (effect) => effects.push(effect), fetcher: vi.fn(async () => json({
        reportId: unsafeId, status: "DRAFT", version: 1, nextPath: `/claimant/reports/${unsafeId}`,
      })) });
    await expect(create.createDraft({ category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: [], publicDescription: "Black case.",
      idempotencyKey: "unsafe-id-create-0001" })).resolves.toMatchObject({ ok: false });
    const stage = createToolExecutor({ stageCsrfToken: "stage", navigate,
      defer: (effect) => effects.push(effect), fetcher: vi.fn(async () => json({
        claimId: unsafeId, status: "EVIDENCE_REQUIRED", version: 1, remainingAttempts: 3,
        nextPath: `/claimant/claims/${unsafeId}`,
      })) });
    await expect(stage.stageClaim({ reportId: "report", candidateHandle: candidate.candidateHandle,
      expectedVersion: 2, idempotencyKey: "unsafe-id-stage-00001" })).resolves.toMatchObject({ ok: false });
    effects.forEach((effect) => effect()); expect(navigate).not.toHaveBeenCalled();
  });

  it("cancels a response stream when the byte limit is crossed", async () => {
    let pulls = 0; let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; if (pulls <= 10) controller.enqueue(new Uint8Array(40_000)); else controller.close(); },
      cancel() { cancelled = true; },
    }));
    await expect(readJson(response)).rejects.toThrow();
    expect(cancelled).toBe(true); expect(pulls).toBeLessThan(10);
  });

  it("clears stale candidates after find or stage failure, but not for a newer generation", async () => {
    let current = true; const effects: Array<() => void> = [];
    const publishCandidates = vi.fn(); const clearCandidates = vi.fn(); const refresh = vi.fn();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ reportVersion: 2, candidates: [candidate], message: "One." }))
      .mockResolvedValueOnce(json({ error: { code: "STATE_CHANGED", message: "stale" } }, 409))
      .mockResolvedValueOnce(json({ error: { code: "ITEM_UNAVAILABLE", message: "gone" } }, 409))
      .mockResolvedValueOnce(json({ error: { code: "STATE_CHANGED", message: "stale" } }, 409));
    const executor = createToolExecutor({ fetcher, stageCsrfToken: "stage", publishCandidates,
      clearCandidates, refresh, isCurrent: () => current, defer: (effect) => effects.push(effect) });
    await executor.findCandidates({ reportId: "report", limit: 1 }); effects.shift()!();
    expect(publishCandidates).toHaveBeenCalledOnce();
    await executor.findCandidates({ reportId: "report", limit: 1 }); effects.shift()!();
    expect(clearCandidates).toHaveBeenCalledWith("report"); expect(refresh).toHaveBeenCalledOnce();
    await executor.stageClaim({ reportId: "report", candidateHandle: candidate.candidateHandle,
      expectedVersion: 2, idempotencyKey: "candidate-stage-00001" }); effects.shift()!();
    expect(clearCandidates).toHaveBeenCalledTimes(2); expect(refresh).toHaveBeenCalledTimes(2);
    current = false; await executor.findCandidates({ reportId: "report", limit: 1 }); effects.shift()!();
    expect(clearCandidates).toHaveBeenCalledTimes(2); expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("rejects bad report time and requests only bounded server summaries", async () => {
    const bad = createToolExecutor({ fetcher: vi.fn(async () => json({ reports: [{
      reportId: "report", category: "earbuds", timeWindow: { from: "", to: "not-a-date" },
      area: "library", color: "black", status: "DRAFT", version: 1,
    }] })) });
    await expect(bad.listReports({})).resolves.toMatchObject({ ok: false });
    const fetcher = vi.fn<typeof fetch>(async () => json({ reports: [{ reportId: "report",
      category: "earbuds", timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", status: "DRAFT", version: 1 }] }));
    await expect(createToolExecutor({ fetcher }).listReports({ status: "DRAFT", limit: 1 }))
      .resolves.toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith("/api/reports?status=DRAFT&limit=1", expect.any(Object));
  });

  it("accepts twenty legal maximum report summaries while bounding the tool envelope", async () => {
    const reports = Array.from({ length: 20 }, (_, index) => ({
      reportId: `report-${index}-${"a".repeat(100)}`,
      category: "界".repeat(64),
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "界".repeat(64), color: "界".repeat(64), status: "DRAFT" as const, version: 1,
    }));
    const result = await createToolExecutor({ fetcher: vi.fn(async () => json({ reports })) })
      .listReports({ limit: 20 });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_500);
  });

  it("keeps legal escaped review descriptions within the final envelope budget", async () => {
    const maximum = { ...review,
      item: { ...review.item, category: "c".repeat(64), area: "a".repeat(64),
        color: "k".repeat(64), publicDescription: "\\".repeat(256) },
      report: { publicDescription: "\\".repeat(256), version: 2 },
      timeline: Array.from({ length: 5 }, (_, index) => ({ action: "EVIDENCE_INSUFFICIENT",
        actor: "claimant" as const, result: "INSUFFICIENT", occurredAtMs: index })) };
    const result = await createToolExecutor({ fetcher: vi.fn(async () => json(maximum)) })
      .getClaimReviewSummary({ claimId: "claim" });
    expect(result).toMatchObject({ ok: true }); expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_500);
    if (result.ok) { expect(result.data.item.publicDescription.length).toBeGreaterThan(0);
      expect(result.data.report.publicDescription.length).toBeGreaterThan(0); }
  });
});
