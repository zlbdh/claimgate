import type { CsrfService } from "@/features/auth/csrf";
import type { DemoSessionSigner } from "@/features/auth/demo-session";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { PersistentRateLimiter } from "@/server/security/rate-limit";
import { mapApiError } from "@/server/http/api-error";
import {
  completeAuthenticatedRequest,
  executeAuthorizedMutation,
  preflightAuthenticatedRequest,
} from "@/server/http/request-context";
import { readStrictUrlEncodedForm } from "@/server/http/urlencoded-form";
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

function parseStrictForm(
  entries: ReadonlyArray<readonly [string, string]>,
  currentRole: DemoRole,
): {
  csrfToken: string;
  targetRole: DemoRole;
} {
  const values = new Map(entries);
  if (
    entries.length !== 2
    || values.size !== 2
    || !values.has("csrfToken")
    || !values.has("targetRole")
  ) throw new DomainError("VALIDATION_FAILED");
  const csrfToken = values.get("csrfToken")!;
  const targetRole = values.get("targetRole")!;
  if (
    csrfToken.length === 0
    || csrfToken.length > 1_024
    || !isDemoRole(targetRole)
    || targetRole === currentRole
  ) throw new DomainError("VALIDATION_FAILED");
  return { csrfToken, targetRole };
}

export function createSwitchRoleRouteHandler(dependencies: SwitchDependencies) {
  return async function switchRole(request: Request): Promise<Response> {
    try {
      const preflight = preflightAuthenticatedRequest({
        request,
        appOrigin: dependencies.appOrigin,
        sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository,
        routeKey: "api.demo.switch-role",
      });
      const entries = await readStrictUrlEncodedForm(request);
      const form = parseStrictForm(entries, preflight.role);
      const context = completeAuthenticatedRequest({
        preflight,
        csrf: dependencies.csrf,
        csrfToken: form.csrfToken,
      });
      const signed = executeAuthorizedMutation({
        context,
        repository: dependencies.repository,
        limiter: dependencies.limiter,
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
