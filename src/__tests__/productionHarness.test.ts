import { describe, expect, it } from "vitest";
import { getHarnessProfile } from "deepagents";
import {
  assertProductionHarnessConfigured,
  configureProductionHarness,
  PRODUCTION_EXCLUDED_AGENT_MIDDLEWARE,
  PRODUCTION_EXCLUDED_AGENT_TOOLS,
} from "../services/productionHarness.js";

describe("production DeepAgent harness", () => {
  it("hides generic tools that can duplicate scripts in conversation history", () => {
    configureProductionHarness();
    expect(() => assertProductionHarnessConfigured()).not.toThrow();

    const profile = getHarnessProfile("openai");
    expect(profile?.generalPurposeSubagent?.enabled).toBe(false);
    for (const toolName of PRODUCTION_EXCLUDED_AGENT_TOOLS) {
      expect(profile?.excludedTools.has(toolName), toolName).toBe(true);
    }
    for (const middlewareName of PRODUCTION_EXCLUDED_AGENT_MIDDLEWARE) {
      expect(profile?.excludedMiddleware.has(middlewareName), middlewareName).toBe(true);
    }
  });
});
