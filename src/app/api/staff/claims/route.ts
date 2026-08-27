import { mapApiError } from "@/server/http/api-error";
import { createAuthenticatedReadContext, executeAuthorizedRead } from "@/server/http/request-context";
import { privateJson, type ReportRouteDependencies } from "@/server/http/report-route-support";
import { createToolApiReadService } from "@/server/http/tool-api-read-service";

export const dynamic = "force-dynamic";

export function createStaffClaimsRouteHandler(dependencies: ReportRouteDependencies) {
  return async function staffClaims(request: Request): Promise<Response> {
    try {
      const context = createAuthenticatedReadContext({
        request, appOrigin: dependencies.appOrigin, sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository, routeKey: "api.staff.claims.list",
      });
      const result = executeAuthorizedRead({
        context,
        limiter: dependencies.limiter,
        read: () => createToolApiReadService(dependencies)
          .listPendingClaims(context, context.query.limit ?? 3),
      });
      return privateJson(result);
    } catch (error) { return mapApiError(error); }
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createStaffClaimsRouteHandler(getHttpRuntime())(request);
  } catch (error) { return mapApiError(error); }
}
