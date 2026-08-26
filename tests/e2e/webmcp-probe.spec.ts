import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __capturedProbe?: {
      tool: WebMCPTool;
      signal?: AbortSignal;
    };
  }
}

test("keeps manual use interactive under the production nonce CSP", async ({
  page,
}) => {
  const response = await page.goto("/webmcp-probe");
  const csp = response?.headers()["content-security-policy"] ?? "";

  expect(csp).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");

  await expect(page.getByRole("heading", { name: "Compatibility desk" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Agent collaboration needs ChatGPT's in-app browser or a supported Chrome test environment",
  );

  await page.getByRole("button", { name: "Run manual readiness check" }).click();
  await expect(page.getByTestId("hydration-result")).toHaveText(
    "Manual controls are ready.",
  );
});

export {};

test("registers, invokes, and aborts the probe with an injected API contract", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        registerTool(tool: WebMCPTool, options?: { signal?: AbortSignal }) {
          window.__capturedProbe = { tool, signal: options?.signal };
          options?.signal?.addEventListener("abort", () => {
            window.localStorage.setItem("claimgate-probe-aborted", "true");
          });
        },
      },
    });
  });

  await page.goto("/webmcp-probe");
  await expect(page.getByRole("status")).toContainText("Native WebMCP probe registered");

  const result = await page.evaluate(async () => {
    return window.__capturedProbe?.tool.execute({ nonce: "e2e-contract-0826" });
  });
  expect(result).toEqual({
    ok: true,
    nonce: "e2e-contract-0826",
    api: "document.modelContext",
  });

  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await page.evaluate(() => localStorage.getItem("claimgate-probe-aborted"))).toBe(
    "true",
  );
});
