type Environment = Record<string, string | undefined>;

type PlaywrightTarget = {
  baseURL: string;
  webServer?: {
    command: string;
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
      reuseExistingServer: !environment.CI,
      timeout: 180_000,
      url: LOCAL_URL,
    },
  };
}
