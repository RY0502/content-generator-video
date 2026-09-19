import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    env: {
      EPISODE_SCRIPT_SCENES_PER_CHUNK: "8",
      PRODUCTION_MIN_SCENES: "16",
      PRODUCTION_MAX_SCENES: "40",
    },
    server: {
      deps: {
        inline: [/p-retry/],
      },
    },
  },
  server: {
    deps: {
      inline: [/p-retry/],
    },
  },
});
