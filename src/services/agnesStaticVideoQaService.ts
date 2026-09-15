import { createHash } from "node:crypto";

/**
 * The static QA contract deliberately has no model/provider dependency. Bump
 * the policy or pipeline version whenever a rule changes so durable passes
 * are automatically re-audited instead of being silently grandfathered.
 */
export const AGNES_STATIC_VIDEO_QA_PIPELINE = "deterministic_static_media_integrity";
export const AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION = 1;
export const AGNES_STATIC_VIDEO_QA_POLICY_VERSION = 1;
export const AGNES_STATIC_VIDEO_QA_MODEL = "static-code-audit-v1";

export const AGNES_STATIC_VIDEO_QA_RULES = [
  "completed_downloaded_nonempty_video",
  "single_1920x1080_h264_video_stream_without_audio",
  "normalized_duration_matches_requested_duration",
  "requested_duration_is_at_most_12_seconds_and_provider_duration_is_4_to_12_seconds",
  "persisted_generation_request_digest_matches_prompt_seed_duration_mode_and_references",
  "at_most_five_unique_public_https_character_references",
  "ordered_picture_mapping_matches_visible_main_cast",
  "visible_cast_ledger_matches_declared_main_and_supporting_figures",
  "character_reference_url_matches_approved_public_portrait_when_available",
  "no_byte_identical_episode_assets",
] as const;

export interface AgnesStaticMediaFacts {
  durationSeconds: number;
  codecName: string;
  width: number;
  height: number;
  videoStreamCount: number;
  audioStreamCount: number;
}

export interface AgnesStaticQaDigestInput {
  sceneNumber: number;
  generationRequestDigest: string;
  renderRevision: number;
  videoSha256: string;
  episodeAssetSetDigest: string;
  expectedMainCast: readonly string[];
  referenceImageUrls: readonly string[];
  media: AgnesStaticMediaFacts;
}

export interface AgnesStaticQaResult extends AgnesStaticQaDigestInput {
  policyVersion: number;
  pipeline: string;
  pipelineVersion: number;
  policyDigest: string;
  decision: "final";
  model: string;
  qaRequestDigest: string;
  pass: boolean;
  checks: readonly {
    code: string;
    pass: boolean;
    detail?: string;
  }[];
  issues: readonly {
    code: string;
    message: string;
    relatedSceneNumbers?: readonly number[];
  }[];
  evidencePath: string;
}

export function currentAgnesStaticVideoQaPolicyDigest(): string {
  return createHash("sha256").update(JSON.stringify({
    pipeline: AGNES_STATIC_VIDEO_QA_PIPELINE,
    pipelineVersion: AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION,
    policyVersion: AGNES_STATIC_VIDEO_QA_POLICY_VERSION,
    rules: AGNES_STATIC_VIDEO_QA_RULES,
  })).digest("hex");
}

export function createAgnesStaticVideoQaRequestDigest(
  input: AgnesStaticQaDigestInput,
): string {
  return createHash("sha256").update(JSON.stringify({
    pipeline: AGNES_STATIC_VIDEO_QA_PIPELINE,
    pipelineVersion: AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION,
    policyVersion: AGNES_STATIC_VIDEO_QA_POLICY_VERSION,
    policyDigest: currentAgnesStaticVideoQaPolicyDigest(),
    sceneNumber: input.sceneNumber,
    generationRequestDigest: input.generationRequestDigest,
    renderRevision: input.renderRevision,
    videoSha256: input.videoSha256,
    episodeAssetSetDigest: input.episodeAssetSetDigest,
    expectedMainCast: [...input.expectedMainCast],
    referenceImageUrls: [...input.referenceImageUrls],
    media: input.media,
  })).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseMedia(value: unknown): AgnesStaticMediaFacts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const media = value as Record<string, unknown>;
  if (
    typeof media.durationSeconds !== "number"
    || !Number.isFinite(media.durationSeconds)
    || typeof media.codecName !== "string"
    || typeof media.width !== "number"
    || !Number.isSafeInteger(media.width)
    || typeof media.height !== "number"
    || !Number.isSafeInteger(media.height)
    || typeof media.videoStreamCount !== "number"
    || !Number.isSafeInteger(media.videoStreamCount)
    || typeof media.audioStreamCount !== "number"
    || !Number.isSafeInteger(media.audioStreamCount)
  ) return null;
  return {
    durationSeconds: media.durationSeconds,
    codecName: media.codecName,
    width: media.width,
    height: media.height,
    videoStreamCount: media.videoStreamCount,
    audioStreamCount: media.audioStreamCount,
  };
}

/** Shared by the QA tool and the final assembly gate. */
export function isCurrentAgnesStaticQaResult(params: {
  result: unknown;
  rowQaRequestDigest: string | null;
  rowQaVideoSha256: string | null;
  rowQaModel: string | null;
  sceneNumber: number;
  generationRequestDigest: string;
  renderRevision: number;
  videoSha256: string;
  episodeAssetSetDigest: string;
  expectedPass: boolean;
}): boolean {
  if (!params.result || typeof params.result !== "object" || Array.isArray(params.result)) return false;
  const result = params.result as Record<string, unknown>;
  const media = parseMedia(result.media);
  if (!media || !isStringArray(result.expectedMainCast) || !isStringArray(result.referenceImageUrls)) {
    return false;
  }
  if (!isSha256(params.rowQaRequestDigest) || !isSha256(params.rowQaVideoSha256)) return false;
  const recomputedQaDigest = createAgnesStaticVideoQaRequestDigest({
    sceneNumber: params.sceneNumber,
    generationRequestDigest: params.generationRequestDigest,
    renderRevision: params.renderRevision,
    videoSha256: params.videoSha256,
    episodeAssetSetDigest: params.episodeAssetSetDigest,
    expectedMainCast: result.expectedMainCast,
    referenceImageUrls: result.referenceImageUrls,
    media,
  });
  const passedMediaContract = media.durationSeconds > 0
    && media.codecName === "h264"
    && media.width === 1_920
    && media.height === 1_080
    && media.videoStreamCount === 1
    && media.audioStreamCount === 0;
  return result.policyVersion === AGNES_STATIC_VIDEO_QA_POLICY_VERSION
    && result.pipeline === AGNES_STATIC_VIDEO_QA_PIPELINE
    && result.pipelineVersion === AGNES_STATIC_VIDEO_QA_PIPELINE_VERSION
    && result.policyDigest === currentAgnesStaticVideoQaPolicyDigest()
    && result.decision === "final"
    && result.model === AGNES_STATIC_VIDEO_QA_MODEL
    && params.rowQaModel === AGNES_STATIC_VIDEO_QA_MODEL
    && result.sceneNumber === params.sceneNumber
    && result.pass === params.expectedPass
    && (!params.expectedPass || passedMediaContract)
    && result.generationRequestDigest === params.generationRequestDigest
    && result.renderRevision === params.renderRevision
    && result.videoSha256 === params.videoSha256
    && params.rowQaVideoSha256 === params.videoSha256
    && result.episodeAssetSetDigest === params.episodeAssetSetDigest
    && result.qaRequestDigest === recomputedQaDigest
    && params.rowQaRequestDigest === recomputedQaDigest
    && typeof result.evidencePath === "string"
    && result.evidencePath.trim().length > 0;
}

export function createAgnesStaticEpisodeAssetSetDigest(
  assets: readonly {
    sceneNumber: number;
    generationRequestDigest: string;
    renderRevision: number;
    videoSha256: string;
  }[],
): string {
  return createHash("sha256").update(JSON.stringify(
    [...assets].sort((left, right) => left.sceneNumber - right.sceneNumber),
  )).digest("hex");
}
