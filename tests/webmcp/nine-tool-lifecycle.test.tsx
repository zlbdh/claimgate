import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebMcpPageScope, WebMcpProvider } from "@/components/webmcp-provider";

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

function installContext() {
  const active = new Map<string, WebMCPTool>();
  const signals = new Map<string, AbortSignal>();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { async registerTool(tool: WebMCPTool, options?: { signal?: AbortSignal }) {
      active.set(tool.name, tool);
      if (options?.signal) signals.set(tool.name, options.signal);
      options?.signal?.addEventListener("abort", () => active.delete(tool.name), { once: true });
    } },
  });
  return { active, signals };
}

afterEach(() => {
  Reflect.deleteProperty(document, "modelContext");
  vi.unstubAllGlobals();
  router.push.mockClear();
  router.refresh.mockClear();
});

function names(active: Map<string, WebMCPTool>) {
  return [...active.keys()].sort();
}

describe("Task 9 provider lifecycle and state synchronization", () => {
  it("replaces exact report and claim sets while aborting old registrations", async () => {
    const native = installContext();
    const view = render(<WebMcpProvider><WebMcpPageScope scope={{
      role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "DRAFT", reportVersion: 1,
    }} updateCsrfToken="update" /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual([
      "list_my_reports", "update_lost_report_draft",
    ]));
    const oldUpdate = native.active.get("update_lost_report_draft")!;
    const oldSignal = native.signals.get("update_lost_report_draft")!;

    view.rerender(<WebMcpProvider><WebMcpPageScope scope={{
      role: "CLAIMANT", page: "REPORT", reportId: "r", reportStatus: "PUBLISHED", reportVersion: 2,
    }} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual([
      "find_candidate_matches", "list_my_reports",
    ]));
    expect(oldSignal.aborted).toBe(true);
    expect(native.active.get("update_lost_report_draft")).not.toBe(oldUpdate);

    for (const [status, expected] of [
      ["EVIDENCE_REQUIRED", ["get_claim_status"]],
      ["UNDER_REVIEW", ["get_claim_status"]],
      ["APPROVED", ["get_claim_status", "get_pickup_instructions"]],
      ["PICKUP_READY", ["get_claim_status", "get_pickup_instructions"]],
      ["COLLECTED", ["get_claim_status"]],
    ] as const) {
      view.rerender(<WebMcpProvider><WebMcpPageScope scope={{
        role: "CLAIMANT", page: "CLAIM", claimId: "c", claimStatus: status, claimVersion: 3,
      }} /></WebMcpProvider>);
      await waitFor(() => expect(names(native.active)).toEqual([...expected].sort()));
    }
  });

  it("switches Claimant and Staff scopes without exposing human-only actions", async () => {
    const native = installContext();
    const view = render(<WebMcpProvider><WebMcpPageScope scope={{
      role: "STAFF", page: "STAFF_QUEUE",
    }} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual(["list_pending_claims"]));
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={{
      role: "STAFF", page: "CLAIM", claimId: "c", claimStatus: "UNDER_REVIEW", claimVersion: 2,
    }} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual([
      "get_claim_review_summary", "get_claim_status",
    ]));
    expect(names(native.active).join(" ")).not.toMatch(/approve|reject|unlock|handoff|issue|publish/i);
  });

  it("executes a read callback and records only bounded safe activity", async () => {
    const native = installContext();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      claimId: "claim", status: "EVIDENCE_REQUIRED", version: 1,
      failedAttempts: 0, remainingAttempts: 3, evidenceEligible: false,
      unlockCount: 0, rejectionReason: null, nextStep: "Submit evidence manually.",
    })));
    const view = render(<WebMcpProvider><WebMcpPageScope scope={{
      role: "CLAIMANT", page: "CLAIM", claimId: "claim",
      claimStatus: "EVIDENCE_REQUIRED", claimVersion: 1,
    }} /></WebMcpProvider>);
    await waitFor(() => expect(native.active.has("get_claim_status")).toBe(true));
    await act(async () => {
      await native.active.get("get_claim_status")!.execute({ claimId: "claim" });
    });
    await waitFor(() => expect(view.container.querySelector(".agent-activity")?.textContent)
      .toContain("get_claim_status"));
    expect(view.container.querySelector(".agent-activity")?.textContent)
      .not.toMatch(/Submit evidence manually|claim-public|cookie|csrf|token/i);
  });

  it("drops stale activity when delayed execute completes after A to B to A churn", async () => {
    const native = installContext();
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const scope = (claimId: string) => ({
      role: "CLAIMANT" as const, page: "CLAIM" as const, claimId,
      claimStatus: "EVIDENCE_REQUIRED" as const, claimVersion: 1,
    });
    const view = render(<WebMcpProvider><WebMcpPageScope scope={scope("claim-a")} /></WebMcpProvider>);
    await waitFor(() => expect(native.active.has("get_claim_status")).toBe(true));
    const oldStatus = native.active.get("get_claim_status")!;
    const invocation = oldStatus.execute({ claimId: "claim-a" });
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("claim-b")} /></WebMcpProvider>);
    await waitFor(() => expect(native.active.get("get_claim_status")).not.toBe(oldStatus));
    const bStatus = native.active.get("get_claim_status");
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("claim-a")} /></WebMcpProvider>);
    await waitFor(() => expect(native.active.get("get_claim_status")).not.toBe(bStatus));
    await act(async () => {
      resolve(Response.json({
        claimId: "claim-a", status: "EVIDENCE_REQUIRED", version: 1,
        failedAttempts: 0, remainingAttempts: 3, evidenceEligible: false,
        unlockCount: 0, rejectionReason: null, nextStep: "Submit evidence manually.",
      }));
      await invocation;
    });
    await new Promise((done) => setTimeout(done, 0));
    expect(view.container.querySelector(".agent-activity")?.textContent)
      .not.toContain("get_claim_status");
  });

  it("removes the staged-claim tool after a later candidate lookup becomes stale", async () => {
    const native = installContext();
    const candidateHandle = `cgch1.1.2.${"A".repeat(43)}`;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({
        reportVersion: 2,
        candidates: [{
          candidateHandle, category: "earbuds", timeBand: "near", area: "library",
          color: "black", confidence: "strong", reasons: ["same area"], expiresAt: 2,
        }],
        message: "One candidate.",
      }))
      .mockResolvedValueOnce(Response.json({
        error: { code: "STATE_CHANGED", message: "stale" },
      }, { status: 409 })));
    render(<WebMcpProvider><WebMcpPageScope scope={{
      role: "CLAIMANT", page: "REPORT", reportId: "r",
      reportStatus: "PUBLISHED", reportVersion: 2,
    }} /></WebMcpProvider>);
    await waitFor(() => expect(native.active.has("find_candidate_matches")).toBe(true));
    await act(async () => {
      await native.active.get("find_candidate_matches")!.execute({ reportId: "r", limit: 1 });
    });
    await waitFor(() => expect(native.active.has("stage_claim_candidate")).toBe(true));
    await act(async () => {
      await native.active.get("find_candidate_matches")!.execute({ reportId: "r", limit: 1 });
    });
    await waitFor(() => expect(native.active.has("stage_claim_candidate")).toBe(false));
  });

  it("refreshes after read results and tears down tools across Claimant and Staff states", async () => {
    const native = installContext();
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const path = String(input);
      if (path.endsWith("/pickup-instructions")) return Response.json({
        claimId: "c", deskName: "Desk 04", hours: "09:00-17:00", passReady: false,
        expiresAtMs: null, generation: 0, status: "APPROVED", claimVersion: 5,
      });
      if (path.startsWith("/api/staff/claims/")) return Response.json({
        claim: { claimId: "c", status: "UNDER_REVIEW", version: 2,
          failedAttempts: 0, remainingAttempts: 3, evidenceEligible: true,
          unlockCount: 0, generation: 0 },
        item: { category: "earbuds", area: "library", color: "black", publicDescription: "Case." },
        report: { publicDescription: "Lost case.", version: 2 },
        conflict: { hasConflict: false, conflictCount: 0 }, timeline: [],
      });
      return Response.json({
        claimId: "c", status: "APPROVED", version: 5,
        failedAttempts: 0, remainingAttempts: 3, evidenceEligible: true,
        unlockCount: 0, rejectionReason: null, nextStep: "Generate pass manually.",
      });
    }));
    const scope = (role: "CLAIMANT" | "STAFF", status: "UNDER_REVIEW" | "APPROVED" | "PICKUP_READY" | "COLLECTED") => ({
      role, page: "CLAIM" as const, claimId: "c", claimStatus: status, claimVersion: 5,
    });
    const view = render(<WebMcpProvider><WebMcpPageScope scope={scope("CLAIMANT", "APPROVED")} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual(["get_claim_status", "get_pickup_instructions"]));
    const approvedPickupSignal = native.signals.get("get_pickup_instructions")!;
    await act(async () => { await native.active.get("get_claim_status")!.execute({ claimId: "c" }); });
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("CLAIMANT", "PICKUP_READY")} /></WebMcpProvider>);
    await waitFor(() => expect(approvedPickupSignal.aborted).toBe(true));
    const readyPickupSignal = native.signals.get("get_pickup_instructions")!;
    await act(async () => { await native.active.get("get_pickup_instructions")!.execute({ claimId: "c" }); });
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(2));
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("CLAIMANT", "COLLECTED")} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual(["get_claim_status"]));
    expect(readyPickupSignal.aborted).toBe(true);

    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("STAFF", "UNDER_REVIEW")} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual(["get_claim_review_summary", "get_claim_status"]));
    const reviewSignal = native.signals.get("get_claim_review_summary")!;
    await act(async () => { await native.active.get("get_claim_review_summary")!.execute({ claimId: "c" }); });
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(3));
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("STAFF", "APPROVED")} /></WebMcpProvider>);
    await waitFor(() => expect(reviewSignal.aborted).toBe(true));
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("STAFF", "PICKUP_READY")} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual(["get_claim_review_summary", "get_claim_status"]));
    const pickupReviewSignal = native.signals.get("get_claim_review_summary")!;
    view.rerender(<WebMcpProvider><WebMcpPageScope scope={scope("STAFF", "COLLECTED")} /></WebMcpProvider>);
    await waitFor(() => expect(names(native.active)).toEqual(["get_claim_status"]));
    expect(pickupReviewSignal.aborted).toBe(true);
  });
});
