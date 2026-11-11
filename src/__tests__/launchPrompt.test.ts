import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const launchPrompt = readFileSync(
  new URL("../../prompt.txt", import.meta.url),
  "utf8",
).trim();

describe("production launch prompt", () => {
  it("keeps the creative brief without duplicating obsolete pipeline rules", () => {
    expect(launchPrompt.length).toBeLessThan(5_000);
    expect(launchPrompt).toContain("Generate the next episode");
    expect(launchPrompt).toContain("Generation Requirements");

    for (const obsoleteRule of [
      "Image Generation Requirements",
      "30-45 scenes",
      "6-8 minutes",
      "1 scene = 1 image",
    ]) {
      expect(launchPrompt).not.toContain(obsoleteRule);
    }
  });
});
