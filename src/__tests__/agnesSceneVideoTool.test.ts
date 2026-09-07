import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { materializeScenePromptMock } = vi.hoisted(() => ({
  materializeScenePromptMock: vi.fn(async () => ({
    prompt: "CANONICAL SCENE PROMPT WITH LOCKED CHARACTER AND CONTINUITY ANCHORS",
    characterNames: ["Pip the Ant"],
    characterDescriptions: ["small ruby-red ant, yellow backpack"],
  })),
}));

vi.mock("../config.js", () => ({
  CONFIG: {
    outputDir: "",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    agnesAccounts: [{
      accountId: "test-account",
      apiKey: "test-agnes-key",
      keyLabel: "key-1",
      keyFingerprint: "a".repeat(64),
    }],
    agnesApiKeys: ["test-agnes-key"],
    agnesBaseUrl: "https://apihub.agnes-ai.com",
    agnesRequestTimeoutMs: 60_000,
    // Keep unit tests fast; production defaults to a 30-second per-account gate.
    agnesPollIntervalMs: 1,
    agnesPollWindowMs: 480_000,
    agnesQueuePollIntervalMs: 30_000,
    agnesQueuePollWindowMs: 300_000,
    agnesSubmissionBatchSize: 2,
    agnesSubmissionRpmPerAccount: 2,
    agnesStatusRpmPerAccount: 2,
    agnesMaxDownloadBytes: 500_000_000,
    agnesSubmissionIntervalMs: 60_000,
    agnesSeed: undefined,
    groqTtsModel: "canopylabs/orpheus-v1-english",
    groqTtsVoice: "hannah",
  },
}));

vi.mock("../services/scenePromptService.js", () => ({
  materializeScenePrompt: materializeScenePromptMock,
}));

import { CONFIG } from "../config.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  agnesKeyArtPaths,
  type AgnesKeyArtAudioAsset,
} from "../services/agnesKeyArtService.js";
import { CHARACTER_INTEGRITY_NEGATIVE_BIBLE } from "../promptBuilder.js";
import { AgnesError, type AgnesSubmitVideoRequest, type AgnesVideoTask } from "../providers/agnes/index.js";
import { ProductionScriptContractError } from "../services/productionScriptContract.js";
import {
  EpisodeAudioMutationInProgressError,
  EpisodeAudioReadinessError,
  type AgnesSceneGenerationRow,
  type UpsertAgnesSceneGenerationInput,
} from "../state/seriesState.js";
import {
  AGNES_PROGRESS_LOG_PREFIX,
  buildAgnesSceneVideoTools as buildAgnesSceneVideoToolsImpl,
  buildAgnesVideoPrompt,
  AGNES_NORMALIZATION_VERSION,
  AGNES_STALE_SUBMISSION_LEASE_MS,
  MIN_PRODUCTION_STATUS_INTERVAL_MS,
  buildDownloadAgnesSceneVideosTool as buildDownloadAgnesSceneVideosToolImpl,
  buildSubmitAgnesSceneVideosTool as buildSubmitAgnesSceneVideosToolImpl,
  buildVerifyAgnesSceneVideosTool as buildVerifyAgnesSceneVideosToolImpl,
  planAgnesVideoSegments,
  resolveStatusRequestIntervalMs,
} from "../tools/agnesSceneVideoTool.js";
import {
  NARRATION_METADATA_KIND,
  NARRATION_METADATA_SCHEMA_VERSION,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
} from "../tools/ttsTool.js";

const withFastRequestGates = (options: Record<string, unknown> = {}) => ({
  submissionIntervalMs: 0,
  statusRequestIntervalMs: 0,
  // Most focused tests exercise numbered scenes only. Production/exported
  // builders include both direct key-art clips unless callers explicitly opt out.
  includeKeyArt: false,
  ...options,
});
const buildAgnesSceneVideoTools = (state: any, options: Record<string, unknown> = {}) => (
  buildAgnesSceneVideoToolsImpl(state, withFastRequestGates(options))
);
const buildSubmitAgnesSceneVideosTool = (state: any, options: Record<string, unknown> = {}) => (
  buildSubmitAgnesSceneVideosToolImpl(state, withFastRequestGates(options))
);
const buildVerifyAgnesSceneVideosTool = (state: any, options: Record<string, unknown> = {}) => (
  buildVerifyAgnesSceneVideosToolImpl(state, withFastRequestGates(options))
);
const buildDownloadAgnesSceneVideosTool = (state: any, options: Record<string, unknown> = {}) => (
  buildDownloadAgnesSceneVideosToolImpl(state, withFastRequestGates(options))
);

function task(videoId: string, status: AgnesVideoTask["status"]): AgnesVideoTask {
  return {
    id: `task-${videoId}`,
    task_id: `task-${videoId}`,
    video_id: videoId,
    model: "agnes-video-2.5-flash",
    status,
    progress: status === "completed" ? 100 : status === "in_progress" ? 50 : 0,
    keyLabel: "key-1",
    keyFingerprint: "a".repeat(64),
    ...(status === "completed" ? { metadata: { url: `https://media.example.test/${videoId}.mp4` } } : {}),
  };
}

function accountTask(
  videoId: string,
  status: AgnesVideoTask["status"],
  keyLabel: string,
  keyFingerprint: string,
): AgnesVideoTask {
  return { ...task(videoId, status), keyLabel, keyFingerprint };
}

function rowFrom(input: UpsertAgnesSceneGenerationInput, id: number, prior?: AgnesSceneGenerationRow): AgnesSceneGenerationRow {
  return {
    id,
    seriesId: input.seriesId,
    episodeNumber: input.episodeNumber,
    sceneNumber: input.sceneNumber,
    variant: input.variant,
    status: input.status,
    prompt: input.prompt,
    requestDigest: input.requestDigest ?? prior?.requestDigest ?? null,
    attemptCount: input.attemptCount ?? prior?.attemptCount ?? 0,
    seed: input.seed ?? prior?.seed ?? null,
    requestedDurationSeconds: input.requestedDurationSeconds,
    providerDurationSeconds: input.providerDurationSeconds,
    publicReferenceUrl: input.publicReferenceUrl ?? prior?.publicReferenceUrl ?? null,
    providerTaskId: input.providerTaskId ?? prior?.providerTaskId ?? null,
    providerReceipt: input.providerReceipt ?? prior?.providerReceipt ?? null,
    providerVideoUrl: input.providerVideoUrl ?? prior?.providerVideoUrl ?? null,
    rawOutputPath: input.rawOutputPath ?? prior?.rawOutputPath ?? null,
    normalizedOutputPath: input.normalizedOutputPath ?? prior?.normalizedOutputPath ?? null,
    downloadStatus: input.downloadStatus ?? prior?.downloadStatus ?? "pending",
    error: input.error === undefined ? prior?.error ?? null : input.error,
    submittedAt: input.submittedAt ?? prior?.submittedAt ?? (input.status === "submitted" ? new Date().toISOString() : null),
    completedAt: input.completedAt ?? prior?.completedAt ?? null,
    createdAt: prior?.createdAt ?? "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

function mockState(sceneCount: number) {
  const rows = new Map<number, AgnesSceneGenerationRow>();
  const rateRows = new Map<string, {
    accountId: string;
    lane: string;
    nextSlotAtMs: number;
    blockedUntilMs: number;
    blockReason: string | null;
    updatedAtMs: number;
  }>();
  let nextId = 0;
  let persistedSeriesSeed: number | undefined;
  const scenes = Array.from({ length: sceneCount }, (_unused, index) => ({
    sceneNumber: index + 1,
    narrationText: `Pip narrates scene ${index + 1}.`,
    environmentDescription: "A warm flower-filled meadow.",
    action: "Pip waves and takes one careful step.",
    characterNames: ["Pip the Ant"],
    continuityAnchors: ["The same yellow flower stands beside Pip."],
  }));
  const state = {
    getEpisodeAudioRevisionForAgnes: vi.fn(async () => 0),
    getOrCreateSeriesAgnesSeed: vi.fn(async (_seriesId: number, preferredCandidate?: number) => {
      persistedSeriesSeed ??= preferredCandidate ?? 1_357_911;
      return persistedSeriesSeed;
    }),
    getEpisodeByNumber: vi.fn(async () => ({ id: 72, scriptJson: { scenes } })),
    assertEpisodeAudioReady: vi.fn(async () => ({ totalDurationSeconds: 300 })),
    assertEpisodeKeyArtAudioReady: vi.fn(async () => undefined),
    getAgnesSceneGeneration: vi.fn(async (_series: number, _episode: number, scene: number) => rows.get(scene) ?? null),
    listAgnesSceneGenerations: vi.fn(async () => [...rows.values()].sort(
      (left, right) => left.sceneNumber - right.sceneNumber,
    )),
    upsertAgnesSceneGeneration: vi.fn(async (input: UpsertAgnesSceneGenerationInput) => {
      const prior = rows.get(input.sceneNumber);
      const row = rowFrom(input, prior?.id ?? ++nextId, prior);
      rows.set(input.sceneNumber, row);
      return row;
    }),
    claimAgnesSceneSubmission: vi.fn(async (input: any, expected: number) => {
      const prior = rows.get(input.sceneNumber);
      if (!prior) return { claimed: false, reason: "missing", row: null };
      if (prior.attemptCount !== expected || prior.requestDigest !== input.requestDigest) {
        return { claimed: false, reason: "conflict", row: prior };
      }
      const row = rowFrom({ ...input, status: "pending", attemptCount: expected + 1 }, prior.id, prior);
      rows.set(input.sceneNumber, row);
      return { claimed: true, row };
    }),
    resetAgnesSceneGenerationForRequest: vi.fn(async (input: any) => {
      const prior = rows.get(input.sceneNumber);
      const row = rowFrom({ ...input, status: "pending", attemptCount: 0, downloadStatus: "pending" }, prior?.id ?? ++nextId);
      rows.set(input.sceneNumber, row);
      return { reset: true, row };
    }),
    reserveAgnesAccountRateSlot: vi.fn(async ({
      accountId,
      lane,
      intervalMs,
      nowMs = Date.now(),
    }: {
      accountId: string;
      lane: string;
      intervalMs: number;
      nowMs?: number;
    }) => {
      const key = `${accountId}:${lane}`;
      const prior = rateRows.get(key);
      const scheduledAtMs = Math.max(
        nowMs,
        prior?.nextSlotAtMs ?? 0,
        prior?.blockedUntilMs ?? 0,
      );
      const row = {
        accountId,
        lane,
        nextSlotAtMs: scheduledAtMs + intervalMs,
        blockedUntilMs: prior?.blockedUntilMs ?? 0,
        blockReason: prior?.blockedUntilMs && prior.blockedUntilMs > nowMs
          ? prior.blockReason
          : null,
        updatedAtMs: nowMs,
      };
      rateRows.set(key, row);
      return { ...row, scheduledAtMs };
    }),
    getAgnesAccountRateState: vi.fn(async (accountId: string, lane: string) => (
      rateRows.get(`${accountId}:${lane}`) ?? null
    )),
    blockAgnesAccountRateLane: vi.fn(async ({
      accountId,
      lane,
      blockedUntilMs,
      blockReason = null,
      nowMs = Date.now(),
    }: {
      accountId: string;
      lane: string;
      blockedUntilMs: number;
      blockReason?: string | null;
      nowMs?: number;
    }) => {
      const key = `${accountId}:${lane}`;
      const prior = rateRows.get(key);
      const useNewBlock = blockedUntilMs >= (prior?.blockedUntilMs ?? 0);
      const row = {
        accountId,
        lane,
        nextSlotAtMs: prior?.nextSlotAtMs ?? 0,
        blockedUntilMs: Math.max(prior?.blockedUntilMs ?? 0, blockedUntilMs),
        blockReason: useNewBlock ? blockReason : prior?.blockReason ?? null,
        updatedAtMs: Math.max(prior?.updatedAtMs ?? 0, nowMs),
      };
      rateRows.set(key, row);
      return row;
    }),
  };
  return { state, rows };
}

async function addAudioFiles(outputDir: string, count: number, durationSeconds = 5.2): Promise<void> {
  const audioDir = path.join(outputDir, "series_7", "episode_2", "audio");
  await mkdir(audioDir, { recursive: true });
  await Promise.all(Array.from({ length: count }, async (_unused, index) => {
    const sceneNumber = index + 1;
    const text = `Pip narrates scene ${sceneNumber}.`;
    const audioPath = path.join(
      audioDir,
      `scene_${String(sceneNumber).padStart(3, "0")}_narrator.wav`,
    );
    await writeFile(audioPath, "wav");
    await writeFile(narrationAudioMetadataPath(audioPath), JSON.stringify({
      schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
      kind: NARRATION_METADATA_KIND,
      requestDigest: createNarrationAudioRequestDigest({
        text,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      }),
      model: CONFIG.groqTtsModel,
      voice: CONFIG.groqTtsVoice,
      responseFormat: "wav",
      textLength: text.length,
      spokenWordCount: 4,
      durationSeconds,
      durationStatus: "ready",
    }), "utf8");
  }));
}

describe("three-phase Agnes scene workflow", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-scenes-"));
    (CONFIG as { outputDir: string }).outputDir = outputDir;
    materializeScenePromptMock.mockClear();
  });

  it("enforces a 30-second production status interval even if env configuration is lower", () => {
    expect(resolveStatusRequestIntervalMs(undefined, 1_000))
      .toBe(MIN_PRODUCTION_STATUS_INTERVAL_MS);
    expect(resolveStatusRequestIntervalMs(undefined, 45_000)).toBe(45_000);
  });

  it("logs safe per-asset progress across submission, queue polling, verification, and download", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state } = mockState(1);
    let retrievalCount = 0;
    const client = {
      submitVideo: vi.fn(async () => task("video-progress-log", "submitted")),
      retrieveVideo: vi.fn(async (input: AgnesVideoTask) => {
        retrievalCount += 1;
        return task(input.video_id, retrievalCount === 1 ? "queued" : "completed");
      }),
      downloadCompletedVideo: vi.fn(async (input: AgnesVideoTask, outputPath: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.alloc(2_048, 1));
        return {
          outputPath,
          url: input.metadata!.url!,
          bytes: 2_048,
          sha256: "b".repeat(64),
        };
      }),
    };
    const normalizeVideo = vi.fn(async ({ outputPath }: { outputPath: string }) => {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.alloc(2_048, 2));
    });
    const [submit, verify, download] = buildAgnesSceneVideoTools(state as never, {
      client,
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      queuePollIntervalMs: 1,
      queuePollWindowMs: 100,
      probeMediaDuration: vi.fn(async () => 5),
      normalizeVideo,
    });
    const captured: unknown[][] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      captured.push(args);
    });

    try {
      await (submit as any).func({ seriesId: 7, episodeNumber: 2 });
      await (verify as any).func({ seriesId: 7, episodeNumber: 2 });
      await (download as any).func({ seriesId: 7, episodeNumber: 2 });
    } finally {
      logSpy.mockRestore();
    }

    const progressCalls = captured.filter(([message]) => (
      typeof message === "string" && message.startsWith(`${AGNES_PROGRESS_LOG_PREFIX} `)
    ));
    const events = progressCalls.map(([message]) => (
      (message as string).slice(AGNES_PROGRESS_LOG_PREFIX.length + 1)
    ));
    expect(events).toEqual(expect.arrayContaining([
      "phase_start",
      "prepared",
      "submission_start",
      "submission_accepted",
      "queue_poll_wait",
      "queue_poll_result",
      "submission_result",
      "verify_status_start",
      "verify_status_result",
      "download_start",
      "download_raw_complete",
      "download_normalized",
      "phase_summary",
    ]));

    const submissionStart = progressCalls.find(([message]) => (
      message === `${AGNES_PROGRESS_LOG_PREFIX} submission_start`
    ));
    expect(submissionStart?.[1]).toMatchObject({
      accountId: "injected-account",
      attemptNumber: 1,
    });
    expect(submissionStart?.[1]).toHaveProperty("assetLabel");
    const submitPhaseStart = progressCalls.find(([message, metadata]) => (
      message === `${AGNES_PROGRESS_LOG_PREFIX} phase_start`
      && (metadata as { phase?: unknown } | undefined)?.phase === "submit"
    ));
    expect(submitPhaseStart?.[1]).toMatchObject({
      seriesId: 7,
      episodeNumber: 2,
      accountCount: 1,
    });

    const serializedLogs = JSON.stringify(progressCalls);
    expect(serializedLogs).not.toContain("test-agnes-key");
    expect(serializedLogs).not.toContain("a".repeat(64));
    expect(serializedLogs).not.toContain("CANONICAL SCENE PROMPT");
    expect(serializedLogs).not.toContain("https://media.example.test");
  });

  it("returns repair_required from every Agnes phase for a typed invalid-script preflight", async () => {
    const { state } = mockState(1);
    const contractError = new ProductionScriptContractError({
      pass: false,
      sceneCount: 31,
      totalSpokenWords: 620,
      issues: Array.from({ length: 20 }, (_unused, index) => `Issue ${index + 1}`),
    });
    state.assertEpisodeAudioReady.mockRejectedValue(contractError);
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tools = buildAgnesSceneVideoTools(state as never, { client });

    for (const [index, phase] of ["submit", "verify", "download"].entries()) {
      const result = JSON.parse(await (tools[index] as any).func({
        seriesId: 7,
        episodeNumber: 2,
      }));
      expect(result).toMatchObject({
        status: "repair_required",
        phase,
        stopRun: false,
        scriptValidation: {
          issueCount: 20,
          omittedIssueCount: 8,
          canReplaceScript: true,
          agnesSubmissionStarted: false,
        },
      });
      expect(result.scriptValidation.issues).toHaveLength(12);
    }
    expect(client.submitVideo).not.toHaveBeenCalled();
    expect(client.retrieveVideo).not.toHaveBeenCalled();
    expect(client.downloadCompletedVideo).not.toHaveBeenCalled();
  });

  it("returns repair_blocked when an invalid script already has durable Agnes work", async () => {
    const { state } = mockState(1);
    state.assertEpisodeAudioReady.mockRejectedValue(new ProductionScriptContractError({
      pass: false,
      sceneCount: 31,
      totalSpokenWords: 620,
      issues: ["Scene count 31 is below the production minimum of 40."],
    }));
    state.listAgnesSceneGenerations.mockResolvedValue([{
      status: "queued",
      attemptCount: 1,
      providerTaskId: "agnes-task-1",
      providerReceipt: { video_id: "agnes-task-1", status: "queued" },
      submittedAt: "2026-09-05T10:00:00.000Z",
    }] as any);
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosTool(state as never, { client });

    const result = JSON.parse(await (tool as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({
      status: "repair_blocked",
      phase: "submit",
      stopRun: true,
      scriptValidation: {
        canReplaceScript: false,
        agnesSubmissionStarted: true,
        startedAssetCount: 1,
      },
    });
    expect(client.submitVideo).not.toHaveBeenCalled();
  });

  it.each([
    { started: false, status: "audio_repair_required", stopRun: false },
    { started: true, status: "audio_repair_blocked", stopRun: true },
  ])("returns $status for typed local audio drift with started=$started", async ({
    started,
    status,
    stopRun,
  }) => {
    const { state } = mockState(1);
    state.assertEpisodeAudioReady.mockRejectedValue(new EpisodeAudioReadinessError({
      reason: "artifact_missing_or_stale",
      sceneNumber: 1,
      message: "Scene 1 narration is missing.",
    }));
    if (started) {
      state.listAgnesSceneGenerations.mockResolvedValue([{
        status: "queued",
        attemptCount: 1,
        providerTaskId: "task-1",
        providerReceipt: { video_id: "task-1" },
        submittedAt: "2026-09-05T10:00:00.000Z",
      }] as any);
    }
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosTool(state as never, { client });

    const result = JSON.parse(await (tool as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({
      status,
      phase: "submit",
      stopRun,
      audioValidation: {
        reason: "artifact_missing_or_stale",
        sceneNumber: 1,
      },
      startedAssetCount: started ? 1 : 0,
    });
    expect(client.submitVideo).not.toHaveBeenCalled();
  });

  it("defers Agnes cleanly while another narration or key-art writer owns the episode lease", async () => {
    const { state } = mockState(1);
    state.getEpisodeAudioRevisionForAgnes.mockRejectedValue(
      new EpisodeAudioMutationInProgressError(2_147_483_647, 9_999_999),
    );
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosTool(state as never, { client });

    const result = JSON.parse(await (tool as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({
      status: "audio_mutation_deferred",
      phase: "submit",
      stopRun: true,
      audioValidation: {
        status: "mutation_deferred",
        reason: "mutation_in_progress",
        sceneNumber: 2_147_483_647,
      },
    });
    expect(client.submitVideo).not.toHaveBeenCalled();
  });

  it("blocks missing key-art audio before mutating it when an Agnes receipt exists", async () => {
    const { state } = mockState(1);
    state.listAgnesSceneGenerations.mockResolvedValue([{
      status: "queued",
      attemptCount: 1,
      providerTaskId: "task-1",
      providerReceipt: { video_id: "task-1" },
      submittedAt: "2026-09-05T10:00:00.000Z",
    }] as any);
    state.assertEpisodeKeyArtAudioReady.mockRejectedValue(
      new EpisodeAudioReadinessError({
        reason: "artifact_missing_or_stale",
        assetKind: "series_key_art",
        message: "Series title audio is missing.",
      }),
    );
    const ensureKeyArtAudioAssets = vi.fn();
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      ensureKeyArtAudioAssets,
    });

    const result = JSON.parse(await (tool as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({
      status: "audio_repair_blocked",
      stopRun: true,
      audioValidation: {
        reason: "artifact_missing_or_stale",
        assetKind: "series_key_art",
      },
      startedAssetCount: 1,
    });
    expect(ensureKeyArtAudioAssets).not.toHaveBeenCalled();
    expect(client.submitVideo).not.toHaveBeenCalled();
  });

  it("does not swallow unrelated audio preflight errors", async () => {
    const { state } = mockState(1);
    state.assertEpisodeAudioReady.mockRejectedValue(new Error("scene 1 narration WAV is missing"));
    const tool = buildSubmitAgnesSceneVideosTool(state as never, {
      client: {
        submitVideo: vi.fn(),
        retrieveVideo: vi.fn(),
        downloadCompletedVideo: vi.fn(),
      },
    });

    await expect((tool as any).func({ seriesId: 7, episodeNumber: 2 }))
      .rejects.toThrow("scene 1 narration WAV is missing");
  });

  it("rejects a preparation snapshot when narration audio changes during media reads", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state } = mockState(1);
    state.getEpisodeAudioRevisionForAgnes
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(9);
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5),
    });

    await expect((tool as any).func({ seriesId: 7, episodeNumber: 2 }))
      .rejects.toThrow("changed during Agnes preparation (revision 8 -> 9)");
    expect(state.claimAgnesSceneSubmission).not.toHaveBeenCalled();
    expect(client.submitVideo).not.toHaveBeenCalled();
  });

  it("binds every outbound claim to the audio revision rechecked after preparation", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state } = mockState(1);
    state.getEpisodeAudioRevisionForAgnes.mockResolvedValue(17);
    const client = {
      submitVideo: vi.fn(async () => task("revision-bound", "queued")),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5),
    });

    await (tool as any).func({ seriesId: 7, episodeNumber: 2 });

    expect(state.getEpisodeAudioRevisionForAgnes).toHaveBeenCalledTimes(2);
    expect(state.claimAgnesSceneSubmission).toHaveBeenCalledWith(
      expect.objectContaining({ expectedEpisodeAudioRevision: 17 }),
      0,
    );
    expect(client.submitVideo).toHaveBeenCalledOnce();
  });

  it("submits both key-art videos by default before the numbered scene manifest", async () => {
    await addAudioFiles(outputDir, 1);
    const { state, rows } = mockState(1);
    // Simulate ensureKeyArtAudioAssets committing revision 1 after the initial
    // stable snapshot at revision 0.
    state.getEpisodeAudioRevisionForAgnes
      .mockResolvedValueOnce(0)
      .mockResolvedValue(1);
    const roster = [
      { name: "Pip the Ant", description: "A small red ant." },
      { name: "Bobo the Backpack", description: "A friendly blue talking backpack." },
    ];
    const approvedSheets = new Map<string, { approvedAt: string; generationPrompt: string }>([[
      "Pip the Ant",
      {
        approvedAt: "2026-09-05T00:00:00.000Z",
        generationPrompt: "tiny ruby-red ant with six legs, bright eyes, and one yellow backpack",
      },
    ]]);
    Object.assign(state, {
      getSeriesInfo: vi.fn(async () => ({
        conceptName: "  Tiny Heroes Club  ",
        episodeFormula: "Small friends solve gentle problems together.",
        charactersJson: roster,
      })),
      getSeriesCharacters: vi.fn(async () => roster),
      getCharacterSheet: vi.fn(async (_seriesId: number, name: string) => approvedSheets.get(name) ?? null),
    });
    const ensureCompleteRoster = vi.fn(async ({ seriesId }: { seriesId: number }) => {
      approvedSheets.set("Bobo the Backpack", {
        approvedAt: "2026-09-06T00:00:00.000Z",
        generationPrompt: "friendly cobalt-blue backpack, amber eyes, yellow zipper. Always same colors.",
      });
      return {
        seriesId,
        rosterCount: 2,
        generatedCount: 1,
        reusedCount: 1,
        characters: [],
      };
    });
    const ensureKeyArtAudioAssets = vi.fn(async () => {
      expect(approvedSheets.has("Bobo the Backpack")).toBe(true);
      const seriesPaths = agnesKeyArtPaths({ outputDir, seriesId: 7, episodeNumber: 2, kind: "series" });
      const episodePaths = agnesKeyArtPaths({ outputDir, seriesId: 7, episodeNumber: 2, kind: "episode" });
      await Promise.all([
        mkdir(seriesPaths.directory, { recursive: true }),
        mkdir(episodePaths.directory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(seriesPaths.audioPath, "series-title-audio"),
        writeFile(episodePaths.audioPath, "episode-title-audio"),
      ]);
      return [
        { ...seriesPaths, text: "Tiny Heroes Club", durationSeconds: 2.25, requestDigest: "series-audio" },
        { ...episodePaths, text: "Pip's Berry Bridge", durationSeconds: 3.25, requestDigest: "episode-audio" },
      ] as [AgnesKeyArtAudioAsset, AgnesKeyArtAudioAsset];
    });
    (state.getEpisodeByNumber as any).mockResolvedValue({
      id: 72,
      title: "  Pip's Berry Bridge  ",
      premise: "Pip carries a bright berry over a tiny stream.",
      scriptJson: {
        scenes: [{
          sceneNumber: 1,
          narrationText: "Pip narrates scene 1.",
          environmentDescription: "A warm flower-filled meadow.",
          action: "Pip waves and takes one careful step.",
          characterNames: ["Pip the Ant"],
          continuityAnchors: ["The same yellow flower stands beside Pip."],
        }],
      },
    });
    let submitted = 0;
    const client = {
      submitVideo: vi.fn(async () => {
        expect(ensureCompleteRoster).toHaveBeenCalledOnce();
        return task(`title-or-scene-${++submitted}`, "queued");
      }),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosToolImpl(state as never, {
      client,
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      ensureKeyArtAudioAssets,
      ensureSeriesCharacterSheets: ensureCompleteRoster as any,
      probeMediaDuration: vi.fn(async () => 5.2),
    });

    const result = JSON.parse(await (tool as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result.status).toBe("submitted");
    expect(result.assetCount).toBe(3);
    expect(result.keyArtCount).toBe(2);
    expect(result.sceneCount).toBe(1);
    expect(ensureCompleteRoster).toHaveBeenCalledWith(expect.objectContaining({
      seriesId: 7,
      roster,
    }));
    expect(client.submitVideo).toHaveBeenCalledTimes(3);
    expect(state.getEpisodeAudioRevisionForAgnes).toHaveBeenCalledTimes(3);
    expect(state.claimAgnesSceneSubmission.mock.calls.every(
      ([input]: [any, number]) => input.expectedEpisodeAudioRevision === 1,
    )).toBe(true);
    expect(ensureKeyArtAudioAssets).toHaveBeenCalledWith(expect.objectContaining({
      seriesTitle: "Tiny Heroes Club",
      episodeTitle: "Pip's Berry Bridge",
    }));
    expect([...rows.keys()]).toEqual([
      AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      1,
    ]);
    expect(rows.get(AGNES_SERIES_KEY_ART_TRACKING_SCENE)?.prompt).toContain("Tiny Heroes Club");
    expect(rows.get(AGNES_EPISODE_KEY_ART_TRACKING_SCENE)?.prompt).toContain("Pip's Berry Bridge");
    for (const sceneNumber of [
      AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
    ]) {
      const prompt = rows.get(sceneNumber)?.prompt ?? "";
      expect(prompt).not.toMatch(/\b(?:poster|thumbnail|cover|image)\b/i);
      const sections = [
        "SUBJECT AND SETTING",
        "ACTION AND CHANGE",
        "CAMERA",
        "VISUAL STYLE",
        "SOUND AND RHYTHM",
        "CONSISTENCY REQUIREMENTS",
      ].map((section) => prompt.indexOf(section));
      expect(sections).toEqual([...sections].sort((left, right) => left - right));
      expect(prompt).toContain("No flicker, jitter, strobing");
    }
    for (const sceneNumber of [
      AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      1,
    ]) {
      const prompt = rows.get(sceneNumber)?.prompt ?? "";
      expect(prompt).toContain("No duplicate characters");
      expect(prompt).toContain("No extra limbs");
      expect(prompt).toContain("No double heads");
      expect(prompt.split(CHARACTER_INTEGRITY_NEGATIVE_BIBLE)).toHaveLength(2);
    }
    expect([...rows.values()].every(({ seed }) => seed === 1_357_911)).toBe(true);
  });

  it("repairs the complete roster before the first Agnes provider claim", async () => {
    const { state } = mockState(1);
    const roster = [
      { name: "Mia", description: "A child explorer in a teal jacket." },
      { name: "Bobo the Backpack", description: "A friendly blue talking backpack." },
    ];
    Object.assign(state, {
      getSeriesInfo: vi.fn(async () => ({
        conceptName: "Tiny Heroes Club",
        episodeFormula: "Small friends solve gentle problems together.",
        charactersJson: roster,
      })),
      getSeriesCharacters: vi.fn(async () => roster),
      getCharacterSheet: vi.fn(async () => null),
    });
    const rosterFailure = new Error("portrait provider temporarily unavailable for Bobo");
    const ensureCompleteRoster = vi.fn(async () => { throw rosterFailure; });
    const ensureKeyArtAudioAssets = vi.fn();
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosToolImpl(state as never, {
      client,
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      ensureSeriesCharacterSheets: ensureCompleteRoster,
      ensureKeyArtAudioAssets,
    });

    await expect((tool as any).func({ seriesId: 7, episodeNumber: 2 }))
      .rejects.toBe(rosterFailure);
    expect(ensureCompleteRoster).toHaveBeenCalledOnce();
    expect(ensureCompleteRoster).toHaveBeenCalledWith(expect.objectContaining({
      seriesId: 7,
      roster,
    }));
    expect(ensureKeyArtAudioAssets).not.toHaveBeenCalled();
    expect(state.claimAgnesSceneSubmission).not.toHaveBeenCalled();
    expect(client.submitVideo).not.toHaveBeenCalled();
  });

  it("keeps character identity read-only after an Agnes claim exists", async () => {
    const { state } = mockState(1);
    state.listAgnesSceneGenerations.mockResolvedValue([{
      status: "queued",
      attemptCount: 1,
      providerTaskId: "locked-task",
      providerReceipt: { video_id: "locked-task", status: "queued" },
      submittedAt: "2026-09-05T10:00:00.000Z",
    }] as any);
    const roster = [{
      name: "Bobo the Backpack",
      description: "A friendly blue talking backpack.",
    }];
    Object.assign(state, {
      getSeriesInfo: vi.fn(async () => ({
        conceptName: "Tiny Heroes Club",
        episodeFormula: "Small friends solve gentle problems together.",
        charactersJson: roster,
      })),
      getSeriesCharacters: vi.fn(async () => roster),
      getCharacterSheet: vi.fn(async () => null),
    });
    const ensureCompleteRoster = vi.fn();
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildVerifyAgnesSceneVideosToolImpl(state as never, {
      client,
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      ensureSeriesCharacterSheets: ensureCompleteRoster,
    });

    await expect((tool as any).func({ seriesId: 7, episodeNumber: 2 }))
      .rejects.toThrow("after Agnes submission already started");
    expect(ensureCompleteRoster).not.toHaveBeenCalled();
    expect(client.submitVideo).not.toHaveBeenCalled();
    expect(client.retrieveVideo).not.toHaveBeenCalled();
  });

  it("uses one persisted series seed for every scene request and reuses it after a rerun", async () => {
    await addAudioFiles(outputDir, 3);
    const { state, rows } = mockState(3);
    const firstRunRequests: AgnesSubmitVideoRequest[] = [];
    const queueFullClient = {
      submitVideo: vi.fn(async (request: AgnesSubmitVideoRequest) => {
        firstRunRequests.push(request);
        throw new AgnesError("queue full", { kind: "provider_capacity" });
      }),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };

    const firstRun = buildSubmitAgnesSceneVideosTool(state as never, {
      client: queueFullClient,
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5.2),
    });
    const firstResult = JSON.parse(await (firstRun as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(firstResult.status).toBe("pending");
    expect(firstRunRequests).toHaveLength(3);
    expect(firstRunRequests.map(({ seed }) => seed)).toEqual([
      1_357_911,
      1_357_911,
      1_357_911,
    ]);
    expect([...rows.values()].map(({ seed }) => seed)).toEqual([
      1_357_911,
      1_357_911,
      1_357_911,
    ]);

    const rerunRequests: AgnesSubmitVideoRequest[] = [];
    let accepted = 0;
    const recoveredClient = {
      submitVideo: vi.fn(async (request: AgnesSubmitVideoRequest) => {
        rerunRequests.push(request);
        return task(`seed-rerun-${++accepted}`, "queued");
      }),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const rerun = buildSubmitAgnesSceneVideosTool(state as never, {
      client: recoveredClient,
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5.2),
    });
    const rerunResult = JSON.parse(await (rerun as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(rerunResult.status).toBe("submitted");
    expect(rerunRequests).toHaveLength(3);
    expect(rerunRequests.every(({ seed }) => seed === 1_357_911)).toBe(true);
    expect(state.getOrCreateSeriesAgnesSeed).toHaveBeenCalledTimes(2);
    expect(state.getOrCreateSeriesAgnesSeed).toHaveBeenNthCalledWith(1, 7, undefined);
    expect(state.getOrCreateSeriesAgnesSeed).toHaveBeenNthCalledWith(2, 7, undefined);
  });

  it("keeps an accepted task resumable when a later deployment strengthens prompt wording", async () => {
    await addAudioFiles(outputDir, 1);
    const { state, rows } = mockState(1);
    materializeScenePromptMock.mockResolvedValueOnce({
      prompt: "OLD CANONICAL PROMPT",
      characterNames: ["Pip the Ant"],
      characterDescriptions: ["tiny red ant"],
    });
    const client = {
      submitVideo: vi.fn(async () => task("accepted-before-prompt-change", "queued")),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const first = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5.2),
    });
    await (first as any).func({ seriesId: 7, episodeNumber: 2 });
    const acceptedPrompt = rows.get(1)?.prompt;
    const acceptedDigest = rows.get(1)?.requestDigest;

    materializeScenePromptMock.mockResolvedValueOnce({
      prompt: "NEW CANONICAL PROMPT WITH NO DOUBLE HEADS",
      characterNames: ["Pip the Ant"],
      characterDescriptions: ["tiny red ant"],
    });
    const later = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5.2),
    });
    const result = JSON.parse(await (later as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result.attemptedCount).toBe(0);
    expect(result.alreadyAcceptedCount).toBe(1);
    expect(client.submitVideo).toHaveBeenCalledOnce();
    expect(rows.get(1)?.prompt).toBe(acceptedPrompt);
    expect(rows.get(1)?.requestDigest).toBe(acceptedDigest);
  });

  it("resubmits a terminally failed provider task exactly once on a later verification run", async () => {
    await addAudioFiles(outputDir, 1);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn()
        .mockResolvedValueOnce(task("provider-failure-first", "queued"))
        .mockResolvedValueOnce(task("provider-failure-replacement", "queued")),
      retrieveVideo: vi.fn(async (input: AgnesVideoTask) => task(input.video_id, "failed")),
      downloadCompletedVideo: vi.fn(),
    };

    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5.2),
    });
    await (submit as any).func({ seriesId: 7, episodeNumber: 2 });

    const firstVerify = buildVerifyAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5.2),
    });
    const failed = JSON.parse(await (firstVerify as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(failed.status).toBe("blocked");
    expect(rows.get(1)?.status).toBe("failed");
    expect(client.submitVideo).toHaveBeenCalledOnce();

    const laterVerify = buildVerifyAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5.2),
    });
    const recovered = JSON.parse(await (laterVerify as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(recovered).toMatchObject({
      status: "submission_attempted",
      stopRun: true,
      pendingBeforeSubmission: 1,
    });
    expect(client.submitVideo).toHaveBeenCalledTimes(2);
    expect(client.retrieveVideo).toHaveBeenCalledOnce();
    expect(rows.get(1)?.providerTaskId).toBe("provider-failure-replacement");
    expect(rows.get(1)?.status).toBe("queued");
    const attempts = (rows.get(1)?.providerReceipt as any).attempts;
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      state: "accepted",
      task: { video_id: "provider-failure-first", status: "failed" },
    });
    expect(attempts[1]).toMatchObject({
      state: "accepted",
      task: { video_id: "provider-failure-replacement", status: "queued" },
    });
  });

  it("round-robins two key arts and ten scenes over five accounts with two concurrent submissions per account", async () => {
    await addAudioFiles(outputDir, 10);
    const { state, rows } = mockState(10);
    Object.assign(state, {
      getSeriesInfo: vi.fn(async () => ({
        conceptName: "Tiny Heroes Club",
        episodeFormula: "Small friends solve gentle problems together.",
        charactersJson: [{ name: "Pip the Ant", description: "A small red ant." }],
      })),
      getSeriesCharacters: vi.fn(async () => [{ name: "Pip the Ant", description: "A small red ant." }]),
      getCharacterSheet: vi.fn(async () => ({
        approvedAt: "2026-09-05T00:00:00.000Z",
        generationPrompt: "tiny ruby-red ant with six legs, bright eyes, and one yellow backpack",
      })),
    });
    (state.getEpisodeByNumber as any).mockResolvedValue({
      id: 72,
      title: "Pip's Berry Bridge",
      premise: "Pip carries a bright berry over a tiny stream.",
      scriptJson: {
        scenes: Array.from({ length: 10 }, (_unused, index) => ({
          sceneNumber: index + 1,
          narrationText: `Pip narrates scene ${index + 1}.`,
          environmentDescription: "A warm flower-filled meadow.",
          action: "Pip waves and takes one careful step.",
          characterNames: ["Pip the Ant"],
          continuityAnchors: ["The same yellow flower stands beside Pip."],
        })),
      },
    });
    const ensureKeyArtAudioAssets = vi.fn(async () => {
      const seriesPaths = agnesKeyArtPaths({ outputDir, seriesId: 7, episodeNumber: 2, kind: "series" });
      const episodePaths = agnesKeyArtPaths({ outputDir, seriesId: 7, episodeNumber: 2, kind: "episode" });
      await Promise.all([
        mkdir(seriesPaths.directory, { recursive: true }),
        mkdir(episodePaths.directory, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(seriesPaths.audioPath, "series-title-audio"),
        writeFile(episodePaths.audioPath, "episode-title-audio"),
      ]);
      return [
        { ...seriesPaths, text: "Tiny Heroes Club", durationSeconds: 2.25, requestDigest: "series-audio" },
        { ...episodePaths, text: "Pip's Berry Bridge", durationSeconds: 3.25, requestDigest: "episode-audio" },
      ] as const;
    });
    let aggregateActive = 0;
    let maximumAggregateActive = 0;
    const accountRecords = [
      { accountId: "account-a", keyLabel: "key-a", fingerprint: "a".repeat(64) },
      { accountId: "account-b", keyLabel: "key-b", fingerprint: "b".repeat(64) },
      { accountId: "account-c", keyLabel: "key-c", fingerprint: "c".repeat(64) },
      { accountId: "account-d", keyLabel: "key-d", fingerprint: "d".repeat(64) },
      { accountId: "account-e", keyLabel: "key-e", fingerprint: "e".repeat(64) },
    ].map((identity) => {
      let active = 0;
      let maximumActive = 0;
      let submitted = 0;
      const client = {
        submitVideo: vi.fn(async () => {
          active += 1;
          aggregateActive += 1;
          maximumActive = Math.max(maximumActive, active);
          maximumAggregateActive = Math.max(maximumAggregateActive, aggregateActive);
          try {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return accountTask(
              `${identity.accountId}-${++submitted}`,
              "queued",
              identity.keyLabel,
              identity.fingerprint,
            );
          } finally {
            active -= 1;
            aggregateActive -= 1;
          }
        }),
        retrieveVideo: vi.fn(),
        downloadCompletedVideo: vi.fn(),
      };
      return { ...identity, client, maximumActive: () => maximumActive };
    });
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      accounts: accountRecords.map(({ accountId, keyLabel, fingerprint, client }) => ({
        accountId,
        keyLabel,
        keyFingerprint: fingerprint,
        client,
      })),
      submissionBatchSize: 2,
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      includeKeyArt: true,
      ensureKeyArtAudioAssets,
      ensureSeriesCharacterSheets: vi.fn(async ({ seriesId, roster }) => ({
        seriesId,
        rosterCount: roster?.length ?? 0,
        generatedCount: 0,
        reusedCount: roster?.length ?? 0,
        characters: (roster ?? []).map((character: { name: string }) => ({
          name: character.name,
          status: "already_approved" as const,
          referenceImagePaths: { portrait: { path: `/approved/${character.name}.png` } },
          generationPrompt: "tiny ruby-red ant with six legs, bright eyes. Always same colors.",
        })),
      })),
      probeMediaDuration: vi.fn(async () => 5.2),
    });

    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result.status).toBe("submitted");
    expect(result.accountCount).toBe(5);
    expect(result.assetCount).toBe(12);
    expect(result.keyArtCount).toBe(2);
    expect(result.sceneCount).toBe(10);
    expect(result.batchSizePerAccount).toBe(2);
    expect(result.totalSubmissionConcurrency).toBe(10);
    expect(maximumAggregateActive).toBe(10);
    for (const [index, account] of accountRecords.entries()) {
      expect(account.client.submitVideo).toHaveBeenCalledTimes(index < 2 ? 3 : 2);
      expect(account.maximumActive()).toBe(2);
    }
    expect([
      AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      ...Array.from({ length: 10 }, (_unused, index) => index + 1),
    ].map((sceneNumber) => {
      const receipt = rows.get(sceneNumber)?.providerReceipt as any;
      return receipt.attempts.at(-1).accountId;
    })).toEqual([
      "account-a",
      "account-b",
      "account-c",
      "account-d",
      "account-e",
      "account-a",
      "account-b",
      "account-c",
      "account-d",
      "account-e",
      "account-a",
      "account-b",
    ]);
  });

  it("fails over one rate-limited scene to the next account and records both account attempts", async () => {
    await addAudioFiles(outputDir, 1);
    const { state, rows } = mockState(1);
    const fingerprintA = "a".repeat(64);
    const fingerprintB = "b".repeat(64);
    const clientA = {
      submitVideo: vi.fn(async () => {
        throw new AgnesError("account A rate limited", { kind: "rate_limit" });
      }),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const clientB = {
      submitVideo: vi.fn(async () => accountTask("failover-b", "queued", "key-b", fingerprintB)),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      accounts: [
        { accountId: "account-a", keyLabel: "key-a", keyFingerprint: fingerprintA, client: clientA },
        { accountId: "account-b", keyLabel: "key-b", keyFingerprint: fingerprintB, client: clientB },
      ],
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5.2),
    });

    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result.status).toBe("submitted");
    expect(clientA.submitVideo).toHaveBeenCalledOnce();
    expect(clientB.submitVideo).toHaveBeenCalledOnce();
    expect(result.results[0]).toMatchObject({ accountId: "account-b", providerVideoId: "failover-b" });
    const attempts = (rows.get(1)?.providerReceipt as any).attempts;
    expect(attempts.map((attempt: any) => attempt.accountId)).toEqual(["account-a", "account-b"]);
    expect(attempts[0]).toMatchObject({
      state: "definite_rejection",
      errorKind: "rate_limit",
      retrySafe: true,
    });
    expect(attempts[1]).toMatchObject({
      state: "accepted",
      accountId: "account-b",
      keyFingerprint: fingerprintB,
    });
  });

  it("persists but rejects an accepted task whose fingerprint differs from its configured account", async () => {
    await addAudioFiles(outputDir, 1);
    const { state, rows } = mockState(1);
    const configuredFingerprint = "a".repeat(64);
    const unexpectedFingerprint = "b".repeat(64);
    const client = {
      submitVideo: vi.fn(async () => accountTask(
        "wrong-account-fingerprint",
        "queued",
        "unexpected-key",
        unexpectedFingerprint,
      )),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const options = {
      accounts: [{
        accountId: "account-a",
        keyLabel: "key-a",
        keyFingerprint: configuredFingerprint,
        client,
      }],
      probeMediaDuration: vi.fn(async () => 5.2),
    };

    const submit = buildSubmitAgnesSceneVideosTool(state as never, options);
    await expect((submit as any).func({ seriesId: 7, episodeNumber: 2 }))
      .rejects.toThrow("different key fingerprint");

    expect(client.submitVideo).toHaveBeenCalledOnce();
    expect(rows.get(1)).toMatchObject({
      providerTaskId: "wrong-account-fingerprint",
      status: "queued",
      error: expect.stringContaining("different key fingerprint"),
    });
    expect((rows.get(1)?.providerReceipt as any).attempts.at(-1)).toMatchObject({
      state: "accepted",
      accountId: "account-a",
      keyFingerprint: unexpectedFingerprint,
      task: {
        video_id: "wrong-account-fingerprint",
        keyFingerprint: unexpectedFingerprint,
      },
    });

    // The persisted provider id suppresses a duplicate POST on a later submit
    // invocation even though retrieval remains fail-closed until config is fixed.
    const laterSubmit = buildSubmitAgnesSceneVideosTool(state as never, options);
    const rerun = JSON.parse(await (laterSubmit as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(rerun.attemptedCount).toBe(0);
    expect(client.submitVideo).toHaveBeenCalledOnce();
  });

  it("does not try another account after a provider-capacity rejection", async () => {
    await addAudioFiles(outputDir, 1);
    const { state, rows } = mockState(1);
    const clientA = {
      submitVideo: vi.fn(async () => {
        throw new AgnesError("render queue full", { kind: "provider_capacity" });
      }),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const clientB = {
      submitVideo: vi.fn(async () => accountTask("must-not-run", "queued", "key-b", "b".repeat(64))),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      accounts: [
        { accountId: "account-a", keyLabel: "key-a", keyFingerprint: "a".repeat(64), client: clientA },
        { accountId: "account-b", keyLabel: "key-b", keyFingerprint: "b".repeat(64), client: clientB },
      ],
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5.2),
    });

    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result.status).toBe("pending");
    expect(clientA.submitVideo).toHaveBeenCalledOnce();
    expect(clientB.submitVideo).not.toHaveBeenCalled();
    expect((rows.get(1)?.providerReceipt as any).attempts).toHaveLength(1);
    expect((rows.get(1)?.providerReceipt as any).attempts[0]).toMatchObject({
      accountId: "account-a",
      errorKind: "provider_capacity",
      state: "definite_rejection",
    });
  });

  it("verifies every accepted task with the account client that originally submitted it", async () => {
    await addAudioFiles(outputDir, 3);
    const { state } = mockState(3);
    const identities = [
      { accountId: "account-a", keyLabel: "key-a", fingerprint: "a".repeat(64) },
      { accountId: "account-b", keyLabel: "key-b", fingerprint: "b".repeat(64) },
      { accountId: "account-c", keyLabel: "key-c", fingerprint: "c".repeat(64) },
    ];
    const accountRecords = identities.map((identity) => {
      let submitted = 0;
      const client = {
        submitVideo: vi.fn(async () => accountTask(
          `${identity.accountId}-${++submitted}`,
          "queued",
          identity.keyLabel,
          identity.fingerprint,
        )),
        retrieveVideo: vi.fn(async (input: AgnesVideoTask) => {
          expect(input.video_id).toMatch(new RegExp(`^${identity.accountId}-`));
          expect(input.keyFingerprint).toBe(identity.fingerprint);
          return accountTask(input.video_id, "completed", identity.keyLabel, identity.fingerprint);
        }),
        downloadCompletedVideo: vi.fn(),
      };
      return { ...identity, client };
    });
    const options = {
      accounts: accountRecords.map(({ accountId, keyLabel, fingerprint, client }) => ({
        accountId,
        keyLabel,
        keyFingerprint: fingerprint,
        client,
      })),
      submissionIntervalMs: 0,
      statusRequestIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5.2),
    };
    const submit = buildSubmitAgnesSceneVideosTool(state as never, options);
    await (submit as any).func({ seriesId: 7, episodeNumber: 2 });

    // Rebuild the tool to prove account affinity comes from the durable receipt,
    // rather than transient state retained by the submission runtime.
    const verify = buildVerifyAgnesSceneVideosTool(state as never, options);
    const result = JSON.parse(await (verify as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result.status).toBe("ready_to_download");
    for (const account of accountRecords) {
      expect(account.client.submitVideo).toHaveBeenCalledOnce();
      expect(account.client.retrieveVideo).toHaveBeenCalledOnce();
    }
  });

  it("submits one request per scene with a maximum concurrency of two, then verifies and downloads separately", async () => {
    await addAudioFiles(outputDir, 6);
    const { state, rows } = mockState(6);
    const requests: AgnesSubmitVideoRequest[] = [];
    let active = 0;
    let maximumActive = 0;
    const client = {
      submitVideo: vi.fn(async (request: AgnesSubmitVideoRequest) => {
        requests.push(request);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return task(`video-${requests.length}`, "queued");
      }),
      retrieveVideo: vi.fn(async (input: AgnesVideoTask) => task(input.video_id, "completed")),
      downloadCompletedVideo: vi.fn(async (input: AgnesVideoTask, outputPath: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.alloc(2_048, 1));
        return { outputPath, url: input.metadata!.url!, bytes: 2_048, sha256: "b".repeat(64) };
      }),
    };
    const normalizeVideo = vi.fn(async ({ outputPath }: { outputPath: string }) => {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.alloc(2_048, 2));
    });
    const [submit, verify, download] = buildAgnesSceneVideoTools(state as never, {
      client,
      submissionIntervalMs: 0,
      // Even an unsafe caller override cannot raise Agnes' hard provider
      // ceiling above two simultaneous submissions.
      submissionBatchSize: 99,
      probeMediaDuration: vi.fn(async () => 5.2),
      normalizeVideo,
    });

    const submitted = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(submitted.phase).toBe("submit");
    expect(submitted.attemptedCount).toBe(6);
    expect(requests).toHaveLength(6);
    expect(maximumActive).toBe(2);
    expect(submitted.batchSize).toBe(2);
    expect(requests.every((request) => request.mode === "text" && request.seconds === 6)).toBe(true);
    expect(requests.every((request) => request.prompt.includes("CANONICAL SCENE PROMPT"))).toBe(true);
    expect(materializeScenePromptMock).toHaveBeenCalledTimes(6);
    expect(state.assertEpisodeAudioReady).toHaveBeenCalledWith(72);

    const verified = JSON.parse(await (verify as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(verified.status).toBe("ready_to_download");
    expect(client.downloadCompletedVideo).not.toHaveBeenCalled();
    expect([...rows.values()].every((row) => row.status === "completed" && row.downloadStatus === "pending")).toBe(true);

    const verifiedAgain = JSON.parse(await (verify as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(verifiedAgain.status).toBe("ready_to_download");
    expect(verifiedAgain.results.every((result: any) => result.reusedReceipt === true)).toBe(true);
    expect(client.retrieveVideo).toHaveBeenCalledTimes(6);

    const downloaded = JSON.parse(await (download as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(downloaded.status).toBe("completed");
    expect(client.downloadCompletedVideo).toHaveBeenCalledTimes(6);
    expect(normalizeVideo).toHaveBeenCalledTimes(6);
    expect([...rows.values()].every((row) => row.status === "completed" && row.downloadStatus === "downloaded")).toBe(true);
  });

  it("paces status GET starts for the single injected account instead of emitting a two-worker burst", async () => {
    await addAudioFiles(outputDir, 3);
    const { state } = mockState(3);
    const retrievalStarts: number[] = [];
    let submittedCount = 0;
    const client = {
      submitVideo: vi.fn(async () => task(`paced-${++submittedCount}`, "queued")),
      retrieveVideo: vi.fn(async (input: AgnesVideoTask) => {
        retrievalStarts.push(Date.now());
        return task(input.video_id, "completed");
      }),
      downloadCompletedVideo: vi.fn(),
    };
    const [submit, verify] = buildAgnesSceneVideoTools(state as never, {
      client,
      submissionIntervalMs: 0,
      submissionBatchSize: 2,
      statusRequestIntervalMs: 20,
      probeMediaDuration: vi.fn(async () => 5.2),
    });

    await (submit as any).func({ seriesId: 7, episodeNumber: 2 });
    const verified = JSON.parse(await (verify as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(verified.status).toBe("ready_to_download");
    expect(retrievalStarts).toHaveLength(3);
    expect(retrievalStarts[1]! - retrievalStarts[0]!).toBeGreaterThanOrEqual(15);
    expect(retrievalStarts[2]! - retrievalStarts[1]!).toBeGreaterThanOrEqual(15);
  });

  it("rejects measured narration over 12 seconds before any billed submission", async () => {
    await addAudioFiles(outputDir, 1, 12.01);
    const { state } = mockState(1);
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const tool = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 12.01),
    });
    await expect((tool as any).func({ seriesId: 7, episodeNumber: 2 }))
      .rejects.toThrow("Split affected script scenes");
    expect(client.submitVideo).not.toHaveBeenCalled();
    expect(state.upsertAgnesSceneGeneration).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous network submission pending until its stale lease expires", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => {
        throw new AgnesError("network unavailable", { kind: "network", ambiguousOutcome: true });
      }),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const [submit, sameRuntimeVerify] = buildAgnesSceneVideoTools(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });
    const first = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(first.status).toBe("pending");
    expect(client.submitVideo).toHaveBeenCalledOnce();
    expect(rows.get(1)?.status).toBe("pending");
    expect((rows.get(1)?.providerReceipt as any).attempts.at(-1)).toMatchObject({
      state: "ambiguous",
      submissionPhase: "post_started",
      retrySafe: false,
    });

    const sameRun = JSON.parse(await (sameRuntimeVerify as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(sameRun.status).toBe("submission_attempted");
    expect(sameRun.stopRun).toBe(true);
    expect(sameRun.results[0]).toMatchObject({
      sceneNumber: 1,
      status: "blocked",
    });
    expect(client.submitVideo).toHaveBeenCalledOnce();

    // Restarting the process/tool does not bypass the persisted ambiguity
    // lease, so an immediate rerun cannot create a duplicate render.
    const immediateLaterRuntimeVerify = buildVerifyAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });
    const second = JSON.parse(await (immediateLaterRuntimeVerify as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(second.status).toBe("submission_attempted");
    expect(second.stopRun).toBe(true);
    expect(second.results[0]).toMatchObject({ sceneNumber: 1, status: "blocked" });
    expect(client.submitVideo).toHaveBeenCalledOnce();
    expect(client.retrieveVideo).not.toHaveBeenCalled();

    // Once the durable lease is stale, one later runtime may recover it. The
    // recovery is deliberately diagnostic because the original POST outcome
    // can never be proven from a transport failure without a provider id.
    const receipt = structuredClone(rows.get(1)?.providerReceipt) as any;
    receipt.attempts.at(-1).startedAt = new Date(
      Date.now() - AGNES_STALE_SUBMISSION_LEASE_MS - 1_000,
    ).toISOString();
    rows.set(1, { ...rows.get(1)!, providerReceipt: receipt });

    const recoveredClient = {
      ...client,
      submitVideo: vi.fn(async () => task("video-after-network-ambiguity", "queued")),
    };
    const staleLaterRuntimeVerify = buildVerifyAgnesSceneVideosTool(state as never, {
      client: recoveredClient,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });
    const third = JSON.parse(await (staleLaterRuntimeVerify as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(third.status).toBe("submission_attempted");
    expect(third.stopRun).toBe(true);
    expect(recoveredClient.submitVideo).toHaveBeenCalledOnce();
    expect(rows.get(1)?.attemptCount).toBe(2);
    const recoveredReceipt = rows.get(1)?.providerReceipt as any;
    expect(recoveredReceipt.attempts[0]).toMatchObject({
      state: "definite_rejection",
      retrySafe: true,
    });
    expect(recoveredReceipt.attempts[0].error).toContain("duplicate provider render");
    expect(recoveredReceipt.attempts[1].state).toBe("accepted");
  });

  it("polls an accepted intermediate task until queue acknowledgement", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    let retrieval = 0;
    const client = {
      submitVideo: vi.fn(async () => task("video-intermediate", "submitted")),
      retrieveVideo: vi.fn(async () => {
        // An accepted provider receipt is durable, but workflow state remains
        // pending until Agnes actually acknowledges its queue transition.
        expect(rows.get(1)?.status).toBe("pending");
        retrieval += 1;
        return task("video-intermediate", retrieval === 1 ? "pending" : "queued");
      }),
      downloadCompletedVideo: vi.fn(),
    };
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      queuePollIntervalMs: 1,
      queuePollWindowMs: 100,
      probeMediaDuration: vi.fn(async () => 5),
    });

    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(result.status).toBe("submitted");
    expect(result.queued).toBe(1);
    expect(result.awaitingAcknowledgement).toBe(0);
    expect(client.retrieveVideo).toHaveBeenCalledTimes(2);
    expect(rows.get(1)?.status).toBe("queued");
  });

  it("does not rematerialize or POST a row invalidated before the pre-claim reload", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => task("must-not-submit", "queued")),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    let reads = 0;
    state.getAgnesSceneGeneration.mockImplementation(async (
      _series: number,
      _episode: number,
      sceneNumber: number,
    ) => {
      reads += 1;
      // prepareEpisode reads once, then initializeAll materializes the row.
      // Deleting it on submitOne's read models promotion between the initial
      // snapshot and the outbound claim.
      if (reads === 3) rows.delete(sceneNumber);
      return rows.get(sceneNumber) ?? null;
    });
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });

    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({
      status: "pending",
      pending: 1,
      missingPreparedRows: 1,
      results: [{ status: "pending", preparedRequestMissing: true }],
    });
    expect(state.claimAgnesSceneSubmission).not.toHaveBeenCalled();
    expect(client.submitVideo).not.toHaveBeenCalled();
    expect(rows.has(1)).toBe(false);
    expect(state.upsertAgnesSceneGeneration).toHaveBeenCalledTimes(1);
  });

  it("does not rematerialize or POST after promotion deletes the row at claim time", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => task("must-not-submit", "queued")),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    state.claimAgnesSceneSubmission.mockImplementationOnce(async (input: any) => {
      rows.delete(input.sceneNumber);
      return { claimed: false, reason: "missing", row: null };
    });
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });

    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({
      status: "pending",
      pending: 1,
      missingPreparedRows: 1,
      results: [{ status: "pending", preparedRequestMissing: true }],
    });
    expect(state.claimAgnesSceneSubmission).toHaveBeenCalledOnce();
    expect(client.submitVideo).not.toHaveBeenCalled();
    expect(rows.has(1)).toBe(false);
    expect(state.upsertAgnesSceneGeneration).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale pre-POST claim only in a later runtime", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => task("video-after-stale-claim", "queued")),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    state.claimAgnesSceneSubmission.mockImplementationOnce(async (input: any, expected: number) => {
      const prior = rows.get(input.sceneNumber)!;
      const receipt = structuredClone(input.providerReceipt);
      receipt.attempts.at(-1).startedAt = new Date(
        Date.now() - AGNES_STALE_SUBMISSION_LEASE_MS - 1_000,
      ).toISOString();
      const claimed = rowFrom({
        ...input,
        providerReceipt: receipt,
        status: "pending",
        attemptCount: expected + 1,
      }, prior.id, prior);
      rows.set(input.sceneNumber, claimed);
      throw new Error("simulated process death after durable claim");
    });

    const crashedRuntime = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });
    await expect((crashedRuntime as any).func({ seriesId: 7, episodeNumber: 2 }))
      .rejects.toThrow("simulated process death");
    expect(client.submitVideo).not.toHaveBeenCalled();

    const laterRuntime = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });
    const recovered = JSON.parse(await (laterRuntime as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(recovered.status).toBe("submitted");
    expect(client.submitVideo).toHaveBeenCalledOnce();
    expect(rows.get(1)?.attemptCount).toBe(2);
    const receipt = rows.get(1)?.providerReceipt as any;
    expect(receipt.attempts[0].error).toContain("pre-POST Agnes claim");
    expect(receipt.attempts[1].state).toBe("accepted");
  });

  it.each(["post_started", undefined])(
    "recovers a stale ambiguous %s submission with a duplicate-risk diagnostic",
    async (submissionPhase) => {
      await addAudioFiles(outputDir, 1, 5);
      const { state, rows } = mockState(1);
      const client = {
        submitVideo: vi.fn(async () => task("video-after-ambiguous", "queued")),
        retrieveVideo: vi.fn(),
        downloadCompletedVideo: vi.fn(),
      };
      state.claimAgnesSceneSubmission.mockImplementationOnce(async (input: any, expected: number) => {
        const prior = rows.get(input.sceneNumber)!;
        const receipt = structuredClone(input.providerReceipt);
        const attempt = receipt.attempts.at(-1);
        attempt.startedAt = new Date(Date.now() - AGNES_STALE_SUBMISSION_LEASE_MS - 1_000).toISOString();
        if (submissionPhase === undefined) delete attempt.submissionPhase;
        else attempt.submissionPhase = submissionPhase;
        const claimed = rowFrom({
          ...input,
          providerReceipt: receipt,
          status: "submitted",
          attemptCount: expected + 1,
        }, prior.id, prior);
        rows.set(input.sceneNumber, claimed);
        throw new Error("simulated crash around provider POST");
      });

      const crashedRuntime = buildSubmitAgnesSceneVideosTool(state as never, {
        client,
        submissionIntervalMs: 0,
        probeMediaDuration: vi.fn(async () => 5),
      });
      await expect((crashedRuntime as any).func({ seriesId: 7, episodeNumber: 2 })).rejects.toThrow();

      const laterRuntime = buildSubmitAgnesSceneVideosTool(state as never, {
        client,
        submissionIntervalMs: 0,
        probeMediaDuration: vi.fn(async () => 5),
      });
      await (laterRuntime as any).func({ seriesId: 7, episodeNumber: 2 });
      const receipt = rows.get(1)?.providerReceipt as any;
      expect(receipt.attempts[0].error).toContain("outcome is ambiguous");
      expect(receipt.attempts[0].error).toContain("duplicate provider render");
      expect(client.submitVideo).toHaveBeenCalledOnce();
    },
  );

  it("does not adopt an untracked canonical clip as a completed download", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const canonicalPath = path.join(
      outputDir, "series_7", "episode_2", "agnes_text", "scenes", "scene_001.mp4",
    );
    await mkdir(path.dirname(canonicalPath), { recursive: true });
    await writeFile(canonicalPath, Buffer.alloc(2_048, 9));
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const download = buildDownloadAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5),
    });

    const result = JSON.parse(await (download as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(result.status).toBe("not_ready");
    expect(result.missingSceneNumbers).toEqual([1]);
    expect(rows.get(1)?.status).toBe("pending");
    expect(client.downloadCompletedVideo).not.toHaveBeenCalled();
  });

  it("rejects a downloaded provider clip that is materially shorter than its narration", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => task("video-too-short", "queued")),
      retrieveVideo: vi.fn(async (input: AgnesVideoTask) => task(input.video_id, "completed")),
      downloadCompletedVideo: vi.fn(async (input: AgnesVideoTask, outputPath: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.alloc(2_048, 3));
        return { outputPath, url: input.metadata!.url!, bytes: 2_048, sha256: "c".repeat(64) };
      }),
    };
    const normalizeVideo = vi.fn();
    const probeMediaDuration = vi.fn(async (filePath: string) => (
      filePath.includes(`${path.sep}raw${path.sep}`) ? 4.9 : 5
    ));
    const [submit, verify, download] = buildAgnesSceneVideoTools(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration,
      normalizeVideo,
    });

    await (submit as any).func({ seriesId: 7, episodeNumber: 2 });
    const verified = JSON.parse(await (verify as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(verified.status).toBe("ready_to_download");

    const result = JSON.parse(await (download as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(result.status).toBe("pending");
    expect(result.results[0].error).toContain("Refusing to add frozen-frame padding");
    expect(normalizeVideo).not.toHaveBeenCalled();
    expect(rows.get(1)?.downloadStatus).toBe("failed");
  });

  it("re-normalizes a legacy canonical clip instead of reusing old frozen-padding output", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => task("video-legacy-normalization", "queued")),
      retrieveVideo: vi.fn(async (input: AgnesVideoTask) => task(input.video_id, "completed")),
      downloadCompletedVideo: vi.fn(async (input: AgnesVideoTask, outputPath: string) => {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, Buffer.alloc(2_048, 4));
        return { outputPath, url: input.metadata!.url!, bytes: 2_048, sha256: "d".repeat(64) };
      }),
    };
    const firstNormalize = vi.fn(async ({ outputPath }: { outputPath: string }) => {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.alloc(2_048, 5));
    });
    const [submit, verify, download] = buildAgnesSceneVideoTools(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
      normalizeVideo: firstNormalize,
    });
    await (submit as any).func({ seriesId: 7, episodeNumber: 2 });
    await (verify as any).func({ seriesId: 7, episodeNumber: 2 });
    await (download as any).func({ seriesId: 7, episodeNumber: 2 });
    expect(firstNormalize).toHaveBeenCalledOnce();

    const legacyReceipt = structuredClone(rows.get(1)!.providerReceipt) as any;
    delete legacyReceipt.normalizationVersion;
    rows.set(1, { ...rows.get(1)!, providerReceipt: legacyReceipt });

    const replacementNormalize = vi.fn(async ({ outputPath }: { outputPath: string }) => {
      await writeFile(outputPath, Buffer.alloc(2_048, 6));
    });
    const laterDownload = buildDownloadAgnesSceneVideosTool(state as never, {
      client,
      probeMediaDuration: vi.fn(async () => 5),
      normalizeVideo: replacementNormalize,
    });
    const result = JSON.parse(await (laterDownload as any).func({ seriesId: 7, episodeNumber: 2 }));

    expect(result.status).toBe("completed");
    expect(replacementNormalize).toHaveBeenCalledOnce();
    expect((rows.get(1)?.providerReceipt as any).normalizationVersion)
      .toBe(AGNES_NORMALIZATION_VERSION);
    expect(client.downloadCompletedVideo).toHaveBeenCalledOnce();
  });

  it("does not let a hanging status GET overrun the queue-acknowledgement window", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state, rows } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => task("video-slow-status", "submitted")),
      retrieveVideo: vi.fn(() => new Promise<AgnesVideoTask>(() => {})),
      downloadCompletedVideo: vi.fn(),
    };
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      queuePollIntervalMs: 1,
      queuePollWindowMs: 20,
      probeMediaDuration: vi.fn(async () => 5),
    });

    const startedAt = Date.now();
    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(250);
    expect(result.status).toBe("pending");
    expect(result.awaitingAcknowledgement).toBe(1);
    expect(client.retrieveVideo).toHaveBeenCalledOnce();
    expect(rows.get(1)?.providerTaskId).toBe("video-slow-status");
  });

  it("does not start a delayed status GET after the queue window expires", async () => {
    await addAudioFiles(outputDir, 2, 5);
    const { state } = mockState(2);
    let taskNumber = 0;
    const client = {
      submitVideo: vi.fn(async () => task(`deadline-${++taskNumber}`, "submitted")),
      retrieveVideo: vi.fn(async (input: AgnesVideoTask) => task(input.video_id, "pending")),
      downloadCompletedVideo: vi.fn(),
    };
    const submit = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      submissionBatchSize: 2,
      statusRequestIntervalMs: 50,
      queuePollIntervalMs: 1,
      queuePollWindowMs: 20,
      probeMediaDuration: vi.fn(async () => 5),
    });

    const result = JSON.parse(await (submit as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(result.status).toBe("pending");
    expect(client.retrieveVideo).toHaveBeenCalledOnce();

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(client.retrieveVideo).toHaveBeenCalledOnce();
  });

  it("reports existing failed rows as failures instead of already accepted", async () => {
    await addAudioFiles(outputDir, 1, 5);
    const { state } = mockState(1);
    const client = {
      submitVideo: vi.fn(async () => {
        throw new AgnesError("invalid prompt", { kind: "validation" });
      }),
      retrieveVideo: vi.fn(),
      downloadCompletedVideo: vi.fn(),
    };
    const firstRuntime = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });
    await (firstRuntime as any).func({ seriesId: 7, episodeNumber: 2 });

    const laterRuntime = buildSubmitAgnesSceneVideosTool(state as never, {
      client,
      submissionIntervalMs: 0,
      probeMediaDuration: vi.fn(async () => 5),
    });
    const result = JSON.parse(await (laterRuntime as any).func({ seriesId: 7, episodeNumber: 2 }));
    expect(result.status).toBe("partial_failure");
    expect(result.attemptedCount).toBe(0);
    expect(result.alreadyAcceptedCount).toBe(0);
    expect(result.failed).toBe(1);
    expect(client.submitVideo).toHaveBeenCalledOnce();
  });

  it("keeps text prompts image-free and refuses multi-request scene splitting", () => {
    const prompt = buildAgnesVideoPrompt({
      canonicalScenePrompt: "locked prompt",
      targetDurationSeconds: 8.2,
    });
    expect(prompt).not.toContain("<Picture 1>");
    expect(prompt).toContain("Silent visual-only shot");
    expect(prompt).not.toContain("DURATION");
    expect(prompt).toContain("No duplicate characters");
    expect(prompt).toContain("No extra limbs");
    expect(prompt).toContain("No double heads");
    expect(prompt).toContain("No flicker, jitter, strobing");
    expect(planAgnesVideoSegments(3.1)).toEqual([4]);
    expect(planAgnesVideoSegments(12)).toEqual([12]);
    expect(() => planAgnesVideoSegments(12.001)).toThrow("at most 12s");
  });
});
