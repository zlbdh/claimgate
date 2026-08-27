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

  it("strictly accepts one optional canonical Staff queue limit", () => {
    expect(resolveAuthenticatedRoute(
      new Request("https://example.test/api/staff/claims?limit=3"),
      "api.staff.claims.list",
    ).query).toEqual({ limit: 3 });
    expect(resolveAuthenticatedRoute(
      new Request("https://example.test/api/staff/claims"),
      "api.staff.claims.list",
    ).query).toEqual({});
  });

  it.each([
    "?limit=01", "?limit=0", "?limit=4", "?limit=%31", "?limit=1&",
    "?limit=2&limit=3", "?other=2", "?limit=2&other=2",
  ])("rejects malformed, duplicate, and extra Staff queue query: %s", (query) => {
    expect(() => resolveAuthenticatedRoute(
      new Request(`https://example.test/api/staff/claims${query}`),
      "api.staff.claims.list",
    )).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("accepts only canonical bounded report-list filters", () => {
    expect(resolveAuthenticatedRoute(
      new Request("https://example.test/api/reports?status=DRAFT&limit=20"),
      "api.reports.list",
    ).query).toEqual({ status: "DRAFT", limit: 20 });
    expect(resolveAuthenticatedRoute(
      new Request("https://example.test/api/reports?limit=1"),
      "api.reports.list",
    ).query).toEqual({ limit: 1 });
    for (const query of [
      "?limit=21", "?status=UNKNOWN", "?limit=1&status=DRAFT",
      "?status=DRAFT&limit=1&limit=2", "?status=%44RAFT&limit=1", "?extra=1",
    ]) expect(() => resolveAuthenticatedRoute(
      new Request(`https://example.test/api/reports${query}`),
      "api.reports.list",
    )).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
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

  it.each([
    ["api.claims.status", "/api/claims/claim_A", ["CLAIMANT", "STAFF"]],
    ["api.claims.pickup.instructions", "/api/claims/claim_A/pickup-instructions", ["CLAIMANT"]],
    ["api.staff.claims.list", "/api/staff/claims", ["STAFF"]],
    ["api.staff.claims.review", "/api/staff/claims/claim_A", ["STAFF"]],
  ] as const)("binds authenticated read %s to its exact role and path", (key, path, roles) => {
    const route = getAuthenticatedRoute(key);
    const resolved = resolveAuthenticatedRoute(new Request(`https://example.test${path}`), key);
    expect(route).toMatchObject({
      method: "GET", action: null, allowedRoles: roles, requiresOneTime: false, ratePolicy: null,
    });
    expect(resolved).toMatchObject({ canonicalPath: path });
  });

  it.each([
    ["api.claims.status", "/api/claims/claim%2fA"],
    ["api.claims.pickup.instructions", "/api/claims/claim%2fA/pickup-instructions"],
    ["api.staff.claims.review", "/api/staff/claims/claim%2fA"],
  ] as const)("rejects percent-encoded authenticated read path for %s", (key, path) => {
    expect(() => resolveAuthenticatedRoute(new Request(`https://example.test${path}`), key))
      .toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
