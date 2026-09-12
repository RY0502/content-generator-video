import { describe, expect, it } from "vitest";
import {
  buildCompletedSceneBeatLedger,
  hasExplainedLightingTransition,
  inspectSceneContinuity,
  normalizeUnstagedLightingContinuity,
  type ContinuityScene,
  type PlannedStoryBeat,
} from "../services/sceneContinuityContract.js";

function scene(
  sceneNumber: number,
  overrides: Partial<ContinuityScene> = {},
): ContinuityScene {
  return {
    sceneNumber,
    narrationText: `Mia completes a distinct story action numbered ${sceneNumber} beside the moonlit garden path.`,
    environmentDescription: `Moonlit garden clearing ${sceneNumber}.`,
    action: `Mia completes distinct action ${sceneNumber} and leaves a unique result.`,
    characterNames: ["Mia"],
    supportingEntities: [],
    continuityAnchors: [],
    sceneDetails: `Mia remains fully visible while completing distinct action ${sceneNumber}; the new result remains beside the path.`,
    cameraAngle: "medium-wide fixed camera at child eye level",
    lighting: "soft silver moonlight with a warm lantern edge",
    ...overrides,
  };
}

describe("sceneContinuityContract", () => {
  it("returns a bounded full-prefix beat ledger without retransmitting scene JSON", () => {
    const scenes = Array.from({ length: 40 }, (_unused, index) => scene(index + 1, {
      narrationText: `${"A detailed narration phrase ".repeat(20)} ${index + 1}`,
      action: `${"A detailed visible action phrase ".repeat(20)} ${index + 1}`,
    }));

    const ledger = buildCompletedSceneBeatLedger(scenes);

    expect(ledger).toHaveLength(40);
    expect(ledger[0]).toContain("S1 [Mia]");
    expect(ledger[39]).toContain("S40 [Mia]");
    expect(Math.max(...ledger.map((entry) => entry.length))).toBeLessThanOrEqual(250);
    expect(JSON.stringify(ledger).length).toBeLessThan(10_500);
  });

  it("rejects a non-adjacent paraphrase of an earlier visual story beat", () => {
    const scenes = [
      scene(1, {
        narrationText: "Mia traces the bird symbol, then studies the zigzag water sign and loaf mark.",
        action: "Mia touches the carved bird, water zigzag, and bread symbol in order.",
        sceneDetails: "Mia follows the bird carving, water zigzag, and loaf-shaped mark with one fingertip.",
      }),
      scene(2),
      scene(3, {
        narrationText: "Mia presses the bird carving before examining the water zigzag and bread symbol.",
        action: "Mia taps the bird, zigzag water mark, and loaf-shaped hieroglyph in order.",
        sceneDetails: "Mia touches the same bird sign, water carving, and oval bread mark with one fingertip.",
      }),
    ];

    const issues = inspectSceneContinuity(scenes, { mainCharacterNames: ["Mia"] });

    expect(issues.join(" ")).toContain("Scene 3 semantically repeats");
    expect(issues.join(" ")).toContain("Scene 1");
  });

  it("allows numbered progression and adjacent start/result shots", () => {
    const scenes = [
      scene(1, {
        environmentDescription: "The same moonlit garden path.",
        narrationText: "Mia places the first blue tile into the moon gate.",
        action: "Mia fits blue tile 1 into the first empty moon gate slot.",
      }),
      scene(2, {
        environmentDescription: "The same moonlit garden path.",
        narrationText: "The first blue tile clicks, and Mia checks its glowing edge.",
        action: "Blue tile 1 settles into the slot while Mia checks the new glow.",
      }),
      scene(3, {
        environmentDescription: "The same moonlit garden path.",
        narrationText: "Mia places the second blue tile into the moon gate.",
        action: "Mia fits blue tile 2 into the second empty moon gate slot.",
      }),
    ];

    expect(inspectSceneContinuity(scenes, { mainCharacterNames: ["Mia"] }))
      .not.toEqual(expect.arrayContaining([expect.stringContaining("semantically repeats")]));
  });

  it("rejects a later scene that regresses to a completed planned beat", () => {
    const plannedBeats: PlannedStoryBeat[] = [
      {
        startScene: 1,
        endScene: 8,
        storyBeat: "Mia finds the locked blue door and studies its carved moon symbols.",
        setting: "Moonlit hall",
        continuityOutcome: "Mia understands the locked blue door needs a moon-shaped key.",
      },
      {
        startScene: 9,
        endScene: 16,
        storyBeat: "Mia crosses the glass bridge and carries the moon key toward the tower.",
        setting: "Glass bridge",
        continuityOutcome: "Mia reaches the tower safely with the key.",
      },
    ];
    const scenes = [
      scene(1),
      scene(9, {
        narrationText: "Mia finds the locked blue door and studies every carved moon symbol.",
        action: "Mia examines the locked blue door to discover which moon-shaped key it needs.",
        sceneDetails: "Mia studies the blue door, the carved moon symbols, and the empty moon-shaped keyhole.",
      }),
    ];

    const issues = inspectSceneContinuity(scenes, {
      mainCharacterNames: ["Mia"],
      plannedBeats,
    });

    expect(issues.join(" ")).toContain("appears to regress to planned scenes 1-8");
  });

  it("allows an explicitly staged callback to an earlier planned beat", () => {
    const plannedBeats: PlannedStoryBeat[] = [
      {
        startScene: 1,
        endScene: 8,
        storyBeat: "Mia finds the locked blue door and studies its carved moon symbols.",
        setting: "Moonlit hall",
        continuityOutcome: "Mia learns the blue door needs a moon-shaped key.",
      },
      {
        startScene: 9,
        endScene: 16,
        storyBeat: "Mia carries the moon key back across the glass bridge to open the tower.",
        setting: "Glass bridge",
        continuityOutcome: "Mia reaches the tower with the key.",
      },
    ];
    const scenes = [scene(9, {
      narrationText: "Mia remembers the locked blue door and compares its carved moon symbol with the key.",
      action: "Mia recalls the earlier moon carving while carrying the key across the bridge.",
    })];

    expect(inspectSceneContinuity(scenes, {
      mainCharacterNames: ["Mia"],
      plannedBeats,
    })).not.toEqual(expect.arrayContaining([expect.stringContaining("appears to regress")]));
  });

  it("requires stable lighting in an unchanged environment unless the transition is visible", () => {
    const first = scene(1, {
      environmentDescription: "The same sandstone chamber with one round doorway.",
      lighting: "warm amber torchlight with soft matte shadows",
    });
    const unexplained = scene(2, {
      environmentDescription: first.environmentDescription,
      lighting: "cold blue high-contrast moonlight",
    });
    const explained = scene(2, {
      environmentDescription: first.environmentDescription,
      narrationText: "The amber torch dims as the blue portal opens beside Mia.",
      action: "The portal opens and its blue glow replaces the fading torchlight.",
      lighting: "cold blue portal glow after the amber torch dims",
    });

    expect(inspectSceneContinuity([first, unexplained]).join(" "))
      .toContain("changes lighting while the environment is unchanged");
    expect(inspectSceneContinuity([first, explained]).join(" "))
      .not.toContain("changes lighting while the environment is unchanged");
  });

  it("normalizes an unstaged lighting change and leaves every other scene field untouched", () => {
    const first = scene(1, {
      environmentDescription: "  The same sandstone chamber with one round doorway.  ",
      lighting: "warm amber torchlight with soft matte shadows",
    });
    const submitted = scene(2, {
      environmentDescription: "the SAME sandstone chamber with one round doorway.",
      narrationText: "Mia studies the round doorway while holding the little compass steady.",
      action: "Mia raises the compass and points its needle toward the round doorway.",
      sceneDetails: "Mia remains left of the doorway; the compass rests in both hands; the carved wall stays still.",
      cameraAngle: "slow child-eye-level push toward Mia and the compass",
      lighting: "cold blue high-contrast moonlight",
    });
    const before = structuredClone(submitted);

    const result = normalizeUnstagedLightingContinuity([submitted], first);

    expect(result.changes).toEqual([{
      sceneNumber: 2,
      previousSceneNumber: 1,
      submittedLighting: "cold blue high-contrast moonlight",
      reusedLighting: first.lighting,
    }]);
    expect(result.scenes[0]).toEqual({ ...before, lighting: first.lighting });
    expect(result.scenes[0]).toMatchObject({
      narrationText: before.narrationText,
      environmentDescription: before.environmentDescription,
      action: before.action,
      characterNames: before.characterNames,
      supportingEntities: before.supportingEntities,
      continuityAnchors: before.continuityAnchors,
      sceneDetails: before.sceneDetails,
      cameraAngle: before.cameraAngle,
    });
    expect(submitted).toEqual(before);
    expect(inspectSceneContinuity([first, result.scenes[0]!]).join(" "))
      .not.toContain("changes lighting while the environment is unchanged");
  });

  it("preserves an intentional staged lighting transition using the validator's same semantics", () => {
    const first = scene(1, {
      environmentDescription: "The same sandstone chamber with one round doorway.",
      lighting: "warm amber torchlight with soft matte shadows",
    });
    const staged = scene(2, {
      environmentDescription: first.environmentDescription,
      narrationText: "The amber torch dims as the blue portal opens beside Mia.",
      action: "The portal opens and its blue glow replaces the fading torchlight.",
      lighting: "cold blue portal glow after the amber torch dims",
    });

    expect(hasExplainedLightingTransition(staged)).toBe(true);
    const result = normalizeUnstagedLightingContinuity([staged], first);

    expect(result.scenes).toEqual([staged]);
    expect(result.changes).toEqual([]);
    expect(inspectSceneContinuity([first, result.scenes[0]!]).join(" "))
      .not.toContain("changes lighting while the environment is unchanged");
  });

  it("carries normalized lighting through a new sequence from its accepted-prefix boundary", () => {
    const accepted = scene(8, {
      environmentDescription: "Moonlit garden path beside the blue gate.",
      lighting: "soft silver moonlight with a warm lantern edge",
    });
    const submitted = [
      scene(9, {
        environmentDescription: " moonlit GARDEN path beside the blue gate. ",
        lighting: "bright flat studio lighting",
      }),
      scene(10, {
        environmentDescription: "Moonlit garden path beside the blue gate.",
        lighting: "green theatrical spotlight",
      }),
    ];

    const result = normalizeUnstagedLightingContinuity(submitted, accepted);

    expect(result.scenes.map((entry) => entry.lighting)).toEqual([
      accepted.lighting,
      accepted.lighting,
    ]);
    expect(result.changes.map((entry) => [entry.previousSceneNumber, entry.sceneNumber]))
      .toEqual([[8, 9], [9, 10]]);
  });

  it("rejects full-roster defaulting in constrained shots without imposing a cast ceiling", () => {
    const roster = ["Mia", "Leo", "Tara", "Bobo"];
    const crowded = Array.from({ length: 8 }, (_unused, index) => scene(index + 1, {
      characterNames: roster,
      cameraAngle: index === 2
        ? "close-up of Mia's fingertip on the carved symbol"
        : "wide fixed camera showing the full group",
      action: `Mia acts in beat ${index + 1}; Leo reacts; Tara waits; Bobo watches.`,
      sceneDetails: `Mia, Leo, Tara, and Bobo are each staged once during unique beat ${index + 1}.`,
    }));
    const varied = crowded.map((entry, index) => index === 2
      ? { ...entry, characterNames: ["Mia"] }
      : entry);

    const crowdedIssues = inspectSceneContinuity(crowded, { mainCharacterNames: roster });
    const variedIssues = inspectSceneContinuity(varied, { mainCharacterNames: roster });

    expect(crowdedIssues.join(" ")).toContain("defaults characterNames to the complete series roster");
    expect(crowdedIssues.join(" ")).toContain("not a cast-size ceiling");
    expect(variedIssues.join(" ")).not.toContain("defaults characterNames to the complete series roster");
  });
});
