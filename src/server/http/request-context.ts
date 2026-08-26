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
  type AuthenticatedRouteKey,
} from "./authenticated-route-registry";
import { throwRateLimited } from "./api-error";
import { requireAuthenticatedWriteOrigin } from "./origin";

export type AuthenticatedRequestPreflight = Readonly<{
  sessionId: string;
  demoInstanceId: string;
  userId: DemoUserId;
  role: DemoRole;
  expiresAt: number;
  routeKey: AuthenticatedRouteKey;
  action: RateLimitAction;
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

function requireRegisteredTarget(request: Request, routeKey: AuthenticatedRouteKey): void {
  const route = getAuthenticatedRoute(routeKey);
  const url = new URL(request.url);
  if (
    request.method !== route.method
    || url.pathname !== route.path
    || url.search !== ""
    || url.hash !== ""
  ) throw new DomainError("FORBIDDEN");
}

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
  requireRegisteredTarget(input.request, input.routeKey);
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
  const csrf = input.csrf.verify({
    token: input.csrfToken,
    sessionId: input.preflight.sessionId,
    method: route.method,
    routeId: input.preflight.routeKey,
    action: route.action,
  });
  if (csrf.oneTime !== route.requiresOneTime) throw new DomainError("FORBIDDEN");
  const context = Object.freeze({
    sessionId: input.preflight.sessionId,
    demoInstanceId: input.preflight.demoInstanceId,
    userId: input.preflight.userId,
    role: input.preflight.role,
    expiresAt: input.preflight.expiresAt,
    action: route.action,
    csrf,
  });
  issuedContexts.add(context);
  return context;
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
