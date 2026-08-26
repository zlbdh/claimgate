import type { DemoSessionSigner } from "@/features/auth/demo-session";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { PersistentGlobalRateLimiter } from "@/server/security/global-rate-limit";
import { mapApiError, throwRateLimited } from "@/server/http/api-error";
import { requireDemoStartOrigin } from "@/server/http/origin";
import { readStrictUrlEncodedForm } from "@/server/http/urlencoded-form";
import type { AppOrigin } from "@/shared/app-origin";
import { DomainError } from "@/shared/domain-error";
import { sessionRedirectResponse } from "../route-response";

type StartDependencies = {
  appOrigin: AppOrigin;
  repository: ClaimGateRepository;
  globalLimiter: PersistentGlobalRateLimiter;
  sessionSigner: DemoSessionSigner;
  now: () => number;
};

function requireStartTarget(request: Request): void {
  const url = new URL(request.url);
  if (
    request.method !== "POST"
    || url.pathname !== "/api/demo/start"
    || url.search !== ""
    || url.hash !== ""
  ) throw new DomainError("FORBIDDEN");
}

export function createStartRouteHandler(dependencies: StartDependencies) {
  return async function start(request: Request): Promise<Response> {
    try {
      requireStartTarget(request);
      requireDemoStartOrigin(request.headers, dependencies.appOrigin);
      const form = await readStrictUrlEncodedForm(request);
      if (form.length !== 0) throw new DomainError("VALIDATION_FAILED");
      const signed = dependencies.repository.withTransaction((repository) => {
        const allowance = dependencies.globalLimiter.consume();
        if (!allowance.allowed) throwRateLimited(allowance.retryAfterMs);
        const instance = repository.createDemoInstance();
        return dependencies.sessionSigner.mint({
          demoInstanceId: instance.demoInstanceId,
          role: "CLAIMANT",
          expiresAt: instance.expiresAtMs,
        });
      });
      return sessionRedirectResponse({
        signed,
        appOrigin: dependencies.appOrigin,
        now: dependencies.now(),
      });
    } catch (error) {
      return mapApiError(error);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    const runtime = getHttpRuntime();
    return createStartRouteHandler(runtime)(request);
  } catch (error) {
    return mapApiError(error);
  }
}
