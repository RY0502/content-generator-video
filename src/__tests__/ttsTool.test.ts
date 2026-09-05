import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTtsTool,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  type NarrationAudioGenerator,
} from "../tools/ttsTool.js";

const temporaryDirectories: string[] = [];
const validNarration =
  "[warm] Mia watches the golden lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.";

async function makeTemporaryOutputDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "narration-tool-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeGenerator(): NarrationAudioGenerator & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async ({ outputPath }: { outputPath: string }) => {
    await writeFile(outputPath, Buffer.from("fake-wave-data"));
    return outputPath;
  });
  return { invoke } as NarrationAudioGenerator & { invoke: ReturnType<typeof vi.fn> };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ttsTool one-scene narration contract", () => {
  it("sends one bounded scene as one unchanged Groq request and reuses it only with a matching digest sidecar", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 8.25,
      retryDelayMs: () => 0,
    });
    const input = { seriesId: 4, episodeNumber: 2, sceneNumber: 7, text: validNarration };

    const generated = JSON.parse(await (tool as any).func(input));
    const reused = JSON.parse(await (tool as any).func(input));

    expect(generated).toMatchObject({ status: "generated", readyForAgnes: true, reused: false, durationSeconds: 8.25 });
    expect(reused).toMatchObject({ status: "already_generated", readyForAgnes: true, reused: true, durationSeconds: 8.25 });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
    expect(audioGenerator.invoke.mock.calls[0][0].input).toBe(validNarration);

    const metadataPath = narrationAudioMetadataPath(generated.path);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(metadata.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.durationStatus).toBe("ready");
  });

  it("invalidates an existing WAV when the exact narration text changes", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 7.5,
      retryDelayMs: () => 0,
    });

    await (tool as any).func({ seriesId: 1, episodeNumber: 1, sceneNumber: 1, text: validNarration });
    await (tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: "[warm] Mia watches the silver lantern glow while fireflies dance above the quiet meadow and everyone smiles together happily.",
    });

    expect(audioGenerator.invoke).toHaveBeenCalledTimes(2);
  });

  it("rejects text over the character or spoken-word limit before a paid request", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 8,
      retryDelayMs: () => 0,
    });

    await expect((tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 1,
      text: "x".repeat(201),
    })).rejects.toThrow("200");
    await expect((tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 2,
      text: Array.from({ length: 21 }, (_, index) => `word${index}`).join(" "),
    })).rejects.toThrow("20");

    expect(audioGenerator.invoke).not.toHaveBeenCalled();
  });

  it("allows a short scene beat because only the global episode runtime has a minimum", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 1.2,
      retryDelayMs: () => 0,
    });

    const generated = JSON.parse(await (tool as any).func({
      seriesId: 1,
      episodeNumber: 1,
      sceneNumber: 3,
      text: "Pip stops.",
    }));

    expect(generated).toMatchObject({ status: "generated", readyForAgnes: true, spokenWordCount: 2 });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns a hard duration_exceeded result and reuses the measured rejected artifact without another request", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => 12.4,
      retryDelayMs: () => 0,
    });
    const input = { seriesId: 2, episodeNumber: 3, sceneNumber: 4, text: validNarration };

    const generated = JSON.parse(await (tool as any).func(input));
    const reused = JSON.parse(await (tool as any).func(input));

    expect(generated).toMatchObject({
      status: "duration_exceeded",
      readyForAgnes: false,
      reused: false,
      durationSeconds: 12.4,
      maxDurationSeconds: 12,
      needsScriptSplit: true,
    });
    expect(generated.path).toBeUndefined();
    expect(generated.rejectedPath).toContain("scene_004_narrator.wav");
    expect(reused).toMatchObject({ status: "duration_exceeded", reused: true });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
  });

  it("honors a persisted duration_exceeded status when a boundary re-probe falls just below 12 seconds", async () => {
    const outputDir = await makeTemporaryOutputDir();
    const audioGenerator = fakeGenerator();
    let measuredDuration = 12.01;
    const tool = buildTtsTool({
      audioGenerator,
      outputDir,
      probeDurationSeconds: async () => measuredDuration,
      retryDelayMs: () => 0,
    });
    const input = { seriesId: 6, episodeNumber: 2, sceneNumber: 8, text: validNarration };

    const generated = JSON.parse(await (tool as any).func(input));
    measuredDuration = 11.99;
    const reused = JSON.parse(await (tool as any).func(input));

    expect(generated).toMatchObject({ status: "duration_exceeded", readyForAgnes: false });
    expect(reused).toMatchObject({
      status: "duration_exceeded",
      readyForAgnes: false,
      reused: true,
      durationSeconds: 11.99,
    });
    expect(audioGenerator.invoke).toHaveBeenCalledTimes(1);
  });

  it("binds request identity to text, model, voice, and response format", () => {
    const base = { text: validNarration, model: "orpheus", voice: "hannah" };
    const digest = createNarrationAudioRequestDigest(base);

    expect(createNarrationAudioRequestDigest(base)).toBe(digest);
    expect(createNarrationAudioRequestDigest({ ...base, text: `${validNarration} Again.` })).not.toBe(digest);
    expect(createNarrationAudioRequestDigest({ ...base, voice: "autumn" })).not.toBe(digest);
    expect(createNarrationAudioRequestDigest({ ...base, model: "another-model" })).not.toBe(digest);
  });
});
