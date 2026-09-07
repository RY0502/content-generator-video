import { describe, expect, it } from "vitest";
import {
  ProductionScriptContractError,
  hasStartedAgnesSubmission,
  inspectProductionScript,
  productionScriptReadiness,
} from "../services/productionScriptContract.js";

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
      sceneDetails: "Pip the Ant remains fully visible beside the same berry while Ladybug friend watches warmly near the clubhouse.",
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

  it("rejects group entities, living anchors, aliases, and uncounted background figures without imposing a cast ceiling", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.characterNames = ["Pip the Ant", "Mia", "Leo"];
    scene.characterVisuals = [
      scene.characterVisuals[0]!,
      { name: "Mia", visualForm: "humanoid", speciesOrType: "young girl", humanoidAllowed: true },
      { name: "Leo", visualForm: "humanoid", speciesOrType: "young boy", humanoidAllowed: true },
    ];
    scene.supportingEntities = ["Dino herd: three green baby dinosaurs"];
    scene.continuityAnchors = ["Dino herd position: beside the stream"];
    scene.environmentDescription = "A fern valley with grazing dinosaurs behind the path.";
    scene.action = "The friends point while the baby dinosaur follows the bag.";

    const result = inspectProductionScript(
      script,
      ["Pip the Ant", "Mia", "Leo"],
    );
    const text = result.issues.join(" ");
    expect(result.pass).toBe(false);
    expect(text).not.toContain("allow at most");
    expect(text).toContain("Each supportingEntities entry must identify exactly one visible individual");
    expect(text).toContain("continuityAnchors are only for non-living props");
    expect(text).toContain("environmentDescription introduces uncounted background figures");
    expect(text).toContain("uses a collective or generic cast alias");
  });

  it("does not mistake an exact object-character name for a generic alias", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.characterNames = ["Bobo the Backpack"];
    scene.characterVisuals = [{
      name: "Bobo the Backpack",
      visualForm: "object_character",
      speciesOrType: "living backpack",
      humanoidAllowed: false,
    }];
    scene.action = "Bobo the Backpack bounces once beside the berry.";
    scene.sceneDetails = "Bobo the Backpack waits left of the berry; Bobo smiles; the meadow stays clear; no one else enters.";

    const result = inspectProductionScript(script, ["Pip the Ant", "Bobo the Backpack"]);
    expect(result.issues.join(" ")).not.toContain("collective or generic cast alias");
  });

  it("rejects a declared figure that is not explicitly staged by exact name", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.characterNames = ["Pip the Ant", "Mia"];
    scene.characterVisuals.push({
      name: "Mia",
      visualForm: "humanoid",
      speciesOrType: "young girl",
      humanoidAllowed: true,
    });

    const result = inspectProductionScript(script, ["Pip the Ant", "Mia"]);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain(
      "declares figure \"Mia\" but never names it in action/sceneDetails",
    );
  });

  it("rejects figures smuggled outside the exact per-scene cast arrays", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.environmentDescription = "A sunny meadow where Mia waits beside the clubhouse.";
    scene.action = "Pip the Ant carries the berry while Leo waves from the path.";
    scene.continuityAnchors = [
      "Berry position: one red berry beside Ladybug friend near the clubhouse.",
    ];

    const result = inspectProductionScript(script, ["Pip the Ant", "Mia", "Leo"]);
    const text = result.issues.join(" ");
    expect(result.pass).toBe(false);
    expect(text).toContain("environmentDescription mentions visible figure");
    expect(text).toContain("action/sceneDetails mentions unlisted figure");
    expect(text).toContain("continuityAnchors are only for non-living props");
  });

  it("returns repair_required only before durable Agnes work begins", () => {
    const inspection = inspectProductionScript({ scenes: [] }, ["Pip the Ant"]);
    const untouched = {
      status: "pending",
      attemptCount: 0,
      providerTaskId: null,
      providerReceipt: null,
      submittedAt: null,
    };
    const claimed = { ...untouched, attemptCount: 1 };

    expect(hasStartedAgnesSubmission(untouched)).toBe(false);
    expect(hasStartedAgnesSubmission(claimed)).toBe(true);
    expect(productionScriptReadiness(inspection, [untouched])).toMatchObject({
      status: "repair_required",
      canReplaceScript: true,
      agnesSubmissionStarted: false,
    });
    expect(productionScriptReadiness(inspection, [claimed])).toMatchObject({
      status: "repair_blocked",
      canReplaceScript: false,
      agnesSubmissionStarted: true,
    });
  });

  it("carries deterministic inspection details in its typed media-boundary error", () => {
    const inspection = inspectProductionScript({ scenes: [] }, ["Pip the Ant"]);
    const error = new ProductionScriptContractError(inspection);

    expect(error).toBeInstanceOf(ProductionScriptContractError);
    expect(error.inspection).toBe(inspection);
    expect(error.message).toContain("Persisted episode script violates the production contract");
  });
});
