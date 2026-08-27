import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import nextConfig from "../../../next.config";
import { proxy } from "../../proxy";

async function configuredHeaders() {
  if (!nextConfig.headers) throw new Error("Next security headers are not configured");
  return nextConfig.headers();
}

function headerRecord(headers: Array<{ key: string; value: string }>) {
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]));
}

function requireCsp(response: Response): string {
  const csp = response.headers.get("content-security-policy");
  if (!csp) throw new Error("CSP is missing");
  return csp;
}

describe("production security headers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("locks the global browser policy and explicitly scopes WebMCP tools to self", async () => {
    const rules = await configuredHeaders();
    const global = rules.find(({ source }) => source === "/(.*)");

    expect(global).toBeDefined();
    expect(headerRecord(global!.headers)).toEqual({
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), tools=(self)",
    });
  });

  it("keeps manual credential endpoints private with no referrer", async () => {
    const rules = await configuredHeaders();
    const sensitive = rules.filter(({ source }) => source !== "/(.*)");

    expect(sensitive.map(({ source }) => source)).toEqual([
      "/api/claims/:claimId/pickup-pass/issue",
      "/api/claims/:claimId/pickup-pass/reissue",
      "/api/staff/claims/:claimId/handoff",
    ]);
    for (const rule of sensitive) {
      expect(headerRecord(rule.headers)).toEqual({
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
      });
    }
  });

  it("binds one fresh nonce to request and response CSP without exposing x-nonce", () => {
    vi.stubEnv("NODE_ENV", "production");
    const first = proxy(new NextRequest("https://example.test/webmcp-probe"));
    const second = proxy(new NextRequest("https://example.test/webmcp-probe"));
    const firstCsp = requireCsp(first);
    const secondCsp = requireCsp(second);
    const firstNonce = firstCsp.match(/'nonce-([^']+)'/)?.[1];
    const secondNonce = secondCsp.match(/'nonce-([^']+)'/)?.[1];

    expect(firstNonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(secondNonce).not.toBe(firstNonce);
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(firstCsp);
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(firstNonce);
    expect(first.headers.get("x-nonce")).toBeNull();
    expect(firstCsp).toContain("script-src 'self' 'nonce-");
    expect(firstCsp).toContain("'strict-dynamic'");
    expect(firstCsp).not.toContain("'unsafe-inline'");
    expect(firstCsp).not.toContain("'unsafe-eval'");
  });

  it("allows unsafe-eval only for the development runtime", () => {
    vi.stubEnv("NODE_ENV", "development");
    const development = requireCsp(proxy(new NextRequest("http://localhost:3000/")));
    vi.stubEnv("NODE_ENV", "production");
    const production = requireCsp(proxy(new NextRequest("https://example.test/")));

    expect(development).toContain("'unsafe-eval'");
    expect(development).not.toContain("'unsafe-inline'");
    expect(production).not.toContain("'unsafe-eval'");
  });

  it.each(["/claimant", "/claimant/claims/c1", "/staff", "/staff/claims/c1"])(
    "marks authenticated page %s private and non-cacheable",
    (pathname) => {
      const response = proxy(new NextRequest(`https://example.test${pathname}`));
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );
});
