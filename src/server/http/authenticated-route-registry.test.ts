import { describe, expect, it } from "vitest";
import { resolveAuthenticatedRoute } from "./authenticated-route-registry";

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
});
