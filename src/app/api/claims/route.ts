import { createClaimService } from "@/features/claims/claim-service";
import { validateStageClaimCommand } from "@/features/claims/claim-schema";
import { mapApiError } from "@/server/http/api-error";
import {
  bindClaimStagePreflight,
  completeAuthenticatedRequest,
  executeAuthorizedMutation,
  preflightAuthenticatedRequest,
} from "@/server/http/request-context";
import { privateJson, reportActorContext, type ReportRouteDependencies } from "@/server/http/report-route-support";
import { readStrictJson } from "@/server/http/strict-json";

export const dynamic = "force-dynamic";

export function createClaimsRouteHandler(dependencies: ReportRouteDependencies) {
  return async function stageClaim(request: Request): Promise<Response> {
    try {
      const preflight = preflightAuthenticatedRequest({
        request,
        appOrigin: dependencies.appOrigin,
        sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository,
        routeKey: "api.claims.stage",
      });
      const command = validateStageClaimCommand(await readStrictJson(request));
      const context = completeAuthenticatedRequest({
        preflight: bindClaimStagePreflight(preflight, command.reportId),
        csrf: dependencies.csrf,
        csrfToken: request.headers.get("x-csrf-token") ?? undefined,
      });
      const result = executeAuthorizedMutation({
        context,
        repository: dependencies.repository,
        limiter: dependencies.limiter,
        mutation: (repository) => createClaimService({
          repository,
          keyring: dependencies.keyring,
          now: dependencies.now,
        }).stage(reportActorContext(context), command),
      });
      return privateJson(result, 201);
    } catch (error) {
      return mapApiError(error);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createClaimsRouteHandler(getHttpRuntime())(request);
  } catch (error) {
    return mapApiError(error);
  }
}
