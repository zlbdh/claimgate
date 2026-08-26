import { parseCreateReportForm } from "@/features/reports/report-schema";
import { mapApiError } from "@/server/http/api-error";
import {
  completeAuthenticatedRequest,
  createAuthenticatedReadContext,
  executeAuthorizedMutation,
  executeAuthorizedRead,
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

export function createReportsRouteHandlers(dependencies: ReportRouteDependencies) {
  return Object.freeze({
    async POST(request: Request): Promise<Response> {
      try {
        const preflight = preflightAuthenticatedRequest({
          request,
          appOrigin: dependencies.appOrigin,
          sessionSigner: dependencies.sessionSigner,
          repository: dependencies.repository,
          routeKey: "api.reports.create",
        });
        const form = parseCreateReportForm(await readStrictUrlEncodedForm(request));
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
            .createDraft(reportActorContext(context), form),
        });
        return privateJson(result, 201);
      } catch (error) {
        return mapApiError(error);
      }
    },

    async GET(request: Request): Promise<Response> {
      try {
        const context = createAuthenticatedReadContext({
          request,
          appOrigin: dependencies.appOrigin,
          sessionSigner: dependencies.sessionSigner,
          repository: dependencies.repository,
          routeKey: "api.reports.list",
        });
        const reports = executeAuthorizedRead({
          context,
          limiter: dependencies.limiter,
          read: () => reportService(dependencies).listOwned(reportActorContext(context)),
        });
        return privateJson({ reports });
      } catch (error) {
        return mapApiError(error);
      }
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createReportsRouteHandlers(getHttpRuntime()).POST(request);
  } catch (error) {
    return mapApiError(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createReportsRouteHandlers(getHttpRuntime()).GET(request);
  } catch (error) {
    return mapApiError(error);
  }
}
