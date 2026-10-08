import { describe, expect, it, vi } from "vitest";
import { performSameOriginWrite } from "./same-origin-write";

describe("Future WebMCP write transport constraints", () => {
  it("fixes the relative URL and no-store/same-origin/redirect-error settings and attaches CSRF internally", async () => {
    type FetchStub = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    const fetcher = vi.fn<FetchStub>(async () => new Response(null, { status: 204 }));
    await performSameOriginWrite({
      path: "/api/reports",
      csrfToken: "internal-token",
      body: "payload",
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledWith("/api/reports", expect.objectContaining({
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      body: "payload",
      headers: expect.any(Headers),
    }));
    const init = fetcher.mock.calls[0][1]!;
    expect((init.headers as Headers).get("x-csrf-token")).toBe("internal-token");
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain("csrfToken");
  });

  it.each([
    "https://example.test/api/reports",
    "//example.test/api/reports",
    "/api/reports?token=x",
    "/api/reports#token",
    "api/reports",
  ])("rejects unapproved relative API paths: %s", async (path) => {
    await expect(performSameOriginWrite({
      path,
      csrfToken: "internal-token",
      body: "payload",
      fetcher: vi.fn(),
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });
});
