import { describe, expect, it } from "vitest";
import {
  canonicalizeSceneCast,
  findGenericVisualCastAliases,
  findMentionedUnlistedFigureNames,
  isCollectiveSupportingIdentity,
  type SceneCastLike,
} from "../services/sceneCastCanonicalizer.js";

const MIA_VISUAL = {
  name: "Mia",
  visualForm: "humanoid",
  speciesOrType: "human child",
  humanoidAllowed: true,
} as const;

const BOBO_VISUAL = {
  name: "Bobo",
  visualForm: "object_character",
  speciesOrType: "small red talking backpack",
  humanoidAllowed: false,
} as const;

function baseScene(overrides: SceneCastLike = {}): SceneCastLike {
  return {
    sceneNumber: 7,
    narrationText: "Mia hears a gentle call beside the fern-covered trail.",
    environmentDescription: "A fern-covered trail curves beside a shallow stream.",
    action: "Mia points toward the stream.",
    characterNames: ["Mia"],
    characterVisuals: [MIA_VISUAL],
    supportingEntities: [],
    continuityAnchors: ["Compass: open on the flat stepping stone"],
    sceneDetails: "Mia kneels on the left side of the trail and studies one footprint.",
    cameraAngle: "child-height medium-wide locked camera",
    lighting: "soft golden morning light filtered through ferns",
    ...overrides,
  };
}

describe("sceneCastCanonicalizer", () => {
  it("locks main visuals and supporting descriptors from explicit, bible, and durable sources", () => {
    const durableAcceptedScenes = [baseScene({
      characterNames: ["Mia"],
      characterVisuals: [MIA_VISUAL],
      supportingEntities: [
        "Calf Mammoth: small cinnamon-brown calf with a cream forehead tuft",
      ],
    })];
    const input = baseScene({
      action: "Mia greets Mother Mammoth while Calf Mammoth waits beside the stream.",
      characterNames: ["Mia", "Bobo"],
      characterVisuals: [
        { name: "Mia", visualForm: "fantasy_creature" },
        { name: "Bobo", visualForm: "humanoid", humanoidAllowed: true },
      ],
      supportingEntities: [
        "Mother Mammoth: a randomly changing gray mammoth",
        "Calf Mammoth: a descriptor that drifted",
      ],
      sceneDetails: "Mia and Bobo face Mother Mammoth; Calf Mammoth stays at her right side.",
    });

    const result = canonicalizeSceneCast(input, {
      durableAcceptedScenes,
      canonicalCharacterVisuals: { Bobo: BOBO_VISUAL },
      supportingEntityBible: [
        "Mother Mammoth: tall cinnamon-brown mammoth with curved ivory tusks",
      ],
    });

    expect(result.scene.characterVisuals).toEqual([MIA_VISUAL, BOBO_VISUAL]);
    expect(result.scene.supportingEntities).toEqual([
      "Mother Mammoth: tall cinnamon-brown mammoth with curved ivory tusks",
      "Calf Mammoth: small cinnamon-brown calf with a cream forehead tuft",
    ]);
    expect(result.exactCastNames).toEqual(["Mia", "Bobo", "Mother Mammoth", "Calf Mammoth"]);
    expect(result.audit.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "canonical_character_visual", name: "Mia", source: "durable" }),
      expect.objectContaining({ kind: "canonical_character_visual", name: "Bobo", source: "explicit" }),
      expect.objectContaining({ kind: "canonical_supporting_descriptor", name: "Mother Mammoth", source: "bible" }),
      expect.objectContaining({ kind: "canonical_supporting_descriptor", name: "Calf Mammoth", source: "durable" }),
    ]));
  });

  it("keeps a descriptor already established by an accepted scene ahead of a conflicting legacy plan", () => {
    const acceptedDescriptor =
      "Baby Dino: small moss-green dinosaur with amber eyes and one cream forehead spot";
    const result = canonicalizeSceneCast(baseScene({
      action: "Mia kneels while Baby Dino follows one footprint.",
      supportingEntities: ["Baby Dino: newly drifting purple dinosaur"],
      sceneDetails: "Mia points ahead; Baby Dino waits beside the left fern.",
    }), {
      durableAcceptedScenes: [baseScene({ supportingEntities: [acceptedDescriptor] })],
      supportingEntityBible: [
        "Baby Dino: incompatible older plan description with blue stripes",
      ],
    });

    expect(result.scene.supportingEntities).toEqual([acceptedDescriptor]);
    expect(result.audit.applied).toContainEqual(expect.objectContaining({
      kind: "canonical_supporting_descriptor",
      name: "Baby Dino",
      source: "durable",
    }));
    expect(result.audit.unresolved).toContainEqual(expect.objectContaining({
      kind: "canonical_source_conflict",
      name: "Baby Dino",
      keptSource: "durable",
      ignoredSource: "bible",
    }));
  });

  it("mechanically replaces a definite object alias and appends missing exact names idempotently", () => {
    const input = baseScene({
      action: "Mia opens the backpack while Leo watches the trail.",
      characterNames: ["Mia", "Leo", "Bobo"],
      characterVisuals: [
        MIA_VISUAL,
        { name: "Leo", visualForm: "humanoid", speciesOrType: "human child" },
        BOBO_VISUAL,
      ],
      supportingEntities: [
        "Mother Mammoth: tall cinnamon-brown mammoth with curved ivory tusks",
      ],
      sceneDetails: "Mia stands left of Leo as the bag glows beside one mossy stone.",
    });

    const first = canonicalizeSceneCast(input, {
      supportingEntityBible: [
        "Mother Mammoth: tall cinnamon-brown mammoth with curved ivory tusks",
      ],
    });
    const second = canonicalizeSceneCast(first.scene, {
      supportingEntityBible: [
        "Mother Mammoth: tall cinnamon-brown mammoth with curved ivory tusks",
      ],
    });

    expect(first.scene.action).toBe("Mia opens Bobo while Leo watches the trail.");
    expect(first.scene.sceneDetails).toBe(
      "Mia stands left of Leo as Bobo glows beside one mossy stone. " +
      "Visible exactly once: Mother Mammoth.",
    );
    expect(first.audit.applied).toEqual(expect.arrayContaining([
      {
        kind: "safe_object_alias",
        field: "action",
        before: "the backpack",
        after: "Bobo",
        occurrences: 1,
      },
      {
        kind: "safe_object_alias",
        field: "sceneDetails",
        before: "the bag",
        after: "Bobo",
        occurrences: 1,
      },
      {
        kind: "exact_visible_presence",
        field: "sceneDetails",
        names: ["Mother Mammoth"],
      },
    ]));
    expect(second.scene).toEqual(first.scene);
    expect(second.changed).toBe(false);
    expect(second.audit.applied).toEqual([]);
  });

  it("never replaces an alias inside a canonical object name and heals the legacy doubled form", () => {
    const fullBoboVisual = {
      ...BOBO_VISUAL,
      name: "Bobo the Backpack",
    };
    const canonical = baseScene({
      action: "Bobo the Backpack nudges snow toward Mia.",
      characterNames: ["Mia", "Bobo the Backpack"],
      characterVisuals: [MIA_VISUAL, fullBoboVisual],
      sceneDetails: "Mia holds one branch while Bobo the Backpack packs the snow.",
    });

    const unchanged = canonicalizeSceneCast(canonical);
    expect(unchanged.scene).toEqual(canonical);
    expect(unchanged.changed).toBe(false);

    const healed = canonicalizeSceneCast({
      ...canonical,
      action: "Bobo Bobo the Backpack nudges snow toward Mia.",
      sceneDetails: "Mia holds one branch while Bobo Bobo the Backpack packs the snow.",
    });
    expect(healed.scene.action).toBe("Bobo the Backpack nudges snow toward Mia.");
    expect(healed.scene.sceneDetails).toBe(
      "Mia holds one branch while Bobo the Backpack packs the snow.",
    );
    expect(canonicalizeSceneCast(healed.scene).changed).toBe(false);

    const bareAlias = canonicalizeSceneCast({
      ...canonical,
      action: "Mia steadies the backpack beside the ridge.",
    });
    expect(bareAlias.scene.action).toBe(
      "Mia steadies Bobo the Backpack beside the ridge.",
    );
  });

  it("promotes one safe roster short alias out of supportingEntities without changing cast size", () => {
    const input = baseScene({
      action: "Mia steadies Bobo as its yellow straps begin to glow.",
      supportingEntities: [
        "Bobo: playful magical living backpack with button eyes and yellow straps",
      ],
      sceneDetails: "Mia stands left while Bobo waits on the right.",
    });

    const first = canonicalizeSceneCast(input, {
      mainCharacterNames: ["Mia", "Bobo the Backpack"],
      supportingEntityBible: [
        "Bobo: playful magical living backpack with button eyes and yellow straps",
      ],
    });
    const second = canonicalizeSceneCast(first.scene, {
      mainCharacterNames: ["Mia", "Bobo the Backpack"],
    });

    expect(first.scene.characterNames).toEqual(["Mia", "Bobo the Backpack"]);
    expect(first.scene.characterVisuals).toEqual([
      MIA_VISUAL,
      {
        name: "Bobo the Backpack",
        visualForm: "object_character",
        speciesOrType: "backpack",
        humanoidAllowed: false,
      },
    ]);
    expect(first.scene.supportingEntities).toEqual([]);
    expect(first.scene.action).toBe(
      "Mia steadies Bobo the Backpack as its yellow straps begin to glow.",
    );
    expect(first.scene.sceneDetails).toBe(
      "Mia stands left while Bobo the Backpack waits on the right.",
    );
    expect(first.exactCastNames).toEqual(["Mia", "Bobo the Backpack"]);
    expect(first.audit.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "canonical_main_character_alias",
        field: "supportingEntities",
        alias: "Bobo",
        name: "Bobo the Backpack",
      }),
      expect.objectContaining({
        kind: "inferred_object_character_visual",
        name: "Bobo the Backpack",
      }),
    ]));
    expect(second.scene).toEqual(first.scene);
    expect(second.changed).toBe(false);
  });

  it("removes a supporting alias duplicate when the exact roster character is already declared", () => {
    const fullBoboVisual = {
      ...BOBO_VISUAL,
      name: "Bobo the Backpack",
      speciesOrType: "backpack",
    };
    const result = canonicalizeSceneCast(baseScene({
      action: "Mia and Bobo the Backpack face the stream.",
      characterNames: ["Mia", "Bobo the Backpack"],
      characterVisuals: [MIA_VISUAL, fullBoboVisual],
      supportingEntities: ["Bobo: blue living backpack with yellow straps"],
      sceneDetails: "Mia stands left of Bobo the Backpack.",
    }), {
      mainCharacterNames: ["Mia", "Bobo the Backpack"],
    });

    expect(result.scene.characterNames).toEqual(["Mia", "Bobo the Backpack"]);
    expect(result.scene.supportingEntities).toEqual([]);
    expect(result.exactCastNames).toEqual(["Mia", "Bobo the Backpack"]);
  });

  it("rewrites a safe short alias in staging text when the cast already uses the exact roster name", () => {
    const result = canonicalizeSceneCast(baseScene({
      action: "Mia steadies Bobo beside the stream.",
      characterNames: ["Mia", "Bobo the Backpack"],
      characterVisuals: [
        MIA_VISUAL,
        {
          ...BOBO_VISUAL,
          name: "Bobo the Backpack",
          speciesOrType: "backpack",
        },
      ],
      sceneDetails: "Mia stands left while Bobo waits on the right.",
    }), {
      mainCharacterNames: ["Mia", "Bobo the Backpack"],
    });

    expect(result.scene.action).toBe(
      "Mia steadies Bobo the Backpack beside the stream.",
    );
    expect(result.scene.sceneDetails).toBe(
      "Mia stands left while Bobo the Backpack waits on the right.",
    );
  });

  it("fails closed when one short alias could name multiple roster object characters", () => {
    const input = baseScene({
      action: "Mia steadies Bobo beside the stream.",
      supportingEntities: ["Bobo: one bright living bag"],
      sceneDetails: "Mia stands left while Bobo waits on the right.",
    });
    const result = canonicalizeSceneCast(input, {
      mainCharacterNames: ["Mia", "Bobo the Backpack", "Bobo the Satchel"],
    });

    expect(result.scene.characterNames).toEqual(["Mia"]);
    expect(result.scene.supportingEntities).toEqual(input.supportingEntities);
    expect(result.audit.unresolved).toContainEqual({
      kind: "ambiguous_main_character_alias",
      field: "supportingEntities",
      alias: "Bobo",
      candidates: ["Bobo the Backpack", "Bobo the Satchel"],
      index: 0,
    });
    expect(result.audit.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "ambiguous_main_character_alias",
        field: "action",
        alias: "Bobo",
      }),
      expect.objectContaining({
        kind: "ambiguous_main_character_alias",
        field: "sceneDetails",
        alias: "Bobo",
      }),
    ]));
  });

  it("masks a declared long name before looking for a shorter legacy identity", () => {
    expect(findMentionedUnlistedFigureNames(
      "Mia waves while Bobo the Backpack nudges snow.",
      ["Mia", "Bobo", "Bobo the Backpack"],
      ["Mia", "Bobo the Backpack"],
    )).toEqual([]);
    expect(findMentionedUnlistedFigureNames(
      "Bobo watches Bobo the Backpack nudge snow.",
      ["Mia", "Bobo", "Bobo the Backpack"],
      ["Mia", "Bobo the Backpack"],
    )).toEqual(["Bobo"]);
  });

  it("does not guess an object alias when multiple object characters are visible", () => {
    const input = baseScene({
      action: "Mia places the bag beside the backpack.",
      characterNames: ["Bobo", "Pip"],
      characterVisuals: [
        BOBO_VISUAL,
        { name: "Pip", visualForm: "object_character", speciesOrType: "blue talking satchel" },
      ],
      sceneDetails: "Bobo waits to the left while Pip waits to the right.",
    });

    const result = canonicalizeSceneCast(input);

    expect(result.scene.action).toBe(input.action);
    expect(result.audit.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "ambiguous_object_alias",
        field: "action",
        candidates: ["Bobo", "Pip"],
      }),
    ]));
  });

  it("recognizes a sole clearly described supporting object character", () => {
    const boboDescriptor =
      "Bobo: small red living backpack with bright eyes, a friendly face, and one gold clasp";
    const input = baseScene({
      action: "Mia opens the backpack beside the fern-covered trail.",
      supportingEntities: [boboDescriptor],
      sceneDetails: "Mia steadies the bag while its gold clasp begins to glow.",
    });

    const result = canonicalizeSceneCast(input, {
      supportingEntityBible: [boboDescriptor],
    });

    expect(result.scene.action).toBe("Mia opens Bobo beside the fern-covered trail.");
    expect(result.scene.sceneDetails).toBe(
      "Mia steadies Bobo while its gold clasp begins to glow.",
    );
    expect(result.exactCastNames).toEqual(["Mia", "Bobo"]);
    expect(result.audit.applied).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "safe_object_alias", field: "action", after: "Bobo" }),
      expect.objectContaining({ kind: "safe_object_alias", field: "sceneDetails", after: "Bobo" }),
    ]));
  });

  it("leaves collective aliases unchanged and reports each affected field", () => {
    const input = baseScene({
      action: "Mia leads the children toward the mammoths without startling the herd.",
      sceneDetails: "The herd stays near the ferns while Mia stops at the stream.",
    });

    const result = canonicalizeSceneCast(input);

    expect(result.scene.action).toBe(input.action);
    expect(result.scene.sceneDetails).toBe(input.sceneDetails);
    expect(result.audit.unresolved).toEqual(expect.arrayContaining([
      { kind: "generic_or_group_alias", field: "action", alias: "children" },
      { kind: "generic_or_group_alias", field: "action", alias: "mammoths" },
      { kind: "generic_or_group_alias", field: "action", alias: "herd" },
      { kind: "generic_or_group_alias", field: "sceneDetails", alias: "herd" },
    ]));
    expect(findGenericVisualCastAliases(
      "Mother Mammoth waits while the mammoths gather into a herd.",
      ["Mother Mammoth"],
    )).toEqual(["mammoths", "herd"]);
    expect(isCollectiveSupportingIdentity("Mammoths")).toBe(true);
    expect(isCollectiveSupportingIdentity("Calves")).toBe(true);
    expect(isCollectiveSupportingIdentity("Luma the Firefly")).toBe(false);
  });

  it("does not mutate input or exceed the configured sceneDetails size bound", () => {
    const details = `${"x".repeat(109)}.`;
    const input = Object.freeze(baseScene({
      action: "A footprint appears beside the stream.",
      sceneDetails: details,
      characterNames: Object.freeze(["Mia"]),
      characterVisuals: Object.freeze([Object.freeze({ ...MIA_VISUAL })]),
      continuityAnchors: Object.freeze(["Footprint: fresh beside the stream"]),
    }));
    const before = JSON.stringify(input);

    const result = canonicalizeSceneCast(input, { maximumSceneDetailsLength: 120 });

    expect(JSON.stringify(input)).toBe(before);
    expect(result.scene.sceneDetails).toBe(details);
    expect(String(result.scene.sceneDetails)).toHaveLength(110);
    expect(result.audit.unresolved).toContainEqual({
      kind: "presence_clause_too_large",
      field: "sceneDetails",
      names: ["Mia"],
      maximumLength: 120,
    });
    expect(JSON.stringify(result.audit).length).toBeLessThan(400);
  });

  it("keeps all non-cast creative and continuity fields byte-for-byte unchanged", () => {
    const input = baseScene({
      narrationText: "  Deliberate narration whitespace remains.  ",
      environmentDescription: "  The same valley; mist curls above the water.  ",
      action: "Mia nods to Mother Mammoth.",
      supportingEntities: [
        "Mother Mammoth: temporary description",
      ],
      sceneDetails: "Mia and Mother Mammoth hold their positions.",
    });

    const result = canonicalizeSceneCast(input, {
      supportingEntityBible: ["Mother Mammoth: locked cinnamon coat and ivory tusks"],
    });

    for (const field of [
      "narrationText",
      "environmentDescription",
      "characterNames",
      "continuityAnchors",
      "cameraAngle",
      "lighting",
    ] as const) {
      expect(result.scene[field]).toBe(input[field]);
    }
    expect(result.scene.action).toBe(input.action);
    expect(result.scene.sceneDetails).toBe(input.sceneDetails);
  });
});
