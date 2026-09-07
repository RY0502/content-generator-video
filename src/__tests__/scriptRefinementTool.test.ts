import { beforeEach, describe, expect, it, vi } from "vitest";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";

const chatTextMock = vi.fn();
const chatStructuredRepairMock = vi.fn();
const chatStructuredNarrationRepairMock = vi.fn();
vi.mock("../providers/aiClient.js", () => ({
  chatText: (...args: unknown[]) => chatTextMock(...args),
  chatStructuredRepair: (...args: unknown[]) => chatStructuredRepairMock(...args),
  chatStructuredNarrationRepair: (...args: unknown[]) =>
    chatStructuredNarrationRepairMock(...args),
}));

import {
  EPISODE_SCRIPT_CHUNK_APPEND_TARGET_SERIALIZED_CHARACTERS,
  EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
  EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS,
  EPISODE_SCRIPT_CHUNK_PROTOCOL,
  EPISODE_SCRIPT_SCENES_PER_CHUNK,
  EPISODE_SCRIPT_CHUNK_START_TARGET_SERIALIZED_CHARACTERS,
  buildEpisodeScriptChunkTool,
  buildScriptDraftTool,
  buildLegacyStandaloneScriptRefinementFixtureTool,
  buildScriptRefinementTool as buildProductionScriptRefinementTool,
  getEpisodeScriptChunkAuthoringProgress,
  type EpisodeScript,
  validateEpisodeScript,
} from "../tools/scriptRefinementTool.js";
import {
  DEFAULT_PRODUCTION_MAX_SCENES,
  DEFAULT_PRODUCTION_MIN_SCENES,
  NARRATION_MAX_RAW_CHARACTERS,
  NARRATION_MAX_SPOKEN_WORDS,
} from "../services/narrationContract.js";
import { ProductionScriptContractError } from "../services/productionScriptContract.js";

/** Keeps legacy fixture coverage explicit while production always requires state. */
function buildScriptRefinementTool(state?: Parameters<typeof buildProductionScriptRefinementTool>[0]) {
  return state
    ? buildProductionScriptRefinementTool(state)
    : buildLegacyStandaloneScriptRefinementFixtureTool();
}

function validFiveMinuteScript(
  sceneCount = DEFAULT_PRODUCTION_MIN_SCENES,
): EpisodeScript {
  const narration =
    "Mia watches the golden lantern glow softly while friendly fireflies dance above the quiet meadow and everyone smiles together happily.";
  return {
    title: "The Golden Lantern",
    premise: "Mia helps the meadow friends find their way home.",
    scenes: Array.from({ length: sceneCount }, (_unused, index) => ({
      sceneNumber: index + 1,
      narrationText: narration,
      environmentDescription: `A distinct moonlit meadow clearing number ${index + 1}.`,
      action: `Mia watches the lantern in clearing ${index + 1}.`,
      characterNames: ["Mia"],
      characterVisuals: [{
        name: "Mia",
        visualForm: "humanoid" as const,
        speciesOrType: "young girl",
        humanoidAllowed: true,
      }],
      supportingEntities: [],
      continuityAnchors: [],
      sceneDetails: `Mia stands left of the golden lantern in clearing ${index + 1}. Friendly fireflies trace one gentle arc above the quiet grass.`,
      cameraAngle: "medium wide shot at child eye level",
      lighting: "soft golden lantern light beneath a deep blue moonlit sky",
    })),
  };
}

function productionStateForDraft(
  script: EpisodeScript,
  overrides: Record<string, unknown> = {},
  revision = 3,
) {
  let currentDraft: any = {
    episodeId: 17,
    revision,
    contentDigest: `digest-${revision}`,
    scriptJson: structuredClone(script),
    validation: null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  const state: any = {
    getEpisodeById: vi.fn().mockResolvedValue({
      id: 17,
      seriesId: 7,
      title: script.title,
      premise: script.premise ?? "",
      status: "pending",
      scriptJson: null,
    }),
    getEpisodeScriptDraft: vi.fn(async () => currentDraft),
    stageEpisodeScriptDraft: vi.fn(async (_episodeId, stagedScript, validation) => {
      currentDraft = {
        ...currentDraft,
        scriptJson: structuredClone(stagedScript),
        validation,
      };
      return { draft: currentDraft, created: true, matches: true };
    }),
    reviseEpisodeScriptDraft: vi.fn(async (_episodeId, expectedRevision, revisedScript, validation) => {
      if (expectedRevision !== currentDraft.revision) throw new Error("stale revision");
      currentDraft = {
        ...currentDraft,
        revision: currentDraft.revision + 1,
        contentDigest: `digest-${currentDraft.revision + 1}`,
        scriptJson: structuredClone(revisedScript),
        validation,
      };
      return currentDraft;
    }),
    deleteEpisodeScriptDraft: vi.fn().mockResolvedValue(undefined),
    promoteEpisodeScriptDraft: vi.fn(async (input) => ({
      status: "promoted",
      episodeId: input.episodeId,
      sourceDraft: {
        revision: input.expectedRevision,
        contentDigest: input.expectedContentDigest,
      },
    })),
    getSeriesCharacters: vi.fn().mockResolvedValue([
      { name: "Mia", description: "A curious child with a yellow raincoat and two dark braids." },
    ]),
    getSeriesEnvironments: vi.fn().mockResolvedValue([
      { name: "Moonlit meadow", description: "Emerald grass, pale fireflies, and a deep blue sky." },
    ]),
    updateEpisodeStatus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { state, getCurrentDraft: () => currentDraft };
}

function chunkAuthoringPlan(targetSceneCount = DEFAULT_PRODUCTION_MIN_SCENES) {
  const beatSize = Math.ceil(targetSceneCount / 4);
  const beats = [];
  let startScene = 1;
  for (let index = 0; index < 4; index += 1) {
    const endScene = index === 3
      ? targetSceneCount
      : Math.min(targetSceneCount, startScene + beatSize - 1);
    beats.push({
      startScene,
      endScene,
      storyBeat: `Story movement ${index + 1} gives Mia a distinct gentle discovery and visible action.`,
      setting: `Moonlit meadow region ${index + 1}.`,
      continuityOutcome: `The golden lantern reaches clearly described state ${index + 1}.`,
    });
    startScene = endScene + 1;
  }
  return {
    storyArc: "Mia follows a glowing lantern trail, helps the meadow friends, and guides everyone safely home.",
    educationalIdea: "Count gentle pools of lantern light while noticing near and far.",
    endingInsight: "Careful observation and teamwork help friends find a safe path.",
    beats,
    supportingEntityBible: [
      "Luma the Firefly: one tiny golden firefly with two pale wings",
    ],
    continuityBible: [
      "Golden lantern: one round brass lantern with a star-shaped window and warm amber flame",
    ],
  };
}

function chunkScenes(startScene: number, count: number): EpisodeScript["scenes"] {
  return validFiveMinuteScript(startScene + count - 1).scenes
    .slice(startScene - 1, startScene + count - 1)
    .map((scene) => structuredClone(scene));
}

function oversizedChunkScenes(startScene: number): EpisodeScript["scenes"] {
  return chunkScenes(startScene, EPISODE_SCRIPT_SCENES_PER_CHUNK).map((scene) => ({
    ...scene,
    environmentDescription: (
      `${scene.environmentDescription} ` +
      "The same emerald grass, pale stepping stones, silver stream edge, flower clusters, distant willow, " +
      "and deep blue sky remain concretely visible in their established positions. ".repeat(8)
    ).slice(0, 900),
    action: (
      `${scene.action} Mia turns toward the lantern, points to its star window, checks the nearby trail, ` +
      "and smiles as the fireflies answer with one gentle arc while every prop remains in its established place. " +
      "The single visible beat ends with her hand resting beside the lantern handle."
    ).slice(0, 400),
    sceneDetails: (
      `${scene.sceneDetails} Mia remains clearly blocked beside the round brass lantern. ` +
      "Concrete visible staging preserves each pose, expression, prop position, background landmark, " +
      "wardrobe color, spatial relationship, and single new action without changing continuity. ".repeat(18)
    ).slice(0, 2_450),
  }));
}

function nearLimitChunkScenes(startScene: number): EpisodeScript["scenes"] {
  return chunkScenes(startScene, EPISODE_SCRIPT_SCENES_PER_CHUNK).map((scene) => ({
    ...scene,
    environmentDescription: (
      `${scene.environmentDescription} ` +
      "Emerald grass, pale stones, a silver stream edge, flower clusters, and the distant willow stay fixed. ".repeat(5)
    ).slice(0, 450),
    action: (
      `${scene.action} She points to the star window, checks the trail, and smiles as the fireflies answer in one arc. ` +
      "The lantern remains steady beside her."
    ).slice(0, 200),
    sceneDetails: (
      `${scene.sceneDetails} Mia is framed beside the lantern with both braids visible. ` +
      "Her hand, gaze, expression, the star window, trail edge, firefly arc, and background landmarks remain visibly precise. ".repeat(12)
    ).slice(0, 1_200),
  }));
}

function verboseButValidChunkAuthoringPlan() {
  const plan = chunkAuthoringPlan();
  plan.storyArc = (
    `${plan.storyArc} ` +
    "The causal adventure keeps each discovery connected to the lantern trail, the friends' choices, the counting idea, and the safe return. ".repeat(20)
  ).slice(0, 1_900);
  plan.beats = plan.beats.map((beat, index) => ({
    ...beat,
    storyBeat: (
      `${beat.storyBeat} Range ${index + 1} advances the cause, reaction, cooperative choice, visible result, and next gentle question. `.repeat(10)
    ).slice(0, 800),
  }));
  return plan;
}

function chunkStateForEpisode(initialDraft: any = null) {
  let currentDraft: any = initialDraft ? structuredClone(initialDraft) : null;
  const stageEpisodeScriptDraft = vi.fn(async (_episodeId, scriptJson, validation) => {
    if (currentDraft) {
      return {
        draft: currentDraft,
        created: false,
        matches: JSON.stringify(currentDraft.scriptJson) === JSON.stringify(scriptJson),
      };
    }
    currentDraft = {
      episodeId: 17,
      revision: 1,
      contentDigest: "chunk-digest-1",
      scriptJson: structuredClone(scriptJson),
      validation: structuredClone(validation),
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    return { draft: currentDraft, created: true, matches: true };
  });
  const reviseEpisodeScriptDraft = vi.fn(
    async (_episodeId, expectedRevision, scriptJson, validation) => {
      if (!currentDraft) {
        throw new Error(
          `Episode script draft revision conflict: expected ${expectedRevision}, current revision is ${currentDraft?.revision}.`,
        );
      }
      const targetMatches = JSON.stringify(currentDraft.scriptJson) === JSON.stringify(scriptJson)
        && JSON.stringify(currentDraft.validation) === JSON.stringify(validation);
      if (targetMatches) return currentDraft;
      if (expectedRevision !== currentDraft.revision) {
        throw new Error(
          `Episode script draft revision conflict: expected ${expectedRevision}, current revision is ${currentDraft.revision}.`,
        );
      }
      currentDraft = {
        ...currentDraft,
        revision: currentDraft.revision + 1,
        contentDigest: `chunk-digest-${currentDraft.revision + 1}`,
        scriptJson: structuredClone(scriptJson),
        validation: structuredClone(validation),
      };
      return currentDraft;
    },
  );
  const state: any = {
    getEpisodeById: vi.fn().mockResolvedValue({
      id: 17,
      seriesId: 7,
      episodeNumber: 1,
      title: "The Golden Lantern",
      premise: "Mia helps the meadow friends find their way home.",
      status: "pending",
      scriptJson: null,
    }),
    getEpisodeScriptDraft: vi.fn(async () => currentDraft),
    stageEpisodeScriptDraft,
    reviseEpisodeScriptDraft,
    promoteEpisodeScriptDraft: vi.fn(async (input) => ({
      status: "promoted",
      episodeId: input.episodeId,
      sourceDraft: {
        revision: input.expectedRevision,
        contentDigest: input.expectedContentDigest,
      },
    })),
    getSeriesCharacters: vi.fn().mockResolvedValue([
      { name: "Mia", description: "A curious child with a yellow raincoat and two dark braids." },
    ]),
  };
  return {
    state,
    getCurrentDraft: () => currentDraft,
    stageEpisodeScriptDraft,
    reviseEpisodeScriptDraft,
  };
}

describe("scriptRefinementTool", () => {
  it("fails closed when production refinement is constructed without durable state", () => {
    expect(() => (buildProductionScriptRefinementTool as any)()).toThrow(
      "Production script refinement requires SeriesState",
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    chatTextMock.mockReset();
    chatStructuredRepairMock.mockReset();
    chatStructuredNarrationRepairMock.mockReset();
  });

  it("advertises one bounded chunk tool with every scene-generation field required", () => {
    const { state } = chunkStateForEpisode();
    const definition = convertToOpenAITool(buildEpisodeScriptChunkTool(state)) as any;
    const parameters = definition.function.parameters;
    const sceneSchema = parameters.properties.scenes.items;

    expect(definition.function.name).toBe("write_episode_script_chunk");
    expect(parameters.properties.operation.enum).toEqual(["start", "append", "restart"]);
    expect(parameters.properties.scenes.type).toBe("array");
    expect(parameters.properties.scenes.maxItems).toBe(EPISODE_SCRIPT_SCENES_PER_CHUNK);
    expect(parameters.properties.scenes.description).toContain("TARGET at most 2000 serialized characters per scene");
    expect(definition.function.description).toContain(
      `TARGET ${EPISODE_SCRIPT_CHUNK_APPEND_TARGET_SERIALIZED_CHARACTERS}`,
    );
    expect(definition.function.description).toContain(
      `hard content maximum is ${EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS}`,
    );
    expect(sceneSchema.properties.narrationText.maxLength).toBe(NARRATION_MAX_RAW_CHARACTERS);
    expect(sceneSchema.properties.narrationText.description).toContain("TARGET: 15-20 spoken words");
    expect(sceneSchema.properties.environmentDescription.description).toContain("TARGET: 120-260 characters");
    expect(sceneSchema.properties.action.description).toContain("TARGET: 70-180 characters");
    expect(sceneSchema.properties.action.description).toContain("clear start, one movement/change, and a readable end state");
    expect(sceneSchema.properties.characterNames.description).toContain("complete exact on-screen cast");
    expect(sceneSchema.properties.supportingEntities.description).toContain("never a group/herd/flock/cluster");
    expect(sceneSchema.properties.continuityAnchors.description).toContain("Never put a character, animal, living object");
    expect(sceneSchema.properties.cameraAngle.description).toContain("TARGET: 25-100 characters");
    expect(sceneSchema.properties.cameraAngle.description).toContain("push/pull/pan/tilt/tracking move or fixed camera");
    expect(sceneSchema.properties.lighting.description).toContain("TARGET: 30-120 characters");
    expect(sceneSchema.properties.sceneDetails.description).toContain("at least 60 characters");
    expect(sceneSchema.properties.sceneDetails.description).toContain("three comma/colon/semicolon-separated");
    expect(sceneSchema.required).toEqual(expect.arrayContaining([
      "sceneNumber",
      "narrationText",
      "environmentDescription",
      "action",
      "characterNames",
      "characterVisuals",
      "supportingEntities",
      "continuityAnchors",
      "sceneDetails",
      "cameraAngle",
      "lighting",
    ]));
  });

  it("stages only the first eight scenes with a bounded immutable continuation plan", async () => {
    const { state, getCurrentDraft } = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(state);
    const scenes = chunkScenes(1, EPISODE_SCRIPT_SCENES_PER_CHUNK);

    const raw = await (tool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes,
    });
    const result = JSON.parse(raw);
    const stored = getCurrentDraft();

    expect(result).toMatchObject({
      status: "script_chunk_staged",
      persisted: true,
      retryThisInvocation: true,
      episodeId: 17,
      draftRevision: 1,
      authoringProgress: {
        completedSceneCount: 8,
        nextSceneNumber: 9,
        nextSceneEnd: 16,
      },
    });
    expect(stored.scriptJson.scenes).toEqual(scenes);
    expect(stored.scriptJson.authoring).toMatchObject({
      protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      plan: chunkAuthoringPlan(),
    });
    expect(result.authoringProgress.authoringPlan).toBeUndefined();
    expect(result.authoringProgress.activePlanBeat).toBeUndefined();
    expect(result.authoringProgress.previousScenes).toBeUndefined();
    expect(raw).not.toContain("clearing number 1");
    expect(raw.length).toBeLessThan(2_000);
  });

  it("corrects an oversized start in the same invocation without mutating the draft", async () => {
    const fixture = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const plan = chunkAuthoringPlan();
    const oversizedScenes = oversizedChunkScenes(1);
    const oversizedInput = {
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes: oversizedScenes,
    };
    expect(JSON.stringify(oversizedInput).length)
      .toBeGreaterThan(EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS);

    const rejected = JSON.parse(await (tool as any).call(oversizedInput));

    expect(rejected).toMatchObject({
      status: "script_chunk_too_large",
      persisted: false,
      retryThisInvocation: true,
      noProgress: true,
      operation: "start",
      targetSerializedCharacters: EPISODE_SCRIPT_CHUNK_START_TARGET_SERIALIZED_CHARACTERS,
      hardMaximumSerializedCharacters: EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS,
      correctionRetryNumber: 1,
      correctionRetryLimit: EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
      requestedSceneRange: { startScene: 1, endScene: 8 },
    });
    expect(rejected.canonicalSerializedCharacters)
      .toBeGreaterThan(EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS);
    expect(rejected.overHardLimitByCharacters).toBe(
      rejected.canonicalSerializedCharacters - EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS,
    );
    expect(rejected.nextAction).toContain("Immediately call write_episode_script_chunk with operation=start");
    expect(rejected.nextAction).toContain("the same complete authoringPlan");
    expect(rejected.nextAction).toContain("exactly scenes 1-8");
    expect(fixture.getCurrentDraft()).toBeNull();
    expect(fixture.stageEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(fixture.reviseEpisodeScriptDraft).not.toHaveBeenCalled();

    const corrected = JSON.parse(await (tool as any).call({
      ...oversizedInput,
      scenes: chunkScenes(1, 8),
    }));
    expect(corrected).toMatchObject({
      status: "script_chunk_staged",
      persisted: true,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
  });

  it("corrects an oversized append against the same durable revision and preserves its prefix", async () => {
    const fixture = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const started = JSON.parse(await (tool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: chunkScenes(1, 8),
    }));
    const before = structuredClone(fixture.getCurrentDraft());
    const oversizedInput = {
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: started.draftRevision,
      scenes: oversizedChunkScenes(9),
    };

    const rejected = JSON.parse(await (tool as any).call(oversizedInput));

    expect(rejected).toMatchObject({
      status: "script_chunk_too_large",
      persisted: false,
      scenePrefixPreserved: true,
      retryThisInvocation: true,
      operation: "append",
      draftRevision: started.draftRevision,
      targetSerializedCharacters: EPISODE_SCRIPT_CHUNK_APPEND_TARGET_SERIALIZED_CHARACTERS,
      requestedSceneRange: { startScene: 9, endScene: 16 },
    });
    expect(rejected.nextAction).toContain("operation=append");
    expect(rejected.nextAction).toContain(`expectedDraftRevision=${started.draftRevision}`);
    expect(rejected.nextAction).toContain("exactly scenes 9-16");
    expect(rejected.nextAction).toContain("Omit targetSceneCount and authoringPlan");
    expect(fixture.getCurrentDraft()).toEqual(before);
    expect(fixture.reviseEpisodeScriptDraft).not.toHaveBeenCalled();

    const corrected = JSON.parse(await (tool as any).call({
      ...oversizedInput,
      scenes: chunkScenes(9, 8),
    }));
    expect(corrected).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      authoringProgress: { completedSceneCount: 16, nextSceneNumber: 17 },
    });
  });

  it("bounds repeated oversized corrections and remains mutation-free on exhaustion", async () => {
    const fixture = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const oversizedInput = {
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: oversizedChunkScenes(1),
    };

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = JSON.parse(await (tool as any).call(oversizedInput));
      expect(result).toMatchObject({
        status: "script_chunk_too_large",
        persisted: false,
        retryThisInvocation:
          attempt <= EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
        correctionRetryNumber: attempt,
      });
      if (attempt === 4) {
        expect(result.nextAction).toContain("Start a fresh run and call");
        expect(result.nextAction).toContain("operation=start");
      }
    }

    expect(fixture.getCurrentDraft()).toBeNull();
    expect(fixture.stageEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(fixture.reviseEpisodeScriptDraft).not.toHaveBeenCalled();
  });

  it("tolerates identical redundant immutable metadata on append without replacing durable values", async () => {
    const fixture = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const plan = chunkAuthoringPlan();
    const started = JSON.parse(await (tool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes: chunkScenes(1, 8),
    }));

    const appended = JSON.parse(await (tool as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: started.draftRevision,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: structuredClone(plan),
      scenes: chunkScenes(9, 8),
    }));

    expect(appended).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      draftRevision: 2,
      authoringProgress: { completedSceneCount: 16, nextSceneNumber: 17 },
    });
    expect(fixture.getCurrentDraft().scriptJson.authoring).toEqual({
      protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      plan,
    });
    expect(appended.nextAction).toContain("Omit targetSceneCount and authoringPlan");
  });

  it("excludes exact redundant append metadata from the content budget only after durable comparison", async () => {
    const fixture = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const plan = verboseButValidChunkAuthoringPlan();
    const started = JSON.parse(await (tool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes: chunkScenes(1, 8),
    }));
    expect(started.status).toBe("script_chunk_staged");

    const scenes = nearLimitChunkScenes(9);
    const canonicalAppend = {
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: started.draftRevision,
      scenes,
    };
    const redundantAppend = {
      ...canonicalAppend,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: structuredClone(plan),
    };
    expect(JSON.stringify(canonicalAppend).length)
      .toBeLessThanOrEqual(EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS);
    expect(JSON.stringify(redundantAppend).length)
      .toBeGreaterThan(EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS);

    const result = JSON.parse(await (tool as any).call(redundantAppend));

    expect(result).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      authoringProgress: { completedSceneCount: 16, nextSceneNumber: 17 },
    });
    expect(fixture.getCurrentDraft().scriptJson.authoring.plan).toEqual(plan);
  });

  it("rejects each mismatched redundant append immutable field before mutation", async () => {
    const fixture = chunkStateForEpisode();
    const plan = chunkAuthoringPlan();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const started = JSON.parse(await (tool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes: chunkScenes(1, 8),
    }));
    const accepted = JSON.parse(await (tool as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: started.draftRevision,
      scenes: chunkScenes(9, 8),
    }));
    const before = structuredClone(fixture.getCurrentDraft());
    const revisionCallsBefore = fixture.reviseEpisodeScriptDraft.mock.calls.length;
    const changedPlan = structuredClone(plan);
    changedPlan.storyArc = `${changedPlan.storyArc} This conflicting replacement must not be accepted.`;

    const cases = [
      {
        extra: { targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES + 1 },
        path: "targetSceneCount",
        issue: "durable draft requires",
      },
      {
        extra: { authoringPlan: changedPlan },
        path: "authoringPlan",
        issue: "does not exactly match the durable draft",
      },
    ];

    for (const mismatch of cases) {
      // This otherwise looks like a lost-response retry of the already-durable
      // 9-16 range. Immutable comparison must win over that idempotency path.
      const result = JSON.parse(await (tool as any).call({
        operation: "append",
        episodeId: 17,
        expectedDraftRevision: started.draftRevision,
        scenes: chunkScenes(9, 8),
        ...mismatch.extra,
      }));

      expect(result).toMatchObject({
        status: "invalid_script_chunk",
        persisted: false,
        retryThisInvocation: false,
        validation: {
          invalidPaths: [mismatch.path],
          issues: [expect.stringContaining(mismatch.issue)],
        },
      });
      expect(result.nextAction).toContain(`expectedDraftRevision=${accepted.draftRevision}`);
      expect(result.nextAction).toContain("exactly scenes 17-24");
      expect(result.nextAction).toContain("Omit targetSceneCount and authoringPlan");
      expect(fixture.getCurrentDraft()).toEqual(before);
    }
    expect(fixture.reviseEpisodeScriptDraft).toHaveBeenCalledTimes(revisionCallsBefore);
  });

  it("stages and resumes when a provider encodes only the scenes array", async () => {
    const fixture = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const firstScenes = chunkScenes(1, EPISODE_SCRIPT_SCENES_PER_CHUNK);

    const started = JSON.parse(await (tool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: JSON.stringify(firstScenes),
    }));

    expect(started).toMatchObject({
      status: "script_chunk_staged",
      persisted: true,
      draftRevision: 1,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual(firstScenes);

    const nextScenes = chunkScenes(9, EPISODE_SCRIPT_SCENES_PER_CHUNK);
    const doubleEncodedScenes = JSON.stringify(JSON.stringify(nextScenes));
    const appended = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: started.draftRevision,
      scenes: `\`\`\`json\n${doubleEncodedScenes}\n\`\`\``,
    }));

    expect(appended).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      draftRevision: 2,
      authoringProgress: { completedSceneCount: 16, nextSceneNumber: 17 },
    });
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual([
      ...firstScenes,
      ...nextScenes,
    ]);
  });

  it("fails closed with an actionable receipt for malformed encoded scenes", async () => {
    const fixture = chunkStateForEpisode();
    const raw = await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: '[{"sceneNumber":1',
    });
    const result = JSON.parse(raw);

    expect(result).toMatchObject({
      status: "invalid_input",
      persisted: false,
      retryThisInvocation: false,
      episodeId: 17,
      validation: {
        invalidPaths: ["scenes"],
        issues: [expect.stringContaining("one complete valid JSON array")],
      },
    });
    expect(fixture.getCurrentDraft()).toBeNull();
  });

  it("runs strict nested validation after decoding an encoded scenes array", async () => {
    const fixture = chunkStateForEpisode();
    const scenes = chunkScenes(1, 8).map((scene) => ({ ...scene })) as any[];
    delete scenes[3].lighting;

    const raw = await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: JSON.stringify(scenes),
    });
    const result = JSON.parse(raw);

    expect(result).toMatchObject({
      status: "invalid_input",
      persisted: false,
      validation: {
        invalidPaths: ["scenes.3.lighting"],
        issues: [expect.stringContaining("scenes.3.lighting")],
      },
    });
    expect(fixture.getCurrentDraft()).toBeNull();
  });

  it("composes encoded-scenes recovery with durable overlength-narration recovery", async () => {
    const fixture = chunkStateForEpisode();
    const plan = chunkAuthoringPlan();
    const scenes = chunkScenes(1, 8);
    scenes[0]!.narrationText = Array.from(
      { length: NARRATION_MAX_SPOKEN_WORDS },
      (_unused, index) => `exceptionallyelongatedstorybookword${index + 1}`,
    ).join(" ");

    const rejected = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes: JSON.stringify(scenes),
    }));

    expect(rejected).toMatchObject({
      status: "invalid_script_chunk",
      persisted: true,
      draftRevision: 1,
      authoringProgress: {
        completedSceneCount: 0,
        nextSceneNumber: 1,
      },
    });
    expect(rejected.authoringProgress.authoringPlan).toBeUndefined();
    expect(rejected.authoringProgress.previousScenes).toBeUndefined();
    expect(rejected.validation.issues.join(" ")).toContain("exceeds the 200-character");
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual([]);

    const recovered = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: rejected.draftRevision,
      scenes: JSON.stringify(chunkScenes(1, 8)),
    }));
    expect(recovered).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
  });

  it("fails closed when a chunk omits a required visual field", async () => {
    const fixture = chunkStateForEpisode();
    const scenes = chunkScenes(1, 8).map((scene) => ({ ...scene })) as any[];
    delete scenes[3].lighting;

    const raw = await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes,
    });
    const result = JSON.parse(raw);

    expect(result).toMatchObject({
      status: "invalid_input",
      persisted: false,
      retryThisInvocation: false,
      validation: {
        invalidPaths: ["scenes.3.lighting"],
        issues: [expect.stringContaining("scenes.3.lighting")],
      },
    });
    expect(fixture.getCurrentDraft()).toBeNull();
    expect(raw.length).toBeLessThan(1_000);
  });

  it("preserves the authoring plan when an otherwise complete first chunk exceeds narration limits", async () => {
    const fixture = chunkStateForEpisode();
    const plan = chunkAuthoringPlan();
    const scenes = chunkScenes(1, 8);
    scenes[0]!.narrationText = Array.from(
      { length: NARRATION_MAX_SPOKEN_WORDS },
      (_unused, index) => `exceptionallyelongatedstorybookword${index + 1}`,
    ).join(" ");

    const rejected = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes,
    }));

    expect(rejected).toMatchObject({
      status: "invalid_script_chunk",
      persisted: true,
      scenePrefixPreserved: true,
      retryThisInvocation: true,
      noProgress: true,
      draftRevision: 1,
      correctionRetryNumber: 1,
      correctionRetryLimit: EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
      authoringProgress: {
        completedSceneCount: 0,
        nextSceneNumber: 1,
        nextSceneEnd: 8,
      },
    });
    expect(rejected.authoringProgress.authoringPlan).toBeUndefined();
    expect(rejected.authoringProgress.previousScenes).toBeUndefined();
    expect(JSON.stringify(rejected).length).toBeLessThan(4_000);
    expect(rejected.validation.issues.join(" ")).toContain("exceeds the 200-character");
    expect(rejected.validation.issues.join(" ")).not.toContain("maximum is 20");
    expect(rejected.validation.invalidPaths).toBeUndefined();
    expect(fixture.getCurrentDraft().scriptJson).toMatchObject({
      scenes: [],
      authoring: {
        protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
        targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
        plan,
      },
    });
    expect(rejected.nextAction).toContain("operation=append");
    expect(rejected.nextAction).toContain("expectedDraftRevision=1");
    expect(rejected.nextAction).toContain("exactly scenes 1-8");

    const recovered = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: rejected.draftRevision,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: structuredClone(plan),
      scenes: chunkScenes(1, 8),
    }));
    expect(recovered).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    expect(rejected.nextAction).toContain("Omit targetSceneCount and authoringPlan");
  });

  it("preserves an accepted prefix and reports exact word-limit evidence for a rejected append", async () => {
    const fixture = chunkStateForEpisode();
    const started = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: chunkScenes(1, 8),
    }));
    const rejectedScenes = chunkScenes(9, 8);
    rejectedScenes[0]!.narrationText = Array.from(
      { length: NARRATION_MAX_SPOKEN_WORDS + 1 },
      (_unused, index) => `word${index + 1}`,
    ).join(" ");

    const rejected = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: started.draftRevision,
      scenes: rejectedScenes,
    }));

    expect(rejected).toMatchObject({
      status: "invalid_script_chunk",
      persisted: true,
      scenePrefixPreserved: true,
      retryThisInvocation: true,
      draftRevision: 2,
      correctionRetryNumber: 1,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9, nextSceneEnd: 16 },
    });
    expect(rejected.validation.issues.join(" ")).toContain(
      `Scene 9 narrationText has ${NARRATION_MAX_SPOKEN_WORDS + 1} spoken words`,
    );
    expect(rejected.validation.issues.join(" ")).toContain("maximum is 20");
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual(chunkScenes(1, 8));

    const recovered = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: rejected.draftRevision,
      scenes: chunkScenes(9, 8),
    }));
    expect(recovered).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      authoringProgress: { completedSceneCount: 16, nextSceneNumber: 17 },
    });
  });

  it("allows only three same-invocation semantic corrections for one exact range", async () => {
    const fixture = chunkStateForEpisode();
    const tool = buildEpisodeScriptChunkTool(fixture.state);
    const invalidScenes = chunkScenes(1, 8);
    invalidScenes[0]!.narrationText = Array.from(
      { length: NARRATION_MAX_SPOKEN_WORDS + 1 },
      (_unused, index) => `word${index + 1}`,
    ).join(" ");

    let result = JSON.parse(await (tool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: invalidScenes,
    }));
    const returnedRevisions: number[] = [];

    for (let retryNumber = 1; retryNumber <= 4; retryNumber += 1) {
      returnedRevisions.push(result.draftRevision);
      expect(result).toMatchObject({
        status: "invalid_script_chunk",
        persisted: true,
        retryThisInvocation:
          retryNumber <= EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
        correctionRetryNumber: retryNumber,
        correctionRetryLimit: EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
        authoringProgress: {
          completedSceneCount: 0,
          nextSceneNumber: 1,
          nextSceneEnd: 8,
        },
      });

      if (retryNumber <= EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES) {
        expect(result.authoringProgress.authoringPlan).toBeUndefined();
        expect(result.authoringProgress.previousScenes).toBeUndefined();
        expect(result.nextAction).toContain("operation=append");
        expect(result.nextAction).toContain(
          `expectedDraftRevision=${result.draftRevision}`,
        );
        expect(result.nextAction).toContain("exactly scenes 1-8");
        result = JSON.parse(await (tool as any).call({
          operation: "append",
          episodeId: 17,
          expectedDraftRevision: result.draftRevision,
          scenes: invalidScenes,
        }));
      }
    }

    expect(result.authoringProgress.authoringPlan).toEqual(chunkAuthoringPlan());
    expect(result.authoringProgress.previousScenes).toEqual([]);
    expect(new Set(returnedRevisions)).toEqual(new Set([1]));
    expect(result.draftRevision).toBe(fixture.getCurrentDraft().revision);
    expect(result.nextAction).toContain("Start a fresh run");
    expect(result.nextAction).toContain(
      `expectedDraftRevision=${result.draftRevision}`,
    );
    expect(result.nextAction).toContain("exactly scenes 1-8");
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual([]);
    expect(fixture.reviseEpisodeScriptDraft).toHaveBeenCalledTimes(3);
  });

  it("resumes through a fresh tool instance and idempotently recognizes an accepted chunk", async () => {
    const fixture = chunkStateForEpisode();
    const start = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: chunkScenes(1, 8),
    }));
    const nextScenes = chunkScenes(9, 8);
    const appendInput = {
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: start.draftRevision,
      scenes: nextScenes,
    };

    const appended = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any)
      .call(appendInput));
    const revisionCallsAfterAppend = fixture.reviseEpisodeScriptDraft.mock.calls.length;
    const repeated = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any)
      .call(appendInput));

    expect(appended).toMatchObject({
      status: "script_chunk_appended",
      retryThisInvocation: true,
      draftRevision: 2,
      authoringProgress: {
        completedSceneCount: 16,
        nextSceneNumber: 17,
        nextSceneEnd: 24,
      },
    });
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual([
      ...chunkScenes(1, 8),
      ...nextScenes,
    ]);
    expect(repeated).toMatchObject({
      status: "script_chunk_already_present",
      persisted: true,
      retryThisInvocation: false,
      noProgress: true,
      draftRevision: 2,
    });
    expect(fixture.reviseEpisodeScriptDraft).toHaveBeenCalledTimes(revisionCallsAfterAppend);
  });

  it("refuses to refine or flatten an unfinished durable chunk prefix", async () => {
    const fixture = chunkStateForEpisode();
    const staged = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: chunkScenes(1, 8),
    }));
    const before = structuredClone(fixture.getCurrentDraft());

    const result = JSON.parse(await (buildProductionScriptRefinementTool(fixture.state) as any)
      .call({ episodeId: 17, draftRevision: staged.draftRevision }));

    expect(result).toMatchObject({
      status: "script_authoring_in_progress",
      persisted: true,
      retryThisInvocation: false,
      noProgress: true,
      draftRevision: staged.draftRevision,
      authoringProgress: {
        completedSceneCount: 8,
        nextSceneNumber: 9,
        nextSceneEnd: 16,
      },
    });
    expect(fixture.getCurrentDraft()).toEqual(before);
    expect(fixture.reviseEpisodeScriptDraft).toHaveBeenCalledTimes(0);
    expect(fixture.state.promoteEpisodeScriptDraft).toHaveBeenCalledTimes(0);
  });

  it("rejects a stale divergent append without changing the accepted prefix", async () => {
    const fixture = chunkStateForEpisode();
    await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: chunkScenes(1, 8),
    });
    const before = structuredClone(fixture.getCurrentDraft());
    const divergent = chunkScenes(9, 8);
    divergent[0]!.action = "Mia performs a different uncommitted action.";

    const result = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: 999,
      scenes: divergent,
    }));

    expect(result).toMatchObject({
      status: "stale_draft_revision",
      persisted: false,
      retryThisInvocation: false,
      noProgress: true,
      draftRevision: 1,
    });
    expect(fixture.getCurrentDraft()).toEqual(before);
  });

  it("rejects gaps and partial non-final ranges without mutating the prefix", async () => {
    const fixture = chunkStateForEpisode();
    const start = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: chunkScenes(1, 8),
    }));
    const before = structuredClone(fixture.getCurrentDraft());

    const result = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: start.draftRevision,
      scenes: chunkScenes(10, 7),
    }));

    expect(result).toMatchObject({
      status: "invalid_script_chunk",
      persisted: false,
      retryThisInvocation: false,
    });
    expect(result.validation.issues.join(" ")).toContain("exactly 8 scenes");
    expect(result.validation.issues.join(" ")).toContain("must be 9");
    expect(fixture.getCurrentDraft()).toEqual(before);
  });

  it("rejects a cross-chunk visual-identity change and preserves only the valid prefix", async () => {
    const fixture = chunkStateForEpisode();
    const firstScenes = chunkScenes(1, 8);
    for (const scene of firstScenes) {
      scene.characterNames = ["Mia"];
      scene.characterVisuals = [{
        name: "Mia",
        visualForm: "humanoid",
        speciesOrType: "little girl",
        humanoidAllowed: true,
      }];
      scene.sceneDetails = `${scene.sceneDetails} Mia stands at frame center while the amber glow outlines her yellow raincoat.`;
    }
    const start = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: firstScenes,
    }));
    expect(start.status, JSON.stringify(start)).toBe("script_chunk_staged");
    const badScenes = chunkScenes(9, 8);
    for (const scene of badScenes) {
      scene.characterNames = ["Mia"];
      scene.characterVisuals = [{
        name: "Mia",
        visualForm: "real_creature",
        speciesOrType: "cat",
        humanoidAllowed: false,
      }];
      scene.sceneDetails = `${scene.sceneDetails} Mia stands at frame center while the amber glow outlines her silhouette.`;
    }

    const result = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: start.draftRevision,
      scenes: badScenes,
    }));

    expect(result).toMatchObject({
      status: "invalid_script_chunk",
      persisted: true,
      scenePrefixPreserved: true,
      retryThisInvocation: true,
      noProgress: true,
      correctionRetryNumber: 1,
      authoringProgress: {
        completedSceneCount: 8,
        nextSceneNumber: 9,
      },
    });
    expect(result.validation.issues.join(" ")).toContain("changes locked characterVisuals metadata");
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual(firstScenes);
  });

  it.each([
    DEFAULT_PRODUCTION_MIN_SCENES,
    DEFAULT_PRODUCTION_MAX_SCENES,
  ])("assembles %i scenes, removes the authoring marker, and hands the exact revision to refinement", async (targetSceneCount) => {
    const fixture = chunkStateForEpisode();
    const chunkTool = buildEpisodeScriptChunkTool(fixture.state);
    let result = JSON.parse(await (chunkTool as any).call({
      operation: "start",
      episodeId: 17,
      targetSceneCount,
      authoringPlan: chunkAuthoringPlan(targetSceneCount),
      scenes: chunkScenes(1, 8),
    }));

    for (let startScene = 9; startScene <= targetSceneCount; startScene += 8) {
      result = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
        operation: "append",
        episodeId: 17,
        expectedDraftRevision: result.draftRevision,
        scenes: chunkScenes(
          startScene,
          Math.min(8, targetSceneCount - startScene + 1),
        ),
      }));
    }

    expect(result).toMatchObject({
      status: "script_draft_complete",
      persisted: true,
      retryThisInvocation: true,
      sceneCount: targetSceneCount,
      totalSpokenWords: targetSceneCount * NARRATION_MAX_SPOKEN_WORDS,
      validation: { pass: true, issues: [] },
    });
    expect(fixture.getCurrentDraft().scriptJson).not.toHaveProperty("authoring");
    expect(fixture.getCurrentDraft().scriptJson.scenes).toEqual(
      validFiveMinuteScript(targetSceneCount).scenes,
    );
    expect(getEpisodeScriptChunkAuthoringProgress(
      fixture.getCurrentDraft().scriptJson,
      fixture.getCurrentDraft().validation,
    )).toBeNull();

    const refined = JSON.parse(await (buildProductionScriptRefinementTool(fixture.state) as any).call({
      episodeId: 17,
      draftRevision: result.draftRevision,
    }));
    expect(refined).toMatchObject({ status: "ready", persisted: true });
    expect(fixture.state.promoteEpisodeScriptDraft).toHaveBeenCalledWith(expect.objectContaining({
      episodeId: 17,
      expectedRevision: result.draftRevision,
      scriptJson: fixture.getCurrentDraft().scriptJson,
    }));
  });

  it("keeps an invalid restart terminal and preserves its unchanged restart contract", async () => {
    const rejectedScript = validFiveMinuteScript();
    rejectedScript.scenes[0]!.lighting = "";
    const initialDraft = {
      episodeId: 17,
      revision: 4,
      contentDigest: "rejected-digest",
      scriptJson: rejectedScript,
      validation: {
        pass: false,
        sceneCount: 40,
        totalSpokenWords: 800,
        issueCount: 1,
        issues: ["Scene 1 is missing lighting."],
        omittedIssueCount: 0,
      },
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    const fixture = chunkStateForEpisode(initialDraft);
    const before = structuredClone(fixture.getCurrentDraft());
    const plan = chunkAuthoringPlan();
    const invalidScenes = chunkScenes(1, 8);
    invalidScenes[0]!.narrationText = Array.from(
      { length: NARRATION_MAX_SPOKEN_WORDS + 1 },
      (_unused, index) => `word${index + 1}`,
    ).join(" ");

    const result = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "restart",
      episodeId: 17,
      expectedDraftRevision: initialDraft.revision,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes: invalidScenes,
    }));

    expect(result).toMatchObject({
      status: "invalid_script_chunk",
      persisted: false,
      retryable: true,
      retryThisInvocation: false,
      draftRevision: initialDraft.revision,
      contentDigest: initialDraft.contentDigest,
      restartPlan: {
        targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
        authoringPlan: plan,
        nextSceneNumber: 1,
        nextSceneEnd: 8,
      },
    });
    expect(result.nextAction).toContain("operation=restart");
    expect(result.nextAction).not.toContain("operation=append");
    expect(result.nextAction).toContain(
      `expectedDraftRevision=${initialDraft.revision}`,
    );
    expect(result.nextAction).toContain(
      `targetSceneCount=${DEFAULT_PRODUCTION_MIN_SCENES}`,
    );
    expect(result.nextAction).toContain("same authoringPlan");
    expect(result.nextAction).toContain("exactly scenes 1-8");
    expect(fixture.getCurrentDraft()).toEqual(before);
    expect(fixture.reviseEpisodeScriptDraft).not.toHaveBeenCalled();
  });

  it("restarts a deterministically rejected complete draft through the same revision CAS", async () => {
    const rejectedScript = validFiveMinuteScript();
    rejectedScript.scenes[0]!.lighting = "";
    const initialDraft = {
      episodeId: 17,
      revision: 4,
      contentDigest: "rejected-digest",
      scriptJson: rejectedScript,
      validation: {
        pass: false,
        sceneCount: 40,
        totalSpokenWords: 800,
        issueCount: 1,
        issues: ["Scene 1 is missing lighting."],
        omittedIssueCount: 0,
      },
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    const fixture = chunkStateForEpisode(initialDraft);
    const restartInput = {
      operation: "restart",
      episodeId: 17,
      expectedDraftRevision: 4,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: chunkAuthoringPlan(),
      scenes: chunkScenes(1, 8),
    };

    const restarted = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any)
      .call(restartInput));
    const repeated = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any)
      .call(restartInput));

    expect(restarted).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      retryThisInvocation: true,
      draftRevision: 5,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    expect(fixture.getCurrentDraft().scriptJson.authoring.protocol)
      .toBe(EPISODE_SCRIPT_CHUNK_PROTOCOL);
    expect(repeated).toMatchObject({
      status: "script_chunk_already_present",
      retryThisInvocation: false,
      draftRevision: 5,
    });
  });

  it("routes a legacy ambiguously counted chunk prefix to one deliberate restart instead of an endless append repair", async () => {
    const plan = chunkAuthoringPlan();
    const legacyScenes = chunkScenes(1, 8).map((scene) => ({
      ...scene,
      characterNames: ["Mia", "Leo", "Tara", "Bobo"],
      characterVisuals: [
        { name: "Mia", visualForm: "humanoid" as const },
        { name: "Leo", visualForm: "humanoid" as const },
        { name: "Tara", visualForm: "humanoid" as const },
        { name: "Bobo", visualForm: "object_character" as const },
      ],
      sceneDetails: `${scene.sceneDetails} Mia points; Leo watches; Tara smiles; Bobo waits; the children watch the bag.`,
    }));
    const initialDraft = {
      episodeId: 17,
      revision: 4,
      contentDigest: "legacy-crowded-prefix",
      scriptJson: {
        title: "The Golden Lantern",
        premise: "Mia helps the meadow friends find their way home.",
        scenes: legacyScenes,
        authoring: {
          protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
          targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
          plan,
        },
      },
      validation: { pass: true, issues: [] },
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    };
    const fixture = chunkStateForEpisode(initialDraft);
    fixture.state.getSeriesCharacters.mockResolvedValue([
      { name: "Mia" }, { name: "Leo" }, { name: "Tara" }, { name: "Bobo" },
    ]);

    const appendResult = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "append",
      episodeId: 17,
      expectedDraftRevision: 4,
      scenes: chunkScenes(9, 8),
    }));

    expect(appendResult).toMatchObject({
      status: "script_chunk_restart_required",
      persisted: false,
      retryThisInvocation: false,
      draftRevision: 4,
      restartPlan: { nextSceneNumber: 1, nextSceneEnd: 8 },
    });
    expect(appendResult.validation.issues.join(" ")).toContain("collective or generic cast alias");
    expect(fixture.reviseEpisodeScriptDraft).not.toHaveBeenCalled();

    const restartResult = JSON.parse(await (buildEpisodeScriptChunkTool(fixture.state) as any).call({
      operation: "restart",
      episodeId: 17,
      expectedDraftRevision: 4,
      targetSceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      authoringPlan: plan,
      scenes: chunkScenes(1, 8),
    }));
    expect(restartResult).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      draftRevision: 5,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
  });

  it("stages a double-encoded detailed draft once without dropping any scene-generation fields", async () => {
    const script = validFiveMinuteScript();
    script.scenes[0] = {
      sceneNumber: 9,
      narrationText: "Mia gently lifts the golden lantern while friendly fireflies circle above the meadow and point toward the winding homeward path.",
      environmentDescription: "A moonlit emerald meadow with a winding pebble path and silver-tipped wildflowers.",
      action: "Mia raises the lantern as the fireflies curve toward the path.",
      characterNames: ["Mia"],
      characterVisuals: [{
        name: "Mia",
        visualForm: "humanoid",
        speciesOrType: "little girl",
        humanoidAllowed: true,
      }],
      supportingEntities: ["Firefly cluster: seven tiny golden lights in a loose crescent formation"],
      continuityAnchors: ["Lantern path setup: one round brass lantern beside a winding pale-gray pebble path"],
      sceneDetails: "Mia stands beside the winding path, lifting the round brass lantern while seven fireflies form a crescent above her.",
      cameraAngle: "medium-wide child-eye-level view facing the path",
      lighting: "soft brass lantern glow mixed with cool blue moonlight",
    };
    const { state } = productionStateForDraft(script);
    const tool = buildScriptDraftTool(state);

    const result = JSON.parse(await (tool as any).call({
      episodeId: 17,
      scriptJson: JSON.stringify(JSON.stringify(script)),
    }));

    expect(result).toMatchObject({
      status: "draft_staged",
      persisted: true,
      episodeId: 17,
      draftRevision: 3,
      sceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
    });
    expect(result.scriptJson).toBeUndefined();
    const stagedScript = state.stageEpisodeScriptDraft.mock.calls[0]?.[1];
    expect(stagedScript.scenes[0]).toEqual({
      ...script.scenes[0],
      sceneNumber: 1,
    });
    expect(JSON.stringify(result).length).toBeLessThan(1_000);
  });

  it.each([
    ["triple-encoded", 3],
    ["four-times-encoded", 4],
  ])("stages a complete %s provider transport without changing its script", async (_label, depth) => {
    const script = validFiveMinuteScript();
    const { state } = productionStateForDraft(script);
    let transported: unknown = script;
    for (let index = 0; index < depth; index++) transported = JSON.stringify(transported);

    const result = JSON.parse(await (buildScriptDraftTool(state) as any).call({
      episodeId: 17,
      scriptJson: transported,
    }));

    expect(result.status).toBe("draft_staged");
    expect(state.stageEpisodeScriptDraft).toHaveBeenCalledTimes(1);
    expect(state.stageEpisodeScriptDraft.mock.calls[0]?.[1]).toEqual(script);
  });

  it("accepts a complete fenced script larger than the failed provider payload", async () => {
    const script = validFiveMinuteScript();
    for (const scene of script.scenes) {
      scene.sceneDetails = `${scene.sceneDetails} ${"Visible period details preserve the exact layout, character spacing, prop state, camera composition, and gentle emotional expression. ".repeat(10)}`;
    }
    const transported = `\`\`\`json\n${JSON.stringify(script)}\n\`\`\``;
    expect(transported.length).toBeGreaterThan(65_536);
    const { state } = productionStateForDraft(script);

    const result = JSON.parse(await (buildScriptDraftTool(state) as any).call({
      episodeId: 17,
      scriptJson: transported,
    }));

    expect(result.status).toBe("draft_staged");
    expect(state.stageEpisodeScriptDraft.mock.calls[0]?.[1]).toEqual(script);
  });

  it("normalizes named supporting-entity objects without losing their visual description", async () => {
    const script = validFiveMinuteScript();
    (script.scenes[0] as any).supportingEntities = [{
      name: "Firefly guide",
      description: "seven tiny golden lights with two pale wings each",
    }];
    const { state } = productionStateForDraft(script);

    const result = JSON.parse(await (buildScriptDraftTool(state) as any).call({
      episodeId: 17,
      scriptJson: script,
    }));

    expect(result.status).toBe("draft_staged");
    expect(state.stageEpisodeScriptDraft.mock.calls[0]![1].scenes[0].supportingEntities)
      .toEqual([
        "Firefly guide: seven tiny golden lights with two pale wings each",
      ]);
  });

  it.each([
    ["truncated", `{"title":"DO_NOT_ECHO_${"x".repeat(50_000)}`],
    ["plain malformed", `DO_NOT_ECHO_${"y".repeat(50_000)}`],
    ["overencoded", JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({
      title: `DO_NOT_ECHO_${"z".repeat(50_000)}`,
      scenes: [],
    })))))],
  ])("returns a compact invalid-input receipt for %s draft transport", async (_label, scriptJson) => {
    const { state } = productionStateForDraft(validFiveMinuteScript());
    const tool = buildScriptDraftTool(state);

    const rawResult = await (tool as any).call({ episodeId: 17, scriptJson });
    const result = JSON.parse(rawResult);

    expect(result).toMatchObject({
      status: "invalid_input",
      persisted: false,
      retryable: true,
      retryThisInvocation: false,
      episodeId: 17,
      reason: "malformed_truncated_or_overencoded_script_json",
    });
    expect(rawResult.length).toBeLessThan(1_000);
    expect(rawResult).not.toContain("DO_NOT_ECHO");
    expect(state.getEpisodeById).not.toHaveBeenCalled();
    expect(state.stageEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(chatTextMock).not.toHaveBeenCalled();
  });

  it("guards the whole staging schema so an invalid sibling cannot echo a large valid script", async () => {
    const script = validFiveMinuteScript();
    script.premise = `DO_NOT_ECHO_${"q".repeat(50_000)}`;
    const { state } = productionStateForDraft(script);
    const tool = buildScriptDraftTool(state);

    const rawResult = await (tool as any).call({
      episodeId: 17,
      scriptJson: script,
      unexpectedTransportField: "wrong",
    });
    const result = JSON.parse(rawResult);

    expect(result.status).toBe("invalid_input");
    expect(result.reason).toBe("schema_mismatch");
    expect(rawResult.length).toBeLessThan(1_000);
    expect(rawResult).not.toContain("DO_NOT_ECHO");
    expect(state.stageEpisodeScriptDraft).not.toHaveBeenCalled();
  });

  it("turns the Agnes-started staging guard into a compact nonfatal receipt", async () => {
    const script = validFiveMinuteScript();
    const { state } = productionStateForDraft(script, {
      stageEpisodeScriptDraft: vi.fn().mockRejectedValue(
        new Error("Cannot stage an episode script draft after Agnes submission has started."),
      ),
    });
    const tool = buildScriptDraftTool(state);

    const rawResult = await (tool as any).call({ episodeId: 17, scriptJson: script });
    const result = JSON.parse(rawResult);

    expect(result).toMatchObject({
      status: "draft_stage_blocked",
      persisted: false,
      retryable: false,
      retryThisInvocation: false,
      episodeId: 17,
    });
    expect(rawResult.length).toBeLessThan(1_000);
  });

  it("returns a compact schema-mismatch receipt for a double-encoded but structurally invalid draft", async () => {
    const { state } = productionStateForDraft(validFiveMinuteScript());
    const tool = buildScriptDraftTool(state);
    const scriptJson = JSON.stringify(JSON.stringify({
      title: "Broken structure",
      scenes: "this must be an array",
    }));

    const rawResult = await (tool as any).call({ episodeId: 17, scriptJson });
    const result = JSON.parse(rawResult);

    expect(result).toMatchObject({
      status: "invalid_input",
      reason: "schema_mismatch",
      validation: { invalidPaths: ["scriptJson.scenes"] },
    });
    expect(rawResult.length).toBeLessThan(1_000);
    expect(state.stageEpisodeScriptDraft).not.toHaveBeenCalled();
  });

  it("keeps malformed direct func callers on the same compact no-side-effect path", async () => {
    const { state } = productionStateForDraft(validFiveMinuteScript());
    const tool = buildScriptDraftTool(state);

    const rawResult = await (tool as any).func({
      episodeId: 17,
      scriptJson: `{"title":"unfinished","scenes":[${"w".repeat(20_000)}`,
    });

    expect(JSON.parse(rawResult).status).toBe("invalid_input");
    expect(rawResult.length).toBeLessThan(1_000);
    expect(state.getEpisodeById).not.toHaveBeenCalled();
    expect(state.stageEpisodeScriptDraft).not.toHaveBeenCalled();
  });

  it("keeps the full advertised staging schema while production refinement exposes only compact references", () => {
    const { state } = productionStateForDraft(validFiveMinuteScript());
    const stageDefinition = convertToOpenAITool(buildScriptDraftTool(state)) as any;
    const refineDefinition = convertToOpenAITool(buildScriptRefinementTool(state)) as any;
    const sceneProperties = stageDefinition.function.parameters.properties.scriptJson
      .properties.scenes.items.properties;

    expect(Object.keys(sceneProperties)).toEqual(expect.arrayContaining([
      "sceneNumber",
      "narrationText",
      "environmentDescription",
      "action",
      "characterNames",
      "characterVisuals",
      "supportingEntities",
      "continuityAnchors",
      "sceneDetails",
      "cameraAngle",
      "lighting",
    ]));
    expect(stageDefinition.function.parameters.properties.scriptJson.type).toBe("object");
    expect(stageDefinition.function.parameters.properties).toHaveProperty("expectedDraftRevision");
    expect(Object.keys(refineDefinition.function.parameters.properties)).toEqual([
      "episodeId",
      "draftRevision",
      "durationExceededScenes",
      "measuredTotalNarrationSeconds",
      "measuredNarrationSceneCount",
    ]);
    expect(refineDefinition.function.parameters.properties).not.toHaveProperty("scriptJson");
    expect(refineDefinition.function.parameters.properties).not.toHaveProperty("mainCharacterNames");
    expect(refineDefinition.function.parameters.properties).not.toHaveProperty("minScenes");
    expect(refineDefinition.function.parameters.properties).not.toHaveProperty("maxScenes");
  });

  it("promotes an already-valid production draft exactly with zero LLM calls", async () => {
    const script = validFiveMinuteScript();
    const { state } = productionStateForDraft(script);
    const tool = buildScriptRefinementTool(state);

    const result = await (tool as any).call({ episodeId: 17, draftRevision: 3 });
    const parsed = JSON.parse(result);

    expect(state.promoteEpisodeScriptDraft).toHaveBeenCalledTimes(1);
    expect(state.promoteEpisodeScriptDraft).toHaveBeenCalledWith({
      episodeId: 17,
      expectedRevision: 3,
      expectedContentDigest: "digest-3",
      scriptJson: script,
    });
    expect(parsed).toMatchObject({
      status: "ready",
      persisted: true,
      episodeId: 17,
      draftRevision: 3,
      sceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      narrationRepairCallCount: 0,
      scriptReloadRequired: true,
      validation: { pass: true, issues: [] },
    });
    expect(parsed.scriptJson).toBeUndefined();
    expect(result.length).toBeLessThan(1_000);
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it("canonicalizes title and premise from the episode without a whole-script review", async () => {
    const draft = validFiveMinuteScript();
    draft.title = "Drifting model title";
    draft.premise = "Drifting model objective";
    const { state } = productionStateForDraft(draft, {
      getEpisodeById: vi.fn().mockResolvedValue({
        id: 17,
        seriesId: 7,
        title: "The Canonical Lantern",
        premise: "Mia returns every meadow friend safely home.",
        status: "pending",
        scriptJson: null,
      }),
    });
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({ episodeId: 17, draftRevision: 3 }));
    const promoted = state.promoteEpisodeScriptDraft.mock.calls[0]?.[0]?.scriptJson;

    expect(result.status).toBe("ready");
    expect(result.scriptReloadRequired).toBe(true);
    expect(promoted.title).toBe("The Canonical Lantern");
    expect(promoted.premise).toBe("Mia returns every meadow friend safely home.");
    expect(promoted.scenes).toEqual(draft.scenes);
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
  });

  it("resumes the latest durable draft by episodeId alone on a fresh run", async () => {
    const script = validFiveMinuteScript();
    const { state } = productionStateForDraft(script, {}, 8);
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({ episodeId: 17 }));

    expect(result).toMatchObject({
      status: "ready",
      persisted: true,
      episodeId: 17,
      draftRevision: 8,
    });
    expect(state.promoteEpisodeScriptDraft).toHaveBeenCalledTimes(1);
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
  });

  it("seeds a missing durable draft from an already-persisted script before compact repair", async () => {
    const script = validFiveMinuteScript();
    let seededDraft: any = null;
    const { state } = productionStateForDraft(script);
    state.getEpisodeById.mockResolvedValue({
      id: 17,
      seriesId: 7,
      title: script.title,
      premise: script.premise ?? "",
      status: "script",
      scriptJson: script,
    });
    state.getEpisodeScriptDraft = vi.fn(async () => seededDraft);
    state.stageEpisodeScriptDraft = vi.fn(async (_episodeId, stagedScript, validation) => {
      seededDraft = {
        episodeId: 17,
        revision: 1,
        contentDigest: "seeded-digest",
        scriptJson: structuredClone(stagedScript),
        validation,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      };
      return { draft: seededDraft, created: true, matches: true };
    });
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({ episodeId: 17 }));

    expect(state.stageEpisodeScriptDraft).toHaveBeenCalledTimes(1);
    expect(state.stageEpisodeScriptDraft.mock.calls[0]?.[1]).toEqual(script);
    expect(result).toMatchObject({
      status: "ready",
      persisted: true,
      episodeId: 17,
      draftRevision: 1,
      scriptReloadRequired: false,
    });
    expect(state.promoteEpisodeScriptDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 1,
      expectedContentDigest: "seeded-digest",
      scriptJson: script,
    }));
  });

  it.each([
    ["zero_total_duration", { measuredTotalNarrationSeconds: 0, measuredNarrationSceneCount: 40 }],
    ["incomplete_total_duration", { measuredTotalNarrationSeconds: 320 }],
    ["incomplete_total_duration", { measuredNarrationSceneCount: 40 }],
    ["incomplete_total_duration", { measuredTotalNarrationSeconds: 320, measuredNarrationSceneCount: 39 }],
    ["incomplete_total_duration", {
      durationExceededScenes: [{ sceneNumber: 1, durationSeconds: 13.25 }],
    }],
  ])("rejects %s aggregate timing without any model or state mutation", async (reason, timing) => {
    const script = validFiveMinuteScript();
    const { state, getCurrentDraft } = productionStateForDraft(script);
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({
      episodeId: 17,
      draftRevision: 3,
      ...timing,
    }));

    expect(result).toMatchObject({
      status: "invalid_timing_evidence",
      reason,
      persisted: false,
      retryThisInvocation: false,
      narrationRepairCallCount: 0,
    });
    expect(getCurrentDraft().revision).toBe(3);
    expect(getCurrentDraft().scriptJson).toEqual(script);
    expect(state.reviseEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(state.promoteEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it("repairs only measured-overlong narration and preserves every non-narration field", async () => {
    const source = validFiveMinuteScript(41);
    const first = source.scenes[0]!;
    const before = structuredClone(source);
    const shortened =
      "Mia watches the golden lantern as friendly fireflies dance above the quiet meadow and smile.";
    chatStructuredNarrationRepairMock.mockImplementationOnce(
      async (params: any) => params.parse(JSON.stringify({
        sceneNumber: 1,
        narrationText: shortened,
      })),
    );
    const { state } = productionStateForDraft(source);
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({
      episodeId: 17,
      draftRevision: 3,
      durationExceededScenes: [{ sceneNumber: 1, durationSeconds: 13.275 }],
      measuredTotalNarrationSeconds: 320,
      measuredNarrationSceneCount: 41,
    }));

    expect(result).toMatchObject({
      status: "ready",
      persisted: true,
      narrationRepairCallCount: 1,
      sceneCount: 41,
    });
    expect(chatStructuredNarrationRepairMock).toHaveBeenCalledTimes(1);
    const request = chatStructuredNarrationRepairMock.mock.calls[0]![0];
    expect(JSON.parse(request.userText)).toMatchObject({
      sceneNumber: 1,
      measuredSeconds: 13.275,
      maximumSeconds: 12,
      narrationToShorten: before.scenes[0]!.narrationText,
    });
    expect(request.systemPrompt).toContain("exactly");
    expect(request.systemPrompt).toContain("narrationText");
    expect(request.userText).not.toContain(first.environmentDescription);
    const promoted = state.promoteEpisodeScriptDraft.mock.calls[0]![0].scriptJson;
    expect(promoted.scenes[0].narrationText).toBe(shortened);
    const { narrationText: _beforeNarration, ...beforeVisual } = before.scenes[0]!;
    const { narrationText: _afterNarration, ...afterVisual } = promoted.scenes[0];
    expect(afterVisual).toEqual(beforeVisual);
    expect(promoted.scenes.slice(1)).toEqual(before.scenes.slice(1));
    expect(source).toEqual(before);
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
  });

  it("repairs at most four narrations per invocation and resumes the durable remainder", async () => {
    const source = validFiveMinuteScript(46);
    const before = structuredClone(source);
    const shortened =
      "Mia watches the golden lantern as friendly fireflies dance above the quiet meadow and smile.";
    chatStructuredNarrationRepairMock.mockImplementation(async (params: any) => {
      const request = JSON.parse(params.userText);
      return params.parse(JSON.stringify({
        sceneNumber: request.sceneNumber,
        narrationText: shortened,
      }));
    });
    const durations = Array.from({ length: 6 }, (_unused, index) => ({
      sceneNumber: index + 1,
      durationSeconds: 13.5,
    }));
    const { state, getCurrentDraft } = productionStateForDraft(source);
    const tool = buildScriptRefinementTool(state);

    const first = JSON.parse(await (tool as any).call({
      episodeId: 17,
      draftRevision: 3,
      durationExceededScenes: durations,
      measuredTotalNarrationSeconds: 360,
      measuredNarrationSceneCount: 46,
    }));

    expect(first).toMatchObject({
      status: "needs_timing_repair",
      narrationRepairCallCount: 4,
      remainingOverlongSceneCount: 2,
      durableTimingEvidenceCount: 2,
    });
    expect(chatStructuredNarrationRepairMock).toHaveBeenCalledTimes(4);
    expect(getCurrentDraft().validation.repairEvidence.durationExceededScenes).toEqual(
      durations.slice(4),
    );
    expect(getCurrentDraft().scriptJson.scenes.slice(0, 4).map((scene: any) =>
      scene.narrationText
    )).toEqual(Array(4).fill(shortened));
    expect(getCurrentDraft().scriptJson.scenes[4].narrationText).toBe(
      before.scenes[4]!.narrationText,
    );

    const resumed = JSON.parse(await (tool as any).call({
      episodeId: 17,
      draftRevision: first.draftRevision,
    }));

    expect(resumed).toMatchObject({
      status: "ready",
      persisted: true,
      narrationRepairCallCount: 2,
      sceneCount: 46,
    });
    expect(chatStructuredNarrationRepairMock).toHaveBeenCalledTimes(6);
    expect(chatStructuredNarrationRepairMock.mock.calls.map((call) =>
      JSON.parse(call[0].userText).sceneNumber
    )).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.promoteEpisodeScriptDraft).toHaveBeenCalledTimes(1);
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
  });

  it("returns needs_reauthor for a deterministic visual defect without calling any model", async () => {
    const source = validFiveMinuteScript();
    const canonicalVisual = {
      name: "Mia",
      visualForm: "humanoid" as const,
      speciesOrType: "little girl",
      humanoidAllowed: true,
    };
    for (const index of [0, 1]) {
      source.scenes[index]!.characterNames = ["Mia"];
      source.scenes[index]!.characterVisuals = [structuredClone(canonicalVisual)];
    }
    source.scenes[1]!.characterVisuals = [{
      ...canonicalVisual,
      visualForm: "fantasy_creature",
      humanoidAllowed: false,
    }];
    const before = structuredClone(source);
    const { state, getCurrentDraft } = productionStateForDraft(source);
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({ episodeId: 17, draftRevision: 3 }));

    expect(result).toMatchObject({
      status: "needs_reauthor",
      reason: "deterministic_script_validation_failed",
      persisted: false,
      draftPersisted: true,
      retryThisInvocation: false,
      draftRevision: 4,
      replacementExpectedDraftRevision: 4,
      narrationRepairCallCount: 0,
    });
    expect(result.validation.issues.some((issue: string) =>
      issue.includes("changes locked characterVisuals metadata")
    )).toBe(true);
    expect(getCurrentDraft().scriptJson).toEqual(before);
    expect(state.promoteEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it("persists measured evidence when a narration-only response violates the narrow schema", async () => {
    const source = validFiveMinuteScript(41);
    const before = structuredClone(source);
    const shortened =
      "Mia watches the golden lantern as friendly fireflies dance above the quiet meadow and smile.";
    chatStructuredNarrationRepairMock.mockImplementationOnce(
      async (params: any) => params.parse(JSON.stringify({
        sceneNumber: 2,
        narrationText: shortened,
        cameraAngle: "an impermissible metadata patch",
      })),
    );
    const { state, getCurrentDraft } = productionStateForDraft(source);
    const tool = buildScriptRefinementTool(state);

    const rawResult = await (tool as any).call({
      episodeId: 17,
      draftRevision: 3,
      durationExceededScenes: [{ sceneNumber: 2, durationSeconds: 13.125 }],
      measuredTotalNarrationSeconds: 320,
      measuredNarrationSceneCount: 41,
    });
    const result = JSON.parse(rawResult);

    expect(result).toMatchObject({
      status: "needs_timing_repair",
      persisted: false,
      draftPersisted: true,
      retryThisInvocation: false,
      narrationRepairCallCount: 1,
      remainingOverlongSceneCount: 1,
      durableTimingEvidenceCount: 2,
    });
    expect(result.validation).not.toHaveProperty("repairEvidence");
    expect(rawResult).not.toContain("repairEvidence");
    expect(getCurrentDraft().validation.repairEvidence).toEqual({
      durationExceededScenes: [{ sceneNumber: 2, durationSeconds: 13.125 }],
      measuredTotalNarrationSeconds: 320,
      measuredNarrationSceneCount: 41,
    });
    expect(getCurrentDraft().scriptJson).toEqual(before);
    expect(state.promoteEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).toHaveBeenCalledTimes(1);
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
  });

  it("replaces a deterministically rejected draft only with its expectedDraftRevision", async () => {
    const invalid = validFiveMinuteScript();
    invalid.scenes[0]!.cameraAngle = "";
    const replacement = validFiveMinuteScript();
    const { state, getCurrentDraft } = productionStateForDraft(invalid);

    const rejected = JSON.parse(await (buildScriptRefinementTool(state) as any).call({
      episodeId: 17,
      draftRevision: 3,
    }));
    const staged = JSON.parse(await (buildScriptDraftTool(state) as any).call({
      episodeId: 17,
      expectedDraftRevision: rejected.replacementExpectedDraftRevision,
      scriptJson: replacement,
    }));

    expect(rejected).toMatchObject({
      status: "needs_reauthor",
      replacementExpectedDraftRevision: 4,
    });
    expect(staged).toMatchObject({
      status: "draft_replaced",
      persisted: true,
      replacedInvalidDraft: true,
      draftRevision: 5,
      draftMatchesSubmitted: true,
    });
    expect(state.reviseEpisodeScriptDraft).toHaveBeenLastCalledWith(
      17,
      4,
      replacement,
      expect.objectContaining({ pass: true }),
    );
    expect(state.stageEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(getCurrentDraft().scriptJson).toEqual(replacement);
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it("blocks complete-draft replacement while durable overlong narration evidence exists", async () => {
    const source = validFiveMinuteScript(41);
    const replacement = validFiveMinuteScript(41);
    replacement.premise = "A replacement premise that must not be accepted.";
    const before = structuredClone(source);
    const { state, getCurrentDraft } = productionStateForDraft(source);
    getCurrentDraft().validation = {
      pass: false,
      issues: ["Scene 2 measured 13.125 seconds in Groq audio."],
      repairEvidence: {
        durationExceededScenes: [{ sceneNumber: 2, durationSeconds: 13.125 }],
      },
    };

    const result = JSON.parse(await (buildScriptDraftTool(state) as any).call({
      episodeId: 17,
      expectedDraftRevision: 3,
      scriptJson: replacement,
    }));

    expect(result).toMatchObject({
      status: "draft_replacement_blocked",
      persisted: false,
      retryable: false,
      retryThisInvocation: false,
      draftRevision: 3,
    });
    expect(getCurrentDraft().scriptJson).toEqual(before);
    expect(state.reviseEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(state.stageEpisodeScriptDraft).not.toHaveBeenCalled();
  });

  it("rejects a complete measured runtime below five minutes without model repair", async () => {
    const source = validFiveMinuteScript();
    const before = structuredClone(source);
    const { state, getCurrentDraft } = productionStateForDraft(source);
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({
      episodeId: 17,
      draftRevision: 3,
      measuredTotalNarrationSeconds: 280,
      measuredNarrationSceneCount: 40,
    }));

    expect(result).toMatchObject({
      status: "needs_reauthor",
      reason: "measured_runtime_too_short",
      persisted: false,
      draftPersisted: true,
      retryThisInvocation: false,
      measuredTotalNarrationSeconds: 280,
      measuredNarrationSceneCount: 40,
      draftRevision: 4,
      replacementExpectedDraftRevision: 4,
      narrationRepairCallCount: 0,
    });
    expect(result.minimumReplacementSpokenWords).toBeGreaterThanOrEqual(800);
    expect(getCurrentDraft().scriptJson).toEqual(before);
    expect(getCurrentDraft().validation.repairEvidence).toMatchObject({
      measuredTotalNarrationSeconds: 280,
      measuredNarrationSceneCount: 40,
    });
    expect(state.promoteEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it.each([
    ["too few scenes", 34],
    ["too many scenes", 61],
  ])("returns needs_reauthor for %s without model repair", async (_label, sceneCount) => {
    const source = validFiveMinuteScript(sceneCount);
    const { state } = productionStateForDraft(source);
    const tool = buildScriptRefinementTool(state);

    const result = JSON.parse(await (tool as any).call({
      episodeId: 17,
      draftRevision: 3,
    }));

    expect(result).toMatchObject({
      status: "needs_reauthor",
      reason: "deterministic_script_validation_failed",
      narrationRepairCallCount: 0,
      retryThisInvocation: false,
    });
    expect(state.promoteEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it("ignores missing and non-overlong timing evidence without calling a provider", async () => {
    const source = validFiveMinuteScript();
    const { state, getCurrentDraft } = productionStateForDraft(source);
    getCurrentDraft().validation = {
      pass: false,
      issues: [],
      repairEvidence: {
        durationExceededScenes: [
          { sceneNumber: 999, durationSeconds: 13.5 },
          { sceneNumber: 1, durationSeconds: 12 },
        ],
      },
    };
    const tool = buildScriptRefinementTool(state);

    const first = JSON.parse(await (tool as any).call({ episodeId: 17, draftRevision: 3 }));
    const second = JSON.parse(await (tool as any).call({ episodeId: 17, draftRevision: 3 }));

    expect(first).toMatchObject({ status: "ready", ignoredTimingEvidenceCount: 2 });
    expect(second).toMatchObject({ status: "ready", ignoredTimingEvidenceCount: 2 });
    expect(state.reviseEpisodeScriptDraft).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it("turns a state production-contract rejection into a nonfatal compact result", async () => {
    const script = validFiveMinuteScript();
    const inspection = {
      pass: false,
      sceneCount: DEFAULT_PRODUCTION_MIN_SCENES,
      totalSpokenWords: 760,
      issues: ["Scene 9 contains a non-roster character."],
    };
    const { state } = productionStateForDraft(script, {
      getEpisodeById: vi.fn().mockResolvedValue({
        id: 18,
        seriesId: 7,
        title: script.title,
        premise: script.premise ?? "",
        status: "pending",
      }),
      promoteEpisodeScriptDraft: vi.fn().mockRejectedValue(new ProductionScriptContractError(inspection)),
    });
    const tool = buildScriptRefinementTool(state);

    const result = await (tool as any).call({
      episodeId: 18,
      draftRevision: 3,
    });
    const parsed = JSON.parse(result);

    expect(parsed).toMatchObject({
      status: "needs_reauthor",
      reason: "authoritative_contract_rejected",
      persisted: false,
      draftPersisted: true,
      retryable: true,
      episodeId: 18,
      draftRevision: 4,
      replacementExpectedDraftRevision: 4,
      narrationRepairCallCount: 0,
      validation: {
        pass: false,
        issues: ["Scene 9 contains a non-roster character."],
      },
    });
    expect(parsed.scriptJson).toBeUndefined();
    expect(state.reviseEpisodeScriptDraft).toHaveBeenCalledTimes(1);
  });

  it("requires episodeId before a production refinement can make any model or state call", async () => {
    const { state } = productionStateForDraft(validFiveMinuteScript());
    const tool = buildScriptRefinementTool(state);

    await expect((tool as any).call({
      draftRevision: 3,
    })).rejects.toThrow();

    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
    expect(state.getEpisodeById).not.toHaveBeenCalled();
    expect(state.promoteEpisodeScriptDraft).not.toHaveBeenCalled();
  });

  it("bounds interpolated validation fields so a huge invalid name cannot enter a receipt", async () => {
    const invalid = validFiveMinuteScript();
    const hugeInvalidName = `Guest_${"m".repeat(50_000)}_SECRET_TAIL`;
    invalid.scenes[0]!.characterNames = [hugeInvalidName];
    invalid.scenes[0]!.characterVisuals = [{
      name: hugeInvalidName,
      visualForm: "humanoid",
      speciesOrType: "guest",
      humanoidAllowed: true,
    }];
    const { state } = productionStateForDraft(invalid);
    const tool = buildScriptRefinementTool(state);

    const rawResult = await (tool as any).call({ episodeId: 17, draftRevision: 3 });
    const result = JSON.parse(rawResult);

    expect(result.status).toBe("needs_reauthor");
    expect(result.reason).toBe("deterministic_script_validation_failed");
    expect(result.retryThisInvocation).toBe(false);
    expect(result.narrationRepairCallCount).toBe(0);
    expect(result.validation.issues.every((issue: string) => issue.length <= 256)).toBe(true);
    expect(rawResult).not.toContain("_SECRET_TAIL");
    expect(rawResult.length).toBeLessThan(5_000);
    expect(chatTextMock).not.toHaveBeenCalled();
    expect(chatStructuredRepairMock).not.toHaveBeenCalled();
    expect(chatStructuredNarrationRepairMock).not.toHaveBeenCalled();
  });

  it("propagates unrelated direct-persistence failures", async () => {
    const script = validFiveMinuteScript();
    const { state } = productionStateForDraft(script, {
      getEpisodeById: vi.fn().mockResolvedValue({
        id: 21,
        seriesId: 7,
        title: script.title,
        premise: script.premise ?? "",
        status: "pending",
      }),
      promoteEpisodeScriptDraft: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });
    const tool = buildScriptRefinementTool(state);

    await expect((tool as any).call({
      episodeId: 21,
      draftRevision: 3,
    })).rejects.toThrow("database unavailable");
  });

  it("normalizes nested stringified scene arrays and nested scene arrays inside scriptJson", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 9,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: JSON.stringify(["Chip the Squirrel"]),
            characterVisuals: JSON.stringify([{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }]),
            supportingEntities: JSON.stringify(["Ladybug friend: tiny red ladybug with black dots"]),
            continuityAnchors: JSON.stringify(["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."]),
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).call({
      scriptJson: JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: JSON.stringify([
          {
            sceneNumber: 1,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: JSON.stringify(["Chip the Squirrel"]),
            characterVisuals: JSON.stringify([{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }]),
            supportingEntities: JSON.stringify(["Ladybug friend: tiny red ladybug with black dots"]),
            continuityAnchors: JSON.stringify(["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."]),
          },
        ]),
      }),
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].characterNames).toEqual(["Chip the Squirrel"]);
    expect(parsed.scriptJson.scenes[0].characterVisuals).toEqual([
      { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
    ]);
    expect(parsed.scriptJson.scenes[0].supportingEntities).toEqual([
      "Ladybug friend: tiny red ladybug with black dots",
    ]);
    expect(parsed.scriptJson.scenes[0].continuityAnchors).toEqual([
      "Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass.",
    ]);
    expect(parsed.validation.pass).toBe(true);
  });

  it("asks the refinement model to preserve explicit continuity anchors with visual specifics", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel searched under the oak roots.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel peers under the roots.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
            continuityAnchors: ["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."],
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    await (tool as any).func({
      scriptJson: {
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel looked high and low.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel searches for the acorn.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const request = chatTextMock.mock.calls[0][0];
    expect(request.systemPrompt).toContain("continuityAnchors");
    expect(request.systemPrompt).toContain("characterVisuals");
    expect(request.systemPrompt).toContain("visualForm");
    expect(request.systemPrompt).toContain("color, pattern, material, shape, size, placement, and current state/change");
    expect(request.userText).toContain("Add or preserve a continuityAnchor only while a non-living prop/layout/environment setup stays visible");
    expect(request.userText).toContain("characterVisuals entries aligned 1:1 with characterNames");
    expect(request.userText).toContain("color, pattern, material, shape, placement, and current state");
    expect(request.systemPrompt).toContain("ONE SCENE = ONE AUDIO = ONE VIDEO");
    expect(request.systemPrompt).toContain(`no more than ${NARRATION_MAX_RAW_CHARACTERS} raw characters`);
    expect(request.systemPrompt).toContain(`no more than ${NARRATION_MAX_SPOKEN_WORDS} spoken words`);
    expect(request.systemPrompt).toContain("preserve its environmentDescription verbatim");
    expect(request.systemPrompt).toContain("Copy a supportingEntities descriptor only into children where that one individual remains visible");
    expect(request.systemPrompt).toContain("Copy only non-living continuityAnchors through children");
    expect(request.userText).toContain("For every split, preserve the source environmentDescription");
  });

  it("normalizes stringified scriptJson and renumbers refined scenes", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 9,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
            continuityAnchors: ["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."],
            sceneDetails: "Chip the Squirrel: alert, crouching beside the pale gray oak roots, scanning the short green grass for the missing acorn.",
          },
          {
            sceneNumber: 10,
            narrationText: "Pip the Ant arrives to help.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Pip the Ant waves up at Chip the Squirrel.",
            characterNames: ["Pip the Ant", "Chip the Squirrel"],
            characterVisuals: [
              { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
              { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
            ],
            continuityAnchors: ["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."],
            sceneDetails: "Pip the Ant: helpful, waving beside the pale gray oak roots. Chip the Squirrel: hopeful, leaning down toward the grass while the same search area stays visible.",
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      }),
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].sceneNumber).toBe(1);
    expect(parsed.scriptJson.scenes[1].sceneNumber).toBe(2);
    expect(parsed.validation.pass).toBe(true);
  });

  it("accepts draft scenes with missing required fields and reports validation issues instead of failing schema parsing", async () => {
    chatTextMock
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("still not json")
      .mockResolvedValueOnce("repair prose")
      .mockResolvedValueOnce("still invalid");

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "The Firefly Lights the Way Home",
        premise: "Luna helps guide friends home at dusk.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Luna glows brighter as dusk settles over the meadow.",
            characterVisuals: [{ name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].sceneNumber).toBe(1);
    expect(parsed.scriptJson.scenes[0].environmentDescription).toBe("");
    expect(parsed.scriptJson.scenes[0].action).toBe("");
    expect(parsed.scriptJson.scenes[0].characterNames).toEqual(["Luna the Firefly"]);
    expect(parsed.validation.pass).toBe(false);
    expect(parsed.validation.issues).toContain("Scene 1 is missing environmentDescription.");
    expect(parsed.validation.issues).toContain("Scene 1 is missing action.");
  });

  it("runs one repair pass when deterministic validation still fails after review", async () => {
    chatTextMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "The Lost Acorn",
          premise: "Chip loses a shiny acorn.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Chip the Squirrel looked high and low, then he ran to the wall, then he hurried to the creek, then he called to everyone for help.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Chip the Squirrel searches for the acorn.",
              characterNames: ["Chip the Squirrel"],
              characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "The Lost Acorn",
          premise: "Chip loses a shiny acorn.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Chip the Squirrel searched under the oak roots.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Chip the Squirrel peers under the roots.",
              characterNames: ["Chip the Squirrel"],
              characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
              continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
              sceneDetails: "Chip the Squirrel: focused, crouching low under the pale gray roots, brushing short green grass aside with both paws.",
            },
            {
              sceneNumber: 2,
              narrationText: "Then Pip the Ant hurried over to help.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Pip the Ant reaches Chip the Squirrel.",
              characterNames: ["Pip the Ant", "Chip the Squirrel"],
              characterVisuals: [
                { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
              ],
              continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
              sceneDetails: "Pip the Ant: eager, hurrying to the roots with one arm raised. Chip the Squirrel: relieved, pointing at the short green grass beneath the same roots.",
            },
          ],
        })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel looked high and low.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel searches for the acorn.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(chatTextMock).toHaveBeenCalledTimes(2);
    expect(chatTextMock.mock.calls[1][0].userText).toContain("Deterministic issues to fix");
    expect(parsed.scriptJson.scenes).toHaveLength(2);
    expect(parsed.validation.pass).toBe(true);
  });

  it("recovers when the first refinement response is prose instead of JSON", async () => {
    chatTextMock
      .mockResolvedValueOnce("We need to split the story into more scenes before returning JSON.")
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "The Lost Acorn",
          premise: "Chip loses a shiny acorn.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Chip the Squirrel searched under the oak roots.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Chip the Squirrel peers under the roots.",
               characterNames: ["Chip the Squirrel"],
               characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
               continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
               sceneDetails: "Chip the Squirrel: focused, crouching low under the pale gray roots, brushing short green grass aside with both paws.",
             },
             {
               sceneNumber: 2,
               narrationText: "Pip the Ant joins Chip the Squirrel.",
               environmentDescription: "Sunny meadow near the oak tree.",
               action: "Pip the Ant joins Chip the Squirrel.",
               characterNames: ["Pip the Ant", "Chip the Squirrel"],
               characterVisuals: [
                 { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                 { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
               ],
               continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
               sceneDetails: "Pip the Ant: eager, hurrying to the roots with one arm raised. Chip the Squirrel: hopeful, leaning toward the same short green grass search area.",
             },
           ],
         })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel looked high and low.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel searches for the acorn.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(chatTextMock).toHaveBeenCalledTimes(2);
    expect(parsed.scriptJson.scenes).toHaveLength(2);
    expect(parsed.warnings).toContain("Initial refinement response was invalid JSON and required one strict repair retry.");
  });

  it("falls back to the original drafted script when refinement never returns parseable JSON", async () => {
    chatTextMock
      .mockResolvedValueOnce("We need to rethink the whole outline first.")
      .mockResolvedValueOnce("Still not JSON.")
      .mockResolvedValueOnce("This repair pass is also commentary.")
      .mockResolvedValueOnce("No JSON here either.");

    const originalScript = {
      title: "The Lost Acorn",
      premise: "Chip loses a shiny acorn.",
      scenes: [
        {
          sceneNumber: 1,
          narrationText: "Chip the Squirrel looked high and low.",
          environmentDescription: "Sunny meadow near the oak tree.",
          action: "Chip the Squirrel searches for the acorn.",
          characterNames: ["Chip the Squirrel"],
        },
      ],
    };

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: originalScript,
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson).toEqual(originalScript);
    expect(parsed.validation.pass).toBe(false);
    expect(parsed.warnings[0]).toContain("Script refinement failed; using original drafted script.");
    expect(parsed.warnings[1]).toContain("Repair pass failed; keeping last valid script.");
  });

  it("does not manufacture anchors for a repeated environment and still flags weak sceneDetails", async () => {
    chatTextMock
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("still not json")
      .mockResolvedValueOnce("not json again")
      .mockResolvedValueOnce("still invalid");

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Storm Lantern",
        premise: "A storm darkens the treehouse.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Rain tapped the window while the lantern shook overhead.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "All six friends gather under the lantern.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            characterVisuals: [
              { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
              { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
              { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
              { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
              { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
              { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
            ],
            continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
            sceneDetails: "Pip worries while Nibbles watches the lantern. Sunny glances at the window as Luna glows softly beside the table.",
          },
          {
            sceneNumber: 2,
            narrationText: "The lantern flickered and the room dimmed.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "Lantern flickers as everyone looks up.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            characterVisuals: [
              { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
              { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
              { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
              { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
              { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
              { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
            ],
            sceneDetails: "Lantern flickering.",
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.pass).toBe(false);
    expect(parsed.validation.issues.join(" ")).not.toContain("missing continuityAnchors");
    expect(parsed.validation.issues).toContain(
      "Scene 2 needs richer sceneDetails for reliable video generation because it has a complex cast or important visual setup. " +
      "Use at least 60 characters and either two sentence-like parts or at least three comma/colon/semicolon-separated visual clauses."
    );
  });

  it("repairs only targeted scene fields using previous-scene continuity context before full-script repair", async () => {
    chatTextMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "Storm Lantern",
          premise: "A storm darkens the treehouse.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Rain tapped the window while the lantern shook overhead.",
              environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
              action: "All six friends gather under the lantern.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
              characterVisuals: [
                { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
                { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
                { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
                { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
                { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
              ],
              continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
              sceneDetails: "Pip worries while Nibbles watches the lantern. Sunny glances at the window as Luna glows softly beside the table.",
            },
            {
              sceneNumber: 2,
              narrationText: "The lantern flickered and the room dimmed.",
              environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
              action: "Lantern flickers as everyone looks up.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
              characterVisuals: [
                { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
                { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
                { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
                { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
                { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
              ],
              sceneDetails: "Lantern flickering.",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
          sceneDetails: "Pip the Ant, Nibbles the Hamster, Sunny the Sparrow, Pebble the Turtle, Luna the Firefly, and Chip the Squirrel all look up from the round wooden table as the warm brass lantern flickers above them and rain streaks the side window.",
        })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Storm Lantern",
        premise: "A storm darkens the treehouse.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Rain tapped the window while the lantern shook overhead.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "All six friends gather under the lantern.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
            sceneDetails: "Pip worries while Nibbles watches the lantern. Sunny glances at the window as Luna glows softly beside the table.",
          },
          {
            sceneNumber: 2,
            narrationText: "The lantern flickered and the room dimmed.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "Lantern flickers as everyone looks up.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            sceneDetails: "Lantern flickering.",
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.pass).toBe(true);
    expect(chatTextMock).toHaveBeenCalledTimes(2);
    expect(parsed.scriptJson.scenes[1].continuityAnchors).toEqual([
      "Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors.",
    ]);
    expect(parsed.scriptJson.scenes[1].sceneDetails).toContain("warm brass lantern flickers above them");
    expect(parsed.scriptJson.scenes[1].sceneDetails).toContain("rain streaks the side window");
  });

  it("does not instruct targeted scene repair to carry forward continuity anchors across environment changes", async () => {
    chatTextMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "From Treehouse To Meadow",
          premise: "The friends run outside after the storm eases.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Inside the treehouse, the lantern still swayed gently.",
              environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
              action: "Friends glance at the lantern.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster"],
              continuityAnchors: ["Treehouse setup: warm brass lantern above a round wooden table inside dark brown treehouse walls."],
              sceneDetails: "Pip the Ant and Nibbles the Hamster stand beside the round wooden table while the warm brass lantern sways above them.",
            },
            {
              sceneNumber: 2,
              narrationText: "Outside, the wet meadow sparkled after the rain.",
              environmentDescription: "A bright meadow with wet green grass, shining puddles, and fresh sunlight after the storm.",
              action: "Pip the Ant and Nibbles the Hamster step into the meadow.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster"],
              sceneDetails: "Pip and Nibbles step outside.",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          continuityAnchors: ["Post-storm meadow setup: wet bright-green grass, silver puddles reflecting sunlight, and a fresh blue sky opening above the field."],
          sceneDetails: "Pip the Ant and Nibbles the Hamster stand in the wet bright-green grass beside silver puddles, fresh sunlight glinting across the puddle edges, while the clearing blue sky opens above the meadow.",
        })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "From Treehouse To Meadow",
        premise: "The friends run outside after the storm eases.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Inside the treehouse, the lantern still swayed gently.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "Friends glance at the lantern.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster"],
            continuityAnchors: ["Treehouse setup: warm brass lantern above a round wooden table inside dark brown treehouse walls."],
            sceneDetails: "Pip the Ant and Nibbles the Hamster stand beside the round wooden table while the warm brass lantern sways above them.",
          },
          {
            sceneNumber: 2,
            narrationText: "Outside, the wet meadow sparkled after the rain.",
            environmentDescription: "A bright meadow with wet green grass, shining puddles, and fresh sunlight after the storm.",
            action: "Pip the Ant and Nibbles the Hamster step into the meadow.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster"],
            sceneDetails: "Pip and Nibbles step outside.",
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.pass).toBe(false);
    const targetedRepairRequest = chatTextMock.mock.calls.find(
      (call) => typeof call[0]?.userText === "string" && call[0].userText.includes("Same environment as previous scene: no")
    )?.[0];
    expect(targetedRepairRequest).toBeDefined();
    expect(targetedRepairRequest.userText).toContain("Same environment as previous scene: no");
    expect(targetedRepairRequest.userText).toContain("Because the environment changed, use continuityAnchors only for a moved/shared non-living prop or setup explicitly visible in the current scene");
    expect(parsed.validation.issues.some((issue: string) => issue.includes("sceneDetails"))).toBe(true);
  });

  it("validates scripts containing 0-character scenery-only scenes without error", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "Meadow At Night",
        premise: "Fireflies light up the meadow after sunset.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "As dusk settled over the meadow, tiny yellow fireflies began to blink into the evening sky.",
            environmentDescription: "A bright green meadow filled with colorful wildflowers, soft grass, and fireflies.",
            action: "Fireflies glow softly over the darkening meadow grass.",
            characterNames: [],
            cameraAngle: "establishing",
            lighting: "cool blue dusk with fireflies",
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Meadow At Night",
        premise: "Fireflies light up the meadow after sunset.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "As dusk settled over the meadow, tiny yellow fireflies began to blink into the evening sky.",
            environmentDescription: "A bright green meadow filled with colorful wildflowers, soft grass, and fireflies.",
            action: "Fireflies glow softly over the darkening meadow grass.",
            characterNames: [],
            cameraAngle: "establishing",
            lighting: "cool blue dusk with fireflies",
          },
        ],
      },
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].characterNames).toEqual([]);
    expect(parsed.validation.pass).toBe(true);
    expect(parsed.validation.issues).toEqual([]);
  });

  it("flags validation issue when a scene continues interacting with supporting entities from previous scene but drops supportingEntities", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "Egyptian Adventure",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Cleo the Scribe pointed to the glowing hieroglyph.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Cleo points to the wall while Mia looks on.",
            characterNames: ["Mia"],
            characterVisuals: [{ name: "Mia", visualForm: "humanoid", speciesOrType: "little girl", humanoidAllowed: true }],
            supportingEntities: ["Cleo the Scribe: young Egyptian girl in white linen"],
            continuityAnchors: ["Chamber setup: glowing stone pedestal"],
            sceneDetails: "Mia and Cleo the Scribe examine the stone hieroglyph on the wall together.",
          },
          {
            sceneNumber: 2,
            narrationText: "Mia smiled as Cleo the Scribe explained the ancient symbols.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Mia listens as Cleo points.",
            characterNames: ["Mia"],
            characterVisuals: [{ name: "Mia", visualForm: "humanoid", speciesOrType: "little girl", humanoidAllowed: true }],
            continuityAnchors: ["Chamber setup: glowing stone pedestal"],
            sceneDetails: "Mia and Cleo the Scribe stand by the chamber wall examining the symbols.",
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Egyptian Adventure",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Cleo the Scribe pointed to the glowing hieroglyph.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Cleo points to the wall while Mia looks on.",
            characterNames: ["Mia"],
            supportingEntities: ["Cleo the Scribe: young Egyptian girl in white linen"],
          },
          {
            sceneNumber: 2,
            narrationText: "Mia smiled as Cleo the Scribe explained the ancient symbols.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Mia listens as Cleo points.",
            characterNames: ["Mia"],
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.issues.some((issue: string) => issue.includes("supporting entities"))).toBe(true);
  });

  it("flags validation issue when a production script has insufficient total narration words for a 5-minute episode", async () => {
    const briefScenes = Array.from({ length: 20 }, (_, i) => ({
      sceneNumber: i + 1,
      narrationText: `Mia looked at the old tree on step ${i + 1}.`,
      environmentDescription: "Sunny green meadow.",
      action: `Mia inspects step ${i + 1}.`,
      characterNames: ["Mia"],
      characterVisuals: [{ name: "Mia", visualForm: "humanoid" as const, speciesOrType: "little girl", humanoidAllowed: true }],
      continuityAnchors: ["Meadow setup: tall green grass"],
      sceneDetails: "Mia stands near the tree in the sunny green meadow.",
    }));

    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "Short Narration Episode",
        scenes: briefScenes,
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Short Narration Episode",
        scenes: briefScenes,
      },
      minScenes: 20,
      maxScenes: 30,
      targetRuntimeMinutes: 5,
      mainCharacterNames: ["Mia"],
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.issues.some((issue: string) => issue.includes("narration word count too low"))).toBe(true);
    expect(parsed.status).toBe("needs_repair");
    expect(parsed.scriptJson).toBeUndefined();
  });

  it("deterministically rejects narration over 200 raw characters and over 20 spoken words", () => {
    const overCharacterValidation = validateEpisodeScript({
      title: "Long input",
      scenes: [{
        sceneNumber: 1,
        narrationText: "x".repeat(NARRATION_MAX_RAW_CHARACTERS + 1),
        environmentDescription: "A sunny meadow clearing.",
        action: "Mia watches the meadow.",
        characterNames: [],
      }],
    }, 1, 4, 5);

    const longNarration = `${Array.from(
      { length: NARRATION_MAX_SPOKEN_WORDS + 1 },
      (_, index) => `word${index}`,
    ).join(" ")}.`;
    const productionScenes = Array.from({ length: 15 }, (_, index) => ({
      sceneNumber: index + 1,
      narrationText: longNarration,
      environmentDescription: `A distinct meadow clearing ${index + 1}.`,
      action: `Mia observes clearing ${index + 1}.`,
      characterNames: [],
    }));
    const overWordValidation = validateEpisodeScript({
      title: "Too many words per scene",
      scenes: productionScenes,
    }, 15, DEFAULT_PRODUCTION_MAX_SCENES, 5);

    expect(overCharacterValidation.issues.some((issue) => issue.includes("200-character"))).toBe(true);
    expect(overWordValidation.issues.some((issue) => issue.includes("maximum is 20"))).toBe(true);
  });

  it("accepts a feasible five-minute production script made of bounded one-video scenes", () => {
    const boundedNarration =
      "Mia watches the golden lantern glow softly while friendly fireflies dance above the quiet meadow and everyone smiles together happily.";
    const scenes = Array.from({ length: DEFAULT_PRODUCTION_MIN_SCENES }, (_, index) => ({
      sceneNumber: index + 1,
      narrationText: boundedNarration,
      environmentDescription: `A distinct moonlit meadow clearing number ${index + 1}.`,
      action: `Mia watches the lantern in clearing ${index + 1}.`,
      characterNames: ["Mia"],
      characterVisuals: [{
        name: "Mia",
        visualForm: "humanoid" as const,
        speciesOrType: "young girl",
        humanoidAllowed: true,
      }],
      sceneDetails: "Mia stands left of the centered golden lantern. Soft fireflies trace one gentle arc above the quiet grass.",
      cameraAngle: "medium wide child-eye-level shot",
      lighting: "warm golden twilight",
    }));

    const validation = validateEpisodeScript(
      { title: "The Lantern Trail", scenes },
      DEFAULT_PRODUCTION_MIN_SCENES,
      DEFAULT_PRODUCTION_MAX_SCENES,
      5,
      ["Mia"],
    );

    expect(validation).toEqual({ pass: true, issues: [] });
  });

  it("accepts a four-figure production scene when all four are counted and named exactly", () => {
    const narration =
      "Mia watches the golden lantern glow softly while friendly fireflies dance above the quiet meadow and everyone smiles together happily.";
    const scenes = Array.from({ length: DEFAULT_PRODUCTION_MIN_SCENES }, (_, index) => ({
      sceneNumber: index + 1,
      narrationText: narration,
      environmentDescription: `A distinct moonlit meadow clearing number ${index + 1}.`,
      action: `Mia points while Leo, Tara, and Bobo stand beside marker ${index + 1}.`,
      characterNames: ["Mia", "Leo", "Tara", "Bobo"],
      characterVisuals: [
        { name: "Mia", visualForm: "humanoid" as const },
        { name: "Leo", visualForm: "humanoid" as const },
        { name: "Tara", visualForm: "humanoid" as const },
        { name: "Bobo", visualForm: "object_character" as const },
      ],
      supportingEntities: [],
      continuityAnchors: [],
      sceneDetails: `Mia points at marker ${index + 1}; Leo stands left; Tara stands right; Bobo waits behind Mia.`,
      cameraAngle: "wide fixed camera",
      lighting: "warm golden twilight",
    }));

    const validation = validateEpisodeScript(
      { title: "Ensemble Lantern Trail", scenes },
      DEFAULT_PRODUCTION_MIN_SCENES,
      DEFAULT_PRODUCTION_MAX_SCENES,
      5,
      ["Mia", "Leo", "Tara", "Bobo"],
    );

    expect(validation).toEqual({ pass: true, issues: [] });
  });

  it("rejects a declared ensemble member that is absent from visual staging", () => {
    const validation = validateEpisodeScript({
      title: "Unstaged Ensemble Member",
      scenes: [{
        sceneNumber: 1,
        narrationText: "Mia studies the little lantern while the moonlit garden becomes quiet and still around her.",
        environmentDescription: "A moonlit garden beside a small blue gate.",
        action: "Mia raises the lantern and studies its star-shaped window.",
        characterNames: ["Mia", "Leo"],
        characterVisuals: [
          { name: "Mia", visualForm: "humanoid", speciesOrType: "young girl", humanoidAllowed: true },
          { name: "Leo", visualForm: "humanoid", speciesOrType: "young boy", humanoidAllowed: true },
        ],
        supportingEntities: [],
        continuityAnchors: [],
        sceneDetails: "Mia stands left of the blue gate. The lantern glows between Mia's hands while the garden remains still.",
        cameraAngle: "medium fixed child-eye-level shot",
        lighting: "soft silver moonlight with a warm lantern glow",
      }],
    }, 1, DEFAULT_PRODUCTION_MAX_SCENES, 5, ["Mia", "Leo"], {
      productionSceneContract: true,
      deferAggregateMinimums: true,
    });

    expect(validation.pass).toBe(false);
    expect(validation.issues.join(" ")).toContain(
      "declares figure \"Leo\" but never names it in action/sceneDetails",
    );
  });

  it("rejects known figures mentioned outside a scene's exact cast arrays", () => {
    const validation = validateEpisodeScript({
      title: "Exact Cast Test",
      scenes: [{
        sceneNumber: 1,
        narrationText: "Mia lifts the glowing map and studies its bright trail beside the quiet garden gate.",
        environmentDescription: "A moonlit garden where Tara waits beside a small blue gate.",
        action: "Mia lifts the map while Leo waves from the path.",
        characterNames: ["Mia"],
        characterVisuals: [{ name: "Mia", visualForm: "humanoid", speciesOrType: "young girl", humanoidAllowed: true }],
        supportingEntities: [],
        continuityAnchors: ["Map position: the glowing map rests beside Leo near the blue gate."],
        sceneDetails: "Mia stands left of the gate; Leo stays on the path; the map glows between them; the garden remains still.",
        cameraAngle: "medium fixed child-eye-level shot",
        lighting: "soft silver moonlight with a warm map glow",
      }],
    }, 1, DEFAULT_PRODUCTION_MAX_SCENES, 5, ["Mia", "Leo", "Tara"], {
      productionSceneContract: true,
      deferAggregateMinimums: true,
    });

    const text = validation.issues.join(" ");
    expect(validation.pass).toBe(false);
    expect(text).toContain("environmentDescription mentions visible figure");
    expect(text).toContain("action/sceneDetails mentions unlisted figure");
    expect(text).toContain("continuityAnchors are only for non-living props");
  });

  it("rejects a renumbered duplicate narration/action beat", () => {
    const scene = {
      sceneNumber: 1,
      narrationText: "Pip lifts the little berry and smiles.",
      environmentDescription: "A sunny meadow beside the clubhouse.",
      action: "Pip lifts one red berry.",
      characterNames: ["Pip"],
      characterVisuals: [{
        name: "Pip",
        visualForm: "real_creature" as const,
        speciesOrType: "ant",
        humanoidAllowed: false,
      }],
      sceneDetails: "Pip stands beside the clubhouse and lifts the berry with a warm smile.",
      cameraAngle: "medium",
      lighting: "warm morning light",
    };
    const validation = validateEpisodeScript({
      title: "Duplicate Beat",
      scenes: [scene, { ...structuredClone(scene), sceneNumber: 2 }],
    }, 1, 4);

    expect(validation.pass).toBe(false);
    expect(validation.issues.join(" ")).toContain("duplicates the complete narration/action beat");
  });
});
