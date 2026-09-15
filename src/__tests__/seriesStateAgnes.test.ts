import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG } from "../config.js";
import {
  canonicalEpisodeScriptJson,
  EpisodeAudioReadinessError,
  SeriesState,
} from "../state/seriesState.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  agnesKeyArtPaths,
} from "../services/agnesKeyArtService.js";
import {
  AGNES_STATIC_VIDEO_QA_MODEL,
  AGNES_STATIC_VIDEO_QA_PIPELINE,
  AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION,
  AGNES_STATIC_VIDEO_QA_POLICY_VERSION,
  createAgnesStaticEpisodeAssetSetDigest,
  createAgnesStaticVideoQaRequestDigest,
  currentAgnesStaticVideoQaPolicyDigest,
} from "../services/agnesStaticVideoQaService.js";
import {
  NARRATION_METADATA_KIND,
  NARRATION_METADATA_SCHEMA_VERSION,
  buildTtsTool,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
} from "../tools/ttsTool.js";

const openStates: SeriesState[] = [];
const AGNES_VIDEO_QA_POLICY_VERSION = 3;
const AGNES_VIDEO_QA_PIPELINE = "retired_test_cascade";
const AGNES_VIDEO_QA_PIPELINE_VERSION = 1;
const LEGACY_SCREENING_MODEL = "retired-screening-model";
const LEGACY_ESCALATION_MODEL = "retired-escalation-model";
const currentAgnesVideoQaPolicyDigest = () => createHash("sha256")
  .update("retired-test-cascade-policy")
  .digest("hex");

async function createStateWithEpisode(): Promise<SeriesState> {
  const state = new SeriesState("file::memory:", "");
  openStates.push(state);
  const client = (state as unknown as { client: { execute(sql: string): Promise<unknown> } }).client;
  await client.execute(`
    CREATE TABLE series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      concept_name TEXT NOT NULL UNIQUE,
      characters_json TEXT NOT NULL DEFAULT '[{"name":"Pip the Ant","description":"A small red ant."}]'
    )
  `);
  await client.execute(`
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      episode_number INTEGER NOT NULL,
      UNIQUE (series_id, episode_number)
    )
  `);
  await client.execute("INSERT INTO series (id, concept_name) VALUES (1, 'Test Series')");
  await client.execute("INSERT INTO episodes (series_id, episode_number) VALUES (1, 2)");
  return state;
}

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
      sceneDetails: "Pip the Ant remains fully visible beside the same berry and clubhouse while Ladybug friend watches warmly.",
      cameraAngle: "medium wide shot at child eye level",
      lighting: "warm soft morning sunlight",
    })),
  };
}

afterEach(async () => {
  await Promise.all(openStates.splice(0).map((state) => state.close()));
});

describe("SeriesState Agnes persistence", () => {
  it("classifies a missing narration artifact as a typed recoverable audio failure", async () => {
    const state = await createStateWithEpisode();
    const previousOutputDir = CONFIG.outputDir;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "audio-readiness-missing-"));
    (CONFIG as { outputDir: string }).outputDir = outputDir;

    try {
      await state.updateEpisodeStatus(1, "script", { scriptJson: productionScript() });
      const failure = await state.assertEpisodeAudioReady(1).catch((error) => error);

      expect(failure).toBeInstanceOf(EpisodeAudioReadinessError);
      expect(failure).toMatchObject({
        reason: "artifact_missing_or_stale",
        sceneNumber: 1,
      });
    } finally {
      (CONFIG as { outputDir: string }).outputDir = previousOutputDir;
    }
  });

  it("audits a metadata-tolerant 12-second crossover from the fresh measured duration", async () => {
    const state = await createStateWithEpisode();
    const previousOutputDir = CONFIG.outputDir;
    const previousFfprobePath = CONFIG.ffprobePath;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "audio-audit-boundary-"));
    const fakeProbe = path.join(outputDir, "fake-ffprobe.sh");
    await writeFile(fakeProbe, "#!/bin/sh\nprintf '12.02\\n'\n", "utf8");
    await chmod(fakeProbe, 0o755);
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    (CONFIG as { ffprobePath: string }).ffprobePath = fakeProbe;

    try {
      const narrationText =
        "Pip carries the bright berry while patient friends smile beside their little clubhouse.";
      const script = {
        title: "Boundary Check",
        scenes: [{ sceneNumber: 1, narrationText }],
      };
      const narrationPath = path.join(
        outputDir,
        "series_1",
        "episode_2",
        "audio",
        "scene_001_narrator.wav",
      );
      await mkdir(path.dirname(narrationPath), { recursive: true });
      await writeFile(narrationPath, "boundary-wave", "utf8");
      await writeFile(narrationAudioMetadataPath(narrationPath), JSON.stringify({
        schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
        kind: NARRATION_METADATA_KIND,
        requestDigest: createNarrationAudioRequestDigest({
          text: narrationText,
          model: CONFIG.groqTtsModel,
          voice: CONFIG.groqTtsVoice,
        }),
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
        responseFormat: "wav",
        textLength: narrationText.length,
        spokenWordCount: 13,
        durationSeconds: 11.98,
        durationStatus: "ready",
      }), "utf8");

      const audit = await state.auditEpisodeNarrationAudioTiming(1, script);

      expect(audit).toEqual({
        complete: true,
        sceneCount: 1,
        verifiedSceneCount: 1,
        totalDurationSeconds: 12.02,
        durationExceededScenes: [{ sceneNumber: 1, durationSeconds: 12.02 }],
        invalidSceneNumbers: [],
      });
    } finally {
      (CONFIG as { outputDir: string }).outputDir = previousOutputDir;
      (CONFIG as { ffprobePath: string }).ffprobePath = previousFfprobePath;
    }
  });

  it("regenerates a reverse-boundary sidecar before SeriesState accepts episode audio", async () => {
    const state = await createStateWithEpisode();
    const previousOutputDir = CONFIG.outputDir;
    const previousFfprobePath = CONFIG.ffprobePath;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "audio-readiness-convergence-"));
    const fakeProbe = path.join(outputDir, "fake-ffprobe.sh");
    await writeFile(
      fakeProbe,
      "#!/bin/sh\ncase \"$*\" in\n*scene_001_narrator.wav*) printf '11.99\\n' ;;\n*) printf '7.5\\n' ;;\nesac\n",
      "utf8",
    );
    await chmod(fakeProbe, 0o755);
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    (CONFIG as { ffprobePath: string }).ffprobePath = fakeProbe;

    try {
      const script = productionScript();
      await state.updateEpisodeStatus(1, "script", { scriptJson: script });
      let sceneOneDuration = 12.01;
      let generationCount = 0;
      const tts = buildTtsTool({
        outputDir,
        audioGenerator: {
          invoke: async ({ outputPath }) => {
            generationCount += 1;
            await writeFile(outputPath, `wave-${generationCount}`, "utf8");
            return outputPath;
          },
        },
        probeDurationSeconds: async (filePath) =>
          filePath.includes("scene_001_") ? sceneOneDuration : 7.5,
        retryDelayMs: () => 0,
      });

      const first = JSON.parse(await (tts as any).func({
        seriesId: 1,
        episodeNumber: 2,
        sceneNumber: 1,
        text: script.scenes[0]!.narrationText,
      }));
      expect(first).toMatchObject({
        status: "duration_exceeded",
        readyForAgnes: false,
        reused: false,
        durationSeconds: 12.01,
      });

      sceneOneDuration = 11.99;
      const converged = JSON.parse(await (tts as any).func({
        seriesId: 1,
        episodeNumber: 2,
        sceneNumber: 1,
        text: script.scenes[0]!.narrationText,
      }));
      expect(converged).toMatchObject({
        status: "generated",
        readyForAgnes: true,
        reused: false,
        durationSeconds: 11.99,
      });

      for (const scene of script.scenes.slice(1)) {
        await (tts as any).func({
          seriesId: 1,
          episodeNumber: 2,
          sceneNumber: scene.sceneNumber,
          text: scene.narrationText,
        });
      }

      expect(generationCount).toBe(41);
      const readiness = await state.assertEpisodeAudioReady(1);
      expect(readiness.totalDurationSeconds).toBeCloseTo(304.49, 5);
    } finally {
      (CONFIG as { outputDir: string }).outputDir = previousOutputDir;
      (CONFIG as { ffprobePath: string }).ffprobePath = previousFfprobePath;
    }
  });

  it("classifies missing locked key-art title audio without regenerating it", async () => {
    const state = await createStateWithEpisode();
    const previousOutputDir = CONFIG.outputDir;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "key-art-audio-readiness-missing-"));
    (CONFIG as { outputDir: string }).outputDir = outputDir;

    try {
      await state.updateEpisodeStatus(1, "script", { scriptJson: productionScript() });
      const client = (state as unknown as {
        client: { execute(sql: string): Promise<unknown> };
      }).client;
      await client.execute("UPDATE episodes SET title = 'Test Episode' WHERE id = 1");
      const failure = await state.assertEpisodeKeyArtAudioReady(1, 2).catch((error) => error);

      expect(failure).toBeInstanceOf(EpisodeAudioReadinessError);
      expect(failure).toMatchObject({
        reason: "artifact_missing_or_stale",
        assetKind: "series_key_art",
      });
    } finally {
      (CONFIG as { outputDir: string }).outputDir = previousOutputDir;
    }
  });

  it("lazily adds request identity columns to an already-created Agnes table", async () => {
    const state = await createStateWithEpisode();
    const client = (state as unknown as { client: { execute(sql: string): Promise<{ rows: any[] }> } }).client;
    await client.execute(`
      CREATE TABLE agnes_scene_generations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        series_id INTEGER NOT NULL,
        episode_number INTEGER NOT NULL,
        scene_number INTEGER NOT NULL,
        variant TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        prompt TEXT NOT NULL,
        seed INTEGER,
        requested_duration_seconds REAL NOT NULL,
        provider_duration_seconds INTEGER NOT NULL,
        public_reference_url TEXT,
        provider_task_id TEXT,
        provider_receipt_json TEXT,
        provider_video_url TEXT,
        raw_output_path TEXT,
        normalized_output_path TEXT,
        error TEXT,
        submitted_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (series_id, episode_number, scene_number, variant)
      )
    `);

    expect(await state.getAgnesSceneGeneration(1, 2, 1, "text")).toBeNull();
    const columns = await client.execute("PRAGMA table_info('agnes_scene_generations')");
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toContain("request_digest");
    expect(names).toContain("attempt_count");
    expect(names).toContain("render_revision");
    expect(names).toContain("qa_status");
    expect(names).toContain("qa_video_sha256");

    const episodeColumns = await client.execute("PRAGMA table_info('episodes')");
    const episodeColumnNames = episodeColumns.rows.map((row) => String(row.name));
    expect(episodeColumnNames).toEqual(expect.arrayContaining([
      "audio_revision",
      "audio_mutation_token",
      "audio_mutation_scene_number",
      "audio_mutation_expires_at_ms",
    ]));
  });

  it("archives one QA-rejected completed render and permits exactly one CAS-controlled rerender", async () => {
    const state = await createStateWithEpisode();
    const directory = await mkdtemp(path.join(os.tmpdir(), "qa-requeue-state-"));
    const videoPath = path.join(directory, "scene_001.mp4");
    await writeFile(videoPath, "rejected-video");
    const originalDigest = "1".repeat(64);
    await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      status: "completed",
      downloadStatus: "downloaded",
      prompt: "Original prompt",
      requestDigest: originalDigest,
      attemptCount: 1,
      seed: 100,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      providerTaskId: "provider-task-1",
      providerReceipt: { accepted: true, task: "provider-task-1" },
      normalizedOutputPath: videoPath,
    });
    await state.upsertEpisodeVideoOutput({
      seriesId: 1,
      episodeNumber: 2,
      variant: "agnes_text",
      status: "completed",
      outputPath: path.join(directory, "old-final.mp4"),
      durationSeconds: 6,
    });
    const client = (state as unknown as {
      client: { execute(statement: string | { sql: string; args: unknown[] }): Promise<{ rows: any[] }> };
    }).client;
    await client.execute("UPDATE episodes SET status = 'assembly' WHERE id = 1");
    const requeued = await state.requeueAgnesSceneAfterQaFailure({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      expectedRequestDigest: originalDigest,
      expectedRenderRevision: 0,
      expectedNormalizedOutputPath: videoPath,
      expectedQaStatus: "pending",
      expectedQaRequestDigest: null,
      qaRequestDigest: "2".repeat(64),
      videoSha256: createHash("sha256").update("rejected-video").digest("hex"),
      result: {
        pass: false,
        issues: [{ code: "duplicate_entity", description: "Pip appears twice." }],
      },
      contactSheetPath: path.join(directory, "sheet.jpg"),
      model: "openai/gpt-5-image",
      retryPrompt: "Original prompt QA RERENDER CORRECTION",
      retryRequestDigest: "3".repeat(64),
      retrySeed: 200,
      archivedVideoPath: path.join(directory, "rejected-copy.mp4"),
    });

    expect(requeued.requeued).toBe(true);
    expect(requeued.row).toMatchObject({
      status: "pending",
      downloadStatus: "pending",
      renderRevision: 1,
      qaStatus: "awaiting_regeneration",
      providerTaskId: null,
      normalizedOutputPath: null,
      seed: 200,
      requestDigest: "3".repeat(64),
    });
    expect(await state.listEpisodeVideoOutputs(1, 2)).toEqual([]);
    expect((await state.getEpisodeByNumber(1, 2))?.status).toBe("audio");
    const history = await client.execute(
      "SELECT render_revision, request_digest, archived_video_path FROM agnes_scene_generation_history",
    );
    expect(history.rows).toEqual([expect.objectContaining({
      render_revision: 0,
      request_digest: originalDigest,
      archived_video_path: path.join(directory, "rejected-copy.mp4"),
    })]);
    await expect(state.requeueAgnesSceneAfterQaFailure({
      ...({} as any),
      expectedRenderRevision: 1,
    })).rejects.toThrow("exactly one rerender");
  });

  it("keeps a first QA verdict when stale verdict, error, and requeue writers arrive later", async () => {
    const state = await createStateWithEpisode();
    const directory = await mkdtemp(path.join(os.tmpdir(), "qa-first-writer-state-"));
    const videoPath = path.join(directory, "scene_001.mp4");
    await writeFile(videoPath, "current-video");
    const requestDigest = "4".repeat(64);
    const videoSha256 = createHash("sha256").update("current-video").digest("hex");
    await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      status: "completed",
      downloadStatus: "downloaded",
      prompt: "Current prompt",
      requestDigest,
      attemptCount: 1,
      seed: 100,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      normalizedOutputPath: videoPath,
    });
    const expectedSnapshot = {
      expectedRequestDigest: requestDigest,
      expectedRenderRevision: 0,
      expectedNormalizedOutputPath: videoPath,
      expectedQaStatus: "pending" as const,
      expectedQaRequestDigest: null,
    };
    const first = await state.recordAgnesVideoQaVerdict({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      ...expectedSnapshot,
      qaRequestDigest: "5".repeat(64),
      videoSha256,
      result: { policyVersion: AGNES_VIDEO_QA_POLICY_VERSION, pass: true },
      contactSheetPath: path.join(directory, "passing-sheet.jpg"),
      model: "openai/gpt-5-image",
      status: "passed",
    });
    expect(first.recorded).toBe(true);

    const staleVerdict = await state.recordAgnesVideoQaVerdict({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      ...expectedSnapshot,
      qaRequestDigest: "6".repeat(64),
      videoSha256,
      result: { policyVersion: AGNES_VIDEO_QA_POLICY_VERSION, pass: false },
      contactSheetPath: path.join(directory, "stale-sheet.jpg"),
      model: "openai/gpt-5-image",
      status: "exhausted",
    });
    expect(staleVerdict.recorded).toBe(false);

    await state.recordAgnesVideoQaError({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      ...expectedSnapshot,
      error: "late batch failure",
    });
    const staleRequeue = await state.requeueAgnesSceneAfterQaFailure({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      ...expectedSnapshot,
      qaRequestDigest: "7".repeat(64),
      videoSha256,
      result: { policyVersion: AGNES_VIDEO_QA_POLICY_VERSION, pass: false },
      contactSheetPath: path.join(directory, "stale-sheet.jpg"),
      model: "openai/gpt-5-image",
      retryPrompt: "Stale retry prompt",
      retryRequestDigest: "8".repeat(64),
      retrySeed: 200,
    });
    expect(staleRequeue.requeued).toBe(false);
    expect(await state.getAgnesSceneGeneration(1, 2, 1, "text")).toMatchObject({
      renderRevision: 0,
      qaStatus: "passed",
      qaRequestDigest: "5".repeat(64),
      qaError: null,
      normalizedOutputPath: videoPath,
    });
    const client = (state as unknown as {
      client: { execute(sql: string): Promise<{ rows: any[] }> };
    }).client;
    expect((await client.execute("SELECT id FROM agnes_scene_generation_history")).rows).toEqual([]);
  });

  it("persists a CAS-bound screening checkpoint and resumes with only the final Pro verdict", async () => {
    const state = await createStateWithEpisode();
    const directory = await mkdtemp(path.join(os.tmpdir(), "qa-screening-resume-state-"));
    const videoPath = path.join(directory, "scene_001.mp4");
    await writeFile(videoPath, "screened-video");
    const requestDigest = "9".repeat(64);
    const videoSha256 = createHash("sha256").update("screened-video").digest("hex");
    const screenRequestDigest = "a".repeat(64);
    const finalRequestDigest = "b".repeat(64);
    const referenceBoardSha256 = "c".repeat(64);
    const portraitSetDigest = "d".repeat(64);
    const contactSheetSha256 = "e".repeat(64);
    const policyDigest = currentAgnesVideoQaPolicyDigest();
    const screenVerdict = {
      sceneNumber: 1,
      pass: false,
      confidence: 0.96,
      issues: [{
        code: "duplicate_entity",
        characterNames: ["Pip the Ant"],
        frames: ["middle"],
        description: "Pip appears twice in the middle frame.",
      }],
    };

    await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      status: "completed",
      downloadStatus: "downloaded",
      prompt: "Current prompt",
      requestDigest,
      attemptCount: 1,
      seed: 100,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      normalizedOutputPath: videoPath,
    });

    const screeningResult = {
      policyVersion: AGNES_VIDEO_QA_POLICY_VERSION,
      pipeline: AGNES_VIDEO_QA_PIPELINE,
      pipelineVersion: AGNES_VIDEO_QA_PIPELINE_VERSION,
      policyDigest,
      decision: "screening",
      model: LEGACY_SCREENING_MODEL,
      screeningModel: LEGACY_SCREENING_MODEL,
      escalationModel: LEGACY_ESCALATION_MODEL,
      referenceBoardSha256,
      portraitSetDigest,
      contactSheetSha256,
      videoSha256,
      qaRequestDigest: screenRequestDigest,
      generationRequestDigest: requestDigest,
      renderRevision: 0,
      sceneNumber: 1,
      screenVerdict,
    };
    const originalSnapshot = {
      expectedRequestDigest: requestDigest,
      expectedRenderRevision: 0,
      expectedNormalizedOutputPath: videoPath,
      expectedQaStatus: "pending" as const,
      expectedQaRequestDigest: null,
    };
    const screening = await state.recordAgnesVideoQaScreening({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      ...originalSnapshot,
      qaRequestDigest: screenRequestDigest,
      videoSha256,
      result: screeningResult,
      contactSheetPath: path.join(directory, "screening-sheet.jpg"),
      model: LEGACY_SCREENING_MODEL,
    });

    expect(screening.recorded).toBe(true);
    expect(screening.row).toMatchObject({
      qaStatus: "pending",
      qaRequestDigest: screenRequestDigest,
      qaVideoSha256: videoSha256,
      qaModel: LEGACY_SCREENING_MODEL,
      qaResult: screeningResult,
      qaError: null,
    });

    const staleScreening = await state.recordAgnesVideoQaScreening({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      ...originalSnapshot,
      qaRequestDigest: "f".repeat(64),
      videoSha256,
      result: { ...screeningResult, qaRequestDigest: "f".repeat(64) },
      contactSheetPath: path.join(directory, "stale-sheet.jpg"),
      model: LEGACY_SCREENING_MODEL,
    });
    expect(staleScreening.recorded).toBe(false);

    const resumed = await state.getAgnesSceneGeneration(1, 2, 1, "text");
    expect(resumed).toMatchObject({
      qaStatus: "pending",
      qaRequestDigest: screenRequestDigest,
      qaResult: screeningResult,
    });
    const reviewVerdict = { sceneNumber: 1, pass: true, confidence: 0.99, issues: [] };
    const finalResult = {
      ...screeningResult,
      decision: "final",
      model: LEGACY_ESCALATION_MODEL,
      finalJudgeModel: LEGACY_ESCALATION_MODEL,
      screenRequestDigest,
      reviewReason: ["screen_failure"],
      reviewVerdict,
      qaRequestDigest: finalRequestDigest,
      ...reviewVerdict,
    };
    const finalVerdict = await state.recordAgnesVideoQaVerdict({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      expectedRequestDigest: requestDigest,
      expectedRenderRevision: 0,
      expectedNormalizedOutputPath: videoPath,
      expectedQaStatus: "pending",
      expectedQaRequestDigest: screenRequestDigest,
      qaRequestDigest: finalRequestDigest,
      videoSha256,
      result: finalResult,
      contactSheetPath: path.join(directory, "pro-sheet.jpg"),
      model: LEGACY_ESCALATION_MODEL,
      status: "passed",
    });

    expect(finalVerdict.recorded).toBe(true);
    expect(finalVerdict.row).toMatchObject({
      qaStatus: "passed",
      qaRequestDigest: finalRequestDigest,
      qaModel: LEGACY_ESCALATION_MODEL,
      qaResult: finalResult,
    });
  });

  it("leases narration mutations, advances revisions on commit, and fences expired owners", async () => {
    const state = await createStateWithEpisode();
    const nowMs = Date.now();
    const identity = {
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 3,
      leaseToken: "tts-owner-1",
    };

    const competingBegins = await Promise.all([
      state.beginEpisodeNarrationAudioMutation({
        ...identity,
        leaseExpiresAtMs: nowMs + 60_000,
        nowMs,
      }),
      state.beginEpisodeNarrationAudioMutation({
        ...identity,
        leaseToken: "tts-owner-2",
        leaseExpiresAtMs: nowMs + 60_000,
        nowMs,
      }),
    ]);
    expect(competingBegins.filter((result) => result.acquired)).toHaveLength(1);
    const acquired = competingBegins.find((result) => result.acquired);
    const blocked = competingBegins.find((result) => !result.acquired);
    expect(acquired).toMatchObject({ acquired: true, audioRevision: 0, startedAssetCount: 0 });
    expect(blocked).toMatchObject({
      acquired: false,
      reason: "mutation_in_progress",
      startedAssetCount: 0,
    });

    const owner = acquired === competingBegins[0]
      ? identity
      : { ...identity, leaseToken: "tts-owner-2" };
    await expect(state.getEpisodeAudioRevisionForAgnes(1, 2, nowMs + 1))
      .rejects.toThrow("Narration audio mutation is in progress");
    expect(await state.renewEpisodeNarrationAudioMutation({
      ...owner,
      leaseExpiresAtMs: nowMs + 120_000,
      nowMs: nowMs + 1,
    })).toBe(true);
    expect(await state.renewEpisodeNarrationAudioMutation({
      ...owner,
      leaseToken: "wrong-owner",
      leaseExpiresAtMs: nowMs + 120_000,
      nowMs: nowMs + 1,
    })).toBe(false);
    expect(await state.completeEpisodeNarrationAudioMutation(owner)).toBe(true);
    expect(await state.completeEpisodeNarrationAudioMutation(owner)).toBe(false);
    expect(await state.getEpisodeAudioRevisionForAgnes(1, 2, nowMs + 2)).toBe(1);

    const expiring = await state.beginEpisodeNarrationAudioMutation({
      ...identity,
      leaseToken: "expired-owner",
      leaseExpiresAtMs: nowMs + 20,
      nowMs: nowMs + 10,
    });
    expect(expiring).toMatchObject({ acquired: true, audioRevision: 1 });
    expect(await state.getEpisodeAudioRevisionForAgnes(1, 2, nowMs + 21)).toBe(2);
    expect(await state.getEpisodeAudioRevisionForAgnes(1, 2, nowMs + 22)).toBe(2);
    expect(await state.completeEpisodeNarrationAudioMutation({
      ...identity,
      leaseToken: "expired-owner",
    })).toBe(false);

    const aborting = await state.beginEpisodeNarrationAudioMutation({
      ...identity,
      leaseToken: "abort-owner",
      leaseExpiresAtMs: nowMs + 120_000,
      nowMs: nowMs + 30,
    });
    expect(aborting).toMatchObject({ acquired: true, audioRevision: 2 });
    expect(await state.abortEpisodeNarrationAudioMutation({
      ...identity,
      leaseToken: "wrong-owner",
    })).toBe(false);
    expect(await state.abortEpisodeNarrationAudioMutation({
      ...identity,
      leaseToken: "abort-owner",
    })).toBe(true);
    expect(await state.getEpisodeAudioRevisionForAgnes(1, 2, nowMs + 31)).toBe(2);

    const client = (state as unknown as {
      client: { execute(sql: string): Promise<unknown> };
    }).client;
    await client.execute("UPDATE episodes SET status = 'done' WHERE series_id = 1 AND episode_number = 2");
    expect(await state.beginEpisodeNarrationAudioMutation({
      ...identity,
      leaseToken: "post-completion-owner",
      leaseExpiresAtMs: nowMs + 120_000,
      nowMs: nowMs + 40,
    })).toMatchObject({
      acquired: false,
      reason: "episode_complete",
      startedAssetCount: 0,
    });
  });

  it("makes Agnes claims CAS on a stable audio revision with no active mutation", async () => {
    const state = await createStateWithEpisode();
    const episodeScript = productionScript();
    await state.updateEpisodeStatus(1, "script", { scriptJson: episodeScript });
    const common = {
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text" as const,
      prompt: "Animate the revision-fenced meadow scene.",
      requestDigest: "revision-fenced-digest",
      expectedEpisodeScriptJson: canonicalEpisodeScriptJson(episodeScript),
      seed: 44,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
    };
    await state.upsertAgnesSceneGeneration({
      ...common,
      status: "pending",
      attemptCount: 0,
    });

    const nowMs = Date.now();
    const lease = {
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      leaseToken: "active-tts",
    };
    expect(await state.beginEpisodeNarrationAudioMutation({
      ...lease,
      leaseExpiresAtMs: nowMs + 60_000,
      nowMs,
    })).toMatchObject({ acquired: true, audioRevision: 0 });

    const blockedByLease = await state.claimAgnesSceneSubmission({
      ...common,
      expectedEpisodeAudioRevision: 0,
      providerReceipt: { state: "submitting", claimToken: "blocked-by-lease" },
    }, 0);
    expect(blockedByLease).toMatchObject({ claimed: false, reason: "conflict" });

    expect(await state.completeEpisodeNarrationAudioMutation(lease)).toBe(true);
    const blockedByRevision = await state.claimAgnesSceneSubmission({
      ...common,
      expectedEpisodeAudioRevision: 0,
      providerReceipt: { state: "submitting", claimToken: "blocked-by-revision" },
    }, 0);
    expect(blockedByRevision).toMatchObject({ claimed: false, reason: "conflict" });

    const claimed = await state.claimAgnesSceneSubmission({
      ...common,
      expectedEpisodeAudioRevision: 1,
      providerReceipt: { state: "submitting", claimToken: "current-revision" },
    }, 0);
    expect(claimed).toMatchObject({ claimed: true, row: { attemptCount: 1 } });

    expect(await state.beginEpisodeNarrationAudioMutation({
      ...lease,
      leaseToken: "too-late-tts",
      leaseExpiresAtMs: nowMs + 120_000,
      nowMs: nowMs + 1,
    })).toMatchObject({
      acquired: false,
      reason: "agnes_started",
      startedAssetCount: 1,
    });
  });

  it("lazily creates tables and preserves a task receipt across status upserts", async () => {
    const state = await createStateWithEpisode();

    expect(await state.getAgnesSceneGeneration(1, 2, 3, "text")).toBeNull();

    const submitted = await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 3,
      variant: "text",
      status: "submitted",
      prompt: "A gentle continuous storybook shot.",
      requestDigest: "digest-v1",
      attemptCount: 1,
      seed: 12345,
      requestedDurationSeconds: 7.35,
      providerDurationSeconds: 8,
      providerTaskId: "agnes-task-3",
      providerReceipt: { video_id: "agnes-task-3", status: "queued" },
    });

    expect(submitted.providerTaskId).toBe("agnes-task-3");
    expect(submitted.providerReceipt).toEqual({ video_id: "agnes-task-3", status: "queued" });
    expect(submitted.requestDigest).toBe("digest-v1");
    expect(submitted.attemptCount).toBe(1);
    expect(submitted.submittedAt).toBeTruthy();

    const completed = await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 3,
      variant: "text",
      status: "completed",
      prompt: "A gentle continuous storybook shot.",
      requestedDurationSeconds: 7.35,
      providerDurationSeconds: 8,
      providerVideoUrl: "https://cdn.example.test/scene-3.mp4",
      rawOutputPath: "/tmp/raw/scene_003.mp4",
      normalizedOutputPath: "/tmp/normalized/scene_003.mp4",
    });

    expect(completed.providerTaskId).toBe("agnes-task-3");
    expect(completed.requestDigest).toBe("digest-v1");
    expect(completed.attemptCount).toBe(1);
    expect(completed.seed).toBe(12345);
    expect(completed.normalizedOutputPath).toBe("/tmp/normalized/scene_003.mp4");
    expect(completed.completedAt).toBeTruthy();
  });

  it("does not let stale provider or download updates regress a completed scene", async () => {
    const state = await createStateWithEpisode();
    const episodeScript = productionScript();
    await state.updateEpisodeStatus(1, "script", { scriptJson: episodeScript });
    await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 4,
      variant: "text",
      status: "completed",
      downloadStatus: "downloaded",
      prompt: "The accepted scene prompt.",
      requestDigest: "accepted-digest",
      attemptCount: 2,
      seed: 777,
      requestedDurationSeconds: 7.5,
      providerDurationSeconds: 8,
      providerTaskId: "accepted-task",
      providerReceipt: { status: "completed", video_id: "accepted-task" },
      providerVideoUrl: "https://cdn.example.test/accepted.mp4",
      rawOutputPath: "/tmp/raw/accepted.mp4",
      normalizedOutputPath: "/tmp/normalized/accepted.mp4",
    });

    const preserved = await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 4,
      variant: "text",
      status: "queued",
      downloadStatus: "failed",
      prompt: "A stale queued response.",
      attemptCount: 1,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      providerTaskId: "stale-task",
      providerReceipt: { status: "queued", video_id: "stale-task" },
      providerVideoUrl: "https://cdn.example.test/stale.mp4",
      rawOutputPath: "/tmp/raw/stale.mp4",
      normalizedOutputPath: "/tmp/normalized/stale.mp4",
      error: "late download error",
    });

    expect(preserved).toMatchObject({
      status: "completed",
      downloadStatus: "downloaded",
      prompt: "The accepted scene prompt.",
      requestDigest: "accepted-digest",
      attemptCount: 2,
      providerTaskId: "accepted-task",
      providerReceipt: { status: "completed", video_id: "accepted-task" },
      providerVideoUrl: "https://cdn.example.test/accepted.mp4",
      rawOutputPath: "/tmp/raw/accepted.mp4",
      normalizedOutputPath: "/tmp/normalized/accepted.mp4",
      error: null,
    });
    expect(preserved.requestedDurationSeconds).toBe(7.5);
    expect(preserved.providerDurationSeconds).toBe(8);

    const staleClaim = await state.claimAgnesSceneSubmission({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 4,
      variant: "text",
      prompt: "A stale resubmission intent.",
      requestDigest: "accepted-digest",
      expectedEpisodeScriptJson: canonicalEpisodeScriptJson(episodeScript),
      expectedEpisodeAudioRevision: 0,
      seed: 777,
      requestedDurationSeconds: 7.5,
      providerDurationSeconds: 8,
      providerReceipt: { state: "submitting", claimToken: "stale-claim" },
    }, 2);
    expect(staleClaim.claimed).toBe(false);
    expect(staleClaim).toMatchObject({
      claimed: false,
      reason: "conflict",
      row: { status: "completed" },
    });

    const staleReset = await state.resetAgnesSceneGenerationForRequest({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 4,
      variant: "text",
      prompt: "A stale reset intent.",
      requestDigest: "replacement-digest",
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
    }, {
      requestDigest: "accepted-digest",
      attemptCount: 2,
    });
    expect(staleReset.reset).toBe(false);
    expect(staleReset.row).toMatchObject({
      status: "completed",
      downloadStatus: "downloaded",
      requestDigest: "accepted-digest",
    });
  });

  it("lists direct Agnes text scenes in deterministic order and persists the Agnes-only output", async () => {
    const state = await createStateWithEpisode();
    const common = {
      seriesId: 1,
      episodeNumber: 2,
      status: "completed" as const,
      prompt: "Storybook animation.",
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
    };

    await state.upsertAgnesSceneGeneration({
      ...common,
      sceneNumber: 2,
      variant: "text",
    });
    await state.upsertAgnesSceneGeneration({ ...common, sceneNumber: 1, variant: "text" });

    const scenes = await state.listAgnesSceneGenerations(1, 2);
    expect(scenes.map(({ sceneNumber, variant }) => `${sceneNumber}:${variant}`)).toEqual([
      "1:text",
      "2:text",
    ]);

    await state.upsertEpisodeVideoOutput({
      seriesId: 1,
      episodeNumber: 2,
      variant: "agnes_text",
      outputPath: "/tmp/episode_agnes_text.mp4",
      durationSeconds: 60,
    });

    const outputs = await state.listEpisodeVideoOutputs(1, 2);
    expect(outputs.map((output) => output.variant)).toEqual(["agnes_text"]);
    expect(outputs.every((output) => output.status === "completed")).toBe(true);
  });

  it("does not let a stale assembly failure regress a completed output", async () => {
    const state = await createStateWithEpisode();
    await state.upsertEpisodeVideoOutput({
      seriesId: 1,
      episodeNumber: 2,
      variant: "agnes_text",
      status: "completed",
      outputPath: "/tmp/old-agnes-text.mp4",
      durationSeconds: 60,
    });
    const preserved = await state.upsertEpisodeVideoOutput({
      seriesId: 1,
      episodeNumber: 2,
      variant: "agnes_text",
      status: "failed",
      outputPath: null,
      durationSeconds: null,
      error: "ffmpeg failed",
      completedAt: null,
    });
    expect(preserved.status).toBe("completed");
    expect(preserved.outputPath).toBe("/tmp/old-agnes-text.mp4");
    expect(preserved.durationSeconds).toBe(60);
    expect(preserved.completedAt).toBeTruthy();
    expect(preserved.error).toBeNull();
  });

  it("atomically claims one POST intent and CAS-resets a proven-safe stale request", async () => {
    const state = await createStateWithEpisode();
    const episodeScript = productionScript();
    await state.updateEpisodeStatus(1, "script", { scriptJson: episodeScript });
    const claimInput = {
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text" as const,
      prompt: "Animate the meadow scene.",
      requestDigest: "digest-old",
      expectedEpisodeScriptJson: canonicalEpisodeScriptJson(episodeScript),
      expectedEpisodeAudioRevision: 0,
      seed: 44,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      providerReceipt: {
        version: 1,
        segments: [{ state: "submitting", claimToken: "claim-1" }],
      },
    };

    // Request preparation is deliberately separate from the outbound POST
    // claim. Claims may update this exact row, but must never insert one.
    await state.upsertAgnesSceneGeneration({
      ...claimInput,
      status: "pending",
      attemptCount: 0,
      providerReceipt: null,
    });

    const claims = await Promise.all([
      state.claimAgnesSceneSubmission(claimInput, 0),
      state.claimAgnesSceneSubmission(claimInput, 0),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.every((claim) => claim.row?.attemptCount === 1)).toBe(true);
    expect(claims.every((claim) => claim.row?.requestDigest === "digest-old")).toBe(true);
    expect(claims.every((claim) => Boolean(claim.row?.submittedAt))).toBe(true);

    const secondClaimInput = {
      ...claimInput,
      providerReceipt: {
        version: 1,
        segments: [
          { state: "accepted", claimToken: "claim-1" },
          { state: "submitting", claimToken: "claim-2" },
        ],
      },
    };
    const secondClaim = await state.claimAgnesSceneSubmission(secondClaimInput, 1);
    expect(secondClaim.claimed).toBe(true);
    if (!secondClaim.claimed) throw new Error("Expected the second Agnes POST claim to succeed.");
    expect(secondClaim.row.attemptCount).toBe(2);
    expect(secondClaim.row.providerReceipt).toEqual(secondClaimInput.providerReceipt);

    const staleSecondClaim = await state.claimAgnesSceneSubmission(secondClaimInput, 1);
    expect(staleSecondClaim).toMatchObject({
      claimed: false,
      reason: "conflict",
      row: { attemptCount: 2 },
    });

    const reset = await state.resetAgnesSceneGenerationForRequest({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      prompt: "Animate the revised meadow scene.",
      requestDigest: "digest-new",
      seed: 45,
      requestedDurationSeconds: 7,
      providerDurationSeconds: 7,
    }, {
      requestDigest: "digest-old",
      attemptCount: 2,
    });
    expect(reset.reset).toBe(true);
    expect(reset.row.requestDigest).toBe("digest-new");
    expect(reset.row.attemptCount).toBe(0);
    expect(reset.row.providerReceipt).toBeNull();

    const staleReset = await state.resetAgnesSceneGenerationForRequest({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      prompt: "A stale competing reset.",
      requestDigest: "digest-other",
      requestedDurationSeconds: 8,
      providerDurationSeconds: 8,
    }, {
      requestDigest: "digest-old",
      attemptCount: 1,
    });
    expect(staleReset.reset).toBe(false);
    expect(staleReset.row.requestDigest).toBe("digest-new");
  });

  it("does not recreate a prepared request deleted before its POST claim", async () => {
    const state = await createStateWithEpisode();
    const episodeScript = productionScript();
    await state.updateEpisodeStatus(1, "script", { scriptJson: episodeScript });
    const input = {
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text" as const,
      prompt: "Animate the original meadow scene.",
      requestDigest: "original-script-digest",
      expectedEpisodeScriptJson: canonicalEpisodeScriptJson(episodeScript),
      expectedEpisodeAudioRevision: 0,
      seed: 44,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
    };
    await state.upsertAgnesSceneGeneration({
      ...input,
      status: "pending",
      attemptCount: 0,
    });

    const client = (state as unknown as {
      client: { execute(statement: string | { sql: string; args: unknown[] }): Promise<unknown> };
    }).client;
    // This models atomic script promotion invalidating a not-yet-started row
    // after preparation but before the invocation obtains its POST claim.
    await client.execute({
      sql: `DELETE FROM agnes_scene_generations
            WHERE series_id = ? AND episode_number = ? AND scene_number = ? AND variant = ?`,
      args: [input.seriesId, input.episodeNumber, input.sceneNumber, input.variant],
    });

    const claim = await state.claimAgnesSceneSubmission({
      ...input,
      providerReceipt: {
        version: 1,
        attempts: [{ state: "submitting", claimToken: "stale-script-claim" }],
      },
    }, 0);

    expect(claim).toEqual({ claimed: false, reason: "missing", row: null });
    expect(await state.getAgnesSceneGeneration(1, 2, 1, "text")).toBeNull();
  });

  it("refuses a stale request materialized after the production script changes", async () => {
    const state = await createStateWithEpisode();
    const oldScript = productionScript();
    await state.updateEpisodeStatus(1, "script", { scriptJson: oldScript });
    const oldScriptSnapshot = canonicalEpisodeScriptJson(oldScript);

    // Promotion wins before the stale invocation's initial materialization.
    const currentScript = structuredClone(oldScript);
    currentScript.scenes[0]!.action =
      "Pip places the berry beside the clubhouse during a new distinct visible beat.";
    await state.updateEpisodeStatus(1, "script", { scriptJson: currentScript });
    await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      status: "pending",
      prompt: "The stale invocation's original meadow prompt.",
      requestDigest: "stale-materialized-digest",
      attemptCount: 0,
      seed: 44,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
    });

    const claim = await state.claimAgnesSceneSubmission({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      prompt: "The stale invocation's original meadow prompt.",
      requestDigest: "stale-materialized-digest",
      expectedEpisodeScriptJson: oldScriptSnapshot,
      expectedEpisodeAudioRevision: 0,
      seed: 44,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      providerReceipt: {
        version: 1,
        attempts: [{ state: "submitting", claimToken: "stale-after-promotion" }],
      },
    }, 0);

    expect(claim).toMatchObject({
      claimed: false,
      reason: "conflict",
      row: {
        requestDigest: "stale-materialized-digest",
        attemptCount: 0,
        providerReceipt: null,
      },
    });
    expect((await state.getEpisodeByNumber(1, 2))?.scriptJson).toEqual(currentScript);
  });

  it("compares scripts semantically and blocks real replacement after Agnes starts", async () => {
    const state = await createStateWithEpisode();
    const original = productionScript();
    await state.updateEpisodeStatus(1, "script", { scriptJson: original });
    await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      status: "pending",
      prompt: "Pending scene.",
      requestDigest: "pending-digest",
      requestedDurationSeconds: 7,
      providerDurationSeconds: 7,
    });
    await state.upsertEpisodeVideoOutput({
      seriesId: 1,
      episodeNumber: 2,
      variant: "agnes_text",
      status: "pending",
    });

    // Root key order differs, but the scene contract is identical. Existing
    // resumable state must survive this harmless serialization difference.
    await state.updateEpisodeStatus(1, "script", {
      scriptJson: { scenes: original.scenes, title: original.title },
    });
    expect(await state.getAgnesSceneGeneration(1, 2, 1, "text")).not.toBeNull();
    expect(await state.listEpisodeVideoOutputs(1, 2)).toHaveLength(1);

    const revised = structuredClone(original);
    revised.scenes[0]!.action = "Pip carefully lifts the berry for the first distinct visible beat.";
    await state.updateEpisodeStatus(1, "script", { scriptJson: revised });
    expect(await state.listAgnesSceneGenerations(1, 2)).toEqual([]);
    expect(await state.listEpisodeVideoOutputs(1, 2)).toEqual([]);

    await state.upsertAgnesSceneGeneration({
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text",
      status: "submitted",
      prompt: "Submitted scene.",
      requestDigest: "submitted-digest",
      attemptCount: 1,
      requestedDurationSeconds: 7,
      providerDurationSeconds: 7,
      providerTaskId: "task-1",
      providerReceipt: { video_id: "task-1", status: "queued" },
    });
    const forbiddenRevision = structuredClone(revised);
    forbiddenRevision.scenes[1]!.action =
      "Pip crosses a silver pebble during the second distinct visible beat.";
    await expect(
      state.updateEpisodeStatus(1, "script", { scriptJson: forbiddenRevision }),
    ).rejects.toThrow("Cannot replace the episode script after Agnes submission has started");

    expect((await state.getEpisodeByNumber(1, 2))?.scriptJson).toEqual(revised);
    expect(await state.getAgnesSceneGeneration(1, 2, 1, "text")).toMatchObject({
      status: "submitted",
      attemptCount: 1,
      providerTaskId: "task-1",
    });
  });

  it("rejects the scriptJson persistence bypass on non-script status updates", async () => {
    const state = await createStateWithEpisode();
    const invalidReplacement = { scenes: [] };

    await expect(
      state.updateEpisodeStatus(1, "audio", { scriptJson: invalidReplacement }),
    ).rejects.toThrow("scriptJson may only be persisted with status=script");

    expect((await state.getEpisodeByNumber(1, 2))?.scriptJson).toBeNull();
  });

  async function prepareProductionEpisode(
    state: SeriesState,
    outputDir: string,
  ): Promise<{ finalPath: string }> {
    const client = (state as unknown as {
      client: { execute(statement: string | { sql: string; args: unknown[] }): Promise<{ rows: any[] }> };
    }).client;
    for (const statement of [
      "ALTER TABLE episodes ADD COLUMN title TEXT NOT NULL DEFAULT 'Test Episode'",
      "ALTER TABLE episodes ADD COLUMN premise TEXT NOT NULL DEFAULT 'A gentle test story.'",
      "ALTER TABLE episodes ADD COLUMN status TEXT NOT NULL DEFAULT 'assembly'",
      "ALTER TABLE episodes ADD COLUMN script_json TEXT",
      "ALTER TABLE episodes ADD COLUMN output_path TEXT",
      "ALTER TABLE episodes ADD COLUMN updated_at TEXT",
    ]) {
      await client.execute(statement);
    }

    const narrationText =
      "Pip the Ant gently carries one berry across the sunny meadow toward all his patient friends beside their cozy clubhouse.";
    const scenes = Array.from({ length: 40 }, (_unused, index) => ({
      sceneNumber: index + 1,
      narrationText,
      environmentDescription: "A sunny meadow beside the cozy wooden clubhouse.",
      action: `Pip the Ant carries the berry through visible beat ${index + 1}.`,
      characterNames: ["Pip the Ant"],
      characterVisuals: [{
        name: "Pip the Ant",
        visualForm: "real_creature",
        speciesOrType: "ant",
        humanoidAllowed: false,
      }],
      supportingEntities: [],
      continuityAnchors: [
        "Berry path: one glossy raspberry-red berry above short green grass beside the wooden clubhouse.",
      ],
      sceneDetails: "Pip the Ant stays fully visible beside the same berry path while taking one careful, readable step.",
      cameraAngle: "medium wide child-eye-level shot",
      lighting: "warm soft morning sunlight",
    }));
    await client.execute({
      sql: "UPDATE episodes SET script_json = ? WHERE id = 1",
      args: [JSON.stringify({ title: "Test Episode", scenes })],
    });

    const episodeDir = path.join(outputDir, "series_1", "episode_2");
    const captionsPath = path.join(episodeDir, "captions.srt");
    await mkdir(path.dirname(captionsPath), { recursive: true });
    await writeFile(captionsPath, "1\n00:00:00,000 --> 00:00:07,500\nPip begins.\n", "utf8");
    const portraitPath = path.join(outputDir, "pip_portrait.png");
    await writeFile(portraitPath, "valid-pip-portrait", "utf8");
    await state.upsertCharacterSheet(
      1,
      "Pip the Ant",
      "A small red ant.",
      { portrait: { path: portraitPath } },
      "One small red ant with an exact locked preschool design.",
    );
    for (const scene of scenes) {
      const stem = `scene_${String(scene.sceneNumber).padStart(3, "0")}`;
      const narrationPath = path.join(episodeDir, "audio", `${stem}_narrator.wav`);
      const videoPath = path.join(episodeDir, "agnes_text", "scenes", `${stem}.mp4`);
      await mkdir(path.dirname(narrationPath), { recursive: true });
      await mkdir(path.dirname(videoPath), { recursive: true });
      await writeFile(narrationPath, "valid-audio", "utf8");
      await writeFile(videoPath, "valid-video", "utf8");
      await writeFile(narrationAudioMetadataPath(narrationPath), JSON.stringify({
        schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
        kind: NARRATION_METADATA_KIND,
        requestDigest: createNarrationAudioRequestDigest({
          text: scene.narrationText,
          model: CONFIG.groqTtsModel,
          voice: CONFIG.groqTtsVoice,
        }),
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
        responseFormat: "wav",
        textLength: scene.narrationText.length,
        spokenWordCount: 20,
        durationSeconds: 7.5,
        durationStatus: "ready",
      }), "utf8");
      const requestDigest = `digest-${scene.sceneNumber}`;
      await state.upsertAgnesSceneGeneration({
        seriesId: 1,
        episodeNumber: 2,
        sceneNumber: scene.sceneNumber,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        prompt: `Complete animation ${scene.sceneNumber}`,
        requestDigest,
        requestedDurationSeconds: 7.5,
        providerDurationSeconds: 8,
        normalizedOutputPath: videoPath,
      });
    }

    for (const spec of [
      {
        kind: "series" as const,
        title: "Test Series",
        trackingSceneNumber: AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      },
      {
        kind: "episode" as const,
        title: "Test Episode",
        trackingSceneNumber: AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      },
    ]) {
      const paths = agnesKeyArtPaths({
        outputDir,
        seriesId: 1,
        episodeNumber: 2,
        kind: spec.kind,
      });
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.audioPath, "valid-key-art-audio", "utf8");
      await writeFile(paths.normalizedVideoPath, "valid-key-art-video", "utf8");
      await writeFile(paths.audioMetadataPath, JSON.stringify({
        schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
        kind: NARRATION_METADATA_KIND,
        requestDigest: createNarrationAudioRequestDigest({
          text: spec.title,
          model: CONFIG.groqTtsModel,
          voice: CONFIG.groqTtsVoice,
        }),
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
        responseFormat: "wav",
        textLength: spec.title.length,
        spokenWordCount: 2,
        durationSeconds: 7.5,
        durationStatus: "ready",
      }), "utf8");
      const requestDigest = `${spec.kind}-key-art-digest`;
      await state.upsertAgnesSceneGeneration({
        seriesId: 1,
        episodeNumber: 2,
        sceneNumber: spec.trackingSceneNumber,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        prompt: `${spec.kind} key-art animation`,
        requestDigest,
        requestedDurationSeconds: 7.5,
        providerDurationSeconds: 8,
        normalizedOutputPath: paths.normalizedVideoPath,
      });
    }

    const qaReportPath = path.join(episodeDir, "agnes_text", "qa", "static_media_integrity_v1.json");
    await mkdir(path.dirname(qaReportPath), { recursive: true });
    await writeFile(qaReportPath, "static QA evidence", "utf8");
    const agnesRows = await state.listAgnesSceneGenerations(1, 2, "text");
    const sources = await Promise.all(agnesRows.map(async (row) => ({
      row,
      videoSha256: createHash("sha256")
        .update(await readFile(row.normalizedOutputPath!))
        .digest("hex"),
    })));
    const episodeAssetSetDigest = createAgnesStaticEpisodeAssetSetDigest(
      sources.map(({ row, videoSha256 }) => ({
        sceneNumber: row.sceneNumber,
        generationRequestDigest: row.requestDigest!,
        renderRevision: row.renderRevision,
        videoSha256,
      })),
    );
    for (const { row, videoSha256 } of sources) {
      const media = {
        durationSeconds: 7.5,
        codecName: "h264",
        width: 1_920,
        height: 1_080,
        videoStreamCount: 1,
        audioStreamCount: 0,
      };
      const digestInput = {
        sceneNumber: row.sceneNumber,
        generationRequestDigest: row.requestDigest!,
        renderRevision: row.renderRevision,
        videoSha256,
        episodeAssetSetDigest,
        expectedMainCast: ["Pip the Ant"],
        referenceImageUrls: [],
        media,
      };
      const qaRequestDigest = createAgnesStaticVideoQaRequestDigest(digestInput);
      await state.recordAgnesVideoQaVerdict({
        seriesId: 1,
        episodeNumber: 2,
        sceneNumber: row.sceneNumber,
        variant: "text",
        expectedRequestDigest: row.requestDigest!,
        expectedRenderRevision: row.renderRevision,
        expectedNormalizedOutputPath: row.normalizedOutputPath!,
        expectedQaStatus: "pending",
        expectedQaRequestDigest: null,
        qaRequestDigest,
        videoSha256,
        result: {
          policyVersion: AGNES_STATIC_VIDEO_QA_POLICY_VERSION,
          pipeline: AGNES_STATIC_VIDEO_QA_PIPELINE,
          pipelineVersion: AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION,
          policyDigest: currentAgnesStaticVideoQaPolicyDigest(),
          decision: "final",
          model: AGNES_STATIC_VIDEO_QA_MODEL,
          ...digestInput,
          qaRequestDigest,
          pass: true,
          checks: [],
          issues: [],
          evidencePath: qaReportPath,
        },
        contactSheetPath: qaReportPath,
        model: AGNES_STATIC_VIDEO_QA_MODEL,
        status: "passed",
      });
    }

    const finalPath = path.join(episodeDir, "Test_episode_2_agnes_text.mp4");
    await writeFile(finalPath, "valid-final-video", "utf8");
    await state.upsertEpisodeVideoOutput({
      seriesId: 1,
      episodeNumber: 2,
      variant: "agnes_text",
      status: "completed",
      outputPath: finalPath,
      durationSeconds: 7.5,
    });
    return { finalPath };
  }

  it("validates the canonical Agnes output but reserves done for YouTube finalization", async () => {
    const state = await createStateWithEpisode();
    const previousOutputDir = CONFIG.outputDir;
    const previousFfprobePath = CONFIG.ffprobePath;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "done-guard-agnes-only-"));
    const fakeProbe = path.join(outputDir, "fake-ffprobe.sh");
    await writeFile(fakeProbe, "#!/bin/sh\nprintf '7.5\\n'\n", "utf8");
    await chmod(fakeProbe, 0o755);
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    (CONFIG as { ffprobePath: string }).ffprobePath = fakeProbe;

    try {
      const { finalPath } = await prepareProductionEpisode(state, outputDir);
      await expect(
        state.updateEpisodeStatus(1, "done", { outputPath: "/tmp/not-canonical.mp4" }),
      ).rejects.toThrow("Only finalizeEpisodeUpload may mark an episode done");
      expect(await state.assertEpisodeReadyForDone(1)).toMatchObject({ outputPath: finalPath });
      const client = (state as unknown as {
        client: { execute(sql: string): Promise<{ rows: any[] }> };
      }).client;
      const completed = await client.execute("SELECT status, output_path FROM episodes WHERE id = 1");
      expect(completed.rows[0]?.status).toBe("assembly");
      expect(completed.rows[0]?.output_path).toBeNull();
      expect((await state.listEpisodeVideoOutputs(1, 2)).map((row) => row.variant)).toEqual(["agnes_text"]);
      expect(await state.getAgnesSceneGeneration(1, 2, 1, "reference")).toBeNull();
    } finally {
      (CONFIG as { outputDir: string }).outputDir = previousOutputDir;
      (CONFIG as { ffprobePath: string }).ffprobePath = previousFfprobePath;
    }
  });

  it("does not bind static video QA to a replaceable local portrait cache", async () => {
    const state = await createStateWithEpisode();
    const previousOutputDir = CONFIG.outputDir;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "qa-portrait-binding-"));
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    try {
      await prepareProductionEpisode(state, outputDir);
      await writeFile(path.join(outputDir, "pip_portrait.png"), "changed-pip-portrait", "utf8");
      await expect(state.assertAgnesVideoQaReady(1, 2))
        .resolves.toMatchObject({ assetCount: 42 });
    } finally {
      (CONFIG as { outputDir: string }).outputDir = previousOutputDir;
    }
  });

  it("keeps a YouTube recovery receipt when post-upload readiness fails", async () => {
    const state = await createStateWithEpisode();

    await expect(state.finalizeEpisodeUpload({
      seriesId: 1,
      episodeNumber: 2,
      videoId: "youtube-recovery-1",
      url: "https://www.youtube.com/watch?v=youtube-recovery-1",
    })).rejects.toThrow("persisted script violates the production contract");

    expect(await state.getYoutubeUploadReceipt(1, 2)).toMatchObject({
      videoId: "youtube-recovery-1",
      url: "https://www.youtube.com/watch?v=youtube-recovery-1",
    });
    await expect(state.recordYoutubeUploadReceipt({
      seriesId: 1,
      episodeNumber: 2,
      videoId: "different-video",
      url: "https://www.youtube.com/watch?v=different-video",
    })).rejects.toThrow("already has a recovery receipt");
  });

  it("self-heals a partial uploaded episode receipt without requiring old artifacts", async () => {
    const state = await createStateWithEpisode();
    await state.initialize();
    const client = (state as unknown as {
      client: {
        execute(statement: string | { sql: string; args: unknown[] }): Promise<{ rows: any[] }>;
      };
    }).client;
    await client.execute({
      sql: `UPDATE episodes
            SET status = 'pending', uploaded_at = '2026-09-04T12:00:00.000Z',
                youtube_video_id = NULL, youtube_url = NULL
            WHERE id = 1`,
      args: [],
    });

    const healed = await state.finalizeEpisodeUpload({
      seriesId: 1,
      episodeNumber: 2,
      videoId: "youtube-healed",
      url: "https://www.youtube.com/watch?v=youtube-healed",
    });
    expect(healed).toMatchObject({
      status: "done",
      youtubeVideoId: "youtube-healed",
      youtubeUrl: "https://www.youtube.com/watch?v=youtube-healed",
      uploadedAt: "2026-09-04T12:00:00.000Z",
    });
    expect(await state.getYoutubeUploadReceipt(1, 2)).toBeNull();
    expect(await state.getNextEpisode(1, {
      now: new Date("2026-09-05T12:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    })).toBeNull();
  });

  it("atomically records YouTube success, cleans transient rows, and advances the series", async () => {
    const state = await createStateWithEpisode();
    const previousOutputDir = CONFIG.outputDir;
    const previousFfprobePath = CONFIG.ffprobePath;
    const previousDailyTimezone = CONFIG.episodeDailyTimezone;
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "upload-finalize-"));
    const fakeProbe = path.join(outputDir, "fake-ffprobe.sh");
    await writeFile(fakeProbe, "#!/bin/sh\nprintf '7.5\\n'\n", "utf8");
    await chmod(fakeProbe, 0o755);
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    (CONFIG as { ffprobePath: string }).ffprobePath = fakeProbe;
    (CONFIG as { episodeDailyTimezone: string }).episodeDailyTimezone = "Asia/Kolkata";

    try {
      const { finalPath } = await prepareProductionEpisode(state, outputDir);
      await state.upsertCharacterSheet(1, "Pip", "A red ant.", { portrait: { path: "/tmp/pip.png" } });
      await state.upsertKeyArt(1, "series", null, {}, "/tmp/legacy.png", "legacy");

      const client = (state as unknown as {
        client: {
          execute: (statement: string | { sql: string; args: unknown[] }) => Promise<any>;
          batch: (...args: any[]) => Promise<any>;
        };
      }).client;
      // Simulate a private draft left by an older/in-flight authoring build.
      // The public API correctly refuses creating one after Agnes has started,
      // while final upload cleanup must still remove any pre-existing row.
      await client.execute({
        sql: `INSERT INTO episode_script_drafts
                (episode_id, revision, script_digest, draft_json)
              VALUES (?, 1, ?, ?)`,
        args: [
          1,
          "0".repeat(64),
          JSON.stringify({ title: "Private authoring draft", scenes: [] }),
        ],
      });
      const originalBatch = client.batch.bind(client);
      client.batch = async () => {
        throw new Error("simulated cleanup transaction outage");
      };
      try {
        await expect(state.finalizeEpisodeUpload({
          seriesId: 1,
          episodeNumber: 2,
          videoId: "youtube-123",
          url: "https://www.youtube.com/watch?v=youtube-123",
        })).rejects.toThrow("simulated cleanup transaction outage");
      } finally {
        client.batch = originalBatch;
      }
      expect(await state.getYoutubeUploadReceipt(1, 2)).toMatchObject({
        videoId: "youtube-123",
      });
      expect((await state.getEpisodeByNumber(1, 2))?.uploadedAt).toBeNull();
      expect(await state.getEpisodeScriptDraft(1)).not.toBeNull();

      // Simulate retrying local finalization after midnight. The first durable
      // outbox time, not recovery time, must remain the episode completion day.
      await (client as unknown as {
        execute(statement: { sql: string; args: unknown[] }): Promise<unknown>;
      }).execute({
        sql: `UPDATE youtube_upload_receipts
              SET created_at = '2026-09-04 18:29:00'
              WHERE series_id = 1 AND episode_number = 2`,
        args: [],
      });

      const finalized = await state.finalizeEpisodeUpload({
        seriesId: 1,
        episodeNumber: 2,
        videoId: "youtube-123",
        url: "https://www.youtube.com/watch?v=youtube-123",
      });
      expect(finalized).toMatchObject({
        status: "done",
        outputPath: finalPath,
        scriptJson: null,
        youtubeVideoId: "youtube-123",
        uploadedAt: "2026-09-04 18:29:00",
        completedAt: "2026-09-04 18:29:00",
        completionLocalDate: "2026-09-04",
      });
      expect(await state.listAgnesSceneGenerations(1, 2)).toEqual([]);
      expect(await state.listEpisodeVideoOutputs(1, 2)).toEqual([]);
      expect(await state.getEpisodeScriptDraft(1)).toBeNull();
      expect(await state.getKeyArt(1, "series", null)).toBeNull();
      expect(await state.getCharacterSheet(1, "Pip")).not.toBeNull();
      expect(await state.getYoutubeUploadReceipt(1, 2)).toBeNull();
      expect(await state.getNextEpisode(1, {
        now: new Date("2026-09-05T12:00:00.000Z"),
        timeZone: "Asia/Kolkata",
      })).toBeNull();

      const repeated = await state.finalizeEpisodeUpload({
        seriesId: 1,
        episodeNumber: 2,
        videoId: "youtube-123",
        url: "https://www.youtube.com/watch?v=youtube-123",
      });
      expect(repeated.youtubeVideoId).toBe("youtube-123");
    } finally {
      (CONFIG as { outputDir: string }).outputDir = previousOutputDir;
      (CONFIG as { ffprobePath: string }).ffprobePath = previousFfprobePath;
      (CONFIG as { episodeDailyTimezone: string }).episodeDailyTimezone = previousDailyTimezone;
    }
  });
});
