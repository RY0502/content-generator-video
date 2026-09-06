import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createAudioGenTool } from "freetier-deepagent-framework";
import { CONFIG } from "../config.js";
import {
  NARRATION_MAX_AUDIO_SECONDS,
  countNarrationSpokenWords,
} from "./narrationContract.js";
import { canonicalizeKeyArtTitle } from "./keyArtTitleContract.js";
import {
  NARRATION_METADATA_KIND,
  NARRATION_METADATA_SCHEMA_VERSION,
  createNarrationAudioRequestDigest,
  narrationAudioMetadataPath,
  readNarrationAudioMetadata,
  writeNarrationAudioMetadata,
  type NarrationAudioGenerator,
  type NarrationAudioMetadata,
} from "../tools/ttsTool.js";

/** Reserved internal row keys; real script scenes are always positive. */
export const AGNES_SERIES_KEY_ART_TRACKING_SCENE = -2;
export const AGNES_EPISODE_KEY_ART_TRACKING_SCENE = -1;

export type AgnesKeyArtKind = "series" | "episode";

export interface AgnesKeyArtPaths {
  kind: AgnesKeyArtKind;
  trackingSceneNumber: number;
  directory: string;
  audioPath: string;
  audioMetadataPath: string;
  normalizedVideoPath: string;
  promptDirectory: string;
  rawDirectory: string;
  stem: string;
}

export interface AgnesKeyArtAudioAsset extends AgnesKeyArtPaths {
  text: string;
  durationSeconds: number;
  requestDigest: string;
}

export interface EnsureAgnesKeyArtAudioOptions {
  outputDir?: string;
  audioGenerator?: NarrationAudioGenerator;
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  retryDelayMs?: (attempt: number) => number;
  /** Production supplies SeriesState so both title WAVs share one durable lease. */
  audioMutationState?: AgnesKeyArtAudioMutationState;
  /** False after any Agnes claim: existing assets may be read, but never changed. */
  allowMutation?: boolean;
  /** Test hook; production uses a deliberately generous lease. */
  mutationLeaseMs?: number;
}

export interface AgnesKeyArtAudioMutationState {
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
    reason?: "episode_complete" | "agnes_started" | "mutation_in_progress";
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
}

export const AGNES_KEY_ART_AUDIO_MUTATION_SCENE = 2_147_483_647;
const DEFAULT_KEY_ART_AUDIO_MUTATION_LEASE_MS = 15 * 60_000;

export type AgnesKeyArtAudioMutationDeferredReason =
  | "episode_complete"
  | "agnes_started"
  | "mutation_in_progress"
  | "mutation_disabled"
  | "lease_lost";

export class AgnesKeyArtAudioMutationDeferredError extends Error {
  readonly reason: AgnesKeyArtAudioMutationDeferredReason;
  readonly startedAssetCount: number;

  constructor(reason: AgnesKeyArtAudioMutationDeferredReason, startedAssetCount = 0) {
    super(
      reason === "agnes_started"
        ? "Agnes submission started before key-art title audio could be locked; existing title audio must remain immutable."
        : reason === "mutation_in_progress"
          ? "Another audio writer owns the episode lease; defer key-art title audio preparation."
          : reason === "episode_complete"
            ? "The completed episode cannot mutate key-art title audio."
            : reason === "mutation_disabled"
              ? "Key-art title audio is missing or stale, but this Agnes phase is validation-only."
              : "The key-art title audio lease was lost; candidates were not committed.",
    );
    this.name = "AgnesKeyArtAudioMutationDeferredError";
    this.reason = reason;
    this.startedAssetCount = startedAssetCount;
  }
}

export function agnesKeyArtPaths(params: {
  outputDir?: string;
  seriesId: number;
  episodeNumber: number;
  kind: AgnesKeyArtKind;
}): AgnesKeyArtPaths {
  const stem = params.kind === "series" ? "series_key_art" : "episode_key_art";
  const directory = path.resolve(
    params.outputDir ?? CONFIG.outputDir,
    `series_${params.seriesId}`,
    `episode_${params.episodeNumber}`,
    "agnes_text",
    "key_art",
    params.kind,
  );
  const audioPath = path.join(directory, `${stem}_narrator.wav`);
  return {
    kind: params.kind,
    trackingSceneNumber: params.kind === "series"
      ? AGNES_SERIES_KEY_ART_TRACKING_SCENE
      : AGNES_EPISODE_KEY_ART_TRACKING_SCENE,
    directory,
    audioPath,
    audioMetadataPath: narrationAudioMetadataPath(audioPath),
    normalizedVideoPath: path.join(directory, `${stem}.mp4`),
    promptDirectory: path.join(directory, "prompts"),
    rawDirectory: path.join(directory, "raw"),
    stem,
  };
}

function defaultProbeDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.ffprobePath, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      const duration = Number(stdout.trim());
      if (code === 0 && Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error(`Invalid key-art audio duration for ${filePath}: ${stderr.slice(-500)}`));
    });
  });
}

async function validAudioDuration(
  filePath: string,
  probeDurationSeconds: (filePath: string) => Promise<number>,
): Promise<number> {
  const details = await stat(filePath);
  if (!details.isFile() || details.size <= 0) throw new Error(`Key-art audio is empty: ${filePath}`);
  const durationSeconds = await probeDurationSeconds(filePath);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Key-art audio has an invalid duration: ${filePath}`);
  }
  return durationSeconds;
}

let defaultAudioGenerator: NarrationAudioGenerator | undefined;

function getDefaultAudioGenerator(): NarrationAudioGenerator {
  defaultAudioGenerator ??= createAudioGenTool();
  return defaultAudioGenerator;
}

interface KeyArtAudioSpec {
  paths: AgnesKeyArtPaths;
  text: string;
  requestDigest: string;
}

interface KeyArtAudioCandidate {
  spec: KeyArtAudioSpec;
  audioPath: string;
  metadataPath: string;
  durationSeconds: number;
}

interface KeyArtAudioPublication {
  candidate: KeyArtAudioCandidate;
  audioBackupPath: string;
  metadataBackupPath: string;
  audioBackedUp: boolean;
  metadataBackedUp: boolean;
  audioPublished: boolean;
  metadataPublished: boolean;
}

async function buildAudioSpec(params: {
  seriesId: number;
  episodeNumber: number;
  kind: AgnesKeyArtKind;
  text: string;
  options: EnsureAgnesKeyArtAudioOptions;
}): Promise<KeyArtAudioSpec> {
  const text = canonicalizeKeyArtTitle(params.text, params.kind);
  const paths = agnesKeyArtPaths({
    outputDir: params.options.outputDir,
    seriesId: params.seriesId,
    episodeNumber: params.episodeNumber,
    kind: params.kind,
  });
  const requestDigest = createNarrationAudioRequestDigest({
    text,
    model: CONFIG.groqTtsModel,
    voice: CONFIG.groqTtsVoice,
  });
  await mkdir(paths.directory, { recursive: true });
  return { paths, text, requestDigest };
}

async function reusableAudio(
  spec: KeyArtAudioSpec,
  probeDurationSeconds: (filePath: string) => Promise<number>,
): Promise<AgnesKeyArtAudioAsset | null> {
  if (existsSync(spec.paths.audioPath) && existsSync(spec.paths.audioMetadataPath)) {
    const metadata = await readNarrationAudioMetadata(spec.paths.audioMetadataPath);
    if (metadata?.requestDigest === spec.requestDigest) {
      try {
        const durationSeconds = await validAudioDuration(spec.paths.audioPath, probeDurationSeconds);
        if (Math.abs(durationSeconds - metadata.durationSeconds) <= 0.05) {
          if (metadata.durationStatus !== "ready" || durationSeconds > NARRATION_MAX_AUDIO_SECONDS) {
            throw new Error(
              `${spec.paths.kind} key-art title audio is ${durationSeconds.toFixed(3)}s; ` +
              `Agnes supports at most ${NARRATION_MAX_AUDIO_SECONDS}s. Shorten the title.`,
            );
          }
          return {
            ...spec.paths,
            text: spec.text,
            durationSeconds,
            requestDigest: spec.requestDigest,
          };
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Shorten the title")) throw error;
      }
    }
  }
  return null;
}

async function generateAudioCandidate(params: {
  spec: KeyArtAudioSpec;
  candidateToken: string;
  options: EnsureAgnesKeyArtAudioOptions;
  renewLease: () => Promise<boolean>;
}): Promise<KeyArtAudioCandidate> {
  const audioGenerator = params.options.audioGenerator ?? getDefaultAudioGenerator();
  const probeDurationSeconds = params.options.probeDurationSeconds ?? defaultProbeDurationSeconds;
  const retryDelayMs = params.options.retryDelayMs ?? ((attempt: number) => attempt * 1_000);
  const candidatePath = `${params.spec.paths.audioPath}.${process.pid}.${params.candidateToken}.candidate.wav`;
  const candidateMetadataPath = narrationAudioMetadataPath(candidatePath);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await Promise.all([
        rm(candidatePath, { force: true }),
        rm(candidateMetadataPath, { force: true }),
      ]);
      if (!(await params.renewLease())) {
        throw new AgnesKeyArtAudioMutationDeferredError("lease_lost");
      }
      const result = await audioGenerator.invoke({
        input: params.spec.text,
        outputPath: candidatePath,
        voice: CONFIG.groqTtsVoice,
        model: CONFIG.groqTtsModel,
        responseFormat: "wav",
      });
      if (typeof result === "string" && result.startsWith("Error generating audio:")) {
        throw new Error(result);
      }
      const durationSeconds = await validAudioDuration(candidatePath, probeDurationSeconds);
      const durationStatus = durationSeconds <= NARRATION_MAX_AUDIO_SECONDS
        ? "ready" as const
        : "duration_exceeded" as const;
      const metadata: NarrationAudioMetadata = {
        schemaVersion: NARRATION_METADATA_SCHEMA_VERSION,
        kind: NARRATION_METADATA_KIND,
        requestDigest: params.spec.requestDigest,
        model: CONFIG.groqTtsModel,
        voice: CONFIG.groqTtsVoice,
        responseFormat: "wav",
        textLength: params.spec.text.length,
        spokenWordCount: countNarrationSpokenWords(params.spec.text),
        durationSeconds,
        durationStatus,
      };
      await writeNarrationAudioMetadata(candidateMetadataPath, metadata);
      if (durationStatus !== "ready") {
        throw new Error(
          `${params.spec.paths.kind} key-art title audio is ${durationSeconds.toFixed(3)}s; ` +
          `Agnes supports at most ${NARRATION_MAX_AUDIO_SECONDS}s. Shorten the title.`,
        );
      }
      if (!(await params.renewLease())) {
        throw new AgnesKeyArtAudioMutationDeferredError("lease_lost");
      }
      return {
        spec: params.spec,
        audioPath: candidatePath,
        metadataPath: candidateMetadataPath,
        durationSeconds,
      };
    } catch (error) {
      lastError = error;
      await Promise.all([
        rm(candidatePath, { force: true }),
        rm(candidateMetadataPath, { force: true }),
      ]);
      if (error instanceof AgnesKeyArtAudioMutationDeferredError) throw error;
      if (error instanceof Error && error.message.includes("Shorten the title")) throw error;
      if (attempt < 3) {
        const waitMs = retryDelayMs(attempt);
        if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }
  throw new Error(
    `Failed to generate ${params.spec.paths.kind} key-art title audio: ${String(lastError)}`,
  );
}

async function publishCandidate(
  candidate: KeyArtAudioCandidate,
  candidateToken: string,
): Promise<KeyArtAudioPublication> {
  const publication: KeyArtAudioPublication = {
    candidate,
    audioBackupPath: `${candidate.spec.paths.audioPath}.${process.pid}.${candidateToken}.backup`,
    metadataBackupPath:
      `${candidate.spec.paths.audioMetadataPath}.${process.pid}.${candidateToken}.backup`,
    audioBackedUp: false,
    metadataBackedUp: false,
    audioPublished: false,
    metadataPublished: false,
  };
  try {
    if (existsSync(candidate.spec.paths.audioPath)) {
      await rename(candidate.spec.paths.audioPath, publication.audioBackupPath);
      publication.audioBackedUp = true;
    }
    if (existsSync(candidate.spec.paths.audioMetadataPath)) {
      await rename(candidate.spec.paths.audioMetadataPath, publication.metadataBackupPath);
      publication.metadataBackedUp = true;
    }
    await rename(candidate.audioPath, candidate.spec.paths.audioPath);
    publication.audioPublished = true;
    await rename(candidate.metadataPath, candidate.spec.paths.audioMetadataPath);
    publication.metadataPublished = true;
    return publication;
  } catch (error) {
    await restorePublication(publication);
    throw error;
  }
}

async function restorePublication(publication: KeyArtAudioPublication): Promise<void> {
  if (publication.audioPublished) {
    await rm(publication.candidate.spec.paths.audioPath, { force: true });
    publication.audioPublished = false;
  }
  if (publication.metadataPublished) {
    await rm(publication.candidate.spec.paths.audioMetadataPath, { force: true });
    publication.metadataPublished = false;
  }
  if (publication.audioBackedUp) {
    await rename(publication.audioBackupPath, publication.candidate.spec.paths.audioPath);
    publication.audioBackedUp = false;
  }
  if (publication.metadataBackedUp) {
    await rename(
      publication.metadataBackupPath,
      publication.candidate.spec.paths.audioMetadataPath,
    );
    publication.metadataBackedUp = false;
  }
}

async function discardCandidate(candidate: KeyArtAudioCandidate): Promise<void> {
  await Promise.all([
    rm(candidate.audioPath, { force: true }),
    rm(candidate.metadataPath, { force: true }),
  ]);
}

/** Ensures both title WAVs exist before the two matching Agnes jobs are prepared. */
export async function ensureAgnesKeyArtAudioAssets(params: {
  seriesId: number;
  episodeNumber: number;
  seriesTitle: string;
  episodeTitle: string;
  options?: EnsureAgnesKeyArtAudioOptions;
}): Promise<[AgnesKeyArtAudioAsset, AgnesKeyArtAudioAsset]> {
  const options = params.options ?? {};
  // Validate both titles before either concurrent branch can make a paid TTS
  // request. ensureOneAudio repeats this at its direct provenance boundary.
  const seriesTitle = canonicalizeKeyArtTitle(params.seriesTitle, "series");
  const episodeTitle = canonicalizeKeyArtTitle(params.episodeTitle, "episode");
  const specs = await Promise.all([
    buildAudioSpec({
      seriesId: params.seriesId,
      episodeNumber: params.episodeNumber,
      kind: "series",
      text: seriesTitle,
      options,
    }),
    buildAudioSpec({
      seriesId: params.seriesId,
      episodeNumber: params.episodeNumber,
      kind: "episode",
      text: episodeTitle,
      options,
    }),
  ]);
  const probeDurationSeconds = options.probeDurationSeconds ?? defaultProbeDurationSeconds;
  let reusable = await Promise.all(specs.map((spec) => reusableAudio(spec, probeDurationSeconds)));
  if (reusable.every((asset) => asset !== null)) {
    return reusable as [AgnesKeyArtAudioAsset, AgnesKeyArtAudioAsset];
  }
  if (options.allowMutation === false) {
    throw new AgnesKeyArtAudioMutationDeferredError("mutation_disabled");
  }

  const leaseToken = randomUUID();
  const leaseIdentity = {
    seriesId: params.seriesId,
    episodeNumber: params.episodeNumber,
    sceneNumber: AGNES_KEY_ART_AUDIO_MUTATION_SCENE,
    leaseToken,
  };
  const leaseMs = options.mutationLeaseMs ?? DEFAULT_KEY_ART_AUDIO_MUTATION_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("Key-art audio mutationLeaseMs must be a positive safe integer.");
  }
  const leaseExpiry = () => Date.now() + leaseMs;
  const mutationState = options.audioMutationState;
  if (mutationState) {
    const acquired = await mutationState.beginEpisodeNarrationAudioMutation({
      ...leaseIdentity,
      leaseExpiresAtMs: leaseExpiry(),
    });
    if (!acquired.acquired) {
      // Never inspect public paths while another writer owns the lease: it may
      // be between the audio/sidecar renames or may still roll back. Once an
      // Agnes claim or episode completion won, however, those paths are
      // immutable and a final validation-only reuse is safe.
      if (acquired.reason === "agnes_started" || acquired.reason === "episode_complete") {
        reusable = await Promise.all(specs.map((spec) => reusableAudio(spec, probeDurationSeconds)));
        if (reusable.every((asset) => asset !== null)) {
          return reusable as [AgnesKeyArtAudioAsset, AgnesKeyArtAudioAsset];
        }
      }
      throw new AgnesKeyArtAudioMutationDeferredError(
        acquired.reason ?? "mutation_in_progress",
        acquired.startedAssetCount,
      );
    }
  }

  let leaseHeld = mutationState !== undefined;
  let committed = false;
  const renewLease = async (): Promise<boolean> => !mutationState
    || mutationState.renewEpisodeNarrationAudioMutation({
      ...leaseIdentity,
      leaseExpiresAtMs: leaseExpiry(),
    });
  const abortLease = async (): Promise<void> => {
    if (!mutationState || !leaseHeld) return;
    await mutationState.abortEpisodeNarrationAudioMutation(leaseIdentity);
    leaseHeld = false;
  };
  const publications: KeyArtAudioPublication[] = [];
  let candidates: KeyArtAudioCandidate[] = [];

  try {
    // Another completed writer can win immediately before this lease. Inspect
    // again while ownership prevents any further publication.
    reusable = await Promise.all(specs.map((spec) => reusableAudio(spec, probeDurationSeconds)));
    if (reusable.every((asset) => asset !== null)) {
      await abortLease();
      return reusable as [AgnesKeyArtAudioAsset, AgnesKeyArtAudioAsset];
    }

    const missingSpecs = specs.filter((_spec, index) => reusable[index] === null);
    const generationResults = await Promise.allSettled(missingSpecs.map((spec) => (
      generateAudioCandidate({ spec, candidateToken: leaseToken, options, renewLease })
    )));
    candidates = generationResults
      .filter((result): result is PromiseFulfilledResult<KeyArtAudioCandidate> => (
        result.status === "fulfilled"
      ))
      .map((result) => result.value);
    const generationFailure = generationResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (generationFailure) throw generationFailure.reason;

    if (!(await renewLease())) {
      throw new AgnesKeyArtAudioMutationDeferredError("lease_lost");
    }
    for (const candidate of candidates) {
      publications.push(await publishCandidate(candidate, leaseToken));
    }

    if (mutationState) {
      const completed = await mutationState.completeEpisodeNarrationAudioMutation(leaseIdentity);
      if (!completed) throw new AgnesKeyArtAudioMutationDeferredError("lease_lost");
      leaseHeld = false;
    }
    committed = true;

    const generatedByKind = new Map(candidates.map((candidate) => [
      candidate.spec.paths.kind,
      {
        ...candidate.spec.paths,
        text: candidate.spec.text,
        durationSeconds: candidate.durationSeconds,
        requestDigest: candidate.spec.requestDigest,
      } satisfies AgnesKeyArtAudioAsset,
    ]));
    const assets = specs.map((spec, index) => (
      reusable[index] ?? generatedByKind.get(spec.paths.kind)!
    )) as [AgnesKeyArtAudioAsset, AgnesKeyArtAudioAsset];

    // Cleanup is non-authoritative after revision commit.
    await Promise.all(publications.flatMap((publication) => [
      rm(publication.audioBackupPath, { force: true }).catch(() => undefined),
      rm(publication.metadataBackupPath, { force: true }).catch(() => undefined),
    ]));
    return assets;
  } catch (error) {
    if (!committed) {
      for (const publication of [...publications].reverse()) {
        await restorePublication(publication);
      }
    }
    await Promise.all(candidates.map((candidate) => discardCandidate(candidate)));
    await abortLease();
    throw error;
  }
}
