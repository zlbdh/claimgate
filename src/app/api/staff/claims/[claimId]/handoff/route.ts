import { createPickupPassService } from "@/features/claims/pickup-pass-service";
import { parsePickupHandoffForm } from "@/features/claims/pickup-pass-form";
import {
  completeAuthenticatedRequest, executeAuthorizedMutation, preflightAuthenticatedRequest,
} from "@/server/http/request-context";
import { reportActorContext, type ReportRouteDependencies } from "@/server/http/report-route-support";
import { sensitiveApiError, sensitiveJson } from "@/server/http/pickup-route-support";
import { readStrictUrlEncodedForm } from "@/server/http/urlencoded-form";

export const dynamic = "force-dynamic";

export function createPickupHandoffRouteHandler(dependencies: ReportRouteDependencies) {
  return async function handoff(request: Request): Promise<Response> {
    try {
      const preflight = preflightAuthenticatedRequest({
        request, appOrigin: dependencies.appOrigin, sessionSigner: dependencies.sessionSigner,
        repository: dependencies.repository, routeKey: "api.staff.claims.handoff",
      });
      const command = parsePickupHandoffForm(await readStrictUrlEncodedForm(request));
      const context = completeAuthenticatedRequest({
        preflight, csrf: dependencies.csrf,
        csrfToken: request.headers.get("x-csrf-token") ?? undefined,
      });
      const result = executeAuthorizedMutation({
        context, repository: dependencies.repository, limiter: dependencies.limiter,
        mutation: (repository) => createPickupPassService({
          repository, keyring: dependencies.keyring, now: dependencies.now,
        }).handoff(reportActorContext(context), preflight.params.claimId!, command),
      });
      return sensitiveJson(result);
    } catch (error) { return sensitiveApiError(error); }
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { getHttpRuntime } = await import("@/server/http/runtime");
    return createPickupHandoffRouteHandler(getHttpRuntime())(request);
  } catch (error) { return sensitiveApiError(error); }
}
