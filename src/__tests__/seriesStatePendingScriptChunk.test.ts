import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SeriesState } from "../state/seriesState.js";

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
    "Pending Chunk Stories",
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rejectedScenes(marker = "first") {
  return [
    { sceneNumber: 1, action: `Pip crosses the ${marker} stepping stone.` },
    { sceneNumber: 2, action: `Pip reaches the ${marker} berry patch.` },
  ];
}

function structuredIssues(marker = "first") {
  return [{
    code: "declared_figure_not_staged",
    sceneNumber: 1,
    field: "sceneDetails",
    path: "scenes.0.sceneDetails",
    message: `Pip needs exact staging in the ${marker} candidate.`,
    key: "[\"declared_figure_not_staged\",1,\"scenes.0.sceneDetails\"]",
    messages: [`Pip needs exact staging in the ${marker} candidate.`],
    occurrenceCount: 1,
    weight: 1,
  }];
}

function productionScript() {
  const narration =
    "Pip gently carries the bright berry across the sunny meadow while patient friends smile beside their cozy little clubhouse today.";
  return {
    title: "Promoted Berry Story",
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

describe("SeriesState pending rejected script chunks", () => {
  it("bootstraps, upserts, and reloads one exact rejected candidate with durable progress", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Episode 1", scenes: [] },
      { pass: false, issues: ["Continue authoring."] },
    );
    const scenes = rejectedScenes();
    const issues = structuredIssues();
    const issueFingerprint = digest(issues);

    const first = await state.upsertEpisodeScriptPendingChunk({
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "start",
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: scenes,
      structuredIssues: issues,
      issueFingerprint,
      consecutiveNoProgressAttempts: 1,
      totalCorrectionAttempts: 1,
    });

    expect(first).toMatchObject({
      episodeId,
      acceptedDraftRevision: 1,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "start",
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: scenes,
      structuredIssues: issues,
      issueFingerprint,
      consecutiveNoProgressAttempts: 1,
      totalCorrectionAttempts: 1,
    });
    expect(first.candidateDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.createdAt).not.toBe("");
    expect(first.updatedAt).not.toBe("");
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toEqual(first);

    const replacementScenes = rejectedScenes("revised");
    const replacementIssues = structuredIssues("revised");
    const replacementFingerprint = digest(replacementIssues);
    const replaced = await state.upsertEpisodeScriptPendingChunk({
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "append",
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: replacementScenes,
      structuredIssues: replacementIssues,
      issueFingerprint: replacementFingerprint,
      consecutiveNoProgressAttempts: 0,
      totalCorrectionAttempts: 2,
      expectedPendingCandidateDigest: first.candidateDigest,
      expectedPendingIssueFingerprint: first.issueFingerprint,
      expectedPendingTotalCorrectionAttempts: first.totalCorrectionAttempts,
    });
    expect(replaced).toMatchObject({
      operation: "append",
      candidateScenes: replacementScenes,
      structuredIssues: replacementIssues,
      issueFingerprint: replacementFingerprint,
      consecutiveNoProgressAttempts: 0,
      totalCorrectionAttempts: 2,
      createdAt: first.createdAt,
    });
    const rows = await stateClient(state).execute(
      "SELECT COUNT(*) AS count FROM episode_script_pending_chunks",
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
  });

  it("rejects malformed ranges, issue payloads, digests, and progress counters", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Episode 1", scenes: [] },
    );
    const valid = {
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "start" as const,
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes(),
      structuredIssues: structuredIssues(),
      issueFingerprint: digest(structuredIssues()),
    };

    await expect(state.upsertEpisodeScriptPendingChunk({
      ...valid,
      sceneEnd: 3,
    })).rejects.toThrow("exactly fill");
    await expect(state.upsertEpisodeScriptPendingChunk({
      ...valid,
      structuredIssues: [],
    })).rejects.toThrow("non-empty array of objects");
    await expect(state.upsertEpisodeScriptPendingChunk({
      ...valid,
      issueFingerprint: "not-a-digest",
    })).rejects.toThrow("lowercase SHA-256");
    await expect(state.upsertEpisodeScriptPendingChunk({
      ...valid,
      expectedPendingCandidateDigest: digest(rejectedScenes()),
    })).rejects.toThrow("must be supplied together");
    await expect(state.upsertEpisodeScriptPendingChunk({
      ...valid,
      consecutiveNoProgressAttempts: 2,
      totalCorrectionAttempts: 1,
    })).rejects.toThrow("cannot exceed");
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
  });

  it("does not let a stale or blind correction overwrite a newer pending candidate", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Episode 1", scenes: [] },
    );
    const firstIssues = structuredIssues("first");
    const first = await state.upsertEpisodeScriptPendingChunk({
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "append",
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes("first"),
      structuredIssues: firstIssues,
      issueFingerprint: digest(firstIssues),
      totalCorrectionAttempts: 1,
    });
    const newerIssues = structuredIssues("newer");
    const newerInput = {
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "append" as const,
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes("newer"),
      structuredIssues: newerIssues,
      issueFingerprint: digest(newerIssues),
      totalCorrectionAttempts: 2,
      expectedPendingCandidateDigest: first.candidateDigest,
      expectedPendingIssueFingerprint: first.issueFingerprint,
      expectedPendingTotalCorrectionAttempts: first.totalCorrectionAttempts,
    };
    const newer = await state.upsertEpisodeScriptPendingChunk(newerInput);

    const staleIssues = structuredIssues("stale");
    await expect(state.upsertEpisodeScriptPendingChunk({
      ...newerInput,
      candidateScenes: rejectedScenes("stale"),
      structuredIssues: staleIssues,
      issueFingerprint: digest(staleIssues),
    })).rejects.toThrow("pending chunk conflict");
    await expect(state.upsertEpisodeScriptPendingChunk({
      ...newerInput,
      candidateScenes: rejectedScenes("blind"),
      structuredIssues: structuredIssues("blind"),
      issueFingerprint: digest(structuredIssues("blind")),
      expectedPendingCandidateDigest: undefined,
      expectedPendingIssueFingerprint: undefined,
      expectedPendingTotalCorrectionAttempts: undefined,
    })).rejects.toThrow("pending chunk conflict");
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toEqual(newer);

    // If a caller lost the successful response, replaying the exact completed
    // write is idempotent even though its old CAS precondition no longer wins.
    await expect(state.upsertEpisodeScriptPendingChunk(newerInput)).resolves.toEqual(newer);
  });

  it("uses the monotonic attempt counter to prevent an ABA pending-row overwrite", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Episode 1", scenes: [] },
    );
    const firstIssues = structuredIssues("first");
    const common = {
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "append" as const,
      sceneStart: 1,
      sceneEnd: 2,
    };
    const first = await state.upsertEpisodeScriptPendingChunk({
      ...common,
      candidateScenes: rejectedScenes("first"),
      structuredIssues: firstIssues,
      issueFingerprint: digest(firstIssues),
      totalCorrectionAttempts: 1,
    });
    const middleIssues = structuredIssues("middle");
    const middle = await state.upsertEpisodeScriptPendingChunk({
      ...common,
      candidateScenes: rejectedScenes("middle"),
      structuredIssues: middleIssues,
      issueFingerprint: digest(middleIssues),
      totalCorrectionAttempts: 2,
      expectedPendingCandidateDigest: first.candidateDigest,
      expectedPendingIssueFingerprint: first.issueFingerprint,
      expectedPendingTotalCorrectionAttempts: first.totalCorrectionAttempts,
    });
    const backToFirst = await state.upsertEpisodeScriptPendingChunk({
      ...common,
      candidateScenes: rejectedScenes("first"),
      structuredIssues: firstIssues,
      issueFingerprint: digest(firstIssues),
      totalCorrectionAttempts: 3,
      expectedPendingCandidateDigest: middle.candidateDigest,
      expectedPendingIssueFingerprint: middle.issueFingerprint,
      expectedPendingTotalCorrectionAttempts: middle.totalCorrectionAttempts,
    });

    await expect(state.upsertEpisodeScriptPendingChunk({
      ...common,
      candidateScenes: rejectedScenes("stale-after-aba"),
      structuredIssues: structuredIssues("stale-after-aba"),
      issueFingerprint: digest(structuredIssues("stale-after-aba")),
      totalCorrectionAttempts: 2,
      expectedPendingCandidateDigest: first.candidateDigest,
      expectedPendingIssueFingerprint: first.issueFingerprint,
      expectedPendingTotalCorrectionAttempts: first.totalCorrectionAttempts,
    })).rejects.toThrow("pending chunk conflict");
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toEqual(backToFirst);
  });

  it("invalidates the candidate atomically when the accepted draft advances and rejects stale writes", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Episode 1", scenes: [] },
    );
    const issues = structuredIssues();
    const pendingInput = {
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "append" as const,
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes(),
      structuredIssues: issues,
      issueFingerprint: digest(issues),
    };
    await state.upsertEpisodeScriptPendingChunk(pendingInput);

    const revised = await state.reviseEpisodeScriptDraft(
      episodeId,
      staged.draft.revision,
      { title: "Episode 1", scenes: rejectedScenes() },
      { pass: false, issues: ["Continue authoring."] },
    );
    expect(revised.revision).toBe(staged.draft.revision + 1);
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();

    await expect(state.upsertEpisodeScriptPendingChunk(pendingInput))
      .rejects.toThrow("pending chunk revision conflict");
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
  });

  it("supports guarded clearing and clears repair state with explicit draft deletion", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Episode 1", scenes: [] },
    );
    const issues = structuredIssues();
    const issueFingerprint = digest(issues);
    const input = {
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "start" as const,
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes(),
      structuredIssues: issues,
      issueFingerprint,
    };
    await state.upsertEpisodeScriptPendingChunk(input);

    expect(await state.clearEpisodeScriptPendingChunk({
      episodeId,
      expectedIssueFingerprint: "0".repeat(64),
    })).toBe(false);
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).not.toBeNull();
    expect(await state.clearEpisodeScriptPendingChunk({
      episodeId,
      expectedAcceptedDraftRevision: staged.draft.revision,
      expectedAcceptedDraftDigest: staged.draft.contentDigest,
      expectedIssueFingerprint: issueFingerprint,
    })).toBe(true);
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();

    await state.upsertEpisodeScriptPendingChunk(input);
    await state.deleteEpisodeScriptDraft(episodeId);
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
    expect(await state.getEpisodeScriptDraft(episodeId)).toBeNull();
  });

  it("cascades pending repair state when its owning episode is deleted", async () => {
    const { state, episodeId } = await createStateWithEpisode();
    const staged = await state.stageEpisodeScriptDraft(
      episodeId,
      { title: "Episode 1", scenes: [] },
    );
    const issues = structuredIssues();
    await state.upsertEpisodeScriptPendingChunk({
      episodeId,
      acceptedDraftRevision: staged.draft.revision,
      acceptedDraftDigest: staged.draft.contentDigest,
      operation: "start",
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes(),
      structuredIssues: issues,
      issueFingerprint: digest(issues),
    });

    await stateClient(state).execute({
      sql: "DELETE FROM episodes WHERE id = ?",
      args: [episodeId],
    });
    expect(await state.getEpisodeScriptPendingChunk(episodeId)).toBeNull();
  });

  it("clears rejected candidates during production promotion and completed-episode cleanup", async () => {
    const promotion = await createStateWithEpisode();
    const source = await promotion.state.stageEpisodeScriptDraft(
      promotion.episodeId,
      { title: "Private source", scenes: [] },
      { pass: false, issues: ["Needs scenes."] },
    );
    const promotionIssues = structuredIssues();
    await promotion.state.upsertEpisodeScriptPendingChunk({
      episodeId: promotion.episodeId,
      acceptedDraftRevision: source.draft.revision,
      acceptedDraftDigest: source.draft.contentDigest,
      operation: "start",
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes(),
      structuredIssues: promotionIssues,
      issueFingerprint: digest(promotionIssues),
    });
    await expect(promotion.state.promoteEpisodeScriptDraft({
      episodeId: promotion.episodeId,
      expectedRevision: source.draft.revision,
      expectedContentDigest: source.draft.contentDigest,
      scriptJson: productionScript(),
    })).resolves.toMatchObject({ status: "promoted" });
    expect(await promotion.state.getEpisodeScriptPendingChunk(promotion.episodeId)).toBeNull();

    const completion = await createStateWithEpisode();
    const completionDraft = await completion.state.stageEpisodeScriptDraft(
      completion.episodeId,
      { title: "Private source", scenes: [] },
    );
    const completionIssues = structuredIssues("completion");
    await completion.state.upsertEpisodeScriptPendingChunk({
      episodeId: completion.episodeId,
      acceptedDraftRevision: completionDraft.draft.revision,
      acceptedDraftDigest: completionDraft.draft.contentDigest,
      operation: "append",
      sceneStart: 1,
      sceneEnd: 2,
      candidateScenes: rejectedScenes("completion"),
      structuredIssues: completionIssues,
      issueFingerprint: digest(completionIssues),
    });
    await stateClient(completion.state).execute({
      sql: `UPDATE episodes
            SET status = 'done', uploaded_at = '2026-09-12T01:00:00.000Z',
                completed_at = '2026-09-12T01:00:00.000Z',
                completion_local_date = '2026-09-12',
                youtube_video_id = 'video-1', youtube_url = 'https://example.test/video-1'
            WHERE id = ?`,
      args: [completion.episodeId],
    });
    await completion.state.cleanupUploadedEpisodeTracking(completion.seriesId, 1);
    expect(await completion.state.getEpisodeScriptPendingChunk(completion.episodeId)).toBeNull();
  });
});
