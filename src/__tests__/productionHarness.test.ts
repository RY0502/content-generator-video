import { describe, expect, it } from "vitest";
import { getHarnessProfile } from "deepagents";
import {
  assertProductionHarnessConfigured,
  configureProductionHarness,
  PRODUCTION_EXCLUDED_AGENT_MIDDLEWARE,
  PRODUCTION_EXCLUDED_AGENT_TOOLS,
} from "../services/productionHarness.js";
import { PRODUCTION_TOOL_PROTOCOL_MIDDLEWARE_NAME } from "../services/productionToolProtocolMiddleware.js";
import { PRODUCTION_MODEL_CALL_FAILOVER_MIDDLEWARE_NAME } from "../services/productionModelCallFailoverMiddleware.js";

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
    const extraMiddleware = typeof profile?.extraMiddleware === "function"
      ? profile.extraMiddleware()
      : profile?.extraMiddleware ?? [];
    expect(extraMiddleware.map((middleware) => middleware.name)).toEqual([
      PRODUCTION_TOOL_PROTOCOL_MIDDLEWARE_NAME,
      PRODUCTION_MODEL_CALL_FAILOVER_MIDDLEWARE_NAME,
    ]);
  });
});
