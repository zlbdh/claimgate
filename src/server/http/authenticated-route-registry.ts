import type { DemoRole } from "@/shared/demo-identity";
import type { RateLimitAction } from "@/server/security/rate-limit";
import {
  INSTANCE_RATE_LIMIT_POLICIES,
  type RateLimitPolicy,
} from "@/server/security/rate-limit-policy";
import { DomainError } from "@/shared/domain-error";

type AuthenticatedRouteDefinition = Readonly<{
  method: "GET" | "POST";
  path: string;
  action: RateLimitAction | null;
  allowedRoles: readonly DemoRole[];
  requiresOneTime: boolean;
  ratePolicy: RateLimitPolicy | null;
}>;

const publicDemoRoles = Object.freeze(["CLAIMANT", "STAFF"] as const);
const claimantRole = Object.freeze(["CLAIMANT"] as const);
const staffRole = Object.freeze(["STAFF"] as const);

export const AUTHENTICATED_ROUTE_REGISTRY = Object.freeze({
  "api.demo.switch-role": Object.freeze({
    method: "POST", path: "/api/demo/switch-role", action: "role_switch",
    allowedRoles: publicDemoRoles, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.role_switch,
  }),
  "api.reports.create": Object.freeze({
    method: "POST", path: "/api/reports", action: "draft_create",
    allowedRoles: claimantRole, requiresOneTime: false,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.draft_create,
  }),
  "api.reports.update": Object.freeze({
    method: "POST", path: "/api/reports/:reportId", action: "draft_update",
    allowedRoles: claimantRole, requiresOneTime: false,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.draft_update,
  }),
  "api.reports.publish": Object.freeze({
    method: "POST", path: "/api/reports/:reportId/publish", action: "report_publish",
    allowedRoles: claimantRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.report_publish,
  }),
  "api.reports.archive": Object.freeze({
    method: "POST", path: "/api/reports/:reportId/archive", action: "report_archive",
    allowedRoles: claimantRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.report_archive,
  }),
  "api.reports.list": Object.freeze({
    method: "GET", path: "/api/reports", action: null,
    allowedRoles: claimantRole, requiresOneTime: false, ratePolicy: null,
  }),
  "api.reports.matches": Object.freeze({
    method: "GET", path: "/api/reports/:reportId/matches", action: "match_find",
    allowedRoles: claimantRole, requiresOneTime: false,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.match_find,
  }),
  "api.claims.stage": Object.freeze({
    method: "POST", path: "/api/claims", action: "claim_stage",
    allowedRoles: claimantRole, requiresOneTime: false,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_stage,
  }),
  "api.claims.status": Object.freeze({
    method: "GET", path: "/api/claims/:claimId", action: null,
    allowedRoles: publicDemoRoles, requiresOneTime: false, ratePolicy: null,
  }),
  "api.claims.pickup.instructions": Object.freeze({
    method: "GET", path: "/api/claims/:claimId/pickup-instructions", action: null,
    allowedRoles: claimantRole, requiresOneTime: false, ratePolicy: null,
  }),
  "api.claims.evidence": Object.freeze({
    method: "POST", path: "/api/claims/:claimId/evidence", action: "evidence_submit",
    allowedRoles: claimantRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.evidence_submit,
  }),
  "api.claims.pickup.issue": Object.freeze({
    method: "POST", path: "/api/claims/:claimId/pickup-pass/issue", action: "pickup_issue",
    allowedRoles: claimantRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.pickup_issue,
  }),
  "api.claims.pickup.reissue": Object.freeze({
    method: "POST", path: "/api/claims/:claimId/pickup-pass/reissue", action: "pickup_reissue",
    allowedRoles: claimantRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.pickup_reissue,
  }),
  "api.staff.claims.approve": Object.freeze({
    method: "POST", path: "/api/staff/claims/:claimId/approve", action: "claim_approve",
    allowedRoles: staffRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_approve,
  }),
  "api.staff.claims.reject": Object.freeze({
    method: "POST", path: "/api/staff/claims/:claimId/reject", action: "claim_reject",
    allowedRoles: staffRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_reject,
  }),
  "api.staff.claims.unlock": Object.freeze({
    method: "POST", path: "/api/staff/claims/:claimId/unlock", action: "claim_unlock",
    allowedRoles: staffRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.claim_unlock,
  }),
  "api.staff.claims.handoff": Object.freeze({
    method: "POST", path: "/api/staff/claims/:claimId/handoff", action: "handoff",
    allowedRoles: staffRole, requiresOneTime: true,
    ratePolicy: INSTANCE_RATE_LIMIT_POLICIES.handoff,
  }),
  "api.staff.claims.list": Object.freeze({
    method: "GET", path: "/api/staff/claims", action: null,
    allowedRoles: staffRole, requiresOneTime: false, ratePolicy: null,
  }),
  "api.staff.claims.review": Object.freeze({
    method: "GET", path: "/api/staff/claims/:claimId", action: null,
    allowedRoles: staffRole, requiresOneTime: false, ratePolicy: null,
  }),
} satisfies Record<string, AuthenticatedRouteDefinition>);

export type AuthenticatedRouteKey = keyof typeof AUTHENTICATED_ROUTE_REGISTRY;
export type AuthenticatedRouteQuery = Readonly<{
  limit?: number;
  status?: "DRAFT" | "PUBLISHED" | "RESOLVED" | "ARCHIVED";
}>;

export type ResolvedAuthenticatedRoute = Readonly<{
  canonicalPath: string;
  csrfRouteId: string;
  params: Readonly<Record<string, string>>;
  query: AuthenticatedRouteQuery;
}>;

export function getAuthenticatedRoute(
  routeKey: AuthenticatedRouteKey,
): AuthenticatedRouteDefinition {
  if (!Object.prototype.hasOwnProperty.call(AUTHENTICATED_ROUTE_REGISTRY, routeKey)) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  return AUTHENTICATED_ROUTE_REGISTRY[routeKey];
}

function resolvePath(template: string, pathname: string): {
  canonicalPath: string;
  params: Readonly<Record<string, string>>;
} {
  if (pathname.includes("%")) throw new DomainError("FORBIDDEN");
  const expected = template.split("/");
  const supplied = pathname.split("/");
  if (expected.length !== supplied.length) throw new DomainError("FORBIDDEN");
  const params: Record<string, string> = {};
  const canonical: string[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const segment = supplied[index]!;
    const templateSegment = expected[index]!;
    if (templateSegment.startsWith(":")) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(segment)) {
        throw new DomainError("FORBIDDEN");
      }
      params[templateSegment.slice(1)] = segment;
      canonical.push(segment);
    } else {
      if (segment !== templateSegment) throw new DomainError("FORBIDDEN");
      canonical.push(templateSegment);
    }
  }
  return { canonicalPath: canonical.join("/"), params: Object.freeze(params) };
}

function resolveReportListQuery(url: URL): AuthenticatedRouteQuery {
  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => key !== "status" && key !== "limit")
    || url.searchParams.getAll("status").length > 1
    || url.searchParams.getAll("limit").length > 1
  ) throw new DomainError("FORBIDDEN");
  const status = url.searchParams.get("status");
  const limit = url.searchParams.get("limit");
  if (
    status !== null && !["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"].includes(status)
    || limit !== null && (!/^(?:[1-9]|1[0-9]|20)$/.test(limit))
  ) throw new DomainError("FORBIDDEN");
  const canonical = status === null
    ? limit === null ? "" : `?limit=${limit}`
    : limit === null ? `?status=${status}` : `?status=${status}&limit=${limit}`;
  if (url.search !== canonical) throw new DomainError("FORBIDDEN");
  return Object.freeze({
    ...(status === null ? {} : { status: status as AuthenticatedRouteQuery["status"] }),
    ...(limit === null ? {} : { limit: Number(limit) }),
  });
}

function resolveQuery(url: URL, routeKey: AuthenticatedRouteKey): AuthenticatedRouteQuery {
  if (routeKey === "api.reports.list") return resolveReportListQuery(url);
  const limitMaximum = routeKey === "api.reports.matches"
    ? 3
    : routeKey === "api.staff.claims.list"
      ? 3
      : null;
  if (limitMaximum === null) {
    if (url.search !== "") throw new DomainError("FORBIDDEN");
    return Object.freeze({});
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "limit") || url.searchParams.getAll("limit").length > 1) {
    throw new DomainError("FORBIDDEN");
  }
  const value = url.searchParams.get("limit");
  if (value === null) return Object.freeze({});
  if (!/^[1-9]$/.test(value) || Number(value) > limitMaximum) throw new DomainError("FORBIDDEN");
  if (url.search !== `?limit=${value}`) throw new DomainError("FORBIDDEN");
  return Object.freeze({ limit: Number(value) });
}

export function resolveAuthenticatedRoute(
  request: Request,
  routeKey: AuthenticatedRouteKey,
): ResolvedAuthenticatedRoute {
  const route = getAuthenticatedRoute(routeKey);
  const url = new URL(request.url);
  if (request.method !== route.method || url.hash !== "") throw new DomainError("FORBIDDEN");
  const { canonicalPath, params } = resolvePath(route.path, url.pathname);
  const query = resolveQuery(url, routeKey);
  return Object.freeze({
    canonicalPath,
    csrfRouteId: Object.keys(params).length === 0 ? routeKey : canonicalPath.slice(1),
    params,
    query,
  });
}
