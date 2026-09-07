import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_EPISODE_SCRIPT_DRAFT_DURATION_EVIDENCE,
  MAX_EPISODE_SCRIPT_DRAFT_VALIDATION_ISSUES,
  MAX_EPISODE_SCRIPT_DRAFT_VALIDATION_ISSUE_CHARACTERS,
  SeriesState,
} from "../state/seriesState.js";

const openStates: SeriesState[] = [];

function stateClient(state: SeriesState): {
  execute(
    statement: string | { sql: string; args: unknown[] },
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
} {
  return (state as unknown as { client: ReturnType<typeof stateClient> }).client;
}

async function createStateWithEpisode(): Promise<{
  state: SeriesState;
  seriesId: number;
  episodeId: number;
}> {
  const state = new SeriesState("file::memory:", "");
  openStates.push(state);
  const seriesId = await state.getOrCreateSeries(
    "Draft Persistence Stories",
    [{ name: "Pip", description: "A curious red ant." }],
    [{ name: "Meadow", description: "A warm wildflower meadow." }],
    "Friends solve one gentle problem together.",
  );
  await state.bulkInsertEpisodesIfEmpty(
    seriesId,
    Array.from({ length: 25 }, (_unused, index) => ({
      episodeNumber: index + 1,
      title: `Episode ${index + 1}`,
      premise: `Pip solves gentle problem ${index + 1}.`,
    })),
  );
  const episode = await state.getEpisodeByNumber(seriesId, 1);
  if (!episode) throw new Error("Test episode was not created.");
  return { state, seriesId, episodeId: episode.id };
}

function productionScript(label = "Promoted") {
  const narration =
    "Pip gently carries the bright berry across the sunny meadow while patient friends smile beside their cozy little clubhouse today.";
  return {
    title: `${label} Berry Story`,
    premise: "Pip carries one berry home.",
    scenes: Array.from({ length: 40 }, (_unused, index) => ({
      sceneNumber: index + 1,
      narrationText: narration,
      environmentDescription: "A sunny green meadow beside the little wooden clubhouse.",
      action: `Pip takes careful step ${index + 1} while carrying the berry.`,
      characterNames: ["Pip"],
      characterVisuals: [{
        name: "Pip",
        visualForm: "real_creature",
        speciesOrType: "ant",
        humanoidAllowed: false,
      }],
      supportingEntities: ["Ladybug friend: tiny red ladybug with seven round black spots"],
      continuityAnchors: ["Berry: one glossy raspberry-red berry held above the short grass"],
      sceneDetails: `Pip and Ladybug friend remain visible at distinct meadow marker ${index + 1} beside the berry and clubhouse.`,
      cameraAngle: "medium wide shot at child eye level",
      lighting: "warm soft morning sunlight",
    })),
  };
}

afterEach(async () => {
  await Promise.all(openStates.splice(0).map((state) => state.close()));
});

describe("SeriesState episode script drafts", () => {
  it("stages one canonical draft idempotently and bounds validation metadata", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const script = {
      title: "Pip and the Berry",
      premise: "Pip carries one berry home.",
      scenes: [{
        sceneNumber: 1,
        action: "Pip lifts the berry.",
        framing: { lighting: "warm", camera: "wide" },
      }],
    };
    const longIssue = "x".repeat(400);
    const validation = {
      pass: false,
      sceneCount: 1,
      totalSpokenWords: 8,
      issueCount: 25,
      omittedIssueCount: 3,
      issues: Array.from({ length: 20 }, (_unused, index) => `${index}-${longIssue}`),
      repairEvidence: {
        durationExceededScenes: Array.from({ length: 75 }, (_unused, index) => ({
          sceneNumber: index + 1,
          durationSeconds: 12.25 + index / 100,
        })),
        measuredTotalNarrationSeconds: 281.375,
        measuredNarrationSceneCount: 1,
        measuredNarrationRecoveryWordTarget: 825,
      },
      ignoredLargeField: "not persisted",
    };

    const first = await state.stageEpisodeScriptDraft(episodeId, script, validation);
    expect(first.created).toBe(true);
    expect(first.matches).toBe(true);
    expect(first.draft).toMatchObject({
      episodeId,
      revision: 1,
      scriptJson: script,
      validation: {
        pass: false,
        sceneCount: 1,
        totalSpokenWords: 8,
        issueCount: 25,
        omittedIssueCount: 13,
      },
    });
    expect(first.draft.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.draft.validation?.issues).toHaveLength(
      MAX_EPISODE_SCRIPT_DRAFT_VALIDATION_ISSUES,
    );
    expect(first.draft.validation?.issues[0]).toHaveLength(
      MAX_EPISODE_SCRIPT_DRAFT_VALIDATION_ISSUE_CHARACTERS,
    );
    expect(first.draft.validation?.repairEvidence).toMatchObject({
      measuredTotalNarrationSeconds: 281.375,
      measuredNarrationSceneCount: 1,
    });
    expect(first.draft.validation?.repairEvidence).not.toHaveProperty(
      "measuredNarrationRecoveryWordTarget",
    );
    expect(first.draft.validation?.repairEvidence?.durationExceededScenes).toHaveLength(
      MAX_EPISODE_SCRIPT_DRAFT_DURATION_EVIDENCE,
    );
    expect(first.draft.validation?.repairEvidence?.durationExceededScenes?.at(-1)).toEqual({
      sceneNumber: MAX_EPISODE_SCRIPT_DRAFT_DURATION_EVIDENCE,
      durationSeconds: 12.25 + (MAX_EPISODE_SCRIPT_DRAFT_DURATION_EVIDENCE - 1) / 100,
    });

    const reorderedScript = {
      scenes: [{
        framing: { camera: "wide", lighting: "warm" },
        action: "Pip lifts the berry.",
        sceneNumber: 1,
      }],
      premise: "Pip carries one berry home.",
      title: "Pip and the Berry",
    };
    const repeated = await state.stageEpisodeScriptDraft(
      episodeId,
      reorderedScript,
      { pass: true, issues: [] },
    );
    expect(repeated).toMatchObject({ created: false, matches: true });
    expect(repeated.draft.revision).toBe(1);
    expect(repeated.draft.contentDigest).toBe(first.draft.contentDigest);
    expect(repeated.draft.validation).toEqual(first.draft.validation);

    const conflictingStage = await state.stageEpisodeScriptDraft(
      episodeId,
      { ...script, title: "A Different Draft" },
    );
    expect(conflictingStage).toMatchObject({ created: false, matches: false });
    expect(conflictingStage.draft.scriptJson).toEqual(script);

    expect(await state.getEpisodeScriptDraft(episodeId)).toEqual(first.draft);
    expect(await state.getEpisodeById(episodeId)).toMatchObject({
      id: episodeId,
      seriesId: expect.any(Number),
      episodeNumber: 1,
    });

    const storedValidation = await stateClient(state).execute({
      sql: "SELECT validation_json FROM episode_script_drafts WHERE episode_id = ?",
      args: [episodeId],
    });
    expect(String(storedValidation.rows[0]?.validation_json).length).toBeLessThanOrEqual(8192);
  });

  it("drops zero, incomplete, and legacy recovery timing evidence", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Timing Evidence", scenes: [] },
      {
        pass: false,
        issues: ["Bad timing evidence must not drive repair."],
        repairEvidence: {
          measuredTotalNarrationSeconds: 0,
          measuredNarrationSceneCount: 40,
          measuredNarrationRecoveryWordTarget: 1_200,
        },
      },
    );

    expect(staged.draft.validation?.repairEvidence).toBeUndefined();

    const incomplete = await state.reviseEpisodeScriptDraft(
      episodeId,
      staged.draft.revision,
      staged.draft.scriptJson,
      {
        pass: false,
        issues: ["A positive total without a measured scene count is incomplete."],
        repairEvidence: { measuredTotalNarrationSeconds: 280 },
      },
    );
    expect(incomplete.validation?.repairEvidence).toBeUndefined();
  });

  it("revises with a revision CAS, supports retry idempotency, and deletes idempotently", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Draft 1", scenes: [] },
      { pass: false, issues: ["Add scenes."] },
    );

    const revisedScript = { title: "Draft 2", scenes: [{ sceneNumber: 1 }] };
    const revisionTwo = await state.reviseEpisodeScriptDraft(
      episodeId,
      1,
      revisedScript,
      { pass: true, issues: [] },
    );
    expect(revisionTwo).toMatchObject({
      episodeId,
      revision: 2,
      scriptJson: revisedScript,
      validation: { pass: true, issueCount: 0, issues: [] },
    });

    // A client retrying after losing the first response gets the committed row
    // even though its expected revision is now stale.
    const repeated = await state.reviseEpisodeScriptDraft(
      episodeId,
      1,
      revisedScript,
      { pass: true, issues: [] },
    );
    expect(repeated).toEqual(revisionTwo);

    await expect(state.reviseEpisodeScriptDraft(
      episodeId,
      1,
      { title: "Conflicting Draft", scenes: [] },
      { pass: false, issues: ["Conflict"] },
    )).rejects.toThrow("revision conflict");

    // Validation is part of a revision, while the script digest remains a
    // content identity for the complete script JSON only.
    const revisionThree = await state.reviseEpisodeScriptDraft(
      episodeId,
      2,
      revisedScript,
      { pass: false, issues: ["Recheck continuity."] },
    );
    expect(revisionThree.revision).toBe(3);
    expect(revisionThree.contentDigest).toBe(revisionTwo.contentDigest);
    expect(revisionThree.validation).toMatchObject({
      pass: false,
      issueCount: 1,
      issues: ["Recheck continuity."],
    });

    await state.deleteEpisodeScriptDraft(episodeId);
    await state.deleteEpisodeScriptDraft(episodeId);
    expect(await state.getEpisodeScriptDraft(episodeId)).toBeNull();
  });

  it("rejects drafts for missing or completed episodes", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    await expect(state.stageEpisodeScriptDraft(999_999, { title: "Missing" }))
      .rejects.toThrow("was not found");

    await stateClient(state).execute({
      sql: `UPDATE episodes
            SET status = 'done', uploaded_at = '2026-09-05T01:00:00.000Z',
                youtube_video_id = 'finished-id', youtube_url = 'https://example.test/finished'
            WHERE id = ?`,
      args: [episodeId],
    });
    await expect(state.stageEpisodeScriptDraft(episodeId, { title: "Too Late" }))
      .rejects.toThrow("completed episode");
  });

  it("treats a staged draft as resumable work across the daily gate", async () => {
    const { state, seriesId, episodeId } = await createStateWithEpisode();
    const secondEpisode = await state.getEpisodeByNumber(seriesId, 2);
    if (!secondEpisode) throw new Error("Second test episode was not created.");
    await state.stageEpisodeScriptDraft(
      secondEpisode.id,
      { title: "Episode 2 Draft", scenes: [] },
      { pass: false, issues: ["Continue refinement."] },
    );
    await stateClient(state).execute({
      sql: `UPDATE episodes
            SET status = 'done', uploaded_at = '2026-09-05T01:00:00.000Z',
                completed_at = '2026-09-05T01:00:00.000Z',
                completion_local_date = '2026-09-05',
                youtube_video_id = 'episode-1', youtube_url = 'https://example.test/episode-1'
            WHERE id = ?`,
      args: [episodeId],
    });

    expect(await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-05T02:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).toMatchObject({
      kind: "ready",
      episode: { id: secondEpisode.id, episodeNumber: 2 },
    });

    await state.deleteEpisodeScriptDraft(secondEpisode.id);
    expect(await state.getNextEpisodeAvailability(seriesId, {
      now: new Date("2026-09-05T02:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).toMatchObject({ kind: "daily_limit", episode: null });
  });

  it("atomically blocks draft creation and revision after Agnes submission starts", async () => {
    const { state, seriesId, episodeId } = await createStateWithEpisode();
    await state.upsertAgnesSceneGeneration({
      seriesId,
      episodeNumber: 1,
      sceneNumber: 1,
      variant: "text",
      status: "pending",
      prompt: "Pip crosses the meadow.",
      requestedDurationSeconds: 8,
      providerDurationSeconds: 8,
    });

    // A materialized prompt alone is reversible, so authoring can still move.
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Before Submission", scenes: [] },
    );
    const revised = await state.reviseEpisodeScriptDraft(
      episodeId,
      staged.draft.revision,
      { title: "Still Before Submission", scenes: [] },
    );
    expect(revised.revision).toBe(2);

    await state.upsertAgnesSceneGeneration({
      seriesId,
      episodeNumber: 1,
      sceneNumber: 1,
      variant: "text",
      status: "submitted",
      prompt: "Pip crosses the meadow.",
      requestDigest: "submitted-request",
      attemptCount: 1,
      requestedDurationSeconds: 8,
      providerDurationSeconds: 8,
      providerReceipt: { state: "submitting", claimToken: "claim-1" },
      submittedAt: "2026-09-05T01:00:00.000Z",
    });

    await expect(state.reviseEpisodeScriptDraft(
      episodeId,
      revised.revision,
      { title: "Unsafe Replacement", scenes: [] },
    )).rejects.toThrow("after Agnes submission has started");
    expect(await state.getEpisodeScriptDraft(episodeId)).toEqual(revised);

    // Creation is guarded by the same atomic provider-state predicate.
    await state.deleteEpisodeScriptDraft(episodeId);
    await expect(state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Unsafe New Draft", scenes: [] },
    )).rejects.toThrow("after Agnes submission has started");
    expect(await state.getEpisodeScriptDraft(episodeId)).toBeNull();
  });

  it("atomically promotes an exact draft and invalidates only pre-submission artifacts", async () => {
    const { state, seriesId, episodeId } = await createStateWithEpisode();
    const source = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Private source", scenes: [] },
      { pass: false, issues: ["Needs refinement."] },
    );
    await stateClient(state).execute({
      sql: "UPDATE episodes SET status = 'assembly', output_path = '/tmp/stale.mp4' WHERE id = ?",
      args: [episodeId],
    });
    await state.upsertAgnesSceneGeneration({
      seriesId,
      episodeNumber: 1,
      sceneNumber: 1,
      variant: "text",
      status: "pending",
      prompt: "A reversible prompt prepared before promotion.",
      requestedDurationSeconds: 8,
      providerDurationSeconds: 8,
    });
    await state.upsertEpisodeVideoOutput({
      seriesId,
      episodeNumber: 1,
      variant: "agnes_text",
      status: "pending",
    });

    const promotedScript = productionScript();
    await expect(state.promoteEpisodeScriptDraft({
      episodeId,
      expectedRevision: source.draft.revision,
      expectedContentDigest: source.draft.contentDigest,
      scriptJson: promotedScript,
    })).resolves.toEqual({
      status: "promoted",
      episodeId,
      sourceDraft: {
        revision: source.draft.revision,
        contentDigest: source.draft.contentDigest,
      },
    });

    expect(await state.getEpisodeById(episodeId)).toMatchObject({
      status: "script",
      scriptJson: promotedScript,
      outputPath: null,
    });
    expect(await state.getEpisodeScriptDraft(episodeId)).toBeNull();
    expect(await state.listAgnesSceneGenerations(seriesId, 1)).toEqual([]);
    expect(await state.listEpisodeVideoOutputs(seriesId, 1)).toEqual([]);
  });

  it("returns stale without publishing or deleting a newer draft revision", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const first = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Revision 1", scenes: [] },
    );
    const newer = await state.reviseEpisodeScriptDraft(
      episodeId,
      first.draft.revision,
      { title: "Revision 2", scenes: [] },
    );

    await expect(state.promoteEpisodeScriptDraft({
      episodeId,
      expectedRevision: first.draft.revision,
      expectedContentDigest: first.draft.contentDigest,
      scriptJson: productionScript("Stale"),
    })).resolves.toEqual({
      status: "stale",
      episodeId,
      expectedDraft: {
        revision: first.draft.revision,
        contentDigest: first.draft.contentDigest,
      },
      currentDraft: {
        revision: newer.revision,
        contentDigest: newer.contentDigest,
      },
    });

    expect(await state.getEpisodeById(episodeId)).toMatchObject({
      status: "pending",
      scriptJson: null,
    });
    expect(await state.getEpisodeScriptDraft(episodeId)).toEqual(newer);
  });

  it("returns blocked and preserves all state when Agnes submission already started", async () => {
    const { state, seriesId, episodeId } = await createStateWithEpisode();
    const source = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Locked source", scenes: [] },
    );
    await state.upsertAgnesSceneGeneration({
      seriesId,
      episodeNumber: 1,
      sceneNumber: 1,
      variant: "text",
      status: "submitted",
      prompt: "A provider-bound prompt.",
      requestDigest: "locked-request",
      attemptCount: 1,
      requestedDurationSeconds: 8,
      providerDurationSeconds: 8,
      providerReceipt: { state: "submitting", claimToken: "locked-claim" },
      submittedAt: "2026-09-05T01:00:00.000Z",
    });

    await expect(state.promoteEpisodeScriptDraft({
      episodeId,
      expectedRevision: source.draft.revision,
      expectedContentDigest: source.draft.contentDigest,
      scriptJson: productionScript("Blocked"),
    })).resolves.toEqual({
      status: "blocked",
      episodeId,
      sourceDraft: {
        revision: source.draft.revision,
        contentDigest: source.draft.contentDigest,
      },
      reason: "agnes_started",
    });

    expect(await state.getEpisodeById(episodeId)).toMatchObject({
      status: "pending",
      scriptJson: null,
    });
    expect(await state.getEpisodeScriptDraft(episodeId)).toEqual(source.draft);
    expect(await state.listAgnesSceneGenerations(seriesId, 1)).toHaveLength(1);
  });

  it("rolls back the production write when artifact invalidation fails", async () => {
    const { state, seriesId, episodeId } = await createStateWithEpisode();
    const source = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Rollback source", scenes: [] },
    );
    await state.upsertEpisodeVideoOutput({
      seriesId,
      episodeNumber: 1,
      variant: "agnes_text",
      status: "pending",
    });
    await stateClient(state).execute(
      `CREATE TRIGGER fail_script_promotion_invalidation
       BEFORE DELETE ON episode_video_outputs
       BEGIN
         SELECT RAISE(ABORT, 'forced invalidation failure');
       END`,
    );

    await expect(state.promoteEpisodeScriptDraft({
      episodeId,
      expectedRevision: source.draft.revision,
      expectedContentDigest: source.draft.contentDigest,
      scriptJson: productionScript("Rollback"),
    })).rejects.toThrow("forced invalidation failure");

    expect(await state.getEpisodeById(episodeId)).toMatchObject({
      status: "pending",
      scriptJson: null,
    });
    expect(await state.getEpisodeScriptDraft(episodeId)).toEqual(source.draft);
    expect(await state.listEpisodeVideoOutputs(seriesId, 1)).toHaveLength(1);
  });
});
