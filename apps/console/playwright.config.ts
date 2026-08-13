import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  forbidOnly: Boolean(process.env["CI"]),
  outputDir: "./test-results/r11-acceptance-record-detail",
  reporter: "line",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node_modules/.bin/next start --hostname 127.0.0.1 --port 3100",
    cwd: new URL(".", import.meta.url).pathname,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
