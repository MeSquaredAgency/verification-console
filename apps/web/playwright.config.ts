import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run the real Worker (wrangler dev, local D1/R2/Queues) and the Vite app,
// on a fresh local database each run.
const API_PORT = 8788;
const WEB_PORT = 5174;

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chrome-1366x768", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } }],
  webServer: [
    {
      cwd: "../api",
      command: `rm -rf .wrangler/e2e && npx wrangler d1 migrations apply vc-db --local --persist-to .wrangler/e2e && npx wrangler dev --port ${API_PORT} --persist-to .wrangler/e2e --var SEED_MODE:never --var DEV_AUTH:1 --var MODEL_MODE:offline`,
      url: `http://localhost:${API_PORT}/api/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      env: { VC_API_URL: `http://localhost:${API_PORT}` },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
