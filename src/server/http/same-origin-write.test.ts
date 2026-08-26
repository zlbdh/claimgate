import { describe, expect, it, vi } from "vitest";
import { performSameOriginWrite } from "./same-origin-write";

describe("未来 WebMCP write transport 约束", () => {
  it("固定 relative URL 和 no-store/same-origin/redirect-error，内部附加 CSRF", async () => {
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
  ])("拒绝非固定 relative API path：%s", async (path) => {
    await expect(performSameOriginWrite({
      path,
      csrfToken: "internal-token",
      body: "payload",
      fetcher: vi.fn(),
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
  });
});
