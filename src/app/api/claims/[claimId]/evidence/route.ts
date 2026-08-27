import { createClaimService } from "@/features/claims/claim-service";
import { parseEvidenceSubmissionForm } from "@/features/claims/claim-review-form";
import { mapApiError } from "@/server/http/api-error";
import {
  completeAuthenticatedRequest,
  executeAuthorizedMutation,
  preflightAuthenticatedRequest,
} from "@/server/http/request-context";
import { privateJson, reportActorContext, type ReportRouteDependencies } from "@/server/http/report-route-support";
import { readStrictUrlEncodedForm } from "@/server/http/urlencoded-form";

export const dynamic = "force-dynamic";

export function createEvidenceRouteHandler(dependencies: ReportRouteDependencies) {
  return async function submitEvidence(request: Request): Promise<Response> {
    try {
      const preflight = preflightAuthenticatedRequest({
        request, appOrigin: dependencies.appOrigin, sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository, routeKey: "api.claims.evidence",
      });
      const command = parseEvidenceSubmissionForm(await readStrictUrlEncodedForm(request));
      const context = completeAuthenticatedRequest({
        preflight, csrf: dependencies.csrf,
        csrfToken: request.headers.get("x-csrf-token") ?? undefined,
      });
      const result = executeAuthorizedMutation({
        context, repository: dependencies.repository, limiter: dependencies.limiter,
        mutation: (repository) => createClaimService({
          repository, keyring: dependencies.keyring, now: dependencies.now,
        }).submitEvidence(reportActorContext(context), preflight.params.claimId!, command),
      });
      return privateJson(result);
    } catch (error) {
      return mapApiError(error);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createEvidenceRouteHandler(getHttpRuntime())(request);
  } catch (error) {
    return mapApiError(error);
  }
}
