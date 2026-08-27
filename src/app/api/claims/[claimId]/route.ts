import { mapApiError } from "@/server/http/api-error";
import { createAuthenticatedReadContext, executeAuthorizedRead } from "@/server/http/request-context";
import { privateJson, type ReportRouteDependencies } from "@/server/http/report-route-support";
import { createToolApiReadService } from "@/server/http/tool-api-read-service";

export const dynamic = "force-dynamic";

export function createClaimStatusRouteHandler(dependencies: ReportRouteDependencies) {
  return async function claimStatus(request: Request): Promise<Response> {
    try {
      const context = createAuthenticatedReadContext({
        request, appOrigin: dependencies.appOrigin, sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository, routeKey: "api.claims.status",
      });
      const result = executeAuthorizedRead({
        context,
        limiter: dependencies.limiter,
        read: () => createToolApiReadService(dependencies)
          .getClaimStatus(context, context.params.claimId!),
      });
      return privateJson(result);
    } catch (error) { return mapApiError(error); }
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createClaimStatusRouteHandler(getHttpRuntime())(request);
  } catch (error) { return mapApiError(error); }
}
