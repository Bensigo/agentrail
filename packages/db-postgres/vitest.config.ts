import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Real-Postgres integration files share one queue. In particular,
    // claimReviewJob is intentionally global, so parallel files can claim a
    // transient job created by another test before that test terminalizes it.
    fileParallelism: false,
  },
});
