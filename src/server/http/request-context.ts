import type { CsrfMetadata, CsrfService } from "@/features/auth/csrf";
import { DEMO_SESSION_COOKIE, type DemoSessionSigner } from "@/features/auth/demo-session";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { PersistentRateLimiter, RateLimitAction } from "@/server/security/rate-limit";
import { INSTANCE_RATE_LIMIT_POLICIES } from "@/server/security/rate-limit-policy";
import type { AppOrigin } from "@/shared/app-origin";
import type { DemoRole, DemoUserId } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import {
  getAuthenticatedRoute,
  resolveAuthenticatedRoute,
  type AuthenticatedRouteKey,
} from "./authenticated-route-registry";
import { throwRateLimited } from "./api-error";
import { requireAuthenticatedReadOrigin, requireAuthenticatedWriteOrigin } from "./origin";

export type AuthenticatedRequestPreflight = Readonly<{
  sessionId: string;
  demoInstanceId: string;
  userId: DemoUserId;
  role: DemoRole;
  expiresAt: number;
  routeKey: AuthenticatedRouteKey;
  action: RateLimitAction;
  csrfRouteId: string;
  canonicalPath: string;
  params: Readonly<Record<string, string>>;
}>;

export type AuthenticatedRequestContext = Readonly<{
  sessionId: string;
  demoInstanceId: string;
  userId: DemoUserId;
  role: DemoRole;
  expiresAt: number;
  action: RateLimitAction;
  csrf: CsrfMetadata;
}>;

const issuedPreflights = new WeakSet<object>();
const issuedContexts = new WeakSet<object>();
const issuedReadContexts = new WeakSet<object>();

function readSessionCookie(headers: Headers): string {
  const raw = headers.get("cookie");
  if (!raw || raw.includes(",")) throw new DomainError("AUTH_REQUIRED");
  const matches = raw.split(";").map((part) => part.trim()).flatMap((part) => {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index) !== DEMO_SESSION_COOKIE) return [];
    return [part.slice(index + 1)];
  });
  if (matches.length !== 1 || !matches[0]) throw new DomainError("AUTH_REQUIRED");
  return matches[0];
}

export function preflightAuthenticatedRequest(input: {
  request: Request;
  appOrigin: AppOrigin;
  sessionSigner: DemoSessionSigner;
  repository: ClaimGateRepository;
  routeKey: AuthenticatedRouteKey;
}): AuthenticatedRequestPreflight {
  const route = getAuthenticatedRoute(input.routeKey);
  const resolved = resolveAuthenticatedRoute(input.request, input.routeKey);
  if (route.method !== "POST" || route.action === null || route.ratePolicy === null) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  requireAuthenticatedWriteOrigin(input.request.headers, input.appOrigin);
  const session = input.sessionSigner.verify(readSessionCookie(input.request.headers));
  let instance;
  try {
    instance = input.repository.getDemoInstance(session.demoInstanceId);
  } catch (error) {
    if (error instanceof DomainError && error.code === "NOT_FOUND") {
      throw new DomainError("AUTH_REQUIRED");
    }
    throw error;
  }
  if (session.expiresAt > instance.expiresAtMs) throw new DomainError("AUTH_REQUIRED");
  if (!route.allowedRoles.includes(session.role)) throw new DomainError("FORBIDDEN");
  const preflight = Object.freeze({
    sessionId: session.sessionId,
    demoInstanceId: session.demoInstanceId,
    userId: session.userId,
    role: session.role,
    expiresAt: session.expiresAt,
    routeKey: input.routeKey,
    action: route.action,
    csrfRouteId: resolved.csrfRouteId,
    canonicalPath: resolved.canonicalPath,
    params: resolved.params,
  });
  issuedPreflights.add(preflight);
  return preflight;
}

export function completeAuthenticatedRequest(input: {
  preflight: AuthenticatedRequestPreflight;
  csrf: CsrfService;
  csrfToken: string | undefined;
}): AuthenticatedRequestContext {
  if (!issuedPreflights.has(input.preflight)) throw new DomainError("CONFIGURATION_ERROR");
  const route = getAuthenticatedRoute(input.preflight.routeKey);
  if (route.method !== "POST" || route.action !== input.preflight.action) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  const csrf = input.csrf.verify({
    token: input.csrfToken,
    sessionId: input.preflight.sessionId,
    method: route.method,
    routeId: input.preflight.csrfRouteId,
    action: input.preflight.action,
  });
  if (csrf.oneTime !== route.requiresOneTime) throw new DomainError("FORBIDDEN");
  const context = Object.freeze({
    sessionId: input.preflight.sessionId,
    demoInstanceId: input.preflight.demoInstanceId,
    userId: input.preflight.userId,
    role: input.preflight.role,
    expiresAt: input.preflight.expiresAt,
    action: input.preflight.action,
    csrf,
  });
  issuedContexts.add(context);
  return context;
}

export function bindClaimStagePreflight(
  preflight: AuthenticatedRequestPreflight,
  reportId: string,
): AuthenticatedRequestPreflight {
  if (
    !issuedPreflights.has(preflight)
    || preflight.routeKey !== "api.claims.stage"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reportId)
  ) throw new DomainError("CONFIGURATION_ERROR");
  issuedPreflights.delete(preflight);
  const bound = Object.freeze({ ...preflight, csrfRouteId: `claims/${reportId}` });
  issuedPreflights.add(bound);
  return bound;
}

export function createAuthenticatedRequestContext(input: {
  request: Request;
  appOrigin: AppOrigin;
  sessionSigner: DemoSessionSigner;
  csrf: CsrfService;
  csrfToken: string | undefined;
  repository: ClaimGateRepository;
  routeKey: AuthenticatedRouteKey;
}): AuthenticatedRequestContext {
  const preflight = preflightAuthenticatedRequest(input);
  return completeAuthenticatedRequest({ preflight, csrf: input.csrf, csrfToken: input.csrfToken });
}

export type AuthenticatedReadContext = Readonly<{
  sessionId: string;
  demoInstanceId: string;
  userId: DemoUserId;
  role: DemoRole;
  expiresAt: number;
  routeKey: AuthenticatedRouteKey;
  action: RateLimitAction | null;
  params: Readonly<Record<string, string>>;
  query: Readonly<{ limit?: number }>;
}>;

export function createAuthenticatedReadContext(input: {
  request: Request;
  appOrigin: AppOrigin;
  sessionSigner: DemoSessionSigner;
  repository: ClaimGateRepository;
  routeKey: AuthenticatedRouteKey;
}): AuthenticatedReadContext {
  const route = getAuthenticatedRoute(input.routeKey);
  if (route.method !== "GET" || route.requiresOneTime) throw new DomainError("CONFIGURATION_ERROR");
  const resolved = resolveAuthenticatedRoute(input.request, input.routeKey);
  requireAuthenticatedReadOrigin(input.request.headers, input.appOrigin);
  const session = input.sessionSigner.verify(readSessionCookie(input.request.headers));
  let instance;
  try {
    instance = input.repository.getDemoInstance(session.demoInstanceId);
  } catch (error) {
    if (error instanceof DomainError && error.code === "NOT_FOUND") {
      throw new DomainError("AUTH_REQUIRED");
    }
    throw error;
  }
  if (session.expiresAt > instance.expiresAtMs) throw new DomainError("AUTH_REQUIRED");
  if (!route.allowedRoles.includes(session.role)) throw new DomainError("FORBIDDEN");
  const context = Object.freeze({
    sessionId: session.sessionId,
    demoInstanceId: session.demoInstanceId,
    userId: session.userId,
    role: session.role,
    expiresAt: session.expiresAt,
    routeKey: input.routeKey,
    action: route.action,
    params: resolved.params,
    query: resolved.query,
  });
  issuedReadContexts.add(context);
  return context;
}

export function executeAuthorizedRead<T>(input: {
  context: AuthenticatedReadContext;
  limiter: PersistentRateLimiter;
  read: () => T;
}): T {
  if (!issuedReadContexts.has(input.context)) throw new DomainError("CONFIGURATION_ERROR");
  const route = getAuthenticatedRoute(input.context.routeKey);
  if (input.context.action !== null) {
    if (route.ratePolicy === null || route.action !== input.context.action) {
      throw new DomainError("CONFIGURATION_ERROR");
    }
    const allowance = input.limiter.consume({
      demoInstanceId: input.context.demoInstanceId,
      actorId: input.context.userId,
      action: input.context.action,
      ...route.ratePolicy,
    });
    if (!allowance.allowed) throwRateLimited(allowance.retryAfterMs);
  }
  return input.read();
}

export function executeAuthorizedMutation<T>(input: {
  context: AuthenticatedRequestContext;
  repository: ClaimGateRepository;
  limiter: PersistentRateLimiter;
  mutation: (repository: ClaimGateRepository) => T extends PromiseLike<unknown> ? never : T;
}): T {
  if (!issuedContexts.has(input.context)) throw new DomainError("CONFIGURATION_ERROR");
  const policy = INSTANCE_RATE_LIMIT_POLICIES[input.context.action];
  return input.repository.withTransaction((repository) => {
    if (input.context.csrf.oneTime) {
      repository.consumeActionNonce({
        demoInstanceId: input.context.demoInstanceId,
        action: input.context.action,
        nonceDigest: input.context.csrf.nonceDigest,
      });
    }
    const result = input.limiter.consume({
      demoInstanceId: input.context.demoInstanceId,
      actorId: input.context.userId,
      action: input.context.action,
      ...policy,
    });
    if (!result.allowed) throwRateLimited(result.retryAfterMs);
    return input.mutation(repository);
  });
}
