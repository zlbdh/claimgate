import { describe, expect, it } from "vitest";
import { getAuthenticatedRoute, resolveAuthenticatedRoute } from "./authenticated-route-registry";

describe("authenticated dynamic route registry", () => {
  it("extracts one bounded canonical report segment from the request path", () => {
    const resolved = resolveAuthenticatedRoute(
      new Request("https://example.test/api/reports/report_A-17/publish", { method: "POST" }),
      "api.reports.publish",
    );
    expect(resolved).toEqual({
      canonicalPath: "/api/reports/report_A-17/publish",
      csrfRouteId: "api/reports/report_A-17/publish",
      params: { reportId: "report_A-17" },
      query: {},
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.params)).toBe(true);
  });

  it.each([
    "/api/reports/a%2Fb/publish",
    "/api/reports/%2e/publish",
    "/api/reports/../publish",
    `/api/reports/${"a".repeat(129)}/publish`,
    "/api/reports/a!/publish",
    "/api/reports/a/publish/extra",
  ])("rejects unsafe or noncanonical dynamic paths: %s", (path) => {
    expect(() => resolveAuthenticatedRoute(
      new Request(`https://example.test${path}`, { method: "POST" }),
      "api.reports.publish",
    )).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("strictly accepts one optional canonical match limit", () => {
    expect(resolveAuthenticatedRoute(
      new Request("https://example.test/api/reports/r1/matches?limit=2"),
      "api.reports.matches",
    ).query).toEqual({ limit: 2 });
    expect(resolveAuthenticatedRoute(
      new Request("https://example.test/api/reports/r1/matches"),
      "api.reports.matches",
    ).query).toEqual({});
  });

  it.each([
    "?limit=02",
    "?limit=0",
    "?limit=4",
    "?limit=2&limit=3",
    "?other=2",
    "?limit=2&other=2",
  ])("rejects malformed, duplicate, and extra match query: %s", (query) => {
    expect(() => resolveAuthenticatedRoute(
      new Request(`https://example.test/api/reports/r1/matches${query}`),
      "api.reports.matches",
    )).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("rejects wrong methods before a handler reads a body", () => {
    expect(() => resolveAuthenticatedRoute(
      new Request("https://example.test/api/reports/r1", { method: "GET" }),
      "api.reports.update",
    )).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it.each([
    ["api.claims.evidence", "/api/claims/claim_A/evidence", "evidence_submit", "CLAIMANT"],
    ["api.staff.claims.approve", "/api/staff/claims/claim_A/approve", "claim_approve", "STAFF"],
    ["api.staff.claims.reject", "/api/staff/claims/claim_A/reject", "claim_reject", "STAFF"],
    ["api.staff.claims.unlock", "/api/staff/claims/claim_A/unlock", "claim_unlock", "STAFF"],
  ] as const)("binds %s to one concrete one-time role/action path", (key, path, action, role) => {
    const route = getAuthenticatedRoute(key);
    const resolved = resolveAuthenticatedRoute(
      new Request(`https://example.test${path}`, { method: "POST" }),
      key,
    );
    expect(route).toMatchObject({
      method: "POST",
      action,
      allowedRoles: [role],
      requiresOneTime: true,
      ratePolicy: expect.any(Object),
    });
    expect(resolved).toEqual({
      canonicalPath: path,
      csrfRouteId: path.slice(1),
      params: { claimId: "claim_A" },
      query: {},
    });
  });
});
