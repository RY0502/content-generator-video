import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import ffmpeg from "fluent-ffmpeg";
import { createAudioGenTool } from "freetier-deepagent-framework";
import { CONFIG } from "../config.js";
import {
  NARRATION_MAX_AUDIO_SECONDS,
  NARRATION_MAX_RAW_CHARACTERS,
  NARRATION_MAX_SPOKEN_WORDS,
  inspectNarrationDuration,
  inspectNarrationText,
} from "../services/narrationContract.js";

ffmpeg.setFfprobePath(CONFIG.ffprobePath);

export const NARRATION_METADATA_SCHEMA_VERSION = 1 as const;
export const NARRATION_METADATA_KIND = "narration-audio" as const;
const NARRATION_RESPONSE_FORMAT = "wav" as const;
const AUDIO_DURATION_METADATA_TOLERANCE_SECONDS = 0.05;
const NARRATION_AUDIO_MUTATION_LEASE_MS = 15 * 60_000;

export interface NarrationAudioGenerator {
  invoke(input: {
    input: string;
    outputPath: string;
    voice: string;
    model: string;
    responseFormat: typeof NARRATION_RESPONSE_FORMAT;
  }): Promise<unknown>;
}

export interface NarrationAudioMetadata {
  schemaVersion: typeof NARRATION_METADATA_SCHEMA_VERSION;
  kind: typeof NARRATION_METADATA_KIND;
  requestDigest: string;
  model: string;
  voice: string;
  responseFormat: typeof NARRATION_RESPONSE_FORMAT;
  textLength: number;
  spokenWordCount: number;
  durationSeconds: number;
  durationStatus: "ready" | "duration_exceeded";
  /** Unique lease owner that published this canonical pair; absent on legacy files. */
  publicationToken?: string;
}

export interface TtsToolOptions {
  audioGenerator?: NarrationAudioGenerator;
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  outputDir?: string;
  seriesState?: {
    beginEpisodeNarrationAudioMutation(input: {
      seriesId: number;
      episodeNumber: number;
      sceneNumber: number;
      leaseToken: string;
      leaseExpiresAtMs: number;
      nowMs?: number;
    }): Promise<{
      acquired: boolean;
      audioRevision?: number;
      reason?: "agnes_started" | "mutation_in_progress" | "episode_complete";
      startedAssetCount: number;
    }>;
    renewEpisodeNarrationAudioMutation(input: {
      seriesId: number;
      episodeNumber: number;
      sceneNumber: number;
      leaseToken: string;
      leaseExpiresAtMs: number;
      nowMs?: number;
    }): Promise<boolean>;
    completeEpisodeNarrationAudioMutation(input: {
      seriesId: number;
      episodeNumber: number;
      sceneNumber: number;
      leaseToken: string;
    }): Promise<boolean>;
    abortEpisodeNarrationAudioMutation(input: {
      seriesId: number;
      episodeNumber: number;
      sceneNumber: number;
      leaseToken: string;
    }): Promise<boolean>;
  };
  /** Test hook; production retains the existing one/two-second outer retry delays. */
  retryDelayMs?: (attempt: number) => number;
}

type NarrationAudioMutationState = NonNullable<TtsToolOptions["seriesState"]>;

/** Minimal durable episode lookup needed by the production batch wrapper. */
export type EpisodeTtsState = NarrationAudioMutationState & {
  getEpisodeByNumber(
    seriesId: number,
    episodeNumber: number,
  ): Promise<{ id: number; scriptJson: unknown } | null>;
};

export type EpisodeTtsToolOptions = Omit<TtsToolOptions, "seriesState"> & {
  seriesState: EpisodeTtsState;
  /** Injectable so focused tests can assert progress without writing to stdout. */
  progressLogger?: (message: string) => void;
};

export type EpisodeTtsToolOverrides = Omit<EpisodeTtsToolOptions, "seriesState">;

interface PersistedNarrationScene {
  sceneNumber: number;
  narrationText: string;
}

interface SingleSceneTtsReceipt {
  status: string;
  readyForAgnes: boolean;
  reused: boolean;
  durationSeconds?: number;
  sceneNumber?: number;
  startedAssetCount?: number;
  phase?: string;
  reason?: string;
}

const MIN_PRODUCTION_NARRATION_SECONDS = 5 * 60;

/** Stable sidecar path used to prove that a WAV belongs to the current narration request. */
export function narrationAudioMetadataPath(audioPath: string): string {
  const extension = path.extname(audioPath);
  return extension
    ? `${audioPath.slice(0, -extension.length)}.metadata.json`
    : `${audioPath}.metadata.json`;
}

/**
 * Fingerprints every input that can change the generated speech. Output paths
 * and scene numbers are deliberately excluded so identical generation inputs
 * have one stable identity.
 */
export function createNarrationAudioRequestDigest(params: {
  text: string;
  model: string;
  voice: string;
  responseFormat?: typeof NARRATION_RESPONSE_FORMAT;
}): string {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
    text: params.text,
    model: params.model,
    voice: params.voice,
    responseFormat: params.responseFormat ?? NARRATION_RESPONSE_FORMAT,
  })).digest("hex");
}

/** Probes an audio file's duration in seconds via ffprobe. */
function defaultProbeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration ?? 0);
    });
  });
}

/** Validates that an audio file exists, is non-empty, and has a usable duration. */
async function validateAudioOutput(
  filePath: string,
  probeDurationSeconds: (filePath: string) => Promise<number>,
): Promise<number> {
  const file = await stat(filePath);
  if (!file.isFile() || file.size === 0) throw new Error(`Audio output is empty or not a file: ${filePath}`);
  const durationSeconds = await probeDurationSeconds(filePath);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Audio output has invalid duration: ${filePath}`);
  }
  return durationSeconds;
}

function isNarrationAudioMetadata(value: unknown): value is NarrationAudioMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === NARRATION_METADATA_SCHEMA_VERSION
    && item.kind === NARRATION_METADATA_KIND
    && typeof item.requestDigest === "string"
    && /^[a-f0-9]{64}$/u.test(item.requestDigest)
    && typeof item.model === "string"
    && typeof item.voice === "string"
    && item.responseFormat === NARRATION_RESPONSE_FORMAT
    && Number.isSafeInteger(item.textLength)
    && Number(item.textLength) >= 0
    && Number.isSafeInteger(item.spokenWordCount)
    && Number(item.spokenWordCount) >= 0
    && typeof item.durationSeconds === "number"
    && Number.isFinite(item.durationSeconds)
    && item.durationSeconds > 0
    && (item.durationStatus === "ready" || item.durationStatus === "duration_exceeded")
    && (item.publicationToken === undefined
      || (typeof item.publicationToken === "string" && item.publicationToken.length > 0));
}

export async function readNarrationAudioMetadata(metadataPath: string): Promise<NarrationAudioMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
    return isNarrationAudioMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeNarrationAudioMetadata(
  metadataPath: string,
  metadata: NarrationAudioMetadata,
): Promise<void> {
  const temporaryPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(metadataPath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function resultForAudio(params: {
  audioPath: string;
  metadataPath: string;
  metadata: NarrationAudioMetadata;
  reused: boolean;
  attempt?: number;
}): string {
  const durationInspection = inspectNarrationDuration(params.metadata.durationSeconds);
  if (params.metadata.durationStatus !== "ready" || !durationInspection.pass) {
    return JSON.stringify({
      status: "duration_exceeded",
      readyForAgnes: false,
      reused: params.reused,
      rejectedPath: params.audioPath,
      metadataPath: params.metadataPath,
      requestDigest: params.metadata.requestDigest,
      durationSeconds: params.metadata.durationSeconds,
      maxDurationSeconds: NARRATION_MAX_AUDIO_SECONDS,
      textLength: params.metadata.textLength,
      spokenWordCount: params.metadata.spokenWordCount,
      needsScriptSplit: true,
      error: durationInspection.message ??
        `Narration metadata marks this artifact as ${params.metadata.durationStatus}; split the script scene and regenerate it.`,
    });
  }

  return JSON.stringify({
    status: params.reused
      ? "already_generated"
      : params.attempt === 1 ? "generated" : "generated_after_retry",
    readyForAgnes: true,
    reused: params.reused,
    path: params.audioPath,
    metadataPath: params.metadataPath,
    requestDigest: params.metadata.requestDigest,
    durationSeconds: params.metadata.durationSeconds,
    maxDurationSeconds: NARRATION_MAX_AUDIO_SECONDS,
    textLength: params.metadata.textLength,
    spokenWordCount: params.metadata.spokenWordCount,
  });
}

function blockedMutationResult(params: {
  sceneNumber: number;
  startedAssetCount: number;
  phase: "before_generation" | "before_publication" | "lease_completion";
  reason: "agnes_started" | "mutation_in_progress" | "lease_lost" | "episode_complete";
}): string {
  const permanentlyLocked = params.reason === "agnes_started" || params.reason === "episode_complete";
  return JSON.stringify({
    status: permanentlyLocked ? "audio_repair_blocked" : "audio_repair_deferred",
    readyForAgnes: false,
    reused: false,
    sceneNumber: params.sceneNumber,
    startedAssetCount: params.startedAssetCount,
    phase: params.phase,
    reason: params.reason,
    error: permanentlyLocked
      ? params.reason === "episode_complete"
        ? "Narration audio is immutable after YouTube completion. The prior WAV and provenance sidecar were preserved; stop this run without retrying TTS."
        : "Narration audio is immutable after any Agnes submission claim. The prior WAV and provenance sidecar were preserved; stop this run without retrying TTS."
      : "Another narration-audio mutation owns the durable lease, or this invocation lost it. The prior WAV and provenance sidecar were preserved; stop and retry on a later run.",
  });
}

function parsePersistedNarrationScenes(value: unknown): PersistedNarrationScene[] {
  let root = value;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root) as unknown;
    } catch {
      throw new Error("Persisted episode script must be a JSON object.");
    }
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("Persisted episode script must be a JSON object.");
  }

  let rawScenes: unknown = (root as Record<string, unknown>).scenes;
  if (typeof rawScenes === "string") {
    try {
      rawScenes = JSON.parse(rawScenes) as unknown;
    } catch {
      throw new Error("Persisted episode script must contain a scenes array.");
    }
  }
  if (!Array.isArray(rawScenes) || rawScenes.length === 0) {
    throw new Error("Persisted episode script must contain a non-empty scenes array.");
  }

  const issues: string[] = [];
  const scenes = rawScenes.map((entry, index): PersistedNarrationScene => {
    const expectedSceneNumber = index + 1;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(`Scene ${expectedSceneNumber} must be an object.`);
      return { sceneNumber: expectedSceneNumber, narrationText: "" };
    }
    const scene = entry as Record<string, unknown>;
    const sceneNumber = Number(scene.sceneNumber);
    if (!Number.isSafeInteger(sceneNumber) || sceneNumber !== expectedSceneNumber) {
      issues.push(`Scene ${expectedSceneNumber} must have sequential sceneNumber ${expectedSceneNumber}.`);
    }
    const narrationText = typeof scene.narrationText === "string"
      ? scene.narrationText.trim()
      : "";
    const inspection = inspectNarrationText(narrationText, { production: true });
    for (const issue of inspection.issues) {
      issues.push(`Scene ${expectedSceneNumber}: ${issue.message}`);
    }
    return { sceneNumber: expectedSceneNumber, narrationText };
  });

  if (issues.length > 0) {
    const shown = issues.slice(0, 8);
    const omitted = issues.length - shown.length;
    throw new Error(
      `Persisted episode narration is invalid: ${shown.join(" | ")}` +
      (omitted > 0 ? ` | ${omitted} additional issue(s) omitted.` : ""),
    );
  }
  return scenes;
}

function parseSingleSceneTtsReceipt(raw: unknown, sceneNumber: number): SingleSceneTtsReceipt {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new Error(`Scene ${sceneNumber} TTS returned invalid JSON.`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Scene ${sceneNumber} TTS returned an invalid receipt.`);
  }
  const receipt = parsed as Record<string, unknown>;
  const supportedStatuses = new Set([
    "generated",
    "generated_after_retry",
    "already_generated",
    "duration_exceeded",
    "audio_repair_blocked",
    "audio_repair_deferred",
  ]);
  if (
    typeof receipt.status !== "string"
    || !supportedStatuses.has(receipt.status)
    || typeof receipt.readyForAgnes !== "boolean"
    || typeof receipt.reused !== "boolean"
  ) {
    throw new Error(`Scene ${sceneNumber} TTS returned an invalid receipt.`);
  }
  const blocked = receipt.status === "audio_repair_blocked"
    || receipt.status === "audio_repair_deferred";
  if (!blocked && (
    typeof receipt.durationSeconds !== "number"
    || !Number.isFinite(receipt.durationSeconds)
    || receipt.durationSeconds <= 0
  )) {
    throw new Error(`Scene ${sceneNumber} TTS returned an invalid measured duration.`);
  }
  return receipt as unknown as SingleSceneTtsReceipt;
}

/**
 * Synthesizes exactly one bounded narration request for one script scene.
 * Long narration is rejected before Groq instead of being concatenated into a
 * scene that Agnes would have to render as two unrelated clips.
 */
export function buildTtsTool(options: TtsToolOptions = {}): DynamicStructuredTool {
  const audioGenerator = options.audioGenerator ?? createAudioGenTool();
  const probeDurationSeconds = options.probeDurationSeconds ?? defaultProbeDurationSeconds;
  const outputDir = path.resolve(options.outputDir ?? CONFIG.outputDir);
  const retryDelayMs = options.retryDelayMs ?? ((attempt: number) => attempt * 1_000);

  return new DynamicStructuredTool({
    name: "synthesize_narration_audio",
    description:
      "Converts exactly one scene's bounded narration into exactly one Groq TTS request using the fixed " +
      "episode narrator. The input must be non-empty, no more than " +
      `${NARRATION_MAX_RAW_CHARACTERS} raw characters, and no more than ${NARRATION_MAX_SPOKEN_WORDS} spoken words. ` +
      `The measured WAV must be no longer than ${NARRATION_MAX_AUDIO_SECONDS} seconds. ` +
      "A duration_exceeded result requires splitting the script scene; do not retry or concatenate it. " +
      "Vocal directions and punctuation are preserved. A durable audio-revision lease prevents any " +
      "replacement from racing or following an Agnes submission claim.",
    schema: z.object({
      seriesId: z.number().int().positive().describe("Series ID as a positive integer"),
      episodeNumber: z.number().int().positive().describe("Episode number as a positive integer"),
      sceneNumber: z.number().int().positive().describe("Scene number as a positive integer"),
      text: z.string().trim().min(1).max(NARRATION_MAX_RAW_CHARACTERS).describe(
        `The exact narration for one scene, at most ${NARRATION_MAX_RAW_CHARACTERS} raw characters and ${NARRATION_MAX_SPOKEN_WORDS} spoken words.`,
      ),
    }),
    func: async ({ seriesId, episodeNumber, sceneNumber, text }) => {
      if (![seriesId, episodeNumber, sceneNumber].every((value) => Number.isSafeInteger(value) && value > 0)) {
        throw new Error("seriesId, episodeNumber, and sceneNumber must be positive integers.");
      }

      const narrationText = text.trim();
      const textInspection = inspectNarrationText(narrationText, { production: true });
      if (!textInspection.pass) {
        throw new Error(
          `Scene ${sceneNumber} narration violates the one-scene contract: ` +
          textInspection.issues.map((issue) => issue.message).join(" "),
        );
      }

      const destDir = path.join(outputDir, `series_${seriesId}`, `episode_${episodeNumber}`, "audio");
      const finalPath = path.join(destDir, `scene_${String(sceneNumber).padStart(3, "0")}_narrator.wav`);
      const metadataPath = narrationAudioMetadataPath(finalPath);
      const requestDigest = createNarrationAudioRequestDigest({
        text: narrationText,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
      });
      await mkdir(destDir, { recursive: true });

      if (existsSync(finalPath) && existsSync(metadataPath)) {
        const metadata = await readNarrationAudioMetadata(metadataPath);
        if (metadata?.requestDigest === requestDigest) {
          try {
            const durationSeconds = await validateAudioOutput(finalPath, probeDurationSeconds);
            if (Math.abs(durationSeconds - metadata.durationSeconds) <= AUDIO_DURATION_METADATA_TOLERANCE_SECONDS) {
              return resultForAudio({
                audioPath: finalPath,
                metadataPath,
                metadata: { ...metadata, durationSeconds },
                reused: true,
              });
            }
          } catch {
            // Invalid/missing media falls through to safe regeneration below.
          }
        }
      }

      const leaseToken = randomUUID();
      const leaseIdentity = { seriesId, episodeNumber, sceneNumber, leaseToken };
      const leaseExpiry = () => Date.now() + NARRATION_AUDIO_MUTATION_LEASE_MS;
      const initialGuard = options.seriesState
        ? await options.seriesState.beginEpisodeNarrationAudioMutation({
            ...leaseIdentity,
            leaseExpiresAtMs: leaseExpiry(),
          })
        : { acquired: true, audioRevision: 0, startedAssetCount: 0 };
      if (!initialGuard.acquired) {
        return blockedMutationResult({
          sceneNumber,
          startedAssetCount: initialGuard.startedAssetCount,
          phase: "before_generation",
          reason: initialGuard.reason ?? "mutation_in_progress",
        });
      }
      let leaseHeld = options.seriesState !== undefined;
      const renewLease = async (): Promise<boolean> => !options.seriesState
        || options.seriesState.renewEpisodeNarrationAudioMutation({
          ...leaseIdentity,
          leaseExpiresAtMs: leaseExpiry(),
        });
      const abortLease = async (): Promise<void> => {
        if (!leaseHeld || !options.seriesState) return;
        await options.seriesState.abortEpisodeNarrationAudioMutation(leaseIdentity);
        leaseHeld = false;
      };

      // Generate into an isolated candidate. The old WAV/sidecar pair stays
      // intact while the durable audio-revision lease blocks every Agnes claim.
      const candidateToken = `${process.pid}.${leaseToken}`;
      const candidatePath = path.join(
        destDir,
        `.scene_${String(sceneNumber).padStart(3, "0")}_${candidateToken}.candidate.wav`,
      );
      const candidateMetadataPath = narrationAudioMetadataPath(candidatePath);

      let lastError: unknown;
      let generated:
        | { attempt: number; metadata: NarrationAudioMetadata }
        | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await Promise.all([
            rm(candidatePath, { force: true }),
            rm(candidateMetadataPath, { force: true }),
          ]);
          if (!(await renewLease())) {
            await abortLease();
            return blockedMutationResult({
              sceneNumber,
              startedAssetCount: 0,
              phase: "before_generation",
              reason: "lease_lost",
            });
          }
          const result = await audioGenerator.invoke({
            input: narrationText,
            outputPath: candidatePath,
            voice: CONFIG.groqTtsVoice,
            model: CONFIG.groqTtsModel,
            responseFormat: NARRATION_RESPONSE_FORMAT,
          });
          if (typeof result === "string" && result.startsWith("Error generating audio:")) {
            throw new Error(result);
          }

          const durationSeconds = await validateAudioOutput(candidatePath, probeDurationSeconds);
          const durationStatus = inspectNarrationDuration(durationSeconds).pass
            ? "ready" as const
            : "duration_exceeded" as const;
          const metadata: NarrationAudioMetadata = {
            schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
            kind: NARRATION_METADATA_KIND,
            requestDigest,
            model: CONFIG.groqTtsModel,
            voice: CONFIG.groqTtsVoice,
            responseFormat: NARRATION_RESPONSE_FORMAT,
            textLength: narrationText.length,
            spokenWordCount: textInspection.spokenWordCount,
            durationSeconds,
            durationStatus,
            publicationToken: leaseToken,
          };
          await writeNarrationAudioMetadata(candidateMetadataPath, metadata);
          generated = { attempt, metadata };
          break;
        } catch (error) {
          lastError = error;
          await Promise.all([
            rm(candidatePath, { force: true }),
            rm(candidateMetadataPath, { force: true }),
          ]);
          if (attempt < 3) {
            const delayMs = retryDelayMs(attempt);
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }

      if (!generated) {
        await abortLease();
        throw new Error(`Audio generation failed after 3 attempts for scene ${sceneNumber}: ${String(lastError)}`);
      }

      if (!(await renewLease())) {
        await Promise.all([
          rm(candidatePath, { force: true }),
          rm(candidateMetadataPath, { force: true }),
        ]);
        await abortLease();
        return blockedMutationResult({
          sceneNumber,
          startedAssetCount: 0,
          phase: "before_publication",
          reason: "lease_lost",
        });
      }

      const backupAudioPath = `${finalPath}.${candidateToken}.backup`;
      const backupMetadataPath = `${metadataPath}.${candidateToken}.backup`;
      let audioBackedUp = false;
      let metadataBackedUp = false;
      let candidateAudioPublished = false;
      let candidateMetadataPublished = false;
      const restorePriorPairWhileLeased = async (): Promise<void> => {
        if (candidateAudioPublished) {
          await rm(finalPath, { force: true });
          candidateAudioPublished = false;
        }
        if (candidateMetadataPublished) {
          await rm(metadataPath, { force: true });
          candidateMetadataPublished = false;
        }
        if (audioBackedUp) {
          await rename(backupAudioPath, finalPath);
          audioBackedUp = false;
        }
        if (metadataBackedUp) {
          await rename(backupMetadataPath, metadataPath);
          metadataBackedUp = false;
        }
      };
      const cleanupPrivatePublicationFiles = async (): Promise<void> => {
        await Promise.all([
          rm(candidatePath, { force: true }),
          rm(candidateMetadataPath, { force: true }),
          rm(backupAudioPath, { force: true }),
          rm(backupMetadataPath, { force: true }),
        ]);
      };
      const restorePriorPairIfStillOwned = async (): Promise<boolean> => {
        if (!options.seriesState) {
          await restorePriorPairWhileLeased();
          return true;
        }

        // Once the original completion CAS fails, its token has no authority
        // over canonical paths. Reacquire a fresh episode lease so a successor
        // cannot publish between our ownership check and rollback.
        const rollbackLeaseToken = randomUUID();
        const rollbackIdentity = {
          seriesId,
          episodeNumber,
          sceneNumber,
          leaseToken: rollbackLeaseToken,
        };
        const rollbackGuard = await options.seriesState.beginEpisodeNarrationAudioMutation({
          ...rollbackIdentity,
          leaseExpiresAtMs: leaseExpiry(),
        });
        if (!rollbackGuard.acquired) return false;

        let rollbackLeaseHeld = true;
        try {
          const canonicalMetadata = await readNarrationAudioMetadata(metadataPath);
          if (canonicalMetadata?.publicationToken !== leaseToken) {
            await options.seriesState.abortEpisodeNarrationAudioMutation(rollbackIdentity);
            rollbackLeaseHeld = false;
            return false;
          }
          await restorePriorPairWhileLeased();
          const committed = await options.seriesState.completeEpisodeNarrationAudioMutation(
            rollbackIdentity,
          );
          if (committed) rollbackLeaseHeld = false;
          return committed;
        } finally {
          if (rollbackLeaseHeld) {
            await options.seriesState.abortEpisodeNarrationAudioMutation(rollbackIdentity);
          }
        }
      };

      let completionAttempted = false;
      try {
        if (existsSync(finalPath)) {
          await rename(finalPath, backupAudioPath);
          audioBackedUp = true;
        }
        if (existsSync(metadataPath)) {
          await rename(metadataPath, backupMetadataPath);
          metadataBackedUp = true;
        }
        await rename(candidatePath, finalPath);
        candidateAudioPublished = true;
        await rename(candidateMetadataPath, metadataPath);
        candidateMetadataPublished = true;

        if (options.seriesState) {
          completionAttempted = true;
          const completed = await options.seriesState.completeEpisodeNarrationAudioMutation(
            leaseIdentity,
          );
          if (!completed) {
            await abortLease();
            await restorePriorPairIfStillOwned();
            await cleanupPrivatePublicationFiles();
            return blockedMutationResult({
              sceneNumber,
              startedAssetCount: 0,
              phase: "lease_completion",
              reason: "lease_lost",
            });
          }
          leaseHeld = false;
        }
        // Backup cleanup is non-authoritative after the new pair and revision
        // have committed. Never roll back a committed pair merely because a
        // hidden recovery file could not be removed.
        await Promise.all([
          rm(backupAudioPath, { force: true }).catch(() => undefined),
          rm(backupMetadataPath, { force: true }).catch(() => undefined),
        ]);
      } catch (error) {
        try {
          if (completionAttempted && options.seriesState) {
            await abortLease();
            await restorePriorPairIfStillOwned();
          } else {
            await restorePriorPairWhileLeased();
          }
        } catch (restoreError) {
          throw new Error(
            `Audio publication failed for scene ${sceneNumber}, and the prior pair could not be restored: ` +
            `${String(error)} | restore: ${String(restoreError)}`,
          );
        } finally {
          await cleanupPrivatePublicationFiles();
          await abortLease();
        }
        throw error;
      }

      return resultForAudio({
        audioPath: finalPath,
        metadataPath,
        metadata: generated.metadata,
        reused: false,
        attempt: generated.attempt,
      });
    },
  });
}

/**
 * Production wrapper that synthesizes or verifies the complete persisted
 * narration manifest in one agent tool call. The inner one-scene implementation
 * remains the only writer, so digest reuse and the durable audio mutation fence
 * retain exactly the same semantics while the parent agent avoids 40-60 turns.
 */
export function buildEpisodeTtsTool(
  seriesState: EpisodeTtsState,
  options?: EpisodeTtsToolOverrides,
): DynamicStructuredTool;
export function buildEpisodeTtsTool(options: EpisodeTtsToolOptions): DynamicStructuredTool;
export function buildEpisodeTtsTool(
  stateOrOptions: EpisodeTtsState | EpisodeTtsToolOptions,
  overrides: EpisodeTtsToolOverrides = {},
): DynamicStructuredTool {
  const normalizedOptions: EpisodeTtsToolOptions = "seriesState" in stateOrOptions
    ? stateOrOptions as EpisodeTtsToolOptions
    : { ...overrides, seriesState: stateOrOptions };
  const {
    seriesState,
    progressLogger = (message: string) => console.log(message),
    ...singleSceneOptions
  } = normalizedOptions;
  const singleSceneTool = buildTtsTool({
    ...singleSceneOptions,
    seriesState,
  });

  return new DynamicStructuredTool({
    name: "synthesize_episode_narration_audio",
    description:
      "Synthesizes or reuses every scene WAV from the persisted production script, sequentially, in one call. " +
      "Pass only seriesId and episodeNumber. Returns compact complete timing evidence for refinement, or a " +
      "typed blocked/deferred receipt when the durable episode-audio fence prevents mutation.",
    schema: z.object({
      seriesId: z.number().int().positive(),
      episodeNumber: z.number().int().positive(),
    }).strict(),
    func: async ({ seriesId, episodeNumber }) => {
      const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
      if (!episode) {
        throw new Error(`Episode ${episodeNumber} was not found for series ${seriesId}.`);
      }
      if (!Number.isSafeInteger(episode.id) || episode.id <= 0) {
        throw new Error(`Episode ${episodeNumber} has an invalid durable id.`);
      }

      // Validate the complete lightweight narration manifest before the first
      // paid request so a malformed later scene cannot leave a partial batch.
      const scenes = parsePersistedNarrationScenes(episode.scriptJson);
      progressLogger(
        `[NarrationAudio] Episode ${episodeNumber}: processing ${scenes.length} persisted scene(s) sequentially.`,
      );

      let measuredTotalNarrationSeconds = 0;
      let generatedSceneCount = 0;
      let reusedSceneCount = 0;
      const durationExceededScenes: Array<{ sceneNumber: number; durationSeconds: number }> = [];

      for (const [index, scene] of scenes.entries()) {
        progressLogger(
          `[NarrationAudio] Episode ${episodeNumber}: scene ${scene.sceneNumber} (${index + 1}/${scenes.length}) starting.`,
        );
        const rawReceipt = await singleSceneTool.func({
          seriesId,
          episodeNumber,
          sceneNumber: scene.sceneNumber,
          text: scene.narrationText,
        });
        const receipt = parseSingleSceneTtsReceipt(rawReceipt, scene.sceneNumber);

        if (
          receipt.status === "audio_repair_blocked"
          || receipt.status === "audio_repair_deferred"
        ) {
          progressLogger(
            `[NarrationAudio] Episode ${episodeNumber}: scene ${scene.sceneNumber} stopped with ${receipt.status}.`,
          );
          return JSON.stringify({
            status: receipt.status,
            readyForAgnes: false,
            seriesId,
            episodeId: episode.id,
            episodeNumber,
            sceneCount: scenes.length,
            processedSceneCount: index,
            sceneNumber: receipt.sceneNumber ?? scene.sceneNumber,
            ...(receipt.startedAssetCount === undefined
              ? {}
              : { startedAssetCount: receipt.startedAssetCount }),
            ...(receipt.phase === undefined ? {} : { phase: receipt.phase }),
            ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
            generatedSceneCount,
            reusedSceneCount,
            nextAction: receipt.status === "audio_repair_blocked"
              ? "Stop this run. Narration audio is immutable after an Agnes claim or episode completion."
              : "Stop this run and retry synthesize_episode_narration_audio on a later invocation.",
          });
        }

        const durationSeconds = receipt.durationSeconds!;
        measuredTotalNarrationSeconds += durationSeconds;
        if (receipt.reused) reusedSceneCount += 1;
        else generatedSceneCount += 1;
        if (receipt.status === "duration_exceeded") {
          durationExceededScenes.push({
            sceneNumber: scene.sceneNumber,
            durationSeconds,
          });
        }
        progressLogger(
          `[NarrationAudio] Episode ${episodeNumber}: scene ${scene.sceneNumber} ${receipt.status} ` +
          `(${durationSeconds.toFixed(3)}s).`,
        );
      }

      // Keep the provider measurements exact in the machine-readable receipt.
      // Rounding at the five-minute boundary could make refinement accept a
      // value that the durable audio preflight correctly rejects.
      const measuredTotal = measuredTotalNarrationSeconds;
      const totalDurationBelowMinimum = measuredTotalNarrationSeconds < MIN_PRODUCTION_NARRATION_SECONDS;
      const repairRequired = durationExceededScenes.length > 0 || totalDurationBelowMinimum;
      progressLogger(
        `[NarrationAudio] Episode ${episodeNumber}: complete; ${scenes.length} scene(s), ` +
        `${measuredTotal.toFixed(3)}s total, ${durationExceededScenes.length} over 12s.`,
      );

      return JSON.stringify({
        status: repairRequired ? "repair_required" : "ready",
        readyForAgnes: !repairRequired,
        seriesId,
        episodeId: episode.id,
        episodeNumber,
        sceneCount: scenes.length,
        measuredNarrationSceneCount: scenes.length,
        measuredTotalNarrationSeconds: measuredTotal,
        durationExceededScenes,
        totalDurationBelowMinimum,
        minimumTotalNarrationSeconds: MIN_PRODUCTION_NARRATION_SECONDS,
        generatedSceneCount,
        reusedSceneCount,
        nextAction: repairRequired
          ? "Call refine_episode_script once with episodeId and this receipt's complete durationExceededScenes, measuredTotalNarrationSeconds, and measuredNarrationSceneCount. Never resend scriptJson."
          : "Generate or reuse episode captions, mark the audio stage ready, and continue to Agnes submission.",
      });
    },
  });
}
