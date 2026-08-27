import { describe, expect, it, vi } from "vitest";
import { createToolExecutor } from "@/features/webmcp/tool-executor";

const candidate = {
  candidateHandle: `cgch1.1.2.${"A".repeat(43)}`,
  category: "earbuds",
  timeBand: "same two-hour window",
  area: "library",
  color: "black",
  confidence: "strong" as const,
  reasons: ["category match"],
  expiresAt: 2,
};

function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("real HTTP tool executor", () => {
  it("uses fixed same-origin report routes and consumes bounded list summaries", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path === "/api/reports" && init?.method === "POST") {
        expect(init).toMatchObject({
          mode: "same-origin", credentials: "same-origin", cache: "no-store", redirect: "error",
        });
        expect(new Headers(init.headers).get("x-csrf-token")).toBe("closure-create-token");
        expect(String(init.body)).not.toContain("csrf");
        return response({ reportId: "report-public", status: "DRAFT", version: 1, nextPath: "/claimant/reports/report-public" }, 201);
      }
      expect(path).toBe("/api/reports?status=DRAFT&limit=1");
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
      expect(new Headers(init?.headers).has("x-csrf-token")).toBe(false);
      return response({ reports: [{
        reportId: "report-public", category: "earbuds",
        timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
        area: "library", color: "black", status: "DRAFT", version: 1,
      }] });
    });
    const executor = createToolExecutor({ fetcher, createCsrfToken: "closure-create-token" });
    await expect(executor.createDraft({
      category: "earbuds", timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: ["wireless"],
      publicDescription: "Black earbud case.", idempotencyKey: "tool-create-00000001",
    })).resolves.toMatchObject({ ok: true, nextPath: "/claimant/reports/report-public" });
    const listed = await executor.listReports({ status: "DRAFT", limit: 1 });
    expect(listed).toEqual({ ok: true, data: { reports: [{
      reportId: "report-public", category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", status: "DRAFT", version: 1,
    }] } });
    expect(JSON.stringify(listed)).not.toMatch(/publicTags|publicDescription|closure-create-token/);
  });

  it("returns the native result before deferred candidate publication and navigation", async () => {
    const deferred: Array<() => void> = [];
    const publishCandidates = vi.fn();
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes("/matches")) {
        return response({ reportVersion: 2, candidates: [candidate], message: "One candidate." });
      }
      return response({
        claimId: "claim-public", status: "EVIDENCE_REQUIRED", version: 1,
        remainingAttempts: 3, nextPath: "/claimant/claims/claim-public",
      }, 201);
    });
    const executor = createToolExecutor({
      fetcher, stageCsrfToken: "closure-stage-token",
      defer: (callback) => { deferred.push(callback); }, publishCandidates, navigate,
    });
    const found = await executor.findCandidates({ reportId: "report-public", limit: 1 });
    expect(found).toEqual({ ok: true, data: { reportVersion: 2, candidates: [candidate], message: "One candidate." } });
    expect(publishCandidates).not.toHaveBeenCalled();
    deferred.shift()!();
    expect(publishCandidates).toHaveBeenCalledWith("report-public", 2, [candidate]);

    const staged = await executor.stageClaim({
      reportId: "report-public", candidateHandle: candidate.candidateHandle,
      expectedVersion: 2, idempotencyKey: "tool-stage-00000001",
    });
    expect(staged).toMatchObject({ ok: true, nextPath: "/claimant/claims/claim-public" });
    expect(navigate).not.toHaveBeenCalled();
    deferred.shift()!();
    expect(navigate).toHaveBeenCalledWith("/claimant/claims/claim-public");
  });

  it("maps known HTTP failures and hides malformed/unknown bodies", async () => {
    const known = createToolExecutor({ fetcher: vi.fn(async () => response({
      error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
    }, 429, { "retry-after": "7" })) });
    await expect(known.listReports({})).resolves.toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later.", retryAfterSeconds: 7 },
    });

    const malformed = createToolExecutor({ fetcher: vi.fn(async () => response({
      error: { code: "SQLITE_PRIVATE", message: "stack and secret" }, extra: true,
    }, 500)) });
    await expect(malformed.listReports({})).resolves.toEqual({
      ok: false, error: { code: "INTERNAL_ERROR", message: "Internal server error." },
    });
  });

  it("ignores forged HTTP messages and invalid retry metadata", async () => {
    const forged = createToolExecutor({ fetcher: vi.fn(async () => response({
      error: { code: "FORBIDDEN", message: "session=SECRET C:/private.db" },
    }, 403)) });
    await expect(forged.listReports({})).resolves.toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "You are not allowed to perform this action." },
    });

    const invalidRetry = createToolExecutor({ fetcher: vi.fn(async () => response({
      error: { code: "RATE_LIMITED", message: "private rate state" },
    }, 429, { "retry-after": "99999" })) });
    await expect(invalidRetry.listReports({})).resolves.toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." },
    });
  });

  it("preserves confirmed write success when defer or its callback throws", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === "/api/claims"
      ? response({
          claimId: "claim-public", status: "EVIDENCE_REQUIRED", version: 1,
          remainingAttempts: 3, nextPath: "/claimant/claims/claim-public",
        }, 201)
      : response({
          reportId: "report-public", status: "DRAFT", version: 1,
          nextPath: "/claimant/reports/report-public",
        }, 201));
    const throwingScheduler = createToolExecutor({
      fetcher, createCsrfToken: "create", stageCsrfToken: "stage",
      defer: () => { throw new Error("scheduler private stack"); },
    });
    await expect(throwingScheduler.createDraft({
      category: "earbuds", timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: [], publicDescription: "Black case.",
      idempotencyKey: "defer-create-0000001",
    })).resolves.toMatchObject({ ok: true, nextPath: "/claimant/reports/report-public" });
    await expect(throwingScheduler.stageClaim({
      reportId: "report-public", candidateHandle: candidate.candidateHandle,
      expectedVersion: 2, idempotencyKey: "defer-stage-00000001",
    })).resolves.toMatchObject({ ok: true, nextPath: "/claimant/claims/claim-public" });

    const throwingCallback = createToolExecutor({
      fetcher, createCsrfToken: "create", defer: (callback) => callback(),
      navigate: () => { throw new Error("router private stack"); },
    });
    await expect(throwingCallback.createDraft({
      category: "earbuds", timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: [], publicDescription: "Black case.",
      idempotencyKey: "callback-create-00001",
    })).resolves.toMatchObject({ ok: true, nextPath: "/claimant/reports/report-public" });
    const throwingPublish = createToolExecutor({
      fetcher: vi.fn(async () => response({ reportVersion: 2, candidates: [candidate], message: "One." })),
      defer: (callback) => callback(),
      publishCandidates: () => { throw new Error("candidate private stack"); },
    });
    await expect(throwingPublish.findCandidates({ reportId: "report-public", limit: 1 }))
      .resolves.toMatchObject({ ok: true, data: { reportVersion: 2 } });
  });

  it("drops deferred effects after their captured generation becomes stale", async () => {
    const deferred: Array<() => void> = [];
    const navigate = vi.fn();
    const publishCandidates = vi.fn();
    const options = {
      fetcher: vi.fn<typeof fetch>(async (input) => String(input).includes("matches")
        ? response({ reportVersion: 2, candidates: [candidate], message: "One candidate." })
        : response({ reportId: "report-public", status: "DRAFT", version: 1, nextPath: "/claimant/reports/report-public" }, 201)),
      createCsrfToken: "create", defer: (callback: () => void) => deferred.push(callback),
      navigate, publishCandidates, isCurrent: () => false,
    } as unknown as Parameters<typeof createToolExecutor>[0];
    const executor = createToolExecutor(options);
    await executor.createDraft({
      category: "earbuds", timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: [], publicDescription: "Black case.",
      idempotencyKey: "stale-create-0000001",
    });
    await executor.findCandidates({ reportId: "report-public", limit: 1 });
    deferred.forEach((callback) => callback());
    expect(navigate).not.toHaveBeenCalled();
    expect(publishCandidates).not.toHaveBeenCalled();
  });
});
