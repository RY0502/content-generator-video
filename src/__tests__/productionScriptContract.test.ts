import { describe, expect, it } from "vitest";
import { inspectProductionScript } from "../services/productionScriptContract.js";

function productionScript() {
  const narration =
    "Pip gently carries the bright berry across the sunny meadow while patient friends smile beside their cozy little clubhouse today.";
  return {
    title: "Pip Shares a Berry",
    scenes: Array.from({ length: 40 }, (_unused, index) => ({
      sceneNumber: index + 1,
      narrationText: narration,
      environmentDescription: "A sunny green meadow beside the little wooden clubhouse.",
      action: `Pip takes careful step ${index + 1} while carrying the berry.`,
      characterNames: ["Pip the Ant"],
      characterVisuals: [{
        name: "Pip the Ant",
        visualForm: "real_creature",
        speciesOrType: "ant",
        humanoidAllowed: false,
      }],
      supportingEntities: ["Ladybug friend: tiny red ladybug with seven round black spots"],
      continuityAnchors: ["Berry: one glossy raspberry-red berry held carefully above the short grass."],
      sceneDetails: "Pip remains fully visible beside the same berry and clubhouse while his friends watch warmly.",
      cameraAngle: "medium wide shot at child eye level",
      lighting: "warm soft morning sunlight",
    })),
  };
}

describe("productionScriptContract", () => {
  it("accepts a complete fixed-roster direct-video manifest", () => {
    expect(inspectProductionScript(productionScript(), ["Pip the Ant"])).toMatchObject({
      pass: true,
      sceneCount: 40,
    });
  });

  it("rejects guests in characterNames and missing direct-video metadata", () => {
    const script = productionScript();
    script.scenes[4]!.characterNames = ["Surprise Fox"];
    script.scenes[4]!.characterVisuals[0]!.name = "Surprise Fox";
    script.scenes[7]!.cameraAngle = "";

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("non-roster name");
    expect(result.issues.join(" ")).toContain("missing required cameraAngle");
  });

  it("rejects changed recurring supporting descriptors and character ontology", () => {
    const script = productionScript();
    script.scenes[2]!.supportingEntities = ["Ladybug friend: large purple beetle with silver wings"];
    script.scenes[3]!.characterVisuals[0]!.visualForm = "humanoid";

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("repeat recurring descriptors verbatim");
    expect(result.issues.join(" ")).toContain("changes locked characterVisuals metadata");
  });

  it("rejects a renumbered duplicate scene before it can create duplicate media", () => {
    const script = productionScript();
    script.scenes[8] = {
      ...structuredClone(script.scenes[7]!),
      sceneNumber: 9,
    };

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("duplicates the complete narration/action beat");
  });
});
