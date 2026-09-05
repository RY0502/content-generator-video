import "dotenv/config";

import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG } from "../src/config.js";
import {
  NARRATION_MAX_AUDIO_SECONDS,
  countNarrationSpokenWords,
} from "../src/services/narrationContract.js";
import {
  AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
  AGNES_SERIES_KEY_ART_TRACKING_SCENE,
  agnesKeyArtPaths,
} from "../src/services/agnesKeyArtService.js";
import { SeriesState } from "../src/state/seriesState.js";
import {
  VIDEO_DURATION_TOLERANCE_SECONDS,
  buildAgnesSceneVideoTools,
} from "../src/tools/agnesSceneVideoTool.js";
import { buildCaptionTool } from "../src/tools/captionTool.js";
import {
  FINAL_DURATION_TOLERANCE_SECONDS,
  buildVideoAssemblyTool,
} from "../src/tools/videoAssemblyTool.js";
import {
  buildTtsTool,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  readNarrationAudioMetadata,
} from "../src/tools/ttsTool.js";

// Bump for a fresh multi-account scheduler run. Older smoke databases remain
// untouched so their receipts can still be audited independently.
const SMOKE_VERSION = "agnes_one_minute_multi_account_v2";
const SMOKE_ROOT = path.resolve(process.cwd(), "output", "smoke", SMOKE_VERSION);
const DATABASE_PATH = path.join(SMOKE_ROOT, "state.db");
const DATABASE_URL = `file:${DATABASE_PATH}`;
const SERIES_TITLE = "Milo and the Moonseed";
const EPISODE_NUMBER = 1;
const CHARACTER_NAME = "Milo the Fox";
const MIN_SMOKE_SECONDS = 50;
const MAX_SMOKE_SECONDS = 75;
const VERIFY_INTERVAL_MS = 30_000;
const MAX_VERIFY_WAIT_MS = 20 * 60_000;

type SmokeScene = {
  sceneNumber: number;
  narrationText: string;
  environmentDescription: string;
  action: string;
  characterNames: string[];
  characterVisuals: Array<{
    name: string;
    visualForm: "anthropomorphic_creature";
    speciesOrType: string;
  }>;
  continuityAnchors: string[];
  sceneDetails: string;
  cameraAngle: "establishing" | "medium" | "close";
  lighting: string;
};

const GARDEN =
  "The same cozy cottage garden at twilight, with a mossy stone path, low wooden gate, round pond, lavender beds, and deep blue sky.";
const MILO_VISUAL = {
  name: CHARACTER_NAME,
  visualForm: "anthropomorphic_creature" as const,
  speciesOrType: "young red fox",
};

const SCENES: SmokeScene[] = [
  {
    sceneNumber: 1,
    narrationText: "At twilight, Milo the little fox discovered a silver seed glowing softly beside the sleepy garden gate.",
    environmentDescription: GARDEN,
    action: "Milo kneels beside the gate and carefully lifts one softly glowing silver seed from the moss.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["One pearl-silver oval seed, small enough to rest in Milo's two paws."],
    sceneDetails: "Lavender sways gently; Milo looks surprised and delighted, with the pond visible far behind him.",
    cameraAngle: "establishing",
    lighting: "soft violet twilight with one subtle silver glow from the seed",
  },
  {
    sceneNumber: 2,
    narrationText: "He nestled it in warm soil, patted three times, and whispered, ‘Grow whenever you feel ready.’",
    environmentDescription: GARDEN,
    action: "Milo places the same silver seed into a tiny garden hollow, covers it, and pats the soil exactly three times.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["The pearl-silver seed is now beneath a neat round patch of freshly patted soil beside the gate."],
    sceneDetails: "His teal scarf hangs forward as he leans close and whispers kindly to the planted seed.",
    cameraAngle: "medium",
    lighting: "the same soft violet twilight, warm cottage window light touching the soil",
  },
  {
    sceneNumber: 3,
    narrationText: "A moonlit sprout curled upward, but a playful breeze bent its shimmering stem toward the dark pond.",
    environmentDescription: GARDEN,
    action: "A tiny silver-green sprout emerges from the same soil patch and bends toward the pond while Milo watches.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["A hand-high silver-green sprout grows from the round soil patch beside the gate, leaning toward the pond."],
    sceneDetails: "The sprout has two small moon-shaped leaves; Milo steadies his scarf in the breeze without touching it.",
    cameraAngle: "medium",
    lighting: "the same twilight, with cool moonlight beginning to edge the leaves",
  },
  {
    sceneNumber: 4,
    narrationText: "Milo stacked smooth pebbles around it, then noticed the tender sprout still needed room to sway.",
    environmentDescription: GARDEN,
    action: "Milo makes a low pebble circle around the leaning sprout, pauses, then removes two stones to give it space.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["The same silver-green sprout leans toward the pond inside a low, incomplete ring of smooth gray pebbles."],
    sceneDetails: "Milo's first proud smile turns thoughtful when the leaves brush the tight pebble ring.",
    cameraAngle: "close",
    lighting: "cool moonlit leaves with soft amber light on Milo from the cottage",
  },
  {
    sceneNumber: 5,
    narrationText: "He wove fallen grass into a gentle ring, leaving little openings for rain, beetles, and dancing fireflies.",
    environmentDescription: GARDEN,
    action: "Milo replaces the pebbles with a loose woven grass ring, visibly leaving several open gaps around the sprout.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["The same leaning silver-green sprout is protected by one loose woven grass ring with visible open gaps."],
    sceneDetails: "Two ordinary fireflies drift through the openings while Milo checks that the stem can sway freely.",
    cameraAngle: "medium",
    lighting: "gentle blue moonlight, warm firefly pinpoints, and no magical symbols",
  },
  {
    sceneNumber: 6,
    narrationText: "Heavy clouds arrived, and Milo shielded the seedling with his tail while bright raindrops drummed around them.",
    environmentDescription: GARDEN,
    action: "Rain begins; Milo curls his single fluffy tail above the same sprout like a small shelter while it sways safely.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["The same sprout remains inside the loose woven grass ring; its two moon-shaped leaves are wet but unbroken."],
    sceneDetails: "Raindrops ripple the pond and darken the path; Milo looks determined, calm, and protective.",
    cameraAngle: "medium",
    lighting: "soft storm-blue moonlight with bright natural rain highlights",
  },
  {
    sceneNumber: 7,
    narrationText: "When the storm passed, the straightened sprout opened into a round moonflower, shining across every wet leaf.",
    environmentDescription: GARDEN,
    action: "The clouds part as the same sprout straightens and slowly opens one large round pearl-white flower before Milo.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["One pearl-white round moonflower now stands upright inside the same loose grass ring beside the gate."],
    sceneDetails: "Milo lowers his tail and beams; water beads on the flower and surrounding lavender.",
    cameraAngle: "establishing",
    lighting: "clear moonlight reflected in raindrops, with a soft natural glow from the open flower",
  },
  {
    sceneNumber: 8,
    narrationText: "Its silver light helped a tiny lost snail find the mossy path home, one patient step at a time.",
    environmentDescription: GARDEN,
    action: "Milo walks slowly beside one tiny brown snail as the moonflower lights their route across the mossy path.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["The same open moonflower and grass ring remain beside the gate behind Milo."],
    sceneDetails: "One tiny brown garden snail with a chestnut spiral shell moves toward the lavender bed; Milo matches its pace.",
    cameraAngle: "medium",
    lighting: "calm silver moonlight tracing a clear path through the wet garden",
  },
  {
    sceneNumber: 9,
    narrationText: "Milo rested beneath the flower’s glow, knowing gentle, patient care can help the smallest wonder grow strong.",
    environmentDescription: GARDEN,
    action: "Milo sits peacefully beside the upright moonflower, smiles at its steady leaves, and looks across the quiet garden.",
    characterNames: [CHARACTER_NAME],
    characterVisuals: [MILO_VISUAL],
    continuityAnchors: ["The same pearl-white moonflower stands upright inside the loose woven grass ring beside the gate."],
    sceneDetails: "The snail is safely near the lavender bed; Milo's paws rest in his lap and his teal scarf is still.",
    cameraAngle: "establishing",
    lighting: "serene silver moonlight mixed with a final warm glow from the cottage window",
  },
];

type JsonObject = Record<string, unknown>;

function log(event: string, details: JsonObject = {}): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`);
}

function parseToolJson(value: unknown, toolName: string): JsonObject {
  if (typeof value !== "string") {
    throw new Error(`${toolName} returned a non-string result.`);
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${toolName} returned a non-object JSON result.`);
  }
  return parsed as JsonObject;
}

async function callTool(
  tool: { call(input: JsonObject): Promise<unknown> },
  input: JsonObject,
  toolName: string,
): Promise<JsonObject> {
  return parseToolJson(await tool.call(input), toolName);
}

function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} exited with code ${code}: ${stderr.slice(-4_000)}`));
    });
  });
}

async function probeDuration(filePath: string): Promise<number> {
  const output = await runProcess(CONFIG.ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid media duration for ${filePath}: ${output.trim()}`);
  }
  return duration;
}

async function probeMedia(filePath: string): Promise<JsonObject> {
  const output = await runProcess(CONFIG.ffprobePath, [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,start_time,duration",
    "-of", "json",
    filePath,
  ]);
  return JSON.parse(output) as JsonObject;
}

async function assertNonEmptyFile(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0) throw new Error(`Expected a non-empty file: ${filePath}`);
}

function scriptPayload(): JsonObject {
  return {
    title: "Milo and the Moonseed",
    premise: "Milo learns that patient, gentle care gives a tiny moonflower room to grow.",
    scenes: SCENES,
  };
}

class SmokeSeriesState extends SeriesState {
  private allowedEpisode: { id: number; seriesId: number; episodeNumber: number } | null = null;

  allowShortEpisode(episode: { id: number; seriesId: number; episodeNumber: number }): void {
    this.allowedEpisode = episode;
  }

  /**
   * Smoke-only replacement for the >=300-second production gate. It preserves
   * exact-text provenance, measured-duration, <=12-second, and manifest checks.
   * This class is connected only to the dedicated local smoke database.
   */
  override async assertEpisodeAudioReady(episodeId: number): Promise<{ totalDurationSeconds: number }> {
    const allowed = this.allowedEpisode;
    if (!allowed || episodeId !== allowed.id) {
      throw new Error("The one-minute override is restricted to the isolated smoke episode.");
    }
    const episode = await this.getEpisodeByNumber(allowed.seriesId, allowed.episodeNumber);
    const root = episode?.scriptJson as { scenes?: SmokeScene[] } | null;
    if (!root?.scenes || JSON.stringify(root.scenes) !== JSON.stringify(SCENES)) {
      throw new Error("The persisted smoke script does not match the fixed smoke manifest.");
    }

    let totalDurationSeconds = 0;
    for (const scene of SCENES) {
      const stem = `scene_${String(scene.sceneNumber).padStart(3, "0")}`;
      const audioPath = path.join(
        CONFIG.outputDir,
        `series_${allowed.seriesId}`,
        `episode_${allowed.episodeNumber}`,
        "audio",
        `${stem}_narrator.wav`,
      );
      await assertNonEmptyFile(audioPath);
      const metadata = await readNarrationAudioMetadata(narrationAudioMetadataPath(audioPath));
      const expectedDigest = createNarrationAudioRequestDigest({
        text: scene.narrationText,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      });
      const durationSeconds = await probeDuration(audioPath);
      if (
        !metadata || metadata.requestDigest !== expectedDigest || metadata.durationStatus !== "ready" ||
        Math.abs(metadata.durationSeconds - durationSeconds) > 0.05 ||
        durationSeconds > NARRATION_MAX_AUDIO_SECONDS
      ) {
        throw new Error(`Smoke narration provenance/duration check failed for scene ${scene.sceneNumber}.`);
      }
      totalDurationSeconds += durationSeconds;
    }
    if (totalDurationSeconds < MIN_SMOKE_SECONDS || totalDurationSeconds > MAX_SMOKE_SECONDS) {
      throw new Error(
        `Smoke narration is ${totalDurationSeconds.toFixed(3)}s; expected ${MIN_SMOKE_SECONDS}-${MAX_SMOKE_SECONDS}s.`,
      );
    }
    return { totalDurationSeconds };
  }
}

async function seedIsolatedState(state: SmokeSeriesState): Promise<{
  seriesId: number;
  episodeId: number;
}> {
  const characterDescription =
    "Milo is a gentle young male red fox with warm russet-orange fur, a cream muzzle and tail tip, large amber eyes, rounded ears, childlike proportions, and one small teal neck scarf.";
  const generationPrompt =
    "Young male red fox, russet-orange fur, cream muzzle and tail tip, large amber eyes, rounded ears, one teal neck scarf, childlike proportions, fluffy single tail, gentle curious smile. Always same colors.";
  const seriesId = await state.getOrCreateSeries(
    SERIES_TITLE,
    [{ name: CHARACTER_NAME, description: characterDescription }],
    [{ name: "Moonseed Garden", description: GARDEN }],
    "A tiny discovery grows through patient, gentle problem solving.",
  );
  await state.bulkInsertEpisodesIfEmpty(
    seriesId,
    Array.from({ length: 25 }, (_unused, index) => ({
      episodeNumber: index + 1,
      title: index === 0 ? "Milo and the Moonseed" : `Reserved smoke episode ${index + 1}`,
      premise: index === 0
        ? "Milo gently helps a moonflower grow after a rainy garden night."
        : "Reserved; this local smoke harness renders episode one only.",
    })),
  );
  await state.upsertCharacterSheet(seriesId, CHARACTER_NAME, characterDescription, {}, generationPrompt);

  const episode = await state.getEpisodeByNumber(seriesId, EPISODE_NUMBER);
  if (!episode) throw new Error("The isolated smoke episode was not created.");
  const database = createClient({ url: DATABASE_URL });
  try {
    const current = await database.execute({
      sql: "SELECT script_json FROM episodes WHERE id = ? LIMIT 1",
      args: [episode.id],
    });
    const existingScript = current.rows[0]?.script_json;
    const nextScript = JSON.stringify(scriptPayload());
    if (existingScript && String(existingScript) !== nextScript) {
      const generations = await state.listAgnesSceneGenerations(seriesId, EPISODE_NUMBER, "text");
      if (generations.length > 0) {
        throw new Error(
          "The smoke script changed after Agnes state was created. Use a new SMOKE_VERSION instead of resubmitting.",
        );
      }
    }
    await database.execute({
      sql: `UPDATE episodes
            SET title = ?, premise = ?, script_json = ?,
                status = CASE WHEN status = 'pending' THEN 'script' ELSE status END,
                updated_at = datetime('now')
            WHERE id = ?`,
      args: [
        "Milo and the Moonseed",
        "Milo learns that patient, gentle care gives a tiny moonflower room to grow.",
        nextScript,
        episode.id,
      ],
    });
  } finally {
    database.close();
  }
  state.allowShortEpisode({ id: episode.id, seriesId, episodeNumber: EPISODE_NUMBER });
  return { seriesId, episodeId: episode.id };
}

async function generateNarration(seriesId: number): Promise<{
  scenes: Array<{ sceneNumber: number; text: string; durationSeconds: number; narrationAudioPath: string }>;
  reusedCount: number;
  totalDurationSeconds: number;
}> {
  const tool = buildTtsTool({ outputDir: CONFIG.outputDir });
  const results = [];
  for (const scene of SCENES) {
    const result = await callTool(tool as never, {
      seriesId,
      episodeNumber: EPISODE_NUMBER,
      sceneNumber: scene.sceneNumber,
      text: scene.narrationText,
    }, "synthesize_narration_audio");
    log("tts_scene", {
      sceneNumber: scene.sceneNumber,
      status: result.status,
      durationSeconds: result.durationSeconds,
    });
    if (result.readyForAgnes !== true || typeof result.path !== "string" || typeof result.durationSeconds !== "number") {
      throw new Error(`Scene ${scene.sceneNumber} narration is not ready for Agnes: ${JSON.stringify(result)}`);
    }
    results.push({
      sceneNumber: scene.sceneNumber,
      text: scene.narrationText,
      durationSeconds: result.durationSeconds,
      narrationAudioPath: result.path,
      reused: result.reused === true,
    });
  }
  return {
    scenes: results.map(({ reused: _reused, ...scene }) => scene),
    reusedCount: results.filter((result) => result.reused).length,
    totalDurationSeconds: results.reduce((sum, result) => sum + result.durationSeconds, 0),
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function validateFinalMedia(params: {
  state: SmokeSeriesState;
  seriesId: number;
  finalPath: string;
  expectedDurationSeconds: number;
  allowedDurationDeltaSeconds: number;
  narration: Array<{ sceneNumber: number; durationSeconds: number; narrationAudioPath: string }>;
}): Promise<JsonObject> {
  const rows = await params.state.listAgnesSceneGenerations(params.seriesId, EPISODE_NUMBER, "text");
  if (rows.length !== SCENES.length + 2) {
    throw new Error(`Expected ${SCENES.length + 2} Agnes rows (two key arts plus scenes), found ${rows.length}.`);
  }
  const requiredAssets = [
    {
      assetKind: "series_key_art" as const,
      sceneNumber: AGNES_SERIES_KEY_ART_TRACKING_SCENE,
      audioPath: agnesKeyArtPaths({
        outputDir: CONFIG.outputDir,
        seriesId: params.seriesId,
        episodeNumber: EPISODE_NUMBER,
        kind: "series",
      }).audioPath,
    },
    {
      assetKind: "episode_key_art" as const,
      sceneNumber: AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
      audioPath: agnesKeyArtPaths({
        outputDir: CONFIG.outputDir,
        seriesId: params.seriesId,
        episodeNumber: EPISODE_NUMBER,
        kind: "episode",
      }).audioPath,
    },
    ...params.narration.map((narration) => ({
      assetKind: "scene" as const,
      sceneNumber: narration.sceneNumber,
      audioPath: narration.narrationAudioPath,
    })),
  ];
  const assetChecks = [];
  for (const asset of requiredAssets) {
    const row = rows.find((entry) => entry.sceneNumber === asset.sceneNumber);
    const assetLabel = asset.assetKind === "scene"
      ? `Scene ${asset.sceneNumber}`
      : `${asset.assetKind === "series_key_art" ? "Series" : "Episode"} key art (${asset.sceneNumber})`;
    if (!row || row.status !== "completed" || row.downloadStatus !== "downloaded" || !row.normalizedOutputPath) {
      throw new Error(`${assetLabel} is not durably downloaded and completed.`);
    }
    if (!row.providerTaskId?.trim()) {
      throw new Error(`${assetLabel} has no persisted Agnes provider task id.`);
    }
    await Promise.all([
      assertNonEmptyFile(asset.audioPath),
      assertNonEmptyFile(row.normalizedOutputPath),
    ]);
    const audioDuration = await probeDuration(asset.audioPath);
    const videoDuration = await probeDuration(row.normalizedOutputPath);
    const deltaSeconds = Math.abs(audioDuration - videoDuration);
    if (deltaSeconds > VIDEO_DURATION_TOLERANCE_SECONDS) {
      throw new Error(`${assetLabel} A/V delta is ${deltaSeconds.toFixed(3)}s.`);
    }
    assetChecks.push({
      assetKind: asset.assetKind,
      sceneNumber: asset.sceneNumber,
      audioDurationSeconds: audioDuration,
      videoDurationSeconds: videoDuration,
      deltaSeconds,
      providerTaskId: row.providerTaskId,
      attemptCount: row.attemptCount,
    });
  }

  await assertNonEmptyFile(params.finalPath);
  const finalDurationSeconds = await probeDuration(params.finalPath);
  const finalDurationDeltaSeconds = Math.abs(finalDurationSeconds - params.expectedDurationSeconds);
  if (finalDurationDeltaSeconds > params.allowedDurationDeltaSeconds) {
    throw new Error(
      `Final duration delta is ${finalDurationDeltaSeconds.toFixed(3)}s (allowed ` +
      `${params.allowedDurationDeltaSeconds.toFixed(3)}s); duplicate/missing timeline suspected.`,
    );
  }
  const media = await probeMedia(params.finalPath);
  const streams = Array.isArray(media.streams) ? media.streams as JsonObject[] : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  if (videoStreams.length !== 1 || audioStreams.length !== 1) {
    throw new Error(`Expected one video and one audio stream; found ${videoStreams.length} and ${audioStreams.length}.`);
  }
  await runProcess(CONFIG.ffmpegPath, ["-v", "error", "-i", params.finalPath, "-f", "null", "-"]);

  const taskIds = assetChecks.map(({ providerTaskId }) => providerTaskId);
  if (new Set(taskIds).size !== requiredAssets.length) {
    throw new Error("Both key arts and every smoke scene must have distinct persisted Agnes task ids.");
  }
  const keyArtChecks = assetChecks.filter(({ assetKind }) => assetKind !== "scene");
  const sceneChecks = assetChecks.filter(({ assetKind }) => assetKind === "scene");
  return {
    pass: true,
    finalDurationSeconds,
    expectedDurationSeconds: params.expectedDurationSeconds,
    finalDurationDeltaSeconds,
    streamCount: streams.length,
    videoCodec: videoStreams[0]?.codec_name,
    audioCodec: audioStreams[0]?.codec_name,
    width: videoStreams[0]?.width,
    height: videoStreams[0]?.height,
    frameRate: videoStreams[0]?.avg_frame_rate,
    keyArtChecks,
    sceneChecks,
  };
}

async function main(): Promise<void> {
  if (!process.env.GROQ_API_KEY_1?.trim()) {
    throw new Error("GROQ_API_KEY_1 is required by the configured audio-generation provider.");
  }
  if (CONFIG.agnesApiKeys.length === 0) {
    throw new Error("At least one AGNES_API_KEY or AGNES_API_KEY_n is required.");
  }
  for (const scene of SCENES) {
    const words = countNarrationSpokenWords(scene.narrationText);
    if (words > 20 || scene.narrationText.length > 200) {
      throw new Error(`Smoke scene ${scene.sceneNumber} exceeds the production narration bounds.`);
    }
  }

  await mkdir(SMOKE_ROOT, { recursive: true });
  (CONFIG as { outputDir: string }).outputDir = SMOKE_ROOT;
  const state = new SmokeSeriesState(DATABASE_URL, "");
  try {
    const { seriesId, episodeId } = await seedIsolatedState(state);
    const availabilityBefore = await state.getNextEpisodeAvailability(seriesId);
    if (availabilityBefore.kind !== "ready" || availabilityBefore.episode.episodeNumber !== EPISODE_NUMBER) {
      throw new Error(`The isolated episode is not resumable: ${JSON.stringify(availabilityBefore)}`);
    }
    log("state_ready", { seriesId, episodeId, status: availabilityBefore.episode.status });

    const narration = await generateNarration(seriesId);
    if (narration.totalDurationSeconds < MIN_SMOKE_SECONDS || narration.totalDurationSeconds > MAX_SMOKE_SECONDS) {
      throw new Error(
        `Measured story narration is ${narration.totalDurationSeconds.toFixed(3)}s; expected ${MIN_SMOKE_SECONDS}-${MAX_SMOKE_SECONDS}s.`,
      );
    }
    await state.updateEpisodeStatus(episodeId, "audio");
    const captionTool = buildCaptionTool();
    const captions = await callTool(captionTool as never, {
      seriesId,
      episodeNumber: EPISODE_NUMBER,
      scenes: narration.scenes.map((scene) => ({
        sceneNumber: scene.sceneNumber,
        text: scene.text,
        durationSeconds: scene.durationSeconds,
      })),
    }, "generate_episode_captions");
    log("audio_ready", {
      sceneCount: narration.scenes.length,
      totalDurationSeconds: narration.totalDurationSeconds,
      reusedCount: narration.reusedCount,
    });

    const [submitTool, verifyTool, downloadTool] = buildAgnesSceneVideoTools(state, {
      includeKeyArt: true,
      submissionBatchSize: 2,
      queuePollIntervalMs: 30_000,
      queuePollWindowMs: 5 * 60_000,
    });
    const identity = { seriesId, episodeNumber: EPISODE_NUMBER };
    const submission = await callTool(submitTool as never, identity, "submit_agnes_scene_videos");
    log("agnes_submit", submission);
    if (Number(submission.failed ?? 0) > 0) {
      throw new Error(`Agnes submission has terminal failures: ${JSON.stringify(submission)}`);
    }
    if (submission.stopRun === true && Number(submission.pending ?? 0) > 0) {
      log("resume_required", {
        reason: "Some submissions remain pending; rerun this command later to preserve retry semantics.",
      });
      process.exitCode = 2;
      return;
    }

    const verifyDeadline = Date.now() + MAX_VERIFY_WAIT_MS;
    let verification: JsonObject;
    while (true) {
      verification = await callTool(verifyTool as never, identity, "verify_agnes_scene_videos");
      log("agnes_verify", {
        status: verification.status,
        readyToDownload: verification.readyToDownload,
        failed: verification.failed,
      });
      if (verification.status === "ready_to_download") break;
      if (verification.status === "blocked" || Number(verification.failed ?? 0) > 0) {
        throw new Error(`Agnes verification is blocked: ${JSON.stringify(verification)}`);
      }
      if (verification.status === "submission_attempted") {
        log("resume_required", {
          reason: "Verification submitted pending work once; rerun later before polling it.",
        });
        process.exitCode = 2;
        return;
      }
      if (Date.now() >= verifyDeadline) {
        log("resume_required", {
          reason: "Provider generation is still active after the bounded smoke wait; rerun to resume.",
        });
        process.exitCode = 2;
        return;
      }
      await wait(VERIFY_INTERVAL_MS);
    }

    const download = await callTool(downloadTool as never, identity, "download_agnes_scene_videos");
    log("agnes_download", { status: download.status, completed: download.completed, pending: download.pending });
    if (download.status !== "completed" || Number(download.completed) !== SCENES.length + 2) {
      throw new Error(`Agnes download did not complete both key arts and every scene: ${JSON.stringify(download)}`);
    }

    // Repeat the safe phases in the same runtime. Neither call may create a
    // second provider task or redownload a valid canonical scene.
    const repeatSubmission = await callTool(submitTool as never, identity, "submit_agnes_scene_videos");
    const repeatDownload = await callTool(downloadTool as never, identity, "download_agnes_scene_videos");
    if (Number(repeatSubmission.attemptedCount) !== 0) {
      throw new Error(`Completed scenes were unexpectedly resubmitted: ${JSON.stringify(repeatSubmission)}`);
    }
    const repeatResults = Array.isArray(repeatDownload.results) ? repeatDownload.results as JsonObject[] : [];
    if (repeatResults.length !== SCENES.length + 2 || repeatResults.some((result) => result.reused !== true)) {
      throw new Error(`Completed key-art/scene downloads were not fully reused: ${JSON.stringify(repeatDownload)}`);
    }

    const episodeDir = path.join(SMOKE_ROOT, `series_${seriesId}`, `episode_${EPISODE_NUMBER}`);
    const finalPath = path.join(episodeDir, "Milo_and_the_Moonseed_smoke.mp4");
    const assemblyTool = buildVideoAssemblyTool(state, {
      outputPath: finalPath,
      workDir: path.join(episodeDir, "work_smoke"),
      includeOutro: false,
      includeKeyArt: true,
    });
    const assembly = await callTool(assemblyTool as never, {
      seriesId,
      seriesTitle: SERIES_TITLE,
      episodeNumber: EPISODE_NUMBER,
      scenes: narration.scenes.map((scene) => ({
        sceneNumber: scene.sceneNumber,
        narrationAudioPath: scene.narrationAudioPath,
      })),
      captionsSrtPath: captions.path,
      burnSubtitles: false,
    }, "assemble_episode_video");
    log("assembly_complete", assembly);

    const validation = await validateFinalMedia({
      state,
      seriesId,
      finalPath,
      expectedDurationSeconds: Number(assembly.expectedDurationSeconds),
      allowedDurationDeltaSeconds: Number(
        assembly.allowedDurationDeltaSeconds ?? FINAL_DURATION_TOLERANCE_SECONDS,
      ),
      narration: narration.scenes,
    });
    let directDoneRejected = false;
    try {
      await state.updateEpisodeStatus(episodeId, "done");
    } catch (error) {
      directDoneRejected = /Only finalizeEpisodeUpload may mark an episode done/u.test(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!directDoneRejected) throw new Error("The smoke episode could bypass YouTube-only completion.");
    const availabilityAfter = await state.getNextEpisodeAvailability(seriesId);
    if (availabilityAfter.kind !== "ready" || availabilityAfter.episode.episodeNumber !== EPISODE_NUMBER) {
      throw new Error("The incomplete smoke episode did not remain resumable after assembly.");
    }

    const report = {
      status: "passed",
      smokeVersion: SMOKE_VERSION,
      concept: SERIES_TITLE,
      seriesId,
      episodeNumber: EPISODE_NUMBER,
      sceneCount: SCENES.length,
      narrationWords: SCENES.reduce((sum, scene) => sum + countNarrationSpokenWords(scene.narrationText), 0),
      narrationDurationSeconds: narration.totalDurationSeconds,
      finalPath,
      captionsPath: captions.path,
      databasePath: DATABASE_PATH,
      ttsReuseCountAtStart: narration.reusedCount,
      repeatSubmissionAttemptedCount: repeatSubmission.attemptedCount,
      repeatDownloadsReused: repeatResults.length,
      directDoneRejected,
      resumableStatusAfterAssembly: availabilityAfter.episode.status,
      validation,
    };
    const reportPath = path.join(episodeDir, "smoke-report.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log("smoke_passed", { finalPath, reportPath, durationSeconds: validation.finalDurationSeconds });
  } finally {
    await state.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
