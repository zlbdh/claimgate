import type { CsrfMetadata, CsrfService } from "@/features/auth/csrf";
import {
  DEMO_SESSION_COOKIE,
  type DemoSessionSigner,
} from "@/features/auth/demo-session";
import type { ClaimGateRepository } from "@/server/db/repository";
import {
  RATE_LIMIT_ACTIONS,
  type PersistentRateLimiter,
  type RateLimitAction,
} from "@/server/security/rate-limit";
import type { RateLimitPolicy } from "@/server/security/rate-limit-policy";
import type { AppOrigin } from "@/shared/app-origin";
import type { DemoRole, DemoUserId } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import { throwRateLimited } from "./api-error";
import { requireAuthenticatedWriteOrigin, requireConfiguredHost } from "./origin";

export type RequestDeclaration = Readonly<{
  method: "POST";
  routeId: string;
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

function expectedPath(routeId: string): string {
  if (!/^api(?:\.[a-z0-9-]+)+$/.test(routeId)) throw new DomainError("CONFIGURATION_ERROR");
  return `/${routeId.replaceAll(".", "/")}`;
}

function requireDeclaration(request: Request, declaration: RequestDeclaration): void {
  const url = new URL(request.url);
  if (
    request.method !== declaration.method
    || !RATE_LIMIT_ACTIONS.includes(declaration.action)
    || url.pathname !== expectedPath(declaration.routeId)
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

export function createAuthenticatedRequestContext(input: {
  request: Request;
  appOrigin: AppOrigin;
  sessionSigner: DemoSessionSigner;
  csrf: CsrfService;
  csrfToken: string | undefined;
  repository: ClaimGateRepository;
  declaration: RequestDeclaration;
  requiredRole?: DemoRole;
}): AuthenticatedRequestContext {
  requireDeclaration(input.request, input.declaration);
  requireConfiguredHost(input.request.headers, input.appOrigin);
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
  requireAuthenticatedWriteOrigin(input.request.headers, input.appOrigin);
  const csrf = input.csrf.verify({
    token: input.csrfToken,
    sessionId: session.sessionId,
    method: input.declaration.method,
    routeId: input.declaration.routeId,
    action: input.declaration.action,
  });
  if (input.requiredRole && session.role !== input.requiredRole) {
    throw new DomainError("FORBIDDEN");
  }
  return Object.freeze({
    sessionId: session.sessionId,
    demoInstanceId: session.demoInstanceId,
    userId: session.userId,
    role: session.role,
    expiresAt: session.expiresAt,
    action: input.declaration.action,
    csrf,
  });
}

export function executeAuthorizedMutation<T>(input: {
  context: AuthenticatedRequestContext;
  repository: ClaimGateRepository;
  limiter: PersistentRateLimiter;
  policy: RateLimitPolicy;
  mutation: (repository: ClaimGateRepository) => T extends PromiseLike<unknown> ? never : T;
}): T {
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
      ...input.policy,
    });
    if (!result.allowed) throwRateLimited(result.retryAfterMs);
    return input.mutation(repository);
  });
}
