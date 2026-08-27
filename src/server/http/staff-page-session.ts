import "server-only";

import type { DemoSession } from "@/features/auth/demo-session";
import { DomainError } from "@/shared/domain-error";
import { getAuthenticatedRoute, resolveAuthenticatedRoute, type AuthenticatedRouteKey } from "./authenticated-route-registry";
import { getHttpRuntime } from "./runtime";

type HttpRuntime = ReturnType<typeof getHttpRuntime>;

export function readStaffPageSession(
  token: string | undefined,
  runtime: HttpRuntime = getHttpRuntime(),
): DemoSession | null {
  if (!token || token.length > 1_024) return null;
  try {
    const session = runtime.sessionSigner.verify(token);
    if (session.role !== "STAFF") return null;
    const instance = runtime.repository.getDemoInstance(session.demoInstanceId);
    if (session.expiresAt > instance.expiresAtMs) return null;
    return session;
  } catch (error) {
    if (error instanceof DomainError && ["AUTH_REQUIRED", "NOT_FOUND"].includes(error.code)) return null;
    throw error;
  }
}

export function mintClaimReviewCsrf(input: {
  runtime: HttpRuntime;
  session: DemoSession;
  routeKey: AuthenticatedRouteKey;
  path: string;
}): string {
  const route = getAuthenticatedRoute(input.routeKey);
  if (route.method !== "POST" || route.action === null || !route.requiresOneTime) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  const resolved = resolveAuthenticatedRoute(new Request(
    `${input.runtime.appOrigin.origin}${input.path}`,
    { method: "POST" },
  ), input.routeKey);
  return input.runtime.csrf.mint({
    sessionId: input.session.sessionId,
    method: "POST",
    routeId: resolved.csrfRouteId,
    action: route.action,
    oneTime: true,
    expiresAt: Math.min(input.session.expiresAt, input.runtime.now() + 10 * 60_000),
  });
}
