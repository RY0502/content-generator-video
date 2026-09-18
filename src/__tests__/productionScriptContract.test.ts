import { describe, expect, it } from "vitest";
import {
  ProductionScriptContractError,
  hasStartedAgnesSubmission,
  inspectProductionScript,
  productionScriptReadiness,
} from "../services/productionScriptContract.js";
import { DEFAULT_PRODUCTION_MIN_SCENES } from "../services/narrationContract.js";

function productionScript() {
  const narration =
    "Pip gently carries the bright berry across the sunny meadow while patient friends smile beside their cozy little clubhouse today.";
  return {
    title: "Pip Shares a Berry",
    scenes: Array.from({ length: DEFAULT_PRODUCTION_MIN_SCENES }, (_unused, index) => ({
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
      sceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
    });
  });

  it("rejects guests in characterNames while treating visual metadata as advisory", () => {
    const script = productionScript();
    script.scenes[4]!.characterNames = ["Surprise Fox"];
    script.scenes[4]!.characterVisuals[0]!.name = "Surprise Fox";
    script.scenes[7]!.cameraAngle = "";

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("non-roster name");
    expect(result.issues.join(" ")).not.toContain("cameraAngle");
  });

  it("does not reject advisory descriptor or legacy characterVisual changes", () => {
    const script = productionScript();
    script.scenes[2]!.supportingEntities = ["Ladybug friend: large purple beetle with silver wings"];
    script.scenes[3]!.characterVisuals[0]!.visualForm = "humanoid";

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(true);
  });

  it("does not use subjective duplicate-beat detection as a persistence gate", () => {
    const script = productionScript();
    script.scenes[8] = {
      ...structuredClone(script.scenes[7]!),
      sceneNumber: 9,
    };

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(true);
  });

  it("rejects unmistakable generated placeholders without imposing subjective prose QA", () => {
    const script = productionScript();
    script.scenes[4]!.narrationText = "scene 5 narration";
    script.scenes[5]!.environmentDescription = "...";
    script.scenes[6]!.action = "scene 7 action";

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    const issues = result.issues.join(" ");

    expect(result.pass).toBe(false);
    expect(issues).toContain("synthetic scene-number placeholder");
    expect(issues).toContain("Scene 6 environmentDescription must be real filmable prose");
    expect(issues).toContain("Scene 7 action must be real filmable prose");
  });

  it("keeps semantic cast and anchor guidance advisory", () => {
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
    expect(result.pass).toBe(true);
    expect(text).toBe("");
  });

  it("does not semantically interpret supporting-entity labels", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.supportingEntities = ["Mammoths: cinnamon wool, curved ivory tusks, and round brown eyes"];
    scene.action = "Pip the Ant waves while Mammoths stop beside the berry.";
    scene.sceneDetails =
      "Pip the Ant remains left of the berry while Mammoths occupy the right side. " +
      "The clubhouse and short grass remain clear behind them.";

    const result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(true);
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
    scene.sceneDetails = "Bobo the Backpack waits left of the berry; Bobo the Backpack smiles; the meadow stays clear; no one else enters.";

    const result = inspectProductionScript(script, ["Pip the Ant", "Bobo the Backpack"]);
    expect(result.issues.join(" ")).not.toContain("collective or generic cast alias");
    expect(result.issues.join(" ")).not.toContain("main-character alias");
  });

  it("accepts a legacy unique roster alias on read so durable episodes can be canonicalized at prompt time", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.characterNames = ["Bobo the Backpack"];
    scene.characterVisuals = [{
      name: "Bobo the Backpack",
      visualForm: "object_character",
      speciesOrType: "living backpack",
      humanoidAllowed: false,
    }];
    scene.action = "Bobo bounces once beside the berry.";
    scene.sceneDetails = "Bobo waits left of the berry while the meadow stays clear.";

    const result = inspectProductionScript(script, ["Pip the Ant", "Bobo the Backpack"]);
    expect(result.issues.join(" ")).not.toContain("main-character alias");
  });

  it("accepts legacy aliases because exact roster identity comes from characterNames", () => {
    const script = productionScript();
    script.scenes[0] = {
      ...script.scenes[0]!,
      action: "Pip the Ant points while Bobo nudges snow beside the berry.",
      supportingEntities: [
        "Bobo: a playful magical living backpack with button eyes and yellow straps",
      ],
      sceneDetails:
        "Pip the Ant stands left of the berry while Bobo waits on the right. " +
        "Both remain fully visible beside the clubhouse.",
    };
    script.scenes[1] = {
      ...script.scenes[1]!,
      action: "Pip the Ant points while Bobo the Backpack nudges snow beside the berry.",
      characterNames: ["Pip the Ant", "Bobo the Backpack"],
      characterVisuals: [
        script.scenes[1]!.characterVisuals[0]!,
        {
          name: "Bobo the Backpack",
          visualForm: "object_character",
          speciesOrType: "living backpack",
          humanoidAllowed: false,
        },
      ],
      supportingEntities: [],
      sceneDetails:
        "Pip the Ant stands left of the berry while Bobo the Backpack waits on the right. " +
        "Both remain fully visible beside the clubhouse.",
    };

    const result = inspectProductionScript(
      script,
      ["Pip the Ant", "Bobo the Backpack"],
    );
    expect(result.issues.join(" ")).not.toContain("main-character alias");
    expect(result.issues.join(" ")).not.toContain(
      'action/sceneDetails mentions unlisted figure "bobo"',
    );

    script.scenes[1]!.action =
      "Bobo watches while Bobo the Backpack nudges snow beside Pip the Ant.";
    expect(inspectProductionScript(
      script,
      ["Pip the Ant", "Bobo the Backpack"],
    ).pass).toBe(true);
  });

  it("does not infer roster identity from prose aliases", () => {
    const script = productionScript();
    script.scenes[0] = {
      ...script.scenes[0]!,
      action: "Pip the Ant greets Bobo beside the berry.",
      supportingEntities: ["Bobo: one small blue living bag"],
      sceneDetails: "Pip the Ant waits left while Bobo stands on the right.",
    };

    const result = inspectProductionScript(
      script,
      ["Pip the Ant", "Bobo the Backpack", "Bobo the Satchel"],
    );
    expect(result.pass).toBe(true);
  });

  it("does not reject subjective prose staging", () => {
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
    expect(result.pass).toBe(true);
  });

  it("does not semantically scan environment/action/anchors for figure names", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.environmentDescription = "A sunny meadow where Mia waits beside the clubhouse.";
    scene.action = "Pip the Ant carries the berry while Leo waves from the path.";
    scene.continuityAnchors = [
      "Berry position: one red berry beside Ladybug friend near the clubhouse.",
    ];

    const result = inspectProductionScript(script, ["Pip the Ant", "Mia", "Leo"]);
    expect(result.pass).toBe(true);
  });

  it("enforces unique exact roster names and the five-name Agnes reference cap", () => {
    const script = productionScript();
    const roster = ["Pip", "Mia", "Leo", "Tara", "Bobo", "Nia"];
    script.scenes[0]!.characterNames = roster;
    let result = inspectProductionScript(script, roster);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("at most 5 exact roster names");

    script.scenes[0]!.characterNames = ["Pip", "Pip"];
    result = inspectProductionScript(script, roster);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("duplicate entries");
  });

  it("accepts omitted characterVisuals and optional structurally valid arrays", () => {
    const script = productionScript();
    delete (script.scenes[0] as Partial<(typeof script.scenes)[number]>).characterVisuals;
    expect(inspectProductionScript(script, ["Pip the Ant"])).toMatchObject({ pass: true });
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

  it("enforces unique visible cast across characterNames and supportingEntities", () => {
    const script = productionScript();
    const scene = script.scenes[0]!;
    scene.characterNames = ["Pip the Ant"];
    scene.supportingEntities = [
      "Stable: tall green trees with thick foliage",
      "Stable: friendly animal sounds echoing gently",
    ];

    let result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("Scene 1 visible cast must contain each main or supporting figure exactly once.");

    // Collision between supporting figure name and characterNames
    scene.supportingEntities = ["Pip the Ant: guest appearance in a blue coat"];
    result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(false);
    expect(result.issues.join(" ")).toContain("Scene 1 visible cast must contain each main or supporting figure exactly once.");

    // Valid unique guest
    scene.supportingEntities = ["Bella the Bird: tiny yellow canary with bright feathers"];
    result = inspectProductionScript(script, ["Pip the Ant"]);
    expect(result.pass).toBe(true);
  });
});
