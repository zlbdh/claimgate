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
import { DEMO_IDENTITIES, isDemoRole, type DemoRole } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";
import { deriveClaimResumeLocation, sessionRedirectResponse } from "../route-response";

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
  resumeClaimId?: string;
} {
  const values = new Map(entries);
  const hasResume = values.has("resumeClaimId");
  const expectedSize = hasResume ? 3 : 2;
  if (
    entries.length !== expectedSize
    || values.size !== expectedSize
    || !values.has("csrfToken")
    || !values.has("targetRole")
    || [...values.keys()].some((key) => ![
      "csrfToken", "targetRole", "resumeClaimId",
    ].includes(key))
  ) throw new DomainError("VALIDATION_FAILED");
  const csrfToken = values.get("csrfToken")!;
  const targetRole = values.get("targetRole")!;
  const resumeClaimId = values.get("resumeClaimId");
  if (
    csrfToken.length === 0
    || csrfToken.length > 1_024
    || !isDemoRole(targetRole)
    || targetRole === currentRole
    || (resumeClaimId !== undefined
      && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(resumeClaimId))
  ) throw new DomainError("VALIDATION_FAILED");
  return resumeClaimId === undefined
    ? { csrfToken, targetRole }
    : { csrfToken, targetRole, resumeClaimId };
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
      const result = executeAuthorizedMutation({
        context,
        repository: dependencies.repository,
        limiter: dependencies.limiter,
        mutation: (repository) => {
          const claim = form.resumeClaimId === undefined
            ? undefined
            : repository.getClaim(context.demoInstanceId, form.resumeClaimId);
          if (
            claim
            && form.targetRole === "CLAIMANT"
            && claim.claimantActorId !== DEMO_IDENTITIES.CLAIMANT.userId
          ) throw new DomainError("NOT_FOUND");
          return {
            signed: dependencies.sessionSigner.rotate(context, form.targetRole),
            location: claim === undefined
              ? undefined
              : deriveClaimResumeLocation(form.targetRole, claim),
          };
        },
      });
      return sessionRedirectResponse({
        signed: result.signed,
        appOrigin: dependencies.appOrigin,
        now: dependencies.now(),
        ...(result.location === undefined ? {} : { location: result.location }),
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
