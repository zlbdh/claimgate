import { parseExpectedVersionForm } from "@/features/reports/report-schema";
import { mapApiError } from "@/server/http/api-error";
import {
  completeAuthenticatedRequest,
  executeAuthorizedMutation,
  preflightAuthenticatedRequest,
} from "@/server/http/request-context";
import {
  reportActorContext,
  reportRedirect,
  reportService,
  type ReportRouteDependencies,
} from "@/server/http/report-route-support";
import { readStrictUrlEncodedForm } from "@/server/http/urlencoded-form";

export const dynamic = "force-dynamic";

export function createArchiveReportRouteHandler(dependencies: ReportRouteDependencies) {
  return async function archiveReport(request: Request): Promise<Response> {
    try {
      const preflight = preflightAuthenticatedRequest({
        request, appOrigin: dependencies.appOrigin, sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository, routeKey: "api.reports.archive",
      });
      const reportId = preflight.params.reportId!;
      const form = parseExpectedVersionForm(await readStrictUrlEncodedForm(request));
      const context = completeAuthenticatedRequest({
        preflight, csrf: dependencies.csrf, csrfToken: form.csrfToken,
      });
      executeAuthorizedMutation({
        context, repository: dependencies.repository, limiter: dependencies.limiter,
        mutation: (repository) => reportService(dependencies, repository)
          .archive(reportActorContext(context), reportId, form.expectedVersion),
      });
      return reportRedirect(reportId);
    } catch (error) {
      return mapApiError(error);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createArchiveReportRouteHandler(getHttpRuntime())(request);
  } catch (error) {
    return mapApiError(error);
  }
}
