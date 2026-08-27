import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebMcpPageScope,
  WebMcpProvider,
  useWebMcpCandidatePublisher,
} from "./webmcp-provider";

const routerMock = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));

function installContext() {
  const active = new Map<string, WebMCPTool>();
  const registerTool = vi.fn(async (tool: WebMCPTool, options?: { signal?: AbortSignal }) => {
    if (active.has(tool.name)) throw new Error("duplicate tool");
    active.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => active.delete(tool.name), { once: true });
  });
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: { registerTool },
  });
  return { active, registerTool };
}

afterEach(() => {
  Reflect.deleteProperty(document, "modelContext");
  vi.unstubAllGlobals();
  routerMock.push.mockClear();
  routerMock.refresh.mockClear();
});

function PublishCandidate() {
  const publish = useWebMcpCandidatePublisher();
  return <button type="button" onClick={() => publish("report-public", 2, [{
    candidateHandle: `cgch1.1.2.${"A".repeat(43)}`,
    category: "earbuds", timeBand: "same window", area: "library", color: "black",
    confidence: "strong", reasons: ["category match"], expiresAt: 2,
  }])}>Publish safe candidate</button>;
}

describe("real root WebMCP provider", () => {
  it("registers the workspace set, then aborts every tool when scope leaves", async () => {
    const native = installContext();
    const view = render(
      <WebMcpProvider>
        <WebMcpPageScope
          scope={{ role: "CLAIMANT", page: "WORKSPACE" }}
          createCsrfToken="closure-only-create"
        />
      </WebMcpProvider>,
    );
    await waitFor(() => expect([...native.active.keys()].sort()).toEqual([
      "create_lost_report_draft", "list_my_reports",
    ]));
    expect(screen.getByText(/Agent tools ready/i)).toBeInTheDocument();

    view.rerender(<WebMcpProvider><main>Home</main></WebMcpProvider>);
    await waitFor(() => expect(native.active.size).toBe(0));
  });

  it("adds stage only from current report candidate state and clears it on snapshot churn", async () => {
    const native = installContext();
    const view = render(
      <WebMcpProvider>
        <WebMcpPageScope
          scope={{ role: "CLAIMANT", page: "REPORT", reportId: "report-public", reportStatus: "PUBLISHED", reportVersion: 2 }}
          stageCsrfToken="closure-only-stage"
        />
        <PublishCandidate />
      </WebMcpProvider>,
    );
    await waitFor(() => expect([...native.active.keys()].sort()).toEqual([
      "find_candidate_matches", "list_my_reports",
    ]));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Publish safe candidate" })));
    await waitFor(() => expect([...native.active.keys()].sort()).toEqual([
      "find_candidate_matches", "list_my_reports", "stage_claim_candidate",
    ]));

    view.rerender(
      <WebMcpProvider>
        <WebMcpPageScope
          scope={{ role: "CLAIMANT", page: "REPORT", reportId: "report-public", reportStatus: "PUBLISHED", reportVersion: 3 }}
          stageCsrfToken="new-closure-only-stage"
        />
        <PublishCandidate />
      </WebMcpProvider>,
    );
    await waitFor(() => expect([...native.active.keys()].sort()).toEqual([
      "find_candidate_matches", "list_my_reports",
    ]));
    fireEvent.click(screen.getByRole("button", { name: "Publish safe candidate" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(native.active.has("stage_claim_candidate")).toBe(false);
  });

  it("shows a bounded unsupported fallback while leaving manual children usable", () => {
    render(<WebMcpProvider><button type="button">Manual action</button></WebMcpProvider>);
    expect(screen.getByText(/Agent collaboration needs a supported environment/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Manual action" })).toBeEnabled();
  });

  it("invalidates deferred navigation synchronously when the page scope unmounts", async () => {
    const native = installContext();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      reportId: "report-public", status: "DRAFT", version: 1,
      nextPath: "/claimant/reports/report-public",
    }, { status: 201 })));
    const view = render(
      <WebMcpProvider>
        <WebMcpPageScope scope={{ role: "CLAIMANT", page: "WORKSPACE" }} createCsrfToken="create" />
      </WebMcpProvider>,
    );
    await waitFor(() => expect(native.active.has("create_lost_report_draft")).toBe(true));
    const create = native.active.get("create_lost_report_draft")!;
    await create.execute({
      category: "earbuds", timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: [], publicDescription: "Black case.",
      idempotencyKey: "provider-create-000001",
    });
    view.rerender(<WebMcpProvider><main>Home</main></WebMcpProvider>);
    await waitFor(() => expect(native.active.size).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it("does not resurrect stage when an old A find resolves after A to B to A churn", async () => {
    const native = installContext();
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const reportScope = (reportId: string) => ({
      role: "CLAIMANT" as const,
      page: "REPORT" as const,
      reportId,
      reportStatus: "PUBLISHED" as const,
      reportVersion: 2,
    });
    const view = render(
      <WebMcpProvider>
        <WebMcpPageScope scope={reportScope("report-a")} stageCsrfToken="stage-a" />
      </WebMcpProvider>,
    );
    await waitFor(() => expect(native.active.has("find_candidate_matches")).toBe(true));
    const oldFind = native.active.get("find_candidate_matches")!;
    const invocation = oldFind.execute({ reportId: "report-a", limit: 1 });

    view.rerender(
      <WebMcpProvider>
        <WebMcpPageScope scope={reportScope("report-b")} stageCsrfToken="stage-b" />
      </WebMcpProvider>,
    );
    await waitFor(() => expect(native.active.get("find_candidate_matches")).not.toBe(oldFind));
    const bFind = native.active.get("find_candidate_matches");
    view.rerender(
      <WebMcpProvider>
        <WebMcpPageScope scope={reportScope("report-a")} stageCsrfToken="stage-a-new" />
      </WebMcpProvider>,
    );
    await waitFor(() => expect(native.active.get("find_candidate_matches")).not.toBe(bFind));

    resolve(Response.json({
      reportVersion: 2,
      candidates: [{
        candidateHandle: `cgch1.1.2.${"A".repeat(43)}`,
        category: "earbuds", timeBand: "same window", area: "library", color: "black",
        confidence: "strong", reasons: ["category match"], expiresAt: 2,
      }],
      message: "Old A result",
    }));
    await invocation;
    await new Promise((done) => setTimeout(done, 10));
    expect(native.active.has("stage_claim_candidate")).toBe(false);
  });
});
