import type { CsrfService } from "@/features/auth/csrf";
import type { DemoSessionSigner } from "@/features/auth/demo-session";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { PersistentRateLimiter } from "@/server/security/rate-limit";
import { INSTANCE_RATE_LIMIT_POLICIES } from "@/server/security/rate-limit-policy";
import { mapApiError } from "@/server/http/api-error";
import {
  createAuthenticatedRequestContext,
  executeAuthorizedMutation,
} from "@/server/http/request-context";
import type { AppOrigin } from "@/shared/app-origin";
import { isDemoRole, type DemoRole } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import { sessionRedirectResponse } from "../route-response";

type SwitchDependencies = {
  appOrigin: AppOrigin;
  repository: ClaimGateRepository;
  limiter: PersistentRateLimiter;
  sessionSigner: DemoSessionSigner;
  csrf: CsrfService;
  now: () => number;
};

async function readStrictForm(request: Request): Promise<{
  csrfToken: string;
  targetRole: DemoRole;
}> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new DomainError("VALIDATION_FAILED");
  }
  const entries = [...form.entries()];
  if (
    entries.length !== 2
    || entries[0]?.[0] !== "csrfToken"
    || entries[1]?.[0] !== "targetRole"
    || typeof entries[0][1] !== "string"
    || entries[0][1].length === 0
    || entries[0][1].length > 1_024
    || !isDemoRole(entries[1][1])
  ) throw new DomainError("VALIDATION_FAILED");
  return { csrfToken: entries[0][1], targetRole: entries[1][1] };
}

export function createSwitchRoleRouteHandler(dependencies: SwitchDependencies) {
  return async function switchRole(request: Request): Promise<Response> {
    try {
      const form = await readStrictForm(request);
      const context = createAuthenticatedRequestContext({
        request,
        appOrigin: dependencies.appOrigin,
        sessionSigner: dependencies.sessionSigner,
        csrf: dependencies.csrf,
        csrfToken: form.csrfToken,
        repository: dependencies.repository,
        declaration: {
          method: "POST",
          routeId: "api.demo.switch-role",
          action: "role_switch",
        },
      });
      if (!context.csrf.oneTime) throw new DomainError("FORBIDDEN");
      const signed = executeAuthorizedMutation({
        context,
        repository: dependencies.repository,
        limiter: dependencies.limiter,
        policy: INSTANCE_RATE_LIMIT_POLICIES.role_switch,
        mutation: () => dependencies.sessionSigner.rotate(context, form.targetRole),
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
    return createSwitchRoleRouteHandler(runtime)(request);
  } catch (error) {
    return mapApiError(error);
  }
}
