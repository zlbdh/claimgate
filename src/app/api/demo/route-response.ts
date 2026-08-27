import type { SignedDemoSession } from "@/features/auth/demo-session";
import { buildDemoSessionCookie } from "@/features/auth/demo-session";
import type { ClaimRecord } from "@/server/db/repository";
import type { AppOrigin } from "@/shared/app-origin";
import type { DemoRole } from "@/shared/demo-identity";
import { DomainError } from "@/shared/domain-error";

declare const relativeLocationBrand: unique symbol;
type ServerDerivedRelativeLocation = string & {
  readonly [relativeLocationBrand]: true;
};

export function deriveClaimResumeLocation(
  targetRole: DemoRole,
  claim: ClaimRecord,
): ServerDerivedRelativeLocation {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(claim.claimId)) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  const desk = targetRole === "CLAIMANT" ? "claimant" : "staff";
  return `/${desk}/claims/${claim.claimId}` as ServerDerivedRelativeLocation;
}

export function sessionRedirectResponse(input: {
  signed: SignedDemoSession;
  appOrigin: AppOrigin;
  now: number;
  location?: ServerDerivedRelativeLocation;
}): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: input.location ?? "/",
      "Set-Cookie": buildDemoSessionCookie({
        token: input.signed.token,
        claims: input.signed.claims,
        appOrigin: input.appOrigin.origin,
        now: input.now,
      }),
    },
  });
}
