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
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const response = await page.goto("/webmcp-probe");
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(response?.headers()["referrer-policy"]).toBe("same-origin");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["x-frame-options"]).toBe("DENY");
  expect(response?.headers()["permissions-policy"]).toBe(
    "camera=(), geolocation=(), microphone=(), tools=(self)",
  );
  expect(response?.headers()["x-nonce"]).toBeUndefined();

  expect(csp).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  expect(csp).not.toContain("'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  const scriptNonces = await page.locator("script").evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).nonce),
  );
  expect(scriptNonces.length).toBeGreaterThan(0);
  expect(new Set(scriptNonces)).toEqual(new Set([nonce]));

  const freshResponse = await page.request.get("/webmcp-probe");
  const freshCsp = freshResponse.headers()["content-security-policy"] ?? "";
  expect(freshCsp.match(/'nonce-([^']+)'/)?.[1]).not.toBe(nonce);

  await expect(page.getByRole("heading", { name: "Compatibility desk" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "Agent collaboration needs ChatGPT's in-app browser or a supported Chrome test environment",
  );

  await page.getByRole("button", { name: "Run manual readiness check" }).click();
  await expect(page.getByTestId("hydration-result")).toHaveText(
    "Manual controls are ready.",
  );
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
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
