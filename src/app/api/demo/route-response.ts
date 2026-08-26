import type { SignedDemoSession } from "@/features/auth/demo-session";
import { buildDemoSessionCookie } from "@/features/auth/demo-session";
import type { AppOrigin } from "@/shared/app-origin";

export function sessionRedirectResponse(input: {
  signed: SignedDemoSession;
  appOrigin: AppOrigin;
  now: number;
}): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: "/",
      "Set-Cookie": buildDemoSessionCookie({
        token: input.signed.token,
        claims: input.signed.claims,
        appOrigin: input.appOrigin.origin,
        now: input.now,
      }),
    },
  });
}
