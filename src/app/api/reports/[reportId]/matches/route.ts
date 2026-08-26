import { mapApiError } from "@/server/http/api-error";
import { createAuthenticatedReadContext, executeAuthorizedRead } from "@/server/http/request-context";
import {
  privateJson,
  reportActorContext,
  reportService,
  type ReportRouteDependencies,
} from "@/server/http/report-route-support";

export const dynamic = "force-dynamic";

export function createMatchesRouteHandler(dependencies: ReportRouteDependencies) {
  return async function findMatches(request: Request): Promise<Response> {
    try {
      const context = createAuthenticatedReadContext({
        request, appOrigin: dependencies.appOrigin, sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository, routeKey: "api.reports.matches",
      });
      const reportId = context.params.reportId!;
      const result = executeAuthorizedRead({
        context,
        limiter: dependencies.limiter,
        read: () => reportService(dependencies).findCandidates(
          reportActorContext(context), reportId, context.query.limit ?? 3,
        ),
      });
      return privateJson(result);
    } catch (error) {
      return mapApiError(error);
    }
  };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createMatchesRouteHandler(getHttpRuntime())(request);
  } catch (error) {
    return mapApiError(error);
  }
}
