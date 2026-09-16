import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../config.js";
import { createAgnesVideoRequestDigest } from "../tools/agnesSceneVideoTool.js";
import {
  buildAgnesVideoQaTool,
  parseAgnesPromptReferenceMap,
  type AgnesStaticMediaProbe,
} from "../tools/agnesVideoQaTool.js";
import type { AgnesSceneGenerationRow } from "../state/seriesState.js";

const originalOutputDir = CONFIG.outputDir;

afterEach(() => {
  (CONFIG as { outputDir: string }).outputDir = originalOutputDir;
});

const portraitUrl = "https://project.supabase.co/storage/v1/object/public/characters/series_7/characters/mia.png";
const boboPortraitUrl = "https://project.supabase.co/storage/v1/object/public/characters/series_7/characters/bobo.png";

function keyPrompt(label: string): string {
  return `${label}. EXACT ON-SCREEN CAST LEDGER — 1 TOTAL CHARACTER FIGURE, AND NO OTHERS: [Mia] × 1. ` +
    "REFERENCE IMAGE IDENTITY MAP — <Picture 1> is mia.png, the approved portrait of Mia. " +
    "Treat each portrait as the authoritative identity and art-style reference.";
}

function scenePrompt(): string {
  return "SETTING — A painted attic. VISIBLE CAST — EXACTLY 1 FIGURE, NO OTHERS: [Mia] × 1. " +
    "Each listed identity appears once; every unlisted figure appears zero times. " +
    "REFERENCE IMAGE IDENTITY MAP — <Picture 1> is mia.png, the approved portrait of Mia. " +
    "Treat each portrait as the authoritative identity and art-style reference.";
}

function completeSeriesKeyPrompt(): string {
  return "Series key. EXACT ON-SCREEN CAST LEDGER — 2 TOTAL CHARACTER FIGURES, AND NO OTHERS: " +
    "[Mia] × 1; [Bobo] × 1. " +
    "REFERENCE IMAGE IDENTITY MAP — <Picture 1> is mia.png, the approved portrait of Mia; " +
    "<Picture 2> is bobo.png, the approved portrait of Bobo. " +
    "Treat each portrait as the authoritative identity and art-style reference.";
}

function row(params: {
  sceneNumber: number;
  videoPath: string;
  prompt: string;
  publicReferenceUrl?: string | null;
}): AgnesSceneGenerationRow {
  const seed = 12_345 + params.sceneNumber;
  const publicReferenceUrl = params.publicReferenceUrl === undefined
    ? JSON.stringify([portraitUrl])
    : params.publicReferenceUrl;
  const urls = publicReferenceUrl ? JSON.parse(publicReferenceUrl) as string[] : [];
  return {
    id: params.sceneNumber + 10,
    seriesId: 7,
    episodeNumber: 2,
    sceneNumber: params.sceneNumber,
    variant: "text",
    status: "completed",
    prompt: params.prompt,
    requestDigest: createAgnesVideoRequestDigest({
      prompt: params.prompt,
      providerSeconds: 6,
      seed,
      duration: 6,
      mode: urls.length > 0 ? "reference" : "text",
      referenceImageUrls: urls,
    }),
    attemptCount: 1,
    seed,
    requestedDurationSeconds: 6,
    providerDurationSeconds: 6,
    publicReferenceUrl,
    providerTaskId: `task-${params.sceneNumber}`,
    providerReceipt: { accepted: true },
    providerVideoUrl: "https://provider.invalid/video.mp4",
    rawOutputPath: null,
    normalizedOutputPath: params.videoPath,
    downloadStatus: "downloaded",
    renderRevision: 0,
    qaStatus: "pending",
    qaRequestDigest: null,
    qaVideoSha256: null,
    qaResult: null,
    qaContactSheetPath: null,
    qaModel: null,
    qaError: null,
    qaCheckedAt: null,
    error: null,
    submittedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:05:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:05:00.000Z",
  };
}

async function fixture(options: { duplicateSceneAndEpisodeKeyArt?: boolean } = {}) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "agnes-static-video-qa-"));
  (CONFIG as { outputDir: string }).outputDir = outputDir;
  const rows = new Map<number, AgnesSceneGenerationRow>();
  for (const [index, sceneNumber] of [-2, -1, 1].entries()) {
    const videoPath = path.join(outputDir, `${sceneNumber}.mp4`);
    const byte = options.duplicateSceneAndEpisodeKeyArt && sceneNumber === 1 ? 2 : index + 1;
    await writeFile(videoPath, Buffer.alloc(2_048, byte));
    rows.set(sceneNumber, row({
      sceneNumber,
      videoPath,
      prompt: sceneNumber === 1 ? scenePrompt() : keyPrompt(`Key ${sceneNumber}`),
    }));
  }
  const state = {
    getSeriesInfo: vi.fn().mockResolvedValue({
      conceptName: "Pocket Stars",
      charactersJson: [{ name: "Mia", description: "A young explorer." }],
    }),
    getEpisodeByNumber: vi.fn().mockResolvedValue({
      title: "The Glowing Map",
      scriptJson: {
        scenes: [{
          sceneNumber: 1,
          narrationText: "Mia opens the map.",
          characterNames: ["Mia"],
          supportingEntities: [],
        }],
      },
    }),
    getSeriesCharacters: vi.fn(),
    getCharacterSheet: vi.fn().mockResolvedValue({
      approvedAt: "2026-09-01T00:00:00.000Z",
      referenceImagePaths: { portrait: { path: "/tmp/mia.png", publicUrl: portraitUrl } },
    }),
    listAgnesSceneGenerations: vi.fn(async () => [...rows.values()]),
    recordAgnesVideoQaVerdict: vi.fn(async (input: any) => {
      const current = rows.get(input.sceneNumber)!;
      if (current.requestDigest !== input.expectedRequestDigest
        || current.renderRevision !== input.expectedRenderRevision
        || current.normalizedOutputPath !== input.expectedNormalizedOutputPath
        || current.qaStatus !== input.expectedQaStatus
        || current.qaRequestDigest !== input.expectedQaRequestDigest) {
        return { recorded: false, row: current };
      }
      const updated = {
        ...current,
        qaStatus: input.status,
        qaRequestDigest: input.qaRequestDigest,
        qaVideoSha256: input.videoSha256,
        qaResult: input.result,
        qaContactSheetPath: input.contactSheetPath,
        qaModel: input.model,
        qaError: null,
      } as AgnesSceneGenerationRow;
      rows.set(input.sceneNumber, updated);
      return { recorded: true, row: updated };
    }),
    recordAgnesVideoQaError: vi.fn(),
  };
  const probeMedia = vi.fn(async (): Promise<AgnesStaticMediaProbe> => ({
    durationSeconds: 6,
    codecName: "h264",
    width: 1_920,
    height: 1_080,
    videoStreamCount: 1,
    audioStreamCount: 0,
  }));
  await mkdir(path.join(outputDir, "unused"), { recursive: true });
  return { outputDir, rows, state, probeMedia };
}

describe("parseAgnesPromptReferenceMap", () => {
  it("accepts a canonical filename before the exact approved-portrait name", () => {
    expect(parseAgnesPromptReferenceMap(
      "REFERENCE IMAGE IDENTITY MAP — <Picture 1> is bobo_the_backpack.png, the approved portrait of Bobo the Backpack. Treat each portrait as authoritative.",
      ["Bobo the Backpack"],
    )).toEqual({ names: ["Bobo the Backpack"] });
  });
});

describe("qa_agnes_episode_videos static audit", () => {
  it("persists source-bound passes without making an analysis API call", async () => {
    const { state, rows, probeMedia } = await fixture();
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({
      status: "passed",
      stopRun: false,
      assetCount: 3,
      passed: 3,
      failed: 0,
      persisted: 3,
      apiCalls: 0,
    });
    expect(state.recordAgnesVideoQaVerdict).toHaveBeenCalledTimes(3);
    expect([...rows.values()].every((item) => item.qaStatus === "passed")).toBe(true);
    expect([...rows.values()].every((item) => (
      (item.qaResult as { pipeline?: string }).pipeline === "deterministic_static_media_integrity"
    ))).toBe(true);
  });

  it("reuses every current static verdict on a rerun", async () => {
    const { state, probeMedia } = await fixture();
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });
    await (tool as any).call({ seriesId: 7, episodeNumber: 2 });
    state.recordAgnesVideoQaVerdict.mockClear();

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({ status: "passed", persisted: 0, reused: 3 });
    expect(state.recordAgnesVideoQaVerdict).not.toHaveBeenCalled();
  });

  it("persists actionable failures for byte-identical episode assets and never requeues", async () => {
    const { state, rows, probeMedia } = await fixture({ duplicateSceneAndEpisodeKeyArt: true });
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({ status: "failed", stopRun: true, failed: 2, apiCalls: 0 });
    expect(result.failures.flatMap((failure: any) => failure.issues))
      .toEqual(expect.arrayContaining([expect.objectContaining({ code: "duplicate_video_file" })]));
    expect(rows.get(-1)?.qaStatus).toBe("exhausted");
    expect(rows.get(1)?.qaStatus).toBe("exhausted");
    expect((state as any).requeueAgnesSceneAfterQaFailure).toBeUndefined();
  });

  it("reuses source-bound failed verdicts instead of repeating persistence on rerun", async () => {
    const { state, probeMedia } = await fixture({ duplicateSceneAndEpisodeKeyArt: true });
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });
    await (tool as any).call({ seriesId: 7, episodeNumber: 2 });
    state.recordAgnesVideoQaVerdict.mockClear();

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({ status: "failed", persisted: 0, reused: 3, failed: 2 });
    expect(state.recordAgnesVideoQaVerdict).not.toHaveBeenCalled();
  });

  it("rejects mismatched visible-character references and prompt mappings", async () => {
    const { state, rows, probeMedia } = await fixture();
    const current = rows.get(1)!;
    const wrongUrl = "https://project.supabase.co/storage/v1/object/public/characters/wrong.png";
    const wrongPrompt = current.prompt.replace("approved portrait of Mia", "approved portrait of Unknown");
    rows.set(1, {
      ...current,
      prompt: wrongPrompt,
      publicReferenceUrl: JSON.stringify([wrongUrl]),
      requestDigest: createAgnesVideoRequestDigest({
        prompt: wrongPrompt,
        providerSeconds: 6,
        seed: current.seed!,
        duration: 6,
        mode: "reference",
        referenceImageUrls: [wrongUrl],
      }),
    });
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    const issues = result.failures.flatMap((failure: any) => failure.issues);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reference_identity_map_valid" }),
      expect.objectContaining({ code: "reference_identity_map_matches_visible_main_cast" }),
      expect.objectContaining({ code: "reference_urls_match_approved_portraits" }),
    ]));
  });

  it("rejects incomplete series key art against the full roster while preserving singleton episode key art", async () => {
    const { state, probeMedia } = await fixture();
    state.getSeriesInfo.mockResolvedValue({
      conceptName: "Pocket Stars",
      charactersJson: [
        { name: "Mia", description: "A young explorer." },
        { name: "Bobo", description: "A friendly living backpack." },
      ],
    });
    state.getCharacterSheet.mockImplementation(async (_seriesId: number, name: string) => ({
      approvedAt: "2026-09-01T00:00:00.000Z",
      referenceImagePaths: {
        portrait: {
          path: `/tmp/${name.toLowerCase()}.png`,
          publicUrl: name === "Mia" ? portraitUrl : boboPortraitUrl,
        },
      },
    }));
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({ status: "failed", failed: 1 });
    expect(result.failures).toEqual([expect.objectContaining({
      sceneNumber: -2,
      label: "series key art",
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "reference_count_matches_visible_main_cast" }),
        expect.objectContaining({ code: "reference_identity_map_matches_visible_main_cast" }),
        expect.objectContaining({ code: "exact_cast_ledger_matches_script" }),
      ]),
    })]);
  });

  it("accepts complete-roster series key art alongside singleton episode key art", async () => {
    const { state, rows, probeMedia } = await fixture();
    state.getSeriesInfo.mockResolvedValue({
      conceptName: "Pocket Stars",
      charactersJson: [
        { name: "Mia", description: "A young explorer." },
        { name: "Bobo", description: "A friendly living backpack." },
      ],
    });
    state.getCharacterSheet.mockImplementation(async (_seriesId: number, name: string) => ({
      approvedAt: "2026-09-01T00:00:00.000Z",
      referenceImagePaths: {
        portrait: {
          path: `/tmp/${name.toLowerCase()}.png`,
          publicUrl: name === "Mia" ? portraitUrl : boboPortraitUrl,
        },
      },
    }));
    const priorSeriesKeyArt = rows.get(-2)!;
    rows.set(-2, row({
      sceneNumber: -2,
      videoPath: priorSeriesKeyArt.normalizedOutputPath!,
      prompt: completeSeriesKeyPrompt(),
      publicReferenceUrl: JSON.stringify([portraitUrl, boboPortraitUrl]),
    }));
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({ status: "passed", passed: 3, failed: 0 });
  });

  it("rejects a visible cast member without an approved public portrait URL", async () => {
    const { state, probeMedia } = await fixture();
    state.getCharacterSheet.mockResolvedValue({
      approvedAt: "2026-09-01T00:00:00.000Z",
      referenceImagePaths: { portrait: { path: "/tmp/mia.png" } },
    });
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    expect(result).toMatchObject({ status: "failed", failed: 3 });
    expect(result.failures.flatMap((failure: any) => failure.issues))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "approved_public_portraits_present" }),
      ]));
  });

  it("rejects clips with audio or a mismatched duration", async () => {
    const { state, probeMedia } = await fixture();
    probeMedia.mockResolvedValueOnce({
      durationSeconds: 8,
      codecName: "h264",
      width: 1_920,
      height: 1_080,
      videoStreamCount: 1,
      audioStreamCount: 1,
    });
    const tool = buildAgnesVideoQaTool(state as any, { probeMedia });

    const result = JSON.parse(await (tool as any).call({ seriesId: 7, episodeNumber: 2 }));

    const issues = result.failures.flatMap((failure: any) => failure.issues);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "video_contains_no_audio" }),
      expect.objectContaining({ code: "normalized_duration_matches_audio" }),
    ]));
  });
});
