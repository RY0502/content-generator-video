import { describe, expect, it } from "vitest";
import {
  inspectProductionScript,
  validateFocalPropContinuity,
} from "../services/productionScriptContract.js";
import { buildStylizedScenePrompt } from "../promptBuilder.js";

describe("Focal Prop and Construction Continuity Contract", () => {
  it("rejects scenes where action mentions bridge building/crossing but anchors lack bridge definition", () => {
    const issues: string[] = [];
    const scene = {
      sceneNumber: 9,
      action: "Nibbles sets stone pillars and Sunny weaves vines between them, creating the bridge base.",
      narrationText: "Stone pillars stand firm!",
      environmentDescription: "creek area with flowing water, smooth rocks, and fallen leaves near the meadow",
      continuityAnchors: ["flowing creek water", "smooth river rocks", "fallen leaves"],
    };

    validateFocalPropContinuity(scene, "Scene 9", issues);

    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('Scene 9 action/narration features focal structure/container "bridge"');
    expect(issues[0]).toContain("neither continuityAnchors nor environmentDescription defines it");
  });

  it("passes scenes when the bridge is explicitly defined in continuityAnchors", () => {
    const issues: string[] = [];
    const scene = {
      sceneNumber: 9,
      action: "Nibbles sets stone pillars and Sunny weaves vines between them, creating the bridge base.",
      narrationText: "Stone pillars stand firm!",
      environmentDescription: "creek area with flowing water, smooth rocks, and fallen leaves near the meadow",
      continuityAnchors: [
        "flowing creek water",
        "Bridge blueprint: two peeled birch logs spanning the creek with woven green-vine railings and stone footings (Stage 2: stone pillars being set)",
      ],
    };

    validateFocalPropContinuity(scene, "Scene 9", issues);

    expect(issues.length).toBe(0);
  });

  it("passes scenes when the focal structure is defined in environmentDescription", () => {
    const issues: string[] = [];
    const scene = {
      sceneNumber: 15,
      action: "All four friends cross the completed bridge together.",
      narrationText: "All cross together!",
      environmentDescription: "At the completed birch log and green-vine bridge spanning the clear flowing creek",
      continuityAnchors: ["flowing creek water", "smooth river rocks"],
    };

    validateFocalPropContinuity(scene, "Scene 15", issues);

    expect(issues.length).toBe(0);
  });

  it("rejects refrigerator scenes when the parent container is dropped from env and anchors", () => {
    const issues: string[] = [];
    const scene = {
      sceneNumber: 3,
      action: "Pip notices the ice begins to melt inside the freezer compartment.",
      narrationText: "Look at the dripping ice!",
      environmentDescription: "A bright kitchen counter with a glass of water",
      continuityAnchors: ["glass of water", "kitchen counter"],
    };

    validateFocalPropContinuity(scene, "Scene 3", issues);

    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('focal structure/container "refrigerator"');
  });

  it("rejects laundry basket scenes when the basket is dropped from env and anchors", () => {
    const issues: string[] = [];
    const scene = {
      sceneNumber: 4,
      action: "Pip climbs into the laundry basket to search through the clothes.",
      narrationText: "Down into the clothes we go!",
      environmentDescription: "A child's bedroom with a wooden floor",
      continuityAnchors: ["wooden floor", "blue rug"],
    };

    validateFocalPropContinuity(scene, "Scene 4", issues);

    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('focal structure/container "laundry basket"');
  });

  it("adds FOCAL PROP & STRUCTURE LOCK to promptBuilder when continuity anchors are present", () => {
    const prompt = buildStylizedScenePrompt({
      characterNames: ["Pip"],
      environmentDescription: "Creek bank near the meadow",
      action: "Pip examines the crossing spot.",
      narrationText: "Look at the creek!",
      cameraAngle: "medium",
      lighting: "daylight",
      continuityAnchors: [
        "Bridge blueprint: two peeled birch logs with woven vine railings",
      ],
    });

    expect(prompt).toContain("FOCAL PROP & STRUCTURE LOCK");
    expect(prompt).toContain("preserve the exact materials, architecture, colors, textures, and construction stage");
  });
});
