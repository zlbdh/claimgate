import "server-only";

import { createCsrfService } from "@/features/auth/csrf";
import { createDemoSessionSigner } from "@/features/auth/demo-session";
import { getDatabaseRuntime } from "@/server/db/runtime";
import { parseAppOrigin } from "./origin";

export function getHttpRuntime() {
  const appOrigin = parseAppOrigin(process.env.CLAIMGATE_APP_ORIGIN);
  const sessionSigner = createDemoSessionSigner({ key: process.env.CLAIMGATE_SESSION_KEY });
  const csrf = createCsrfService({ key: process.env.CLAIMGATE_CSRF_KEY });
  const databaseRuntime = getDatabaseRuntime();
  return Object.freeze({
    ...databaseRuntime,
    appOrigin,
    sessionSigner,
    csrf,
    now: Date.now,
  });
}
