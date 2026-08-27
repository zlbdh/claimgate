import "server-only";

import type { CsrfService } from "@/features/auth/csrf";
import type { DemoSession } from "@/features/auth/demo-session";

type RoleSwitchRuntime = Readonly<{
  csrf: CsrfService;
  now: () => number;
}>;

export function mintRoleSwitchCsrf(input: {
  runtime: RoleSwitchRuntime;
  session: Pick<DemoSession, "sessionId" | "expiresAt">;
}): string {
  return input.runtime.csrf.mint({
    sessionId: input.session.sessionId,
    method: "POST",
    routeId: "api.demo.switch-role",
    action: "role_switch",
    expiresAt: Math.min(input.session.expiresAt, input.runtime.now() + 10 * 60_000),
    oneTime: true,
  });
}
