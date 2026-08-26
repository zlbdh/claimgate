import { parseUpdateReportForm } from "@/features/reports/report-schema";
import { mapApiError } from "@/server/http/api-error";
import {
  completeAuthenticatedRequest,
  executeAuthorizedMutation,
  preflightAuthenticatedRequest,
} from "@/server/http/request-context";
import {
  privateJson,
  reportActorContext,
  reportService,
  type ReportRouteDependencies,
} from "@/server/http/report-route-support";
import { readStrictUrlEncodedForm } from "@/server/http/urlencoded-form";

export const dynamic = "force-dynamic";

export function createUpdateReportRouteHandler(dependencies: ReportRouteDependencies) {
  return async function updateReport(request: Request): Promise<Response> {
    try {
      const preflight = preflightAuthenticatedRequest({
        request,
        appOrigin: dependencies.appOrigin,
        sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository,
        routeKey: "api.reports.update",
      });
      const reportId = preflight.params.reportId!;
      const form = parseUpdateReportForm(await readStrictUrlEncodedForm(request));
      const context = completeAuthenticatedRequest({
        preflight,
        csrf: dependencies.csrf,
        csrfToken: request.headers.get("x-csrf-token") ?? undefined,
      });
      const result = executeAuthorizedMutation({
        context,
        repository: dependencies.repository,
        limiter: dependencies.limiter,
        mutation: (repository) => reportService(dependencies, repository)
          .updateDraft(reportActorContext(context), reportId, form),
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
    return createUpdateReportRouteHandler(getHttpRuntime())(request);
  } catch (error) {
    return mapApiError(error);
  }
}
