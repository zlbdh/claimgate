import { describe, expect, it, vi } from "vitest";
import { createToolExecutor } from "@/features/webmcp/tool-executor";

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

const claimStatus = {
  claimId: "claim", status: "APPROVED", version: 5,
  failedAttempts: 0, remainingAttempts: 3, evidenceEligible: true,
  unlockCount: 0, rejectionReason: null,
  nextStep: "Generate a pickup pass manually.",
};
const pickup = {
  claimId: "claim", deskName: "Desk 04", hours: "09:00-17:00",
  passReady: false, expiresAtMs: null, generation: 0,
  status: "APPROVED", claimVersion: 5,
};
const queue = { claims: [{
  claimId: "claim", status: "UNDER_REVIEW", failedAttempts: 0,
  waitingDurationMs: 1000, hasConflict: false,
  item: { category: "earbuds", area: "library", color: "black" },
}] };
const review = {
  claim: { claimId: "claim", status: "UNDER_REVIEW", version: 2,
    failedAttempts: 0, remainingAttempts: 3, evidenceEligible: true,
    unlockCount: 0, generation: 0 },
  item: { category: "earbuds", area: "library", color: "black", publicDescription: "Black case." },
  report: { publicDescription: "Lost black case.", version: 2 },
  conflict: { hasConflict: false, conflictCount: 0 },
  timeline: [{ action: "EVIDENCE_ELIGIBLE", actor: "claimant", result: "ELIGIBLE", occurredAtMs: 1000 }],
};

describe("Task 9 fixed HTTP tool executor", () => {
  it("adapts update POST exactly and refreshes only after confirmed success", async () => {
    const effects: Array<() => void> = [];
    const refresh = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => json({
      reportId: "report", status: "DRAFT", version: 2,
      nextPath: "/claimant/reports/report",
    }));
    const executor = createToolExecutor({
      fetcher, updateCsrfToken: "update-csrf", refresh,
      defer: (effect) => effects.push(effect),
    });
    const result = await executor.updateDraft({
      reportId: "report", expectedVersion: 1,
      patch: { color: "black", publicTags: ["wireless"] },
      idempotencyKey: "update-draft-000001",
    });
    expect(result).toEqual({ ok: true, data: { reportId: "report", status: "DRAFT", version: 2 } });
    expect(fetcher).toHaveBeenCalledOnce();
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/reports/report");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect((init!.headers as Record<string, string>)["X-CSRF-Token"]).toBe("update-csrf");
    expect(Object.fromEntries((init!.body as URLSearchParams).entries())).toEqual({
      expectedVersion: "1", color: "black", publicTags: '["wireless"]',
      idempotencyKey: "update-draft-000001",
    });
    expect(refresh).not.toHaveBeenCalled();
    effects.forEach((effect) => effect());
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("consumes the four exact authenticated GET shapes", async () => {
    const effects: Array<() => void> = [];
    const refresh = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path.endsWith("/pickup-instructions")) return json(pickup);
      if (path === "/api/claims/claim") return json(claimStatus);
      if (path === "/api/staff/claims?limit=3") return json(queue);
      if (path === "/api/staff/claims/claim") return json(review);
      return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    const executor = createToolExecutor({ fetcher, refresh, defer: (effect) => effects.push(effect) });
    await expect(executor.getClaimStatus({ claimId: "claim" }))
      .resolves.toEqual({ ok: true, data: claimStatus });
    await expect(executor.getPickupInstructions({ claimId: "claim" }))
      .resolves.toEqual({ ok: true, data: pickup });
    await expect(executor.listPendingClaims({ limit: 3 }))
      .resolves.toEqual({ ok: true, data: queue });
    await expect(executor.getClaimReviewSummary({ claimId: "claim" }))
      .resolves.toEqual({ ok: true, data: review });
    for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect(refresh).not.toHaveBeenCalled();
    expect(effects).toHaveLength(4);
    effects.forEach((effect) => effect());
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("rejects extra, oversized, or wrong-shape successful bodies without forwarding text", async () => {
    for (const body of [
      { ...claimStatus, token: "forbidden" },
      { ...claimStatus, nextStep: "x".repeat(2_000) },
      { ...claimStatus, status: "UNKNOWN" },
    ]) {
      const executor = createToolExecutor({ fetcher: vi.fn(async () => json(body)) });
      await expect(executor.getClaimStatus({ claimId: "claim" })).resolves.toEqual({
        ok: false, error: { code: "INTERNAL_ERROR", message: "Internal server error." },
      });
    }
  });


  it("drops update refresh after its captured generation becomes stale", async () => {
    const effects: Array<() => void> = [];
    const refresh = vi.fn();
    const executor = createToolExecutor({
      updateCsrfToken: "update", refresh, isCurrent: () => false,
      defer: (effect) => effects.push(effect),
      fetcher: vi.fn(async () => json({ reportId: "report", status: "DRAFT", version: 2,
        nextPath: "/claimant/reports/report" })),
    });
    await executor.updateDraft({ reportId: "report", expectedVersion: 1,
      patch: { color: "black" }, idempotencyKey: "update-stale-000001" });
    effects.forEach((effect) => effect());
    expect(refresh).not.toHaveBeenCalled();
  });

  it("drops authenticated read refresh after its captured generation becomes stale", async () => {
    const effects: Array<() => void> = [];
    const refresh = vi.fn();
    const executor = createToolExecutor({
      refresh, isCurrent: () => false, defer: (effect) => effects.push(effect),
      fetcher: vi.fn(async () => json(claimStatus)),
    });
    await executor.getClaimStatus({ claimId: "claim" });
    effects.forEach((effect) => effect());
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(["update", "read"] as const)(
    "safely refreshes current %s STATE_CHANGED but drops it when stale",
    async (kind) => {
      let current = true;
      const effects: Array<() => void> = [];
      const refresh = vi.fn();
      const executor = createToolExecutor({
        updateCsrfToken: "update", refresh, isCurrent: () => current,
        defer: (effect) => effects.push(effect),
        fetcher: vi.fn(async () => json({
          error: { code: "STATE_CHANGED", message: "private server detail" },
        }, 409)),
      });
      const result = kind === "update"
        ? await executor.updateDraft({ reportId: "report", expectedVersion: 1,
            patch: { color: "black" }, idempotencyKey: "state-update-000001" })
        : await executor.getClaimStatus({ claimId: "claim" });
      expect(result).toMatchObject({ ok: false, error: { code: "STATE_CHANGED" } });
      expect(effects).toHaveLength(1);
      effects[0]!();
      expect(refresh).toHaveBeenCalledOnce();
      current = false;
      const staleResult = kind === "update"
        ? await executor.updateDraft({ reportId: "report", expectedVersion: 1,
            patch: { color: "blue" }, idempotencyKey: "state-update-000002" })
        : await executor.getClaimStatus({ claimId: "claim" });
      expect(staleResult).toMatchObject({ ok: false, error: { code: "STATE_CHANGED" } });
      effects[1]!();
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

});
