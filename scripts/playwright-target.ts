import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Environment = Record<string, string | undefined>;

type PlaywrightTarget = {
  baseURL: string;
  webServer?: {
    command: string;
    env: Record<string, string>;
    reuseExistingServer: boolean;
    timeout: number;
    url: string;
  };
};

const LOCAL_URL = "http://127.0.0.1:3100";

export function resolvePlaywrightTarget(environment: Environment): PlaywrightTarget {
  const externalURL = environment.PLAYWRIGHT_BASE_URL?.trim();

  if (externalURL) {
    const parsed = new URL(externalURL);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error("PLAYWRIGHT_BASE_URL must use http: or https:");
    }

    return { baseURL: parsed.toString().replace(/\/$/, "") };
  }

  return {
    baseURL: LOCAL_URL,
    webServer: {
      command: "npm run build && node scripts/start-standalone.mjs",
      env: {
        CLAIMGATE_HMAC_KEY: Buffer.alloc(32, 71).toString("base64"),
        CLAIMGATE_SESSION_KEY: Buffer.alloc(32, 72).toString("base64"),
        CLAIMGATE_CSRF_KEY: Buffer.alloc(32, 73).toString("base64"),
        CLAIMGATE_DATABASE_PATH: join(tmpdir(), `claimgate-e2e-${randomUUID()}.sqlite`),
        CLAIMGATE_APP_ORIGIN: LOCAL_URL,
      },
      reuseExistingServer: !environment.CI,
      timeout: 180_000,
      url: LOCAL_URL,
    },
  };
}
