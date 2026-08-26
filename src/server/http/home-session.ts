import "server-only";

import { DomainError } from "@/shared/domain-error";
import { getHttpRuntime } from "./runtime";

function looksLikeSessionEnvelope(value: string): boolean {
  if (value.length === 0 || value.length > 1_024) return false;
  const parts = value.split(".");
  return parts.length === 3
    && parts[0] === "v1"
    && parts.slice(1).every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}

export function readHomeSession(cookieValue: string | undefined) {
  if (!cookieValue || !looksLikeSessionEnvelope(cookieValue)) return null;
  const runtime = getHttpRuntime();
  let session;
  try {
    session = runtime.sessionSigner.verify(cookieValue);
    const instance = runtime.repository.getDemoInstance(session.demoInstanceId);
    if (session.expiresAt > instance.expiresAtMs) return null;
  } catch (error) {
    if (error instanceof DomainError && (
      error.code === "AUTH_REQUIRED" || error.code === "NOT_FOUND"
    )) return null;
    throw error;
  }
  const now = runtime.now();
  const csrfToken = runtime.csrf.mint({
    sessionId: session.sessionId,
    method: "POST",
    routeId: "api.demo.switch-role",
    action: "role_switch",
    expiresAt: Math.min(session.expiresAt, now + 10 * 60 * 1_000),
    oneTime: true,
  });
  return Object.freeze({ session, csrfToken });
}
