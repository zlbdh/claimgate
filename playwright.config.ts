import { defineConfig, devices } from "@playwright/test";

import { resolvePlaywrightTarget } from "./scripts/playwright-target";

const target = resolvePlaywrightTarget(process.env);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: target.baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: target.webServer,
});
