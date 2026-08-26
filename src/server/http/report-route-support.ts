import type { CsrfService } from "@/features/auth/csrf";
import type { DemoSessionSigner } from "@/features/auth/demo-session";
import { createReportService } from "@/features/reports/report-service";
import type { ClaimGateRepository } from "@/server/db/repository";
import type { Keyring } from "@/server/security/keyring";
import type { PersistentRateLimiter } from "@/server/security/rate-limit";
import type { AppOrigin } from "@/shared/app-origin";
import type { DemoUserId } from "@/shared/demo-identity";

export type ReportRouteDependencies = Readonly<{
  appOrigin: AppOrigin;
  repository: ClaimGateRepository;
  limiter: PersistentRateLimiter;
  sessionSigner: DemoSessionSigner;
  csrf: CsrfService;
  keyring: Keyring;
  now: () => number;
}>;

export function reportService(
  dependencies: ReportRouteDependencies,
  repository = dependencies.repository,
) {
  return createReportService({ repository, keyring: dependencies.keyring, now: dependencies.now });
}

export function reportActorContext(input: {
  demoInstanceId: string;
  userId: DemoUserId;
  expiresAt: number;
}) {
  return Object.freeze({
    demoInstanceId: input.demoInstanceId,
    actorId: input.userId,
    sessionExpiresAt: input.expiresAt,
  });
}

export function privateJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export function reportRedirect(reportId: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store",
      Location: `/claimant/reports/${reportId}`,
    },
  });
}
