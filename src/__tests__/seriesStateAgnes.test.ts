import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG } from "../config.js";
import { SeriesState } from "../state/seriesState.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  agnesKeyArtPaths,
} from "../services/agnesKeyArtService.js";
import {
  NARRATION_METADATA_KIND,
  NARRATION_METADATA_SCHEMA_VERSION,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
} from "../tools/ttsTool.js";

const openStates: SeriesState[] = [];

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
      sceneDetails: "Pip remains fully visible beside the same berry and clubhouse while his friends watch warmly.",
      cameraAngle: "medium wide shot at child eye level",
      lighting: "warm soft morning sunlight",
    })),
  };
}

afterEach(async () => {
  await Promise.all(openStates.splice(0).map((state) => state.close()));
});

describe("SeriesState Agnes persistence", () => {
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
      seed: 777,
      requestedDurationSeconds: 7.5,
      providerDurationSeconds: 8,
      providerReceipt: { state: "submitting", claimToken: "stale-claim" },
    }, 2);
    expect(staleClaim.claimed).toBe(false);
    expect(staleClaim.row.status).toBe("completed");

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
    const claimInput = {
      seriesId: 1,
      episodeNumber: 2,
      sceneNumber: 1,
      variant: "text" as const,
      prompt: "Animate the meadow scene.",
      requestDigest: "digest-old",
      seed: 44,
      requestedDurationSeconds: 6,
      providerDurationSeconds: 6,
      providerReceipt: {
        version: 1,
        segments: [{ state: "submitting", claimToken: "claim-1" }],
      },
    };

    const claims = await Promise.all([
      state.claimAgnesSceneSubmission(claimInput, 0),
      state.claimAgnesSceneSubmission(claimInput, 0),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.every((claim) => claim.row.attemptCount === 1)).toBe(true);
    expect(claims.every((claim) => claim.row.requestDigest === "digest-old")).toBe(true);
    expect(claims.every((claim) => Boolean(claim.row.submittedAt))).toBe(true);

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
    expect(secondClaim.row.attemptCount).toBe(2);
    expect(secondClaim.row.providerReceipt).toEqual(secondClaimInput.providerReceipt);

    const staleSecondClaim = await state.claimAgnesSceneSubmission(secondClaimInput, 1);
    expect(staleSecondClaim.claimed).toBe(false);
    expect(staleSecondClaim.row.attemptCount).toBe(2);

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
      action: `Pip carries the berry through visible beat ${index + 1}.`,
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
      sceneDetails: "Pip stays fully visible beside the same berry path while taking one careful, readable step.",
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
      await state.upsertAgnesSceneGeneration({
        seriesId: 1,
        episodeNumber: 2,
        sceneNumber: scene.sceneNumber,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        prompt: `Complete animation ${scene.sceneNumber}`,
        requestDigest: `digest-${scene.sceneNumber}`,
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
      await state.upsertAgnesSceneGeneration({
        seriesId: 1,
        episodeNumber: 2,
        sceneNumber: spec.trackingSceneNumber,
        variant: "text",
        status: "completed",
        downloadStatus: "downloaded",
        prompt: `${spec.kind} key-art animation`,
        requestDigest: `${spec.kind}-key-art-digest`,
        requestedDurationSeconds: 7.5,
        providerDurationSeconds: 8,
        normalizedOutputPath: paths.normalizedVideoPath,
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
          batch: (...args: any[]) => Promise<any>;
        };
      }).client;
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
