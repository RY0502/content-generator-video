import { afterEach, describe, expect, it } from "vitest";
import {
  EPISODE_SCRIPT_CHUNK_PROTOCOL,
  EPISODE_SCRIPT_SCENES_PER_CHUNK,
  EPISODE_SCRIPT_CHUNK_MAX_CONSECUTIVE_NO_PROGRESS_RETRIES,
  buildEpisodeScriptChunkTool,
  type EpisodeScript,
  type EpisodeScriptChunkAuthoringPlan,
} from "../tools/scriptRefinementTool.js";
import { buildSeriesStateTools } from "../tools/seriesStateTools.js";
import { DEFAULT_PRODUCTION_MAX_SCENES } from "../services/narrationContract.js";
import { SeriesState } from "../state/seriesState.js";

type EpisodeScene = EpisodeScript["scenes"][number];

const openStates: SeriesState[] = [];

async function createFixture(
  characters: Array<{ name: string; description: string }> = [{
    name: "Mia",
    description: "A curious young girl in a yellow raincoat with two dark braids.",
  }],
): Promise<{
  state: SeriesState;
  seriesId: number;
  episodeId: number;
}> {
  const state = new SeriesState("file::memory:", "");
  openStates.push(state);
  const seriesId = await state.getOrCreateSeries(
    "Durable Chunk Repair Stories",
    characters,
    [{
      name: "Moonlit meadow",
      description: "Emerald grass, pale stepping stones, a silver stream, and one old willow.",
    }],
    "Mia follows a lantern trail and solves one gentle mystery.",
  );
  await state.bulkInsertEpisodesIfEmpty(
    seriesId,
    Array.from({ length: 25 }, (_unused, index) => ({
      episodeNumber: index + 1,
      title: `Lantern Trail ${index + 1}`,
      premise: `Mia follows a new lantern clue at meadow marker ${index + 1}.`,
    })),
  );
  const episode = await state.getEpisodeByNumber(seriesId, 1);
  if (!episode) throw new Error("Test episode was not created.");
  return { state, seriesId, episodeId: episode.id };
}

function authoringPlan(
  supportingEntityBible: string[] = [],
): EpisodeScriptChunkAuthoringPlan {
  return {
    storyArc:
      "Mia follows numbered lantern markers across the meadow, discovers why the light is wandering, " +
      "restores the brass lantern to its stone stand, and carries the lesson home.",
    educationalIdea: "Following numbered markers in order makes a winding route easier to understand.",
    endingInsight: "Careful observation can turn a confusing trail into a clear path.",
    beats: [
      {
        startScene: 1,
        endScene: 10,
        storyBeat: "Mia follows the first markers and discovers a star-shaped beam beside the stream.",
        setting: "The meadow entrance and silver stream path.",
        continuityOutcome: "The lantern beam points toward the willow path.",
      },
      {
        startScene: 11,
        endScene: 20,
        storyBeat: "Mia compares the middle markers and finds the lantern's empty stone stand.",
        setting: "The willow path and circular stone clearing.",
        continuityOutcome: "The empty stand establishes where the lantern belongs.",
      },
      {
        startScene: 21,
        endScene: 30,
        storyBeat: "Mia follows the returning beam and carries the lantern toward its stand.",
        setting: "The return path beside the stream.",
        continuityOutcome: "The lantern reaches the edge of the stone clearing.",
      },
      {
        startScene: 31,
        endScene: DEFAULT_PRODUCTION_MAX_SCENES,
        storyBeat: "Mia restores the lantern and checks every marker on the safely lit route.",
        setting: "The restored lantern stand and completed meadow route.",
        continuityOutcome: "The lantern is secure and every numbered marker is visible again.",
      },
    ],
    supportingEntityBible,
    continuityBible: [
      "Brass lantern: one round brass lantern with a star-shaped window and warm amber flame",
    ],
  };
}

function validNarration(sceneNumber: number): string {
  return (
    `Mia studies marker ${sceneNumber} beside the glowing lantern while warm fireflies trace ` +
    "a calm arc over the quiet meadow path."
  );
}

function overlongNarration(wordCount: number): string {
  return Array.from({ length: wordCount }, (_unused, index) => `word${index + 1}`).join(" ");
}

function sceneAt(sceneNumber: number): EpisodeScene {
  return {
    sceneNumber,
    narrationText: validNarration(sceneNumber),
    environmentDescription:
      `A moonlit meadow clearing number ${sceneNumber} with emerald grass, pale stepping stones, ` +
      "a silver stream edge, and one willow silhouette.",
    action:
      `Mia lifts the brass lantern at marker ${sceneNumber}, follows its star-shaped beam, ` +
      "and stops beside the next pale stone.",
    characterNames: ["Mia"],
    characterVisuals: [{
      name: "Mia",
      visualForm: "humanoid" as const,
      speciesOrType: "young girl",
      humanoidAllowed: true,
    }],
    supportingEntities: [],
    continuityAnchors: [
      "Brass lantern: one round brass lantern with a star-shaped window and warm amber flame",
    ],
    sceneDetails:
      `Mia stands left of the brass lantern at marker ${sceneNumber}, with both dark braids clear ` +
      "and one hand on its round handle. The star window points toward the next pale stone " +
      "while the silver stream remains behind her.",
    cameraAngle: "medium wide child-eye tracking move alongside Mia",
    lighting: "soft amber lantern light under a deep blue moonlit sky",
  };
}

function numberedScenes(count: number): EpisodeScene[] {
  return Array.from({ length: count }, (_unused, index) => sceneAt(index + 1));
}

function openingScenes(): EpisodeScene[] {
  return numberedScenes(EPISODE_SCRIPT_SCENES_PER_CHUNK);
}

async function callChunk(tool: unknown, input: Record<string, unknown>): Promise<any> {
  const raw = await (tool as { call(value: unknown): Promise<string> }).call(input);
  return JSON.parse(raw);
}

function draftScenes(draft: Awaited<ReturnType<SeriesState["getEpisodeScriptDraft"]>>): EpisodeScene[] {
  if (!draft || !draft.scriptJson || typeof draft.scriptJson !== "object") {
    throw new Error("Expected a persisted chunk draft envelope.");
  }
  const scenes = (draft.scriptJson as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes)) throw new Error("Expected draft scenes.");
  return scenes as EpisodeScene[];
}

afterEach(async () => {
  await Promise.all(openStates.splice(0).map((state) => state.close()));
});

describe("write_episode_script_chunk durable pending repair integration", () => {
  it("stages only an empty accepted prefix for an invalid initial start and never advances it for rejection", async () => {
    const { state, episodeId } = await createFixture();
    const tool = buildEpisodeScriptChunkTool(state);
    const invalidScenes = openingScenes();
    invalidScenes[0]!.narrationText = overlongNarration(24);

    const rejected = await callChunk(tool, {
      operation: "start",
      episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan(),
      scenes: invalidScenes,
    });

    expect(rejected).toMatchObject({
      status: "invalid_script_chunk",
      persisted: true,
      pendingCandidatePreserved: true,
      draftRevision: 1,
      authoringProgress: { completedSceneCount: 0, nextSceneNumber: 1 },
      pendingRepair: {
        requiredSceneNumbers: [1],
        candidateScenes: [invalidScenes[0]],
        editableFields: [{ sceneNumber: 1, fields: ["narrationText"] }],
      },
    });
    expect(rejected.pendingRepair.candidateScenes).toHaveLength(1);
    expect(rejected.nextAction).toContain("only complete scenes 1");
    expect(rejected.nextAction).toContain("pendingRepair.candidateScenes");
    const firstDraft = await state.getEpisodeScriptDraft(episodeId);
    const firstPending = await state.getEpisodeScriptPendingChunk(episodeId);
    expect(firstDraft?.revision).toBe(1);
    expect(draftScenes(firstDraft)).toEqual([]);
    expect(firstPending).toMatchObject({
      acceptedDraftRevision: 1,
      sceneStart: 1,
      sceneEnd: 8,
      totalCorrectionAttempts: 1,
    });
    expect(firstPending?.candidateScenes).toEqual(invalidScenes);

    const rejectedAgain = await callChunk(tool, {
      operation: "append",
      episodeId,
      expectedDraftRevision: 1,
      scenes: [invalidScenes[0]],
    });
    expect(rejectedAgain).toMatchObject({
      status: "invalid_script_chunk",
      draftRevision: 1,
      pendingCandidatePreserved: true,
      totalCorrectionAttempts: 2,
    });
    expect((await state.getEpisodeScriptDraft(episodeId))?.revision).toBe(1);
    expect(draftScenes(await state.getEpisodeScriptDraft(episodeId))).toEqual([]);
  });

  it("exposes and accepts only non-contiguous scenes affected by pending issues", async () => {
    const { state, episodeId } = await createFixture();
    const tool = buildEpisodeScriptChunkTool(state);
    const invalidScenes = openingScenes();
    invalidScenes[0]!.narrationText = overlongNarration(24);
    invalidScenes[2]!.narrationText = Array.from(
      { length: 23 },
      (_unused, index) => `thirdword${index + 1}`,
    ).join(" ");

    const rejected = await callChunk(tool, {
      operation: "start",
      episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan(),
      scenes: invalidScenes,
    });

    expect(rejected.pendingRepair).toMatchObject({
      requiredSceneNumbers: [1, 3],
      editableFields: [
        { sceneNumber: 1, fields: ["narrationText"] },
        { sceneNumber: 3, fields: ["narrationText"] },
      ],
    });
    expect(rejected.pendingRepair.candidateScenes.map(
      (scene: EpisodeScene) => scene.sceneNumber,
    )).toEqual([1, 3]);

    const overbroad = await callChunk(tool, {
      operation: "append",
      episodeId,
      expectedDraftRevision: rejected.draftRevision,
      scenes: invalidScenes,
    });
    expect(overbroad).toMatchObject({
      status: "invalid_script_chunk",
      persisted: false,
      validation: {
        issues: [expect.stringContaining("Pending repair requires exactly complete scenes 1, 3")],
      },
    });

    const corrections = structuredClone(
      rejected.pendingRepair.candidateScenes,
    ) as EpisodeScene[];
    corrections[0]!.narrationText = validNarration(1);
    corrections[1]!.narrationText = validNarration(3);
    // This non-editable attempted change must not replace the durable value.
    corrections[0]!.cameraAngle = "an unrelated replacement overhead camera";
    const accepted = await callChunk(tool, {
      operation: "append",
      episodeId,
      expectedDraftRevision: rejected.draftRevision,
      scenes: corrections,
    });

    expect(accepted).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    const acceptedScenes = draftScenes(await state.getEpisodeScriptDraft(episodeId));
    expect(acceptedScenes[0]!.cameraAngle).toBe(invalidScenes[0]!.cameraAngle);
    expect(acceptedScenes[1]).toEqual(invalidScenes[1]);
    expect(acceptedScenes[3]).toEqual(invalidScenes[3]);
  });

  it("canonicalizes a declared Mother Mammoth omission and accepts the chunk without a semantic retry", async () => {
    const { state, episodeId } = await createFixture();
    const descriptor =
      "Mother Mammoth: one adult woolly mammoth with russet fur, curved ivory tusks, and a blue leaf ribbon";
    const scenes = openingScenes();
    scenes[0]!.supportingEntities = [descriptor];
    expect(`${scenes[0]!.action} ${scenes[0]!.sceneDetails}`).not.toContain("Mother Mammoth");

    const result = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "start",
      episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan([descriptor]),
      scenes,
    });

    expect(result).toMatchObject({
      status: "script_chunk_staged",
      persisted: true,
      draftRevision: 1,
      castCanonicalization: {
        changedSceneCount: 1,
        unresolvedIssueCount: 0,
      },
    });
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
    const accepted = draftScenes(await state.getEpisodeScriptDraft(episodeId));
    expect(accepted[0]!.supportingEntities).toEqual([descriptor]);
    expect(accepted[0]!.sceneDetails).toContain("Visible exactly once: Mother Mammoth.");
    expect(accepted[0]!.sceneDetails!.match(/Mother Mammoth/gu)).toHaveLength(1);
  });

  it("treats planned-figure declarations as advisory in rendered fields and narration", async () => {
    const descriptor =
      "Luma: one tiny amber firefly with two clear wings and a steady gold glow";

    const visibleFixture = await createFixture();
    const visibleScenes = openingScenes();
    visibleScenes[0]!.action =
      "Mia lifts the brass lantern while Luma circles its handle and stops above marker 1.";
    visibleScenes[0]!.sceneDetails =
      "Mia stands left of the brass lantern with both braids clear. Luma hovers above its round handle, " +
      "while the star window points toward the first pale stone.";
    const visibleResult = await callChunk(buildEpisodeScriptChunkTool(visibleFixture.state), {
      operation: "start",
      episodeId: visibleFixture.episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan([descriptor]),
      scenes: visibleScenes,
    });
    expect(visibleResult).toMatchObject({
      status: "script_chunk_staged",
      persisted: true,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    expect(await visibleFixture.state.getEpisodeScriptPendingChunk(
      visibleFixture.episodeId,
    )).toBeNull();

    const narrationFixture = await createFixture();
    const narrationScenes = openingScenes();
    narrationScenes[0]!.narrationText =
      "Mia remembers Luma and studies marker one while the lantern traces a calm arc over the quiet meadow path.";
    const narrationResult = await callChunk(buildEpisodeScriptChunkTool(narrationFixture.state), {
      operation: "start",
      episodeId: narrationFixture.episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan([descriptor]),
      scenes: narrationScenes,
    });
    expect(narrationResult).toMatchObject({ status: "script_chunk_staged" });
  });

  it("completes the final chunk without subjective planned-figure count rejection", async () => {
    const { state, episodeId } = await createFixture();
    const descriptor =
      "Luma: one tiny amber firefly with two clear wings and a steady gold glow";
    const plan = authoringPlan([descriptor]);
    plan.beats = plan.beats.map((beat) => ({
      ...beat,
      storyBeat: "Mia studies numbered meadow markers and advances one lantern clue.",
      continuityOutcome: "The next numbered marker becomes clear along the lantern path.",
    }));
    const acceptedPrefix = numberedScenes(32);
    const staged = await state.stageEpisodeScriptDraft(episodeId, {
      title: "Lantern Trail 1",
      premise: "Mia follows a new lantern clue at meadow marker 1.",
      scenes: acceptedPrefix,
      authoring: {
        protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
        targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
        plan,
      },
    });
    const finalScenes = Array.from(
      { length: EPISODE_SCRIPT_SCENES_PER_CHUNK },
      (_unused, index) => sceneAt(index + 33),
    );
    finalScenes[7]!.action =
      "Mia steadies the brass lantern while Luma circles marker 40 and stops above the final pale stone.";
    finalScenes[7]!.sceneDetails +=
      " Luma remains exactly once above the final stone with both clear wings visible.";

    const result = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: staged.draft.revision,
      scenes: finalScenes,
    });

    expect(result).toMatchObject({
      status: "script_draft_complete",
      persisted: true,
      sceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      validation: { pass: true, issues: [] },
    });
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
    expect(draftScenes(await state.getEpisodeScriptDraft(episodeId))).toHaveLength(
      DEFAULT_PRODUCTION_MAX_SCENES,
    );
  });

  it("uses an accepted legacy supporting descriptor instead of entering permanent plan drift", async () => {
    const { state, episodeId } = await createFixture();
    const acceptedDescriptor =
      "Luma: one tiny amber firefly with two clear wings and a steady gold glow";
    const legacyPlanDescriptor =
      "Luma: an obsolete blue firefly descriptor retained in the old plan";
    const acceptedOpening = openingScenes();
    acceptedOpening[0]!.supportingEntities = [acceptedDescriptor];
    acceptedOpening[0]!.action =
      "Mia lifts the brass lantern while Luma circles its handle and stops above marker 1.";
    acceptedOpening[0]!.sceneDetails +=
      " Luma remains exactly once above the handle with a calm amber glow.";
    const staged = await state.stageEpisodeScriptDraft(episodeId, {
      title: "Lantern Trail 1",
      premise: "Mia follows a new lantern clue at meadow marker 1.",
      scenes: acceptedOpening,
      authoring: {
        protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
        targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
        plan: authoringPlan([legacyPlanDescriptor]),
      },
    });

    const nextScenes = Array.from(
      { length: EPISODE_SCRIPT_SCENES_PER_CHUNK },
      (_unused, index) => sceneAt(index + 9),
    );
    for (const scene of nextScenes.filter((item) => item.sceneNumber >= 11)) {
      scene.narrationText =
        `Mia compares middle marker ${scene.sceneNumber} beneath the old willow and notices ` +
        "the lantern's empty circular stone stand.";
      scene.environmentDescription =
        `A circular stone clearing number ${scene.sceneNumber} beneath one old willow, with an ` +
        "empty carved stand, emerald grass, and the silver stream behind it.";
      scene.action =
        `Mia compares marker ${scene.sceneNumber} with the carved empty stand, traces its round rim, ` +
        "and points toward the matching lantern socket.";
      scene.sceneDetails =
        `Mia kneels left of marker ${scene.sceneNumber} with both braids clear and one finger on the ` +
        "empty stand's rim. The circular lantern socket remains centered beneath the willow, " +
        "with the silver stream behind her.";
    }
    nextScenes[0]!.supportingEntities = [legacyPlanDescriptor];
    nextScenes[0]!.action =
      "Mia steadies the brass lantern while Luma crosses marker 9 and stops over the next pale stone.";
    nextScenes[0]!.sceneDetails +=
      " Luma remains exactly once over the next stone with both clear wings visible.";
    const result = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: staged.draft.revision,
      scenes: nextScenes,
    });

    expect(result, JSON.stringify(result)).toMatchObject({
      status: "script_chunk_appended",
      draftRevision: 2,
    });
    const accepted = draftScenes(await state.getEpisodeScriptDraft(episodeId));
    expect(accepted[8]!.supportingEntities).toEqual([acceptedDescriptor]);
  });

  it("repairs a guest cast move as one unit while preserving unrelated cinematography", async () => {
    const { state, episodeId } = await createFixture();
    const descriptor =
      "Luma: one tiny amber firefly with two clear wings and a steady gold glow";
    const invalidScenes = openingScenes();
    invalidScenes[0]!.characterNames = ["Mia", "Luma"];
    invalidScenes[0]!.characterVisuals = [
      invalidScenes[0]!.characterVisuals![0]!,
      {
        name: "Luma",
        visualForm: "real_creature",
        speciesOrType: "firefly",
        humanoidAllowed: false,
      },
    ];
    invalidScenes[0]!.action =
      "Mia lifts the brass lantern while Luma circles its handle and stops above marker 1.";
    invalidScenes[0]!.sceneDetails +=
      " Luma remains exactly once above the handle with both clear wings visible.";
    const first = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "start",
      episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan([descriptor]),
      scenes: invalidScenes,
    });
    expect(first).toMatchObject({ status: "invalid_script_chunk" });

    const correction = structuredClone(invalidScenes);
    correction[0]!.characterNames = ["Mia"];
    correction[0]!.characterVisuals = [correction[0]!.characterVisuals![0]!];
    correction[0]!.supportingEntities = [descriptor];
    correction[0]!.cameraAngle = "an unrelated replacement overhead camera";
    correction[0]!.lighting = "an unrelated replacement cold blue light";
    const result = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: first.draftRevision,
      scenes: [correction[0]],
    });

    expect(result).toMatchObject({ status: "script_chunk_appended" });
    const accepted = draftScenes(await state.getEpisodeScriptDraft(episodeId));
    expect(accepted[0]).toMatchObject({
      characterNames: ["Mia"],
      supportingEntities: [descriptor],
      cameraAngle: invalidScenes[0]!.cameraAngle,
      lighting: invalidScenes[0]!.lighting,
    });
  });

  it("patches only the failing field over a pending candidate and clears pending state after success", async () => {
    const { state, episodeId } = await createFixture();
    const tool = buildEpisodeScriptChunkTool(state);
    const invalidScenes = openingScenes();
    invalidScenes[0]!.narrationText = overlongNarration(23);

    const rejected = await callChunk(tool, {
      operation: "start",
      episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan(),
      scenes: invalidScenes,
    });
    const pendingBefore = await state.getEpisodeScriptPendingChunk(episodeId);
    if (!pendingBefore) throw new Error("Expected rejected candidate to be durable.");
    const pendingCandidate = structuredClone(pendingBefore.candidateScenes) as EpisodeScene[];
    const correctionSubmission = structuredClone(pendingCandidate);
    correctionSubmission[0] = {
      ...correctionSubmission[0]!,
      narrationText: validNarration(1),
      environmentDescription: "A deliberately different but valid replacement clearing.",
      action: "Mia deliberately replaces the original action and stops beside a different stone.",
      characterVisuals: [{
        name: "Mia",
        visualForm: "humanoid",
        speciesOrType: "adult astronaut",
        humanoidAllowed: true,
      }],
      continuityAnchors: ["Replacement prop: one square silver box on a purple tile"],
      sceneDetails:
        "Mia occupies a deliberately changed position beside a replacement prop. " +
        "Her pose, expression, and blocking are all different from the pending candidate.",
      cameraAngle: "fixed overhead wide shot centered on Mia",
      lighting: "cold white ceiling light with hard blue shadows",
    };

    const acceptedResult = await callChunk(tool, {
      operation: "append",
      episodeId,
      expectedDraftRevision: rejected.draftRevision,
      scenes: [correctionSubmission[0]],
    });

    expect(acceptedResult).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      draftRevision: 2,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();

    const expectedAcceptedScenes = structuredClone(pendingCandidate);
    expectedAcceptedScenes[0]!.narrationText = validNarration(1);
    const acceptedScenes = draftScenes(await state.getEpisodeScriptDraft(episodeId));
    expect(acceptedScenes).toEqual(expectedAcceptedScenes);
    expect(acceptedScenes[0]!.environmentDescription)
      .not.toBe(correctionSubmission[0]!.environmentDescription);
    expect(acceptedScenes[0]!.characterVisuals)
      .not.toEqual(correctionSubmission[0]!.characterVisuals);
  });

  it("reloads and improves a pending correction across fresh tool instances", async () => {
    const { state, episodeId } = await createFixture();
    const initialScenes = openingScenes();
    initialScenes[0]!.narrationText = overlongNarration(24);
    const first = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "start",
      episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan(),
      scenes: initialScenes,
    });

    const improvedButInvalid = structuredClone(initialScenes);
    improvedButInvalid[0]!.narrationText = overlongNarration(21);
    const second = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: first.draftRevision,
      scenes: [improvedButInvalid[0]],
    });

    expect(second).toMatchObject({
      status: "invalid_script_chunk",
      persisted: true,
      draftRevision: 1,
      progressDirection: "improved",
      noProgress: false,
      consecutiveNoProgressAttempts: 0,
      totalCorrectionAttempts: 2,
      pendingCandidatePreserved: true,
    });
    expect((await state.getEpisodeScriptDraft(episodeId))?.revision).toBe(1);
    expect((await state.getEpisodeScriptPendingChunk(episodeId))?.candidateScenes[0])
      .toMatchObject({ narrationText: overlongNarration(21) });

    const corrected = structuredClone(improvedButInvalid);
    corrected[0]!.narrationText = validNarration(1);
    const third = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: first.draftRevision,
      scenes: [corrected[0]],
    });

    expect(third).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      draftRevision: 2,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
  });

  it("resets only the no-progress retry streak for a fresh tool instance", async () => {
    const { state, episodeId } = await createFixture();
    const firstTool = buildEpisodeScriptChunkTool(state);
    const invalidScenes = openingScenes();
    invalidScenes[0]!.narrationText = overlongNarration(24);
    const first = await callChunk(firstTool, {
      operation: "start",
      episodeId,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan(),
      scenes: invalidScenes,
    });
    expect(first.consecutiveNoProgressAttempts).toBe(0);

    let last = first;
    for (
      let attempt = 1;
      attempt <= EPISODE_SCRIPT_CHUNK_MAX_CONSECUTIVE_NO_PROGRESS_RETRIES + 1;
      attempt += 1
    ) {
      last = await callChunk(firstTool, {
        operation: "append",
        episodeId,
        expectedDraftRevision: first.draftRevision,
        scenes: [invalidScenes[0]],
      });
      expect(last).toMatchObject({
        status: "invalid_script_chunk",
        consecutiveNoProgressAttempts: attempt,
        totalCorrectionAttempts: attempt + 1,
      });
    }
    expect(last.retryThisInvocation).toBe(false);
    const freshRun = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: first.draftRevision,
      scenes: [invalidScenes[0]],
    });
    expect(freshRun).toMatchObject({
      status: "invalid_script_chunk",
      retryThisInvocation: true,
      consecutiveNoProgressAttempts: 1,
      totalCorrectionAttempts:
        EPISODE_SCRIPT_CHUNK_MAX_CONSECUTIVE_NO_PROGRESS_RETRIES + 3,
    });
  });

  it("appends to a legacy prefix whose former semantic defect is now advisory", async () => {
    const { state, seriesId, episodeId } = await createFixture();
    const plan = authoringPlan();
    const legacyOpening = openingScenes().map((scene) => ({
      ...scene,
      action: `${scene.action} The children watch the bag beside the marker.`,
      sceneDetails:
        `${scene.sceneDetails} The children watch the bag while Mia remains beside the lantern.`,
    }));
    const legacyDraft = await state.stageEpisodeScriptDraft(episodeId, {
      title: "Lantern Trail 1",
      premise: "Mia follows a new lantern clue at meadow marker 1.",
      scenes: legacyOpening,
      authoring: {
        protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
        targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
        plan,
      },
    });
    expect(legacyDraft.draft.revision).toBe(1);

    const proposedAppend = Array.from(
      { length: EPISODE_SCRIPT_SCENES_PER_CHUNK },
      (_unused, index) => sceneAt(index + 9),
    );
    const appended = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: legacyDraft.draft.revision,
      scenes: proposedAppend,
    });

    expect(appended).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      retryable: true,
      retryThisInvocation: true,
      episodeId,
      draftRevision: 2,
      authoringProgress: {
        completedSceneCount: EPISODE_SCRIPT_SCENES_PER_CHUNK * 2,
        nextSceneNumber: EPISODE_SCRIPT_SCENES_PER_CHUNK * 2 + 1,
      },
    });

    const durableDraft = await state.getEpisodeScriptDraft(episodeId);
    expect(durableDraft).toMatchObject({
      revision: 2,
      validation: {
        pass: true,
      },
    });
    expect(draftScenes(durableDraft)).toEqual([
      ...legacyOpening,
      ...proposedAppend,
    ]);
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();

    // A new process resumes from the durable contiguous prefix and requests
    // only the next exact range; it does not restart for subjective prose.
    const freshGetNextEpisode = buildSeriesStateTools(state, {
      youtubeUploadEnabled: false,
    }).find((tool) => tool.name === "get_next_episode");
    if (!freshGetNextEpisode) throw new Error("get_next_episode tool was not created.");
    const resumed = JSON.parse(await (freshGetNextEpisode as any).call({ seriesId }));
    expect(resumed).toMatchObject({
      kind: "ready",
      resumeAction: "script_authoring",
      scriptDraft: {
        revision: 2,
        validation: {
          pass: true,
        },
        authoringProgress: {
          status: "in_progress",
          completedSceneCount: EPISODE_SCRIPT_SCENES_PER_CHUNK * 2,
          nextSceneNumber: EPISODE_SCRIPT_SCENES_PER_CHUNK * 2 + 1,
          nextSceneEnd: EPISODE_SCRIPT_SCENES_PER_CHUNK * 3,
        },
      },
      scriptValidation: {
        status: "authoring_in_progress",
      },
    });
    expect(resumed.scriptValidation.nextAction).toContain("Append only scenes 17-24");
    expect(resumed.scriptValidation.nextAction).toContain("draft revision 2");
    expect(resumed.scriptValidation.nextAction).not.toContain("Restart authoring");
  });

  it("turns an invalid restart into one durable empty prefix that get_next_episode resumes", async () => {
    const { state, seriesId, episodeId } = await createFixture();
    const rejectedCompleteScenes = numberedScenes(DEFAULT_PRODUCTION_MAX_SCENES);
    rejectedCompleteScenes[0]!.narrationText = overlongNarration(24);
    const rejectedCompleteDraft = await state.stageEpisodeScriptDraft(
      episodeId,
      {
        title: "Lantern Trail 1",
        premise: "Mia follows a new lantern clue at meadow marker 1.",
        scenes: rejectedCompleteScenes,
      },
      {
        pass: false,
        sceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
        totalSpokenWords: 804,
        issueCount: 1,
        issues: [
          "Scene 1 narrationText has 24 spoken words; the production maximum is 20.",
        ],
        omittedIssueCount: 0,
      },
    );
    expect(rejectedCompleteDraft.draft.revision).toBe(1);

    const replacementOpening = openingScenes();
    replacementOpening[0]!.narrationText = overlongNarration(23);
    const rejectedRestart = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "restart",
      episodeId,
      expectedDraftRevision: rejectedCompleteDraft.draft.revision,
      targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
      authoringPlan: authoringPlan(),
      scenes: replacementOpening,
    });

    expect(rejectedRestart).toMatchObject({
      status: "invalid_script_chunk",
      persisted: true,
      pendingCandidatePreserved: true,
      draftRevision: 2,
      authoringProgress: { completedSceneCount: 0, nextSceneNumber: 1 },
    });
    const restartedPrefix = await state.getEpisodeScriptDraft(episodeId);
    expect(restartedPrefix?.revision).toBe(2);
    expect(draftScenes(restartedPrefix)).toEqual([]);
    expect(restartedPrefix?.scriptJson).toMatchObject({
      authoring: {
        targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
        plan: authoringPlan(),
      },
    });
    const pendingRestart = await state.getEpisodeScriptPendingChunk(episodeId);
    expect(pendingRestart).toMatchObject({
      acceptedDraftRevision: 2,
      acceptedDraftDigest: restartedPrefix?.contentDigest,
      operation: "append",
      sceneStart: 1,
      sceneEnd: 8,
      totalCorrectionAttempts: 1,
    });

    const getNextEpisode = buildSeriesStateTools(state, { youtubeUploadEnabled: false })
      .find((tool) => tool.name === "get_next_episode");
    if (!getNextEpisode) throw new Error("get_next_episode tool was not created.");
    const resumed = JSON.parse(await (getNextEpisode as any).call({ seriesId }));
    expect(resumed).toMatchObject({
      kind: "ready",
      resumeAction: "script_authoring",
      scriptDraft: {
        revision: 2,
        pendingRepair: {
          operation: "append",
          sceneStart: 1,
          sceneEnd: 8,
          totalCorrectionAttempts: 1,
        },
        authoringProgress: {
          status: "in_progress",
          completedSceneCount: 0,
          requiredAction: "correct_pending_chunk",
          nextSceneNumber: 1,
          nextSceneEnd: 8,
        },
      },
      scriptValidation: {
        status: "authoring_in_progress",
        nextAction: expect.stringContaining("complete scenes 1"),
      },
    });
    expect((await state.getEpisodeScriptDraft(episodeId))?.revision).toBe(2);

    const correctedOpening = structuredClone(
      pendingRestart?.candidateScenes ?? replacementOpening,
    ) as EpisodeScene[];
    correctedOpening[0]!.narrationText = validNarration(1);
    const corrected = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: 2,
      scenes: [correctedOpening[0]],
    });

    expect(corrected).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      draftRevision: 3,
      authoringProgress: { completedSceneCount: 8, nextSceneNumber: 9 },
    });
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
    expect(draftScenes(await state.getEpisodeScriptDraft(episodeId))).toEqual(correctedOpening);
  });

  it("self-heals Episode-128-shaped Bobo alias corruption while appending the full pending range", async () => {
    const { state, episodeId } = await createFixture([
      {
        name: "Mia",
        description: "A curious young girl in a yellow raincoat with two dark braids.",
      },
      {
        name: "Bobo the Backpack",
        description: "A friendly cobalt-blue talking backpack with amber eyes and a gold star zipper.",
      },
    ]);
    const legacyBoboDescriptor =
      "Bobo: one cobalt-blue talking backpack with amber eyes and a gold star zipper";
    const plan = authoringPlan([legacyBoboDescriptor]);
    plan.beats = plan.beats.map((beat) => ({
      ...beat,
      storyBeat: "Mia advances along numbered lantern markers through the assigned route section.",
      continuityOutcome: "The numbered lantern route advances into its next marked section.",
    }));

    const acceptedPrefix = numberedScenes(16);
    acceptedPrefix[0]!.supportingEntities = [legacyBoboDescriptor];
    acceptedPrefix[0]!.action += " Bobo glows beside the first numbered marker.";
    acceptedPrefix[0]!.sceneDetails +=
      " Bobo rests upright beside the lantern with amber eyes open and the gold star zipper visible.";
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      {
        title: "Lantern Trail 1",
        premise: "Mia follows a new lantern clue at meadow marker 1.",
        scenes: acceptedPrefix,
        authoring: {
          protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
          targetSceneCount: DEFAULT_PRODUCTION_MAX_SCENES,
          plan,
        },
      },
      { pass: true, issues: [] },
    );
    expect(staged.draft.revision).toBe(1);

    const pendingScenes = numberedScenes(24).slice(16);
    pendingScenes[0] = {
      ...pendingScenes[0]!,
      action:
        "Mia points toward marker 17 while Bobo Bobo the Backpack nudges the brass lantern into its carved circle.",
      characterNames: ["Mia", "Bobo the Backpack"],
      characterVisuals: [
        pendingScenes[0]!.characterVisuals![0]!,
        {
          name: "Bobo the Backpack",
          visualForm: "object_character",
          speciesOrType: "talking backpack",
          humanoidAllowed: false,
        },
      ],
      sceneDetails:
        "Mia kneels left of the carved circle with both dark braids clear. " +
        "Bobo Bobo the Backpack stays upright on the right, amber eyes open and gold star zipper visible, " +
        "while the brass lantern settles between them at marker 17.",
    };
    const issueMessage =
      'Scene 17 action/sceneDetails mentions unlisted figure "Bobo". ' +
      "Every visible figure must be counted exactly once in characterNames or supportingEntities for this scene.";
    await state.upsertEpisodeScriptPendingChunk({
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "append",
      sceneStart: 17,
      sceneEnd: 24,
      candidateScenes: pendingScenes,
      structuredIssues: [{
        code: "cast.unlisted_figure",
        sceneNumber: 17,
        field: "action/sceneDetails",
        path: "scenes[16].action/sceneDetails",
        subject: "bobo",
        messages: [issueMessage],
        occurrenceCount: 1,
        weight: 70,
      }],
      issueFingerprint: "e".repeat(64),
      consecutiveNoProgressAttempts: 0,
      totalCorrectionAttempts: 1,
    });

    // A pending retry sends only the implicated complete scene. The remaining
    // seven already-valid candidates stay private and must still be appended.
    const result = await callChunk(buildEpisodeScriptChunkTool(state), {
      operation: "append",
      episodeId,
      expectedDraftRevision: staged.draft.revision,
      scenes: [structuredClone(pendingScenes[0]!)],
    });

    expect(result).toMatchObject({
      status: "script_chunk_appended",
      persisted: true,
      draftRevision: 2,
      acceptedSceneCount: 8,
      requestedSceneCount: 8,
      authoringProgress: {
        completedSceneCount: 24,
        nextSceneNumber: 25,
        nextSceneEnd: 32,
      },
    });
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
    const accepted = draftScenes(await state.getEpisodeScriptDraft(episodeId));
    expect(accepted).toHaveLength(24);
    expect(accepted[0]!.supportingEntities).toEqual([legacyBoboDescriptor]);
    expect(accepted[16]!.characterNames).toEqual(["Mia", "Bobo the Backpack"]);
    expect(accepted[16]!.action).toContain(
      "Bobo the Backpack nudges the brass lantern",
    );
    expect(accepted[16]!.sceneDetails).toContain(
      "Bobo the Backpack stays upright",
    );
    expect(`${accepted[16]!.action} ${accepted[16]!.sceneDetails}`)
      .not.toContain("Bobo Bobo the Backpack");
    expect(accepted.slice(17)).toEqual(pendingScenes.slice(1));
  });
});
