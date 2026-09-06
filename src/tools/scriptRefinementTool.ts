import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  chatStructuredNarrationRepair,
  chatText,
} from "../providers/aiClient.js";
import {
  DEFAULT_PRODUCTION_MAX_SCENES,
  DEFAULT_PRODUCTION_MIN_SCENES,
  NARRATION_AUTHORING_TARGET_MAX_RAW_CHARACTERS,
  NARRATION_AUTHORING_TARGET_MIN_SPOKEN_WORDS,
  NARRATION_MAX_AUDIO_SECONDS,
  NARRATION_MAX_RAW_CHARACTERS,
  NARRATION_MAX_SPOKEN_WORDS,
  NARRATION_TARGET_MAX_AUDIO_SECONDS,
  NARRATION_WORDS_PER_MINUTE,
  countNarrationSpokenWords,
  inspectNarrationText,
  minimumNarrationWords,
} from "../services/narrationContract.js";
import {
  ProductionScriptContractError,
  inspectProductionScript,
} from "../services/productionScriptContract.js";

type CharacterVisualForm = "real_creature" | "humanoid" | "anthropomorphic_creature" | "object_character" | "fantasy_creature";

type SceneCharacterVisual = {
  name: string;
  visualForm: CharacterVisualForm;
  speciesOrType?: string;
  humanoidAllowed?: boolean;
};

export type EpisodeScene = {
  sceneNumber: number;
  narrationText: string;
  environmentDescription: string;
  action: string;
  characterNames: string[];
  characterVisuals?: SceneCharacterVisual[];
  supportingEntities?: string[];
  continuityAnchors?: string[];
  sceneDetails?: string;
  cameraAngle?: string;
  lighting?: string;
};

export type EpisodeScript = {
  title: string;
  premise?: string;
  scenes: EpisodeScene[];
};

export type ScriptValidationResult = {
  pass: boolean;
  issues: string[];
};

type RefinementAttemptResult = {
  script: EpisodeScript;
  recoveredFromParseFailure: boolean;
};

type SceneRepairResult = {
  continuityAnchors?: string[];
  supportingEntities?: string[];
  sceneDetails?: string;
};

type CanonicalCharacterContext = {
  name: string;
  description: string;
};

type CanonicalEnvironmentContext = {
  name: string;
  description: string;
};

type EpisodeContext = {
  id: number;
  seriesId: number;
  title: string;
  premise: string;
  status: string;
  scriptJson: unknown;
};

type EpisodeScriptDraftRow = {
  episodeId: number;
  revision: number;
  contentDigest: string;
  scriptJson: unknown;
  validation: unknown;
  createdAt: string;
  updatedAt: string;
};

type PromoteEpisodeScriptDraftResult =
  | {
      status: "promoted";
      episodeId: number;
      sourceDraft: { revision: number; contentDigest: string };
    }
  | {
      status: "stale";
      episodeId: number;
      expectedDraft: { revision: number; contentDigest: string };
      currentDraft: { revision: number; contentDigest: string } | null;
    }
  | {
      status: "blocked";
      episodeId: number;
      sourceDraft: { revision: number; contentDigest: string };
      reason: "agnes_started" | "episode_completed";
    };

/** Structural boundary implemented by SeriesState and small test fakes. */
type ScriptDraftPersistence = {
  getEpisodeById(episodeId: number): Promise<EpisodeContext | null>;
  getEpisodeScriptDraft(episodeId: number): Promise<EpisodeScriptDraftRow | null>;
  stageEpisodeScriptDraft(
    episodeId: number,
    scriptJson: unknown,
    validation?: unknown,
  ): Promise<{ draft: EpisodeScriptDraftRow; created: boolean; matches: boolean }>;
  reviseEpisodeScriptDraft(
    episodeId: number,
    expectedRevision: number,
    scriptJson: unknown,
    validation?: unknown,
  ): Promise<EpisodeScriptDraftRow>;
  promoteEpisodeScriptDraft(input: {
    episodeId: number;
    expectedRevision: number;
    expectedContentDigest: string;
    scriptJson: unknown;
  }): Promise<PromoteEpisodeScriptDraftResult>;
  getSeriesCharacters(seriesId: number): Promise<CanonicalCharacterContext[]>;
};

type CanonicalProductionContext = {
  episodeTitle: string;
  episodePremise: string;
  characters: readonly CanonicalCharacterContext[];
  environments: readonly CanonicalEnvironmentContext[];
};

type RefinementPipelineResult = {
  script: EpisodeScript;
  validation: ScriptValidationResult;
  warnings: string[];
};

type DurationExceededScene = {
  sceneNumber: number;
  durationSeconds: number;
};

type PersistedTimingEvidence = {
  durationExceededScenes: DurationExceededScene[];
  measuredTotalNarrationSeconds?: number;
  measuredNarrationSceneCount?: number;
};

// Tool-capable providers occasionally wrap a nested JSON argument more than
// once, or surround that nested value with a JSON markdown fence. Decode only
// a small fixed number of complete JSON layers; the Zod schema still validates
// the final object and no missing/truncated content is inferred or repaired.
const JSON_INPUT_DECODE_LIMIT = 4;
const INVALID_REFINEMENT_INPUT = Symbol("invalid-refinement-input");

type InvalidRefinementInput = {
  readonly [INVALID_REFINEMENT_INPUT]: true;
  readonly episodeId?: number;
  readonly reason: "malformed_truncated_or_overencoded_script_json" | "schema_mismatch";
  readonly issuePaths: string[];
  readonly omittedIssueCount: number;
};

function isRecord(value: unknown): value is Record<string | symbol, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Accepts an object or up to four complete encoded/fenced transport layers. */
function decodeJsonInput(value: unknown): unknown {
  let decoded = value;
  for (let depth = 0; depth < JSON_INPUT_DECODE_LIMIT && typeof decoded === "string"; depth += 1) {
    const trimmed = decoded.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
    const candidate = fenced?.[1]?.trim() ?? trimmed;
    try {
      decoded = JSON.parse(candidate) as unknown;
    } catch {
      break;
    }
  }
  return decoded;
}

function compactIssuePaths(error: z.ZodError): { issuePaths: string[]; omittedIssueCount: number } {
  const allPaths = [...new Set(error.issues.map((issue) =>
    (issue.path.join(".") || "input").slice(0, 128)
  ))];
  return {
    issuePaths: allPaths.slice(0, 8),
    omittedIssueCount: Math.max(0, allPaths.length - 8),
  };
}

function invalidRefinementInput(input: unknown, error: z.ZodError): InvalidRefinementInput {
  const record = isRecord(input) ? input : {};
  const decodedScript = decodeJsonInput(record.scriptJson);
  const { issuePaths, omittedIssueCount } = compactIssuePaths(error);
  const rawEpisodeId = record.episodeId;
  return {
    [INVALID_REFINEMENT_INPUT]: true,
    ...(typeof rawEpisodeId === "number" && Number.isInteger(rawEpisodeId) && rawEpisodeId > 0
      ? { episodeId: rawEpisodeId }
      : {}),
    reason:
      typeof record.scriptJson === "string" && typeof decodedScript === "string"
        ? "malformed_truncated_or_overencoded_script_json"
        : "schema_mismatch",
    issuePaths,
    omittedIssueCount,
  };
}

function isInvalidRefinementInput(value: unknown): value is InvalidRefinementInput {
  return isRecord(value) && value[INVALID_REFINEMENT_INPUT] === true;
}

function compactInvalidInputResult(input: InvalidRefinementInput): string {
  return JSON.stringify({
    status: "invalid_input",
    persisted: false,
    retryable: true,
    retryThisInvocation: false,
    ...(input.episodeId === undefined ? {} : { episodeId: input.episodeId }),
    reason: input.reason,
    validation: {
      pass: false,
      issues: [
        "scriptJson must be one complete JSON object matching the advertised episode-script schema.",
      ],
      invalidPaths: input.issuePaths,
      omittedIssueCount: input.omittedIssueCount,
    },
    nextAction:
      "Call stage_episode_script_draft once with scriptJson as an object (not encoded prose), preserving every scene field.",
  });
}

function parseJsonArrayInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeSupportingEntitiesInput(value: unknown): unknown {
  const parsed = parseJsonArrayInput(value);
  if (!Array.isArray(parsed)) {
    return parsed;
  }

  return parsed
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }

      const candidate = entry as { description?: unknown; name?: unknown; type?: unknown };
      if (typeof candidate.name === "string" && candidate.name.trim()) {
        const name = candidate.name.trim();
        if (typeof candidate.description === "string" && candidate.description.trim()) {
          const description = candidate.description.trim();
          return description.toLocaleLowerCase().startsWith(`${name.toLocaleLowerCase()}:`)
            ? description
            : `${name}: ${description}`;
        }
        const suffix = typeof candidate.type === "string" && candidate.type.trim()
          ? `: ${candidate.type.trim()}`
          : "";
        return `${name}${suffix}`;
      }
      if (typeof candidate.description === "string" && candidate.description.trim()) {
        return candidate.description.trim();
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
}

const sceneCharacterVisualSchema = z.object({
  name: z.string(),
  visualForm: z.enum(["real_creature", "humanoid", "anthropomorphic_creature", "object_character", "fantasy_creature"]),
  speciesOrType: z.string().optional(),
  humanoidAllowed: z.boolean().optional(),
  });

const draftSceneSchema = z.object({
  sceneNumber: z.number().optional(),
  narrationText: z.string().optional(),
  environmentDescription: z.string().optional(),
  action: z.string().optional(),
  characterNames: z.preprocess(parseJsonArrayInput, z.array(z.string())).optional(),
  characterVisuals: z.preprocess(parseJsonArrayInput, z.array(sceneCharacterVisualSchema)).optional(),
  supportingEntities: z.preprocess(normalizeSupportingEntitiesInput, z.array(z.string())).optional(),
  continuityAnchors: z.preprocess(parseJsonArrayInput, z.array(z.string())).optional(),
  sceneDetails: z.string().optional(),
  cameraAngle: z.string().optional(),
  lighting: z.string().optional(),
});

const sceneSchema = z.object({
  sceneNumber: z.number(),
  narrationText: z.string(),
  environmentDescription: z.string(),
  action: z.string(),
  characterNames: z.preprocess(parseJsonArrayInput, z.array(z.string())),
  characterVisuals: z.preprocess(parseJsonArrayInput, z.array(sceneCharacterVisualSchema)).optional(),
  supportingEntities: z.preprocess(normalizeSupportingEntitiesInput, z.array(z.string())).optional(),
  continuityAnchors: z.preprocess(parseJsonArrayInput, z.array(z.string())).optional(),
  sceneDetails: z.string().optional(),
  cameraAngle: z.string().optional(),
  lighting: z.string().optional(),
});

const scriptSchema = z.object({
  title: z.string(),
  premise: z.string().optional(),
  scenes: z.preprocess(parseJsonArrayInput, z.array(sceneSchema)),
});

const draftScriptSchema = z.object({
  title: z.string(),
  premise: z.string().optional(),
  scenes: z.preprocess(parseJsonArrayInput, z.array(draftSceneSchema)),
});

export const EPISODE_SCRIPT_CHUNK_PROTOCOL = "chunked_episode_script_v1" as const;
export const EPISODE_SCRIPT_SCENES_PER_CHUNK = 8;
export const EPISODE_SCRIPT_CHUNK_APPEND_TARGET_SERIALIZED_CHARACTERS = 18_000;
export const EPISODE_SCRIPT_CHUNK_START_TARGET_SERIALIZED_CHARACTERS = 20_000;
export const EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS = 24_000;
export const EPISODE_SCRIPT_CHUNK_MAX_RAW_TRANSPORT_CHARACTERS = 48_000;
export const EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES = 3;

const boundedRequiredText = (label: string, maximum: number) => z.string()
  .max(maximum, `${label} must be at most ${maximum} characters.`)
  .refine((value) => value.trim().length > 0, `${label} must not be empty.`);

const chunkCharacterVisualSchema = z.object({
  name: boundedRequiredText("characterVisuals.name", 200).describe(
    "TARGET: exact stored character name only; do not add appearance prose.",
  ),
  visualForm: z.enum([
    "real_creature",
    "humanoid",
    "anthropomorphic_creature",
    "object_character",
    "fantasy_creature",
  ]),
  speciesOrType: boundedRequiredText("characterVisuals.speciesOrType", 300).optional().describe(
    "TARGET: 2-60 characters naming only the canonical species/type.",
  ),
  humanoidAllowed: z.boolean().optional(),
}).strict();

/**
 * Unlike the permissive legacy draft schema, a chunk never silently drops a
 * scene-generation field. Empty arrays are explicit and valid when no cast,
 * supporting entity, or continuity anchor is visible in that scene.
 */
const completeChunkSceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  narrationText: boundedRequiredText("narrationText", NARRATION_MAX_RAW_CHARACTERS).describe(
    "TARGET: 15-20 spoken words and at most 170 characters; hard maximum 200 characters. Keep vocal directions only when useful.",
  ),
  environmentDescription: boundedRequiredText("environmentDescription", 1_500).describe(
    "TARGET: 120-260 characters of concrete location, layout, weather/time, and stable background details. Reuse verbatim while unchanged; hard maximum 1500.",
  ),
  action: boundedRequiredText("action", 1_500).describe(
    "TARGET: 70-180 characters for one visible action and emotion beat; hard maximum 1500. Do not repeat environment or camera prose.",
  ),
  characterNames: z.array(boundedRequiredText("characterNames entry", 200)).max(12).describe(
    "Only characters visible in this shot, using exact stored names and no descriptors.",
  ),
  characterVisuals: z.array(chunkCharacterVisualSchema).max(12).describe(
    "One compact identity record per characterName in the same order; do not duplicate wardrobe or scene prose here.",
  ),
  supportingEntities: z.array(
    boundedRequiredText("supportingEntities entry", 1_000).describe(
      "TARGET: at most 220 characters per stable name + locked visual descriptor; include only visible entities and reuse unchanged text verbatim.",
    ),
  ).max(12).describe("Usually 0-3 concise visible supporting-entity descriptors."),
  continuityAnchors: z.array(
    boundedRequiredText("continuityAnchors entry", 1_000).describe(
      "TARGET: at most 220 characters per concrete continuing prop/layout/state anchor; reuse unchanged text verbatim.",
    ),
  ).max(16).describe("Usually 0-3 anchors needed for this shot; avoid duplicating environment prose."),
  sceneDetails: boundedRequiredText("sceneDetails", 2_500).describe(
    "TARGET: 180-360 characters for exact blocking, poses, expressions, prop state, and the new visible beat; hard maximum 2500. " +
    "For scenes with a complex cast or important visual setup, write at least 60 characters and either " +
    "two sentence-like parts or three comma/colon/semicolon-separated visual clauses. Do not repeat the full environment, camera, or lighting text.",
  ),
  cameraAngle: boundedRequiredText("cameraAngle", 500).describe(
    "TARGET: 25-100 characters naming framing, viewpoint, and any deliberate movement; hard maximum 500.",
  ),
  lighting: boundedRequiredText("lighting", 500).describe(
    "TARGET: 30-120 characters naming source, color/quality, and mood; hard maximum 500.",
  ),
}).strict();

const authoringPlanBeatSchema = z.object({
  startScene: z.number().int().min(1).max(DEFAULT_PRODUCTION_MAX_SCENES),
  endScene: z.number().int().min(1).max(DEFAULT_PRODUCTION_MAX_SCENES),
  storyBeat: boundedRequiredText("authoringPlan beat storyBeat", 900).describe(
    "TARGET: at most 220 characters describing the causal story movement for this range.",
  ),
  setting: boundedRequiredText("authoringPlan beat setting", 600).describe(
    "TARGET: at most 140 characters naming the range's location/setup.",
  ),
  continuityOutcome: boundedRequiredText("authoringPlan beat continuityOutcome", 900).describe(
    "TARGET: at most 220 characters stating the concrete state carried into the next range.",
  ),
}).strict();

export const episodeScriptChunkAuthoringPlanSchema = z.object({
  storyArc: boundedRequiredText("authoringPlan.storyArc", 2_000).describe(
    "TARGET: 500-900 characters covering the complete causal arc without scene-by-scene repetition.",
  ),
  educationalIdea: boundedRequiredText("authoringPlan.educationalIdea", 600).describe(
    "TARGET: at most 240 characters for the one integrated learning idea.",
  ),
  endingInsight: boundedRequiredText("authoringPlan.endingInsight", 600).describe(
    "TARGET: at most 240 characters for the final preschool takeaway.",
  ),
  beats: z.array(authoringPlanBeatSchema).min(3).max(12),
  supportingEntityBible: z.array(
    boundedRequiredText("authoringPlan.supportingEntityBible entry", 1_000).describe(
      "TARGET: at most 220 characters for one reusable stable name + locked visual descriptor.",
    ),
  ).max(12).describe("Only recurring supporting entities; do not repeat beat prose."),
  continuityBible: z.array(
    boundedRequiredText("authoringPlan.continuityBible entry", 1_000).describe(
      "TARGET: at most 220 characters for one episode-wide prop/layout/state rule.",
    ),
  ).max(16).describe("Only continuity rules reused across ranges; avoid duplicates."),
}).strict();

export type EpisodeScriptChunkAuthoringPlan = z.infer<
  typeof episodeScriptChunkAuthoringPlanSchema
>;

const episodeScriptChunkAuthoringMarkerSchema = z.object({
  protocol: z.literal(EPISODE_SCRIPT_CHUNK_PROTOCOL),
  targetSceneCount: z.number().int()
    .min(DEFAULT_PRODUCTION_MIN_SCENES)
    .max(DEFAULT_PRODUCTION_MAX_SCENES),
  plan: episodeScriptChunkAuthoringPlanSchema,
}).strict();

const episodeScriptChunkDraftEnvelopeSchema = z.object({
  title: z.string(),
  premise: z.string().optional(),
  scenes: z.array(completeChunkSceneSchema).max(DEFAULT_PRODUCTION_MAX_SCENES),
  authoring: episodeScriptChunkAuthoringMarkerSchema,
}).strict();

const completedChunkScriptSchema = z.object({
  title: z.string(),
  premise: z.string().optional(),
  scenes: z.array(completeChunkSceneSchema)
    .min(DEFAULT_PRODUCTION_MIN_SCENES)
    .max(DEFAULT_PRODUCTION_MAX_SCENES),
}).strict();

type EpisodeScriptChunkDraftEnvelope = z.infer<
  typeof episodeScriptChunkDraftEnvelopeSchema
>;

const episodeScriptChunkInputSchema = z.object({
  operation: z.enum(["start", "append", "restart"]).describe(
    "start begins a new draft; append adds the exact next range; restart replaces only a deterministically rejected complete draft.",
  ),
  episodeId: z.number().int().positive(),
  expectedDraftRevision: z.number().int().positive().optional().describe(
    "Required for append/restart and forbidden for start.",
  ),
  targetSceneCount: z.number().int()
    .min(DEFAULT_PRODUCTION_MIN_SCENES)
    .max(DEFAULT_PRODUCTION_MAX_SCENES)
    .optional()
    .describe("Required for start/restart and immutable after the first chunk."),
  authoringPlan: episodeScriptChunkAuthoringPlanSchema.optional().describe(
    "Required for start/restart and omitted for append; it is persisted and returned as bounded continuation context.",
  ),
  scenes: z.array(completeChunkSceneSchema)
    .min(1)
    .max(EPISODE_SCRIPT_SCENES_PER_CHUNK)
    .describe(
      `The exact next ${EPISODE_SCRIPT_SCENES_PER_CHUNK} scenes, except the final range may be shorter. ` +
      `TARGET at most 2000 serialized characters per scene and ${EPISODE_SCRIPT_CHUNK_APPEND_TARGET_SERIALIZED_CHARACTERS} ` +
      "for a complete append call. Every scene-generation field is required; be concise without omitting visual or continuity detail.",
    ),
}).strict();

/*
 * Keep the advertised tool contract strict (narration maxLength=200), while
 * allowing the implementation to turn an otherwise complete overlong
 * narration into a durable, actionable semantic rejection. Without this
 * recovery schema, Zod rejects the whole call before the immutable plan or an
 * already-accepted prefix can be preserved for the next run.
 */
const recoverableNarrationChunkSceneSchema = completeChunkSceneSchema.extend({
  narrationText: boundedRequiredText(
    "narrationText",
    EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS,
  ),
});

const recoverableNarrationChunkInputSchema = episodeScriptChunkInputSchema.extend({
  scenes: z.array(recoverableNarrationChunkSceneSchema)
    .min(1)
    .max(EPISODE_SCRIPT_SCENES_PER_CHUNK),
});

const INVALID_SCRIPT_CHUNK_INPUT = Symbol("invalid-script-chunk-input");

type InvalidScriptChunkInput = {
  readonly [INVALID_SCRIPT_CHUNK_INPUT]: true;
  readonly episodeId?: number;
  readonly issues: string[];
  readonly invalidPaths: string[];
  readonly omittedIssueCount: number;
};

function invalidScriptChunkInput(input: unknown, error: z.ZodError): InvalidScriptChunkInput {
  const record = isRecord(input) ? input : {};
  const compact = compactIssuePaths(error);
  const allIssues = [...new Set(error.issues.map((issue) => {
    const path = issue.path.join(".") || "input";
    const message = `${path}: ${issue.message}`;
    return message.length <= 256 ? message : `${message.slice(0, 253)}...`;
  }))];
  const rawEpisodeId = record.episodeId;
  return {
    [INVALID_SCRIPT_CHUNK_INPUT]: true,
    ...(typeof rawEpisodeId === "number" && Number.isSafeInteger(rawEpisodeId) && rawEpisodeId > 0
      ? { episodeId: rawEpisodeId }
      : {}),
    issues: allIssues.slice(0, 8),
    invalidPaths: compact.issuePaths,
    omittedIssueCount: Math.max(0, allIssues.length - 8),
  };
}

function isInvalidScriptChunkInput(value: unknown): value is InvalidScriptChunkInput {
  return isRecord(value) && value[INVALID_SCRIPT_CHUNK_INPUT] === true;
}

function invalidEncodedScenesChunkInput(
  input: unknown,
  issue: string,
): InvalidScriptChunkInput {
  const record = isRecord(input) ? input : {};
  const rawEpisodeId = record.episodeId;
  return {
    [INVALID_SCRIPT_CHUNK_INPUT]: true,
    ...(typeof rawEpisodeId === "number" && Number.isSafeInteger(rawEpisodeId) && rawEpisodeId > 0
      ? { episodeId: rawEpisodeId }
      : {}),
    issues: [issue],
    invalidPaths: ["scenes"],
    omittedIssueCount: 0,
  };
}

function recoverNarrationLimitOnlyChunkInput(
  input: unknown,
  error: z.ZodError,
): z.infer<typeof episodeScriptChunkInputSchema> | null {
  const onlyNarrationCharacterLimitIssues = error.issues.length > 0
    && error.issues.every((issue) =>
      issue.code === "too_big"
      && issue.path.length === 3
      && issue.path[0] === "scenes"
      && typeof issue.path[1] === "number"
      && issue.path[2] === "narrationText"
    );
  if (!onlyNarrationCharacterLimitIssues) return null;

  const recovered = recoverableNarrationChunkInputSchema.safeParse(input);
  return recovered.success
    ? recovered.data as z.infer<typeof episodeScriptChunkInputSchema>
    : null;
}

/**
 * Some tool-capable providers serialize only the nested `scenes` argument even
 * though its advertised JSON Schema is an array. Normalize that transport
 * quirk inside the catch boundary, then run the unchanged strict input schema.
 * Nothing partial is repaired: the string must be one complete JSON value,
 * optionally fenced or encoded through the same small fixed layer limit used
 * for other nested JSON transport values, and that value must be an array.
 */
function recoverScriptChunkInput(
  input: unknown,
  error: z.ZodError,
): z.infer<typeof episodeScriptChunkInputSchema> | InvalidScriptChunkInput {
  if (isRecord(input) && typeof input.scenes === "string") {
    if (input.scenes.length > EPISODE_SCRIPT_CHUNK_MAX_RAW_TRANSPORT_CHARACTERS) {
      return invalidEncodedScenesChunkInput(
        input,
        `scenes: Encoded scenes payload exceeds the raw transport safety limit of ` +
        `${EPISODE_SCRIPT_CHUNK_MAX_RAW_TRANSPORT_CHARACTERS} characters. ` +
        "Send one complete bounded JSON array for only the requested scene range.",
      );
    }

    const decodedScenes = decodeJsonInput(input.scenes);
    if (!Array.isArray(decodedScenes)) {
      return invalidEncodedScenesChunkInput(
        input,
        `scenes: Encoded scenes must be one complete valid JSON array (plain, fenced, or within ` +
        `${JSON_INPUT_DECODE_LIMIT} encoded layers); no partial or prose-wrapped value is accepted.`,
      );
    }

    const normalizedInput = { ...input, scenes: decodedScenes };
    const strictResult = episodeScriptChunkInputSchema.safeParse(normalizedInput);
    if (strictResult.success) return strictResult.data;

    return recoverNarrationLimitOnlyChunkInput(normalizedInput, strictResult.error)
      ?? invalidScriptChunkInput(normalizedInput, strictResult.error);
  }

  return recoverNarrationLimitOnlyChunkInput(input, error)
    ?? invalidScriptChunkInput(input, error);
}

export interface EpisodeScriptChunkAuthoringProgress {
  protocol: typeof EPISODE_SCRIPT_CHUNK_PROTOCOL;
  status: "in_progress" | "complete";
  targetSceneCount: number;
  completedSceneCount: number;
  nextSceneNumber: number | null;
  nextSceneEnd: number | null;
  totalSpokenWords: number;
  minimumSpokenWords: number;
  remainingMinimumSpokenWords: number;
  requiredAverageWordsPerRemainingScene: number;
  authoringPlan: EpisodeScriptChunkAuthoringPlan;
  activePlanBeat: z.infer<typeof authoringPlanBeatSchema> | null;
  previousScenes: EpisodeScene[];
  validationIssues: string[];
}

function validateAuthoringPlanCoverage(
  plan: EpisodeScriptChunkAuthoringPlan,
  targetSceneCount: number,
): string[] {
  const issues: string[] = [];
  let expectedStart = 1;
  plan.beats.forEach((beat, index) => {
    if (beat.endScene < beat.startScene) {
      issues.push(`authoringPlan.beats[${index}] endScene must be at least startScene.`);
    }
    if (beat.startScene !== expectedStart) {
      issues.push(
        `authoringPlan.beats[${index}] must start at scene ${expectedStart} so beat ranges are contiguous.`,
      );
    }
    expectedStart = beat.endScene + 1;
  });
  if (plan.beats.at(-1)?.endScene !== targetSceneCount) {
    issues.push(`authoringPlan beats must cover scene 1 through ${targetSceneCount} exactly.`);
  }
  return issues;
}

function parseEpisodeScriptChunkDraftEnvelope(
  value: unknown,
): EpisodeScriptChunkDraftEnvelope | null {
  const parsed = episodeScriptChunkDraftEnvelopeSchema.safeParse(decodeJsonInput(value));
  if (!parsed.success) return null;
  const envelope = parsed.data;
  if (validateAuthoringPlanCoverage(
    envelope.authoring.plan,
    envelope.authoring.targetSceneCount,
  ).length > 0) return null;
  if (envelope.scenes.length > envelope.authoring.targetSceneCount) return null;
  if (!envelope.scenes.every((scene, index) => scene.sceneNumber === index + 1)) return null;
  return envelope;
}

function boundedDraftValidationIssues(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.issues)) return [];
  return value.issues
    .filter((issue): issue is string => typeof issue === "string" && Boolean(issue.trim()))
    .slice(0, 8)
    .map((issue) => issue.length <= 256 ? issue : `${issue.slice(0, 253)}...`);
}

/**
 * Public, bounded resume view used by get_next_episode. It deliberately returns
 * only the immutable plan and two-scene handoff, never the cumulative prefix.
 */
export function getEpisodeScriptChunkAuthoringProgress(
  scriptJson: unknown,
  validation?: unknown,
): EpisodeScriptChunkAuthoringProgress | null {
  const envelope = parseEpisodeScriptChunkDraftEnvelope(scriptJson);
  if (!envelope) return null;
  const completedSceneCount = envelope.scenes.length;
  const targetSceneCount = envelope.authoring.targetSceneCount;
  const remainingSceneCount = Math.max(0, targetSceneCount - completedSceneCount);
  const nextSceneNumber = remainingSceneCount === 0 ? null : completedSceneCount + 1;
  const nextSceneEnd = nextSceneNumber === null
    ? null
    : Math.min(targetSceneCount, completedSceneCount + EPISODE_SCRIPT_SCENES_PER_CHUNK);
  const totalSpokenWords = envelope.scenes.reduce(
    (total, scene) => total + countNarrationSpokenWords(scene.narrationText),
    0,
  );
  const minimumSpokenWords = minimumNarrationWords(5);
  const remainingMinimumSpokenWords = Math.max(0, minimumSpokenWords - totalSpokenWords);
  const activePlanBeat = nextSceneNumber === null
    ? null
    : envelope.authoring.plan.beats.find((beat) =>
        beat.startScene <= nextSceneNumber && beat.endScene >= nextSceneNumber
      ) ?? null;
  return {
    protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
    status: remainingSceneCount === 0 ? "complete" : "in_progress",
    targetSceneCount,
    completedSceneCount,
    nextSceneNumber,
    nextSceneEnd,
    totalSpokenWords,
    minimumSpokenWords,
    remainingMinimumSpokenWords,
    requiredAverageWordsPerRemainingScene: remainingSceneCount === 0
      ? 0
      : Number((remainingMinimumSpokenWords / remainingSceneCount).toFixed(2)),
    authoringPlan: envelope.authoring.plan,
    activePlanBeat,
    previousScenes: envelope.scenes.slice(-2) as EpisodeScene[],
    validationIssues: boundedDraftValidationIssues(validation),
  };
}

/**
 * Normalizes draft or refined scripts into the stable scene shape used by validation and repair.
 */
function normalizeSceneNumbers(script: EpisodeScript): EpisodeScript {
  const scenes = Array.isArray(script.scenes) ? script.scenes : [];
  return {
    ...script,
    scenes: scenes.map((scene, index) => ({
      ...scene,
      sceneNumber: index + 1,
      narrationText: typeof scene.narrationText === "string" ? scene.narrationText.trim() : "",
      environmentDescription: typeof scene.environmentDescription === "string" ? scene.environmentDescription.trim() : "",
      action: typeof scene.action === "string" ? scene.action.trim() : "",
      // Preserve explicitly authored characterNames (including an intentional
      // empty list). Inferring from characterVisuals only when the field is
      // genuinely absent keeps validation able to catch name/visual mismatch.
      characterNames: Array.isArray(scene.characterNames)
        ? scene.characterNames.map((name) => name.trim()).filter(Boolean)
        : Array.isArray(scene.characterVisuals)
          ? scene.characterVisuals.map((item) => item.name.trim()).filter(Boolean)
          : [],
      characterVisuals: Array.isArray(scene.characterVisuals)
        ? scene.characterVisuals.map((item) => ({
            name: item.name.trim(),
            visualForm: item.visualForm,
            speciesOrType: item.speciesOrType?.trim() || undefined,
            humanoidAllowed: item.humanoidAllowed,
          })).filter((item) => item.name)
        : undefined,
      supportingEntities: Array.isArray(scene.supportingEntities) ? scene.supportingEntities : undefined,
      continuityAnchors: Array.isArray(scene.continuityAnchors) ? scene.continuityAnchors : undefined,
    })),
  };
}

function countNarrativeBeats(text: string): number {
  return (text.match(/\b(?:then|next|after|suddenly|but|meanwhile|finally|when)\b/gi) ?? []).length;
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function hasMeaningfulContinuityAnchors(scene: EpisodeScene): boolean {
  return Array.isArray(scene.continuityAnchors) && scene.continuityAnchors.some((anchor) => anchor.trim().length > 0);
}

function hasMeaningfulSupportingEntities(scene: EpisodeScene): boolean {
  return Array.isArray(scene.supportingEntities) && scene.supportingEntities.some((entity) => entity.trim().length > 0);
}

function hasWeakSceneDetails(scene: EpisodeScene): boolean {
  const details = scene.sceneDetails?.trim() ?? "";
  if (!details) return true;
  if (details.length < 60) return true;
  const sentenceLikeParts = details.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  if (sentenceLikeParts.length >= 2) return false;
  const clauseCount = (details.match(/[,:;]/g) ?? []).length;
  return clauseCount < 3;
}

function hasConsistentCharacterVisuals(scene: EpisodeScene): boolean {
  if (!scene.characterVisuals || scene.characterVisuals.length === 0) return false;
  if (scene.characterVisuals.length !== scene.characterNames.length) return false;
  return scene.characterVisuals.every((item, index) => {
    const expectedName = scene.characterNames[index]?.trim();
    return item.name.trim() === expectedName;
  });
}

function sceneMentionsVisualSetup(scene: EpisodeScene): boolean {
  const combined = `${scene.narrationText} ${scene.action} ${scene.sceneDetails ?? ""}`.toLowerCase();
  return /(lantern|blanket|table|window|door|wagon|basket|prototype|wind-?mill|tool|rope|cup|cookies|apple|leaf|rain|storm|light|glow)/.test(combined);
}

function extractSceneNumbersForTargetedRepair(issues: string[]): number[] {
  const sceneNumbers = new Set<number>();
  for (const issue of issues) {
    if (!issue.includes("continuityAnchors") && !issue.includes("sceneDetails") && !issue.includes("supportingEntities")) continue;
    const match = issue.match(/^Scene\s+(\d+)/i);
    if (match) sceneNumbers.add(Number(match[1]));
  }
  return [...sceneNumbers].sort((a, b) => a - b);
}

function parseSceneRepairResponse(raw: string): SceneRepairResult {
  const parsed = JSON.parse(extractJsonObject(raw)) as SceneRepairResult;
  return {
    continuityAnchors: Array.isArray(parsed.continuityAnchors)
      ? parsed.continuityAnchors.map(String).map((item) => item.trim()).filter(Boolean)
      : undefined,
    supportingEntities: Array.isArray(parsed.supportingEntities)
      ? parsed.supportingEntities.map(String).map((item) => item.trim()).filter(Boolean)
      : undefined,
    sceneDetails: typeof parsed.sceneDetails === "string" ? parsed.sceneDetails.trim() : undefined,
  };
}

async function repairSceneFields(params: {
  scene: EpisodeScene;
  previousScene?: EpisodeScene;
  sameEnvironmentAsPrevious: boolean;
  issues: string[];
}): Promise<SceneRepairResult> {
  const systemPrompt =
    "You repair a single children's storybook scene JSON entry for direct video-generation reliability. " +
    "Return ONLY valid JSON with this exact shape: {\"continuityAnchors\": string[]?, \"supportingEntities\": string[]?, \"sceneDetails\": string?}. " +
    "Do not rewrite narrationText, environmentDescription, action, characterNames, cameraAngle, or lighting. " +
    "Your job is ONLY to repair continuityAnchors, supportingEntities, and/or sceneDetails. " +
    "If supportingEntities are needed (e.g. secondary guest characters, guides, scribes, or baby animals mentioned in the action/narration or continuing from previous scenes), include them with locked exact visual descriptions. " +
    "If continuityAnchors are needed, make them explicit, drawable, and reusable across adjacent scenes using concrete details like color, pattern, material, shape, size, placement, and current state. " +
    "If sceneDetails are weak, rewrite them into a vivid single-moment visual description that clearly places the required characters and props in the frame. " +
    "Ensure sceneDetails and props strictly respect each character's canonical wardrobe — do not invent unapproved hats, bags, clothing, or accessories for characters who do not have them. " +
    "Preserve continuity of recurring supportingEntities and continuityAnchors from the previous scene when they continue in the story. " +
    "If the environment changed, do NOT carry forward previous continuityAnchors unless the current scene explicitly preserves a moved/shared object or setup. " +
    "Return one JSON object only, no markdown and no commentary.";

  const userText =
    `Target scene JSON:\n${JSON.stringify(params.scene)}\n\n` +
    `Previous scene JSON:\n${JSON.stringify(params.previousScene ?? null)}\n\n` +
    `Same environment as previous scene: ${params.sameEnvironmentAsPrevious ? "yes" : "no"}\n\n` +
    `Issues to fix:\n- ${params.issues.join("\n- ")}\n\n` +
    `Repair only continuityAnchors, supportingEntities, and sceneDetails for the target scene. ` +
    (params.sameEnvironmentAsPrevious
      ? `If the previous scene contains reusable continuityAnchors or supportingEntities for continuing figures/setups, carry them forward and adapt only if the current narration/action clearly changes their state.`
      : `Because the environment changed, generate continuityAnchors from the current scene itself unless the current narration/action explicitly preserves a moved/shared object, guide, or setup from the previous scene.`);

  const raw = await chatText({
    systemPrompt,
    userText,
  });

  try {
    return parseSceneRepairResponse(raw);
  } catch {
    const retryRaw = await chatText({
      systemPrompt:
        systemPrompt +
        " Your previous response was not valid JSON. Output a single valid JSON object only.",
      userText:
        `${userText}\n\n` +
        `Your previous invalid response was:\n${raw}\n\n` +
        `Now return only the corrected JSON object.`,
    });
    return parseSceneRepairResponse(retryRaw);
  }
}

async function repairTargetedScenes(script: EpisodeScript, issues: string[]): Promise<EpisodeScript> {
  const sceneNumbers = extractSceneNumbersForTargetedRepair(issues);
  if (sceneNumbers.length === 0) return script;

  const repairedScenes = [...script.scenes];
  for (const sceneNumber of sceneNumbers) {
    const sceneIndex = sceneNumber - 1;
    const scene = repairedScenes[sceneIndex];
    if (!scene) continue;

    const sceneIssues = issues.filter((issue) => issue.startsWith(`Scene ${sceneNumber} `));
    const previousScene = sceneIndex > 0 ? repairedScenes[sceneIndex - 1] : undefined;
    const sameEnvironmentAsPrevious = previousScene
      ? normalizeText(previousScene.environmentDescription) === normalizeText(scene.environmentDescription)
      : false;
    const repairedFields = await repairSceneFields({
      scene,
      previousScene,
      sameEnvironmentAsPrevious,
      issues: sceneIssues,
    });

    repairedScenes[sceneIndex] = {
      ...scene,
      continuityAnchors: repairedFields.continuityAnchors ?? scene.continuityAnchors,
      supportingEntities: repairedFields.supportingEntities ?? scene.supportingEntities,
      sceneDetails: repairedFields.sceneDetails ?? scene.sceneDetails,
    };
  }

  return {
    ...script,
    scenes: repairedScenes,
  };
}

export function validateEpisodeScript(
  script: EpisodeScript,
  minScenes: number,
  maxScenes: number,
  targetRuntimeMinutes = 5,
  mainCharacterNames?: readonly string[],
  options: {
    /** Enforce every production scene rule even while a prefix has fewer scenes. */
    productionSceneContract?: boolean;
    /** Used only for bounded chunk assembly; final validation never sets this. */
    deferAggregateMinimums?: boolean;
  } = {},
): ScriptValidationResult {
  const issues: string[] = [];
  if (!options.deferAggregateMinimums && script.scenes.length < minScenes) {
    issues.push(`Scene count too low: ${script.scenes.length}. Minimum required is ${minScenes}.`);
  }
  if (script.scenes.length > maxScenes) {
    issues.push(`Scene count too high: ${script.scenes.length}. Maximum allowed is ${maxScenes}.`);
  }

  // Runtime and word count checks apply only to full production episodes so
  // small fixtures/manual previews can still validate a deliberately tiny set.
  const isFullProduction = options.productionSceneContract ?? minScenes >= 15;
  const canonicalCast = mainCharacterNames
    ? new Set(mainCharacterNames.map((name) => name.trim()).filter(Boolean))
    : null;
  if (isFullProduction && (!canonicalCast || canonicalCast.size === 0)) {
    issues.push(
      "Production refinement requires mainCharacterNames from the fixed Turso roster so guests cannot leak into characterNames."
    );
  }
  const minRequiredWords = isFullProduction ? minimumNarrationWords(targetRuntimeMinutes) : 0;
  const totalWords = script.scenes.reduce((sum, sc) => {
    return sum + countNarrationSpokenWords(sc.narrationText ?? "");
  }, 0);

  if (isFullProduction && maxScenes * NARRATION_MAX_SPOKEN_WORDS < minRequiredWords) {
    issues.push(
      `Configured scene range cannot satisfy the narration runtime contract: at most ${maxScenes} scenes ` +
      `with ${NARRATION_MAX_SPOKEN_WORDS} spoken words each cannot reach the required ${minRequiredWords} words.`
    );
  }
  if (isFullProduction && !options.deferAggregateMinimums && totalWords < minRequiredWords) {
    const estRuntime = (totalWords / NARRATION_WORDS_PER_MINUTE).toFixed(1);
    issues.push(
      `Total episode narration word count too low: ${totalWords} spoken words (~${estRuntime} minutes). ` +
      `Minimum required for a ${targetRuntimeMinutes}-minute episode is ${minRequiredWords} words. ` +
      `Add meaningful visual beats instead of making any scene exceed ${NARRATION_MAX_SPOKEN_WORDS} spoken words.`
    );
  }

  const sceneBeatBySignature = new Map<string, number>();
  script.scenes.forEach((scene, index) => {
    const label = `Scene ${index + 1}`;
    if (!scene.environmentDescription.trim()) {
      issues.push(`${label} is missing environmentDescription.`);
    }
    if (!scene.action.trim()) {
      issues.push(`${label} is missing action.`);
    }
    const beatSignature = JSON.stringify([
      normalizeText(scene.environmentDescription),
      normalizeText(scene.action),
      normalizeText(scene.sceneDetails),
      normalizeText(scene.narrationText),
    ]);
    if (
      scene.environmentDescription.trim()
      && scene.action.trim()
      && scene.sceneDetails?.trim()
      && scene.narrationText.trim()
    ) {
      const duplicateOf = sceneBeatBySignature.get(beatSignature);
      if (duplicateOf !== undefined) {
        issues.push(
          `${label} duplicates the complete narration/action beat from Scene ${duplicateOf}; ` +
          "write a genuinely distinct visible beat instead of renumbering repeated content."
        );
      } else {
        sceneBeatBySignature.set(beatSignature, index + 1);
      }
    }
    if (isFullProduction && !scene.sceneDetails?.trim()) {
      issues.push(`${label} is missing sceneDetails required for direct video generation.`);
    }
    if (isFullProduction && !scene.cameraAngle?.trim()) {
      issues.push(`${label} is missing cameraAngle required for direct video generation.`);
    }
    if (isFullProduction && !scene.lighting?.trim()) {
      issues.push(`${label} is missing lighting required for direct video generation.`);
    }
    const narrationInspection = inspectNarrationText(scene.narrationText, { production: isFullProduction });
    if (!scene.narrationText.trim()) {
      issues.push(`${label} is missing narrationText.`);
    } else {
      if (narrationInspection.issues.some((issue) => issue.code === "too_many_raw_characters")) {
        issues.push(
          `${label} narrationText has ${narrationInspection.rawCharacterCount} raw characters and exceeds ` +
          `the ${NARRATION_MAX_RAW_CHARACTERS}-character one-request Groq limit; split it into consecutive scenes.`
        );
      }
      if (narrationInspection.issues.some((issue) => issue.code === "too_many_spoken_words")) {
        issues.push(
          `${label} narrationText has ${narrationInspection.spokenWordCount} spoken words; the production ` +
          `maximum is ${NARRATION_MAX_SPOKEN_WORDS} so one Groq narration can fit one ` +
          `${NARRATION_MAX_AUDIO_SECONDS}-second Agnes scene. Split it into consecutive scenes.`
        );
      }
    }
    if (!Array.isArray(scene.characterNames)) {
      issues.push(`${label} is missing characterNames.`);
    } else if (isFullProduction && !Array.isArray(scene.characterVisuals)) {
      issues.push(`${label} must include characterVisuals aligned 1:1 with characterNames (use [] when empty).`);
    } else if (scene.characterNames.length > 0 && !hasConsistentCharacterVisuals(scene)) {
      issues.push(`${label} must include characterVisuals entries matching characterNames in order, with explicit visualForm metadata for each character.`);
    } else if (Array.isArray(scene.characterVisuals) && scene.characterVisuals.length !== scene.characterNames.length) {
      issues.push(`${label} characterVisuals must align 1:1 with characterNames.`);
    }
    if (canonicalCast) {
      const unknownNames = scene.characterNames.filter((name) => !canonicalCast.has(name.trim()));
      if (unknownNames.length > 0) {
        issues.push(
          `${label} characterNames contains non-roster names: ${unknownNames.join(", ")}. ` +
          "Put guests and secondary creatures in supportingEntities."
        );
      }
    }
    if (countNarrativeBeats(scene.narrationText) >= 2) {
      issues.push(`${label} narration appears overloaded with multiple beats and should be split.`);
    }
    const previousScene = index > 0 ? script.scenes[index - 1] : null;
    const sameEnvironmentAsPrevious = previousScene
      ? normalizeText(previousScene.environmentDescription) === normalizeText(scene.environmentDescription)
      : false;
    if (sameEnvironmentAsPrevious && !hasMeaningfulContinuityAnchors(scene)) {
      issues.push(`${label} continues the same setup/location as the previous scene but is missing continuityAnchors.`);
    }
    if (previousScene && hasMeaningfulSupportingEntities(previousScene) && !hasMeaningfulSupportingEntities(scene)) {
      const combined = `${scene.narrationText} ${scene.action} ${scene.sceneDetails ?? ""}`.toLowerCase();
      if (previousScene.supportingEntities!.some((e) => {
        const namePart = e.split(":")[0]?.toLowerCase().trim();
        return namePart && namePart.length > 2 && combined.includes(namePart);
      })) {
        issues.push(`${label} continues interacting with supporting entities from the previous scene but is missing supportingEntities.`);
      }
    }

    const requiresRicherSceneDetails = scene.characterNames.length >= 4 || (scene.characterNames.length > 0 && sceneMentionsVisualSetup(scene));
    if (requiresRicherSceneDetails && hasWeakSceneDetails(scene)) {
      issues.push(
        `${label} needs richer sceneDetails for reliable video generation because it has a complex cast or important visual setup. ` +
        "Use at least 60 characters and either two sentence-like parts or at least three comma/colon/semicolon-separated visual clauses.",
      );
    }
  });

  return { pass: issues.length === 0, issues };
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1).trim();
  }

  return trimmed;
}

function parseScriptResponse(raw: string): EpisodeScript {
  const parsed = scriptSchema.parse(JSON.parse(extractJsonObject(raw)));
  return normalizeSceneNumbers(parsed);
}

async function rewriteScript(params: {
  script: EpisodeScript;
  minScenes: number;
  maxScenes: number;
  targetRuntimeMinutes: number;
  mainCharacterNames?: readonly string[];
  canonicalContext?: CanonicalProductionContext;
  issues?: string[];
  mode: "review" | "repair";
}): Promise<RefinementAttemptResult> {
  const requiredWords = minimumNarrationWords(params.targetRuntimeMinutes);
  const baseSystemPrompt =
    "You refine children's episodic scene scripts for one-scene/one-video generation. " +
    "Return ONLY valid JSON matching this shape: {\"title\": string, \"premise\": string?, \"scenes\": [{\"sceneNumber\": number, \"narrationText\": string, \"environmentDescription\": string, \"action\": string, \"characterNames\": string[], \"characterVisuals\": [{\"name\": string, \"visualForm\": \"real_creature\"|\"humanoid\"|\"anthropomorphic_creature\"|\"object_character\"|\"fantasy_creature\", \"speciesOrType\": string?, \"humanoidAllowed\": boolean?}], \"supportingEntities\": string[]?, \"continuityAnchors\": string[]?, \"sceneDetails\": string, \"cameraAngle\": string, \"lighting\": string}]}. " +
    `ONE SCENE = ONE AUDIO = ONE VIDEO (CRITICAL): Keep exactly one visible beat per scene. Each narrationText must be one or two concise sentences, no more than ${NARRATION_MAX_RAW_CHARACTERS} raw characters including vocal directions, and no more than ${NARRATION_MAX_SPOKEN_WORDS} spoken words. Aim for ${NARRATION_AUTHORING_TARGET_MIN_SPOKEN_WORDS}-${NARRATION_MAX_SPOKEN_WORDS} spoken words and no more than ${NARRATION_AUTHORING_TARGET_MAX_RAW_CHARACTERS} raw characters so the measured Groq narration normally lands around 7-${NARRATION_TARGET_MAX_AUDIO_SECONDS} seconds and never requires two Agnes clips. ` +
    "Split scenes when a narration paragraph contains multiple visible moments, action changes, emotional turns, time jumps, or too much speech for one clip. Never duplicate or lightly renumber the same narration/action beat to reach the scene or runtime target. " +
    `TOTAL RUNTIME & WORD COUNT DISCIPLINE (CRITICAL): The episode must reach at least ${params.targetRuntimeMinutes} minutes and ${requiredWords} total spoken words across ${params.minScenes}-${params.maxScenes} concise scenes. Add meaningful consecutive visual beats; never lengthen an individual narration beyond the per-scene limits. ` +
    "SPLIT-METADATA PRESERVATION (CRITICAL): When splitting one source scene into consecutive child scenes, preserve its environmentDescription verbatim while the location is unchanged. Preserve each character's exact characterVisuals entry and keep it aligned with characterNames. Copy every supportingEntities descriptor verbatim into each child where that entity remains present or interacting. Copy continuityAnchors verbatim through all children until the narration explicitly changes that visual state; after a state change, create one concrete replacement anchor and carry that exact replacement forward. Divide action and sceneDetails into one clear visible sub-action and emotion per child. Preserve cameraAngle and lighting unless the new visible beat deliberately requires a change. " +
    "Preserve the story, characters, tone, and continuity. Expand by splitting overloaded scenes rather than inventing filler. " +
    "Use full character names. Keep narration warm, vivid, and suitable for ages 2-5. " +
    "CRITICAL CAST DISCIPLINE: characterNames must ONLY contain the main series characters present in that scene. Do NOT invent new character names in characterNames. Any secondary/extra creature or background animal (e.g. baby duck, butterfly, bird) must be placed in supportingEntities (e.g. ['Baby duck: tiny yellow duckling with orange bill']) or described in narrationText/action, never in characterNames. " +
    "WARDROBE & ACCESSORY CONTINUITY (CRITICAL): Characters must strictly maintain their canonical appearance and wardrobe across all scenes. Never describe characters acquiring, wearing, or carrying unapproved clothing, hats, sunhats, dresses, shirts, shoes, bags, satchels, or glasses in narrationText, action, or sceneDetails unless explicitly defined in their canonical character description or introduced as an explicit episodic plot prop. " +
    "SUPPORTING ENTITY CONTINUITY (CRITICAL): When an episode features guest characters, guides, scribes, baby animals, or secondary recurring figures, define them in supportingEntities with locked visual descriptions (e.g. ['Cleo the Scribe: young Egyptian girl with straight black hair, white linen tunic, blue beaded collar, holding a tablet']). Carry that EXACT supportingEntities descriptor forward across EVERY scene where that guest figure appears or interacts with the group. Never drop supportingEntities from intermediate scenes. " +
    "OBJECT CHARACTERS & COMPANIONS (CRITICAL): When an object character (e.g. a living backpack, talking clock, animated toy, companion item) is in the scene, always refer to it consistently by its character name. Avoid ambiguous phrasing that implies both a generic personal possession and a separate character in the same sentence (e.g., write 'Tara zipped up Bobo and gave him a pat' instead of 'Tara zipped up her backpack and gave Bobo a pat') to prevent the video model from creating two separate items in the scene. " +
    "For every scene, include characterVisuals for every character in the same order as characterNames. characterVisuals is mandatory; output [] when characterNames is empty. sceneDetails, cameraAngle, and lighting are also mandatory and non-empty. " +
    "Use visualForm to explicitly define body ontology so the video model does not guess: real_creature, humanoid, anthropomorphic_creature, object_character, or fantasy_creature. " +
    "Use speciesOrType when helpful, such as 'butterfly', 'sparrow', 'little girl', 'talking teapot', or 'dragon'. " +
    "Set humanoidAllowed to false for real animals/insects/birds that must not become humanoid, and true only when a humanoid body plan is intentionally allowed by the story. " +
    "When a prop, layout, setup, or visual state continues across adjacent scenes, use continuityAnchors to carry that continuity explicitly. " +
    "Each continuityAnchors entry must be a short exact visual descriptor that includes concrete appearance details whenever applicable: color, pattern, material, shape, size, placement, and current state/change. " +
    "Good example: 'Picnic setup: red-and-white checkered blanket spread flat on green grass with three round yellow apple slices, two brown cookies, and pale green leaf cups near the top edge.' " +
    "Reuse the exact same continuityAnchors strings across continuing scenes. Only remove or replace an anchor when the narration clearly changes or removes that setup.";

  const canonicalContextText = params.canonicalContext
    ?
      `Canonical episode title (preserve exactly): ${JSON.stringify(params.canonicalContext.episodeTitle)}\n` +
      `Canonical episode premise and story objective (preserve): ${JSON.stringify(params.canonicalContext.episodePremise)}\n` +
      `Canonical character appearance bible (preserve these identities and visual details): ${JSON.stringify(params.canonicalContext.characters)}\n` +
      `Established series environment bible (reuse exact relevant setting details and do not flatten scene-specific action): ${JSON.stringify(params.canonicalContext.environments)}\n`
    : "";

  const baseUserText =
    `Mode: ${params.mode}\n` +
    `Target scene count: ${params.minScenes}-${params.maxScenes}\n` +
    `Target runtime: at least ${params.targetRuntimeMinutes} minutes (minimum ${requiredWords} total spoken words)\n` +
    `Per-scene narration contract: 1-2 sentences, <=${NARRATION_MAX_RAW_CHARACTERS} raw characters, <=${NARRATION_MAX_SPOKEN_WORDS} spoken words, authored for <=${NARRATION_MAX_AUDIO_SECONDS} seconds of measured Groq audio.\n` +
    `Fixed main-character roster (characterNames may contain ONLY these exact names): ${JSON.stringify(params.mainCharacterNames ?? [])}\n` +
    canonicalContextText +
    (params.issues && params.issues.length > 0 ? `Deterministic issues to fix:\n- ${params.issues.join("\n- ")}\n\n` : "") +
    `Current script JSON:\n${JSON.stringify(params.script)}\n\n` +
    `Task: Review this episode and refine it so the final result lands in the target scene range, uses one visual beat and one bounded narration per scene, and preserves the complete story by splitting overloaded scenes into smaller consecutive scenes. ` +
    `Also ensure every scene contains characterVisuals entries aligned 1:1 with characterNames so each character's visual ontology is explicit instead of inferred. ` +
    `For every split, preserve the source environmentDescription, exact characterVisuals entries, supportingEntities descriptors, continuityAnchors, cameraAngle, and lighting according to the split-metadata rules above; rewrite only what must change to express each child's visible sub-action. ` +
    `Also add or preserve continuityAnchors whenever a visual setup should continue across adjacent scenes. Make every continuity anchor concretely drawable by explicitly naming visual attributes like color, pattern, material, shape, placement, and current state when relevant, and ensure recurring guest figures or secondary characters have their supportingEntities descriptor preserved across all scenes where they appear. Return the full updated JSON only.`;

  const raw = await chatText({
    systemPrompt: baseSystemPrompt,
    userText: baseUserText,
  });

  try {
    return {
      script: parseScriptResponse(raw),
      recoveredFromParseFailure: false,
    };
  } catch {
    const repairRaw = await chatText({
      systemPrompt:
        baseSystemPrompt +
        " Your previous response was not valid JSON. Do not explain anything. Do not include markdown fences. Output a single valid JSON object only.",
      userText:
        `${baseUserText}\n\n` +
        `Your previous invalid response was:\n${raw}\n\n` +
        `Now rewrite it as one valid JSON object only.`,
    });

    return {
      script: parseScriptResponse(repairRaw),
      recoveredFromParseFailure: true,
    };
  }
}

function findSurvivingMeasuredSceneIndex(params: {
  sourceScene: EpisodeScene;
  candidate: EpisodeScript;
  claimedCandidateIndexes?: ReadonlySet<number>;
}): number {
  const isAvailable = (index: number): boolean =>
    index >= 0 && !params.claimedCandidateIndexes?.has(index);
  const sourceSignature = sceneContentSignature(params.sourceScene);
  const sameNumberIndex = params.candidate.scenes.findIndex(
    (scene) => scene.sceneNumber === params.sourceScene.sceneNumber,
  );
  if (
    isAvailable(sameNumberIndex)
    && sceneContentSignature(params.candidate.scenes[sameNumberIndex]!) === sourceSignature
  ) return sameNumberIndex;

  const signatureIndex = params.candidate.scenes.findIndex(
    (scene, index) => isAvailable(index) && sceneContentSignature(scene) === sourceSignature,
  );
  if (signatureIndex >= 0) return signatureIndex;

  const sourceNarration = normalizeText(params.sourceScene.narrationText);
  const narrationMatches = params.candidate.scenes
    .map((scene, index) => ({ scene, index }))
    .filter(({ scene, index }) =>
      isAvailable(index) && normalizeText(scene.narrationText) === sourceNarration
    );
  // Narration-only recovery is safe only when it identifies exactly one
  // surviving scene. Repeated lines are common in children's stories; choosing
  // the first duplicate would transfer an already-resolved TTS measurement to
  // an unrelated beat after a split or merge.
  return narrationMatches.length === 1 ? narrationMatches[0]!.index : -1;
}

function durationRepairIssues(
  sourceScript: EpisodeScript,
  candidate: EpisodeScript,
  durationExceededScenes: readonly DurationExceededScene[],
): string[] {
  const issues: string[] = [];
  const claimedCandidateIndexes = new Set<number>();
  for (const exceeded of durationExceededScenes) {
    if (exceeded.durationSeconds <= NARRATION_MAX_AUDIO_SECONDS) continue;
    const sourceScene = sourceScript.scenes.find(
      (scene) => scene.sceneNumber === exceeded.sceneNumber,
    );
    if (!sourceScene) continue;
    // Earlier repairs can insert scenes and renumber every later beat. Prefer
    // the complete beat signature so repeated narration cannot steal another
    // scene's measurement; narration-only matching is a conservative fallback.
    const survivingIndex = findSurvivingMeasuredSceneIndex({
      sourceScene,
      candidate,
      claimedCandidateIndexes,
    });
    if (survivingIndex >= 0) {
      claimedCandidateIndexes.add(survivingIndex);
      const unchangedNarrationScene = candidate.scenes[survivingIndex]!;
      issues.push(
        `Scene ${unchangedNarrationScene.sceneNumber} measured ${exceeded.durationSeconds.toFixed(3)} seconds in Groq audio, above the ` +
        `${NARRATION_MAX_AUDIO_SECONDS}-second Agnes limit. Shorten only that exact narration while preserving ` +
        "its environment, action, cast visuals, supporting entities, continuity anchors, scene details, camera, and lighting unchanged.",
      );
    }
  }
  return issues;
}

function totalNarrationWords(script: EpisodeScript): number {
  return script.scenes.reduce(
    (sum, scene) => sum + countNarrationSpokenWords(scene.narrationText),
    0,
  );
}

function validateRefinementCandidate(params: {
  sourceScript: EpisodeScript;
  candidate: EpisodeScript;
  minScenes: number;
  maxScenes: number;
  targetRuntimeMinutes: number;
  mainCharacterNames?: readonly string[];
  durationExceededScenes?: readonly DurationExceededScene[];
}): ScriptValidationResult {
  const validation = validateEpisodeScript(
    params.candidate,
    params.minScenes,
    params.maxScenes,
    params.targetRuntimeMinutes,
    params.mainCharacterNames,
  );
  const measuredDurationIssues = durationRepairIssues(
    params.sourceScript,
    params.candidate,
    params.durationExceededScenes ?? [],
  );
  return {
    pass: validation.pass && measuredDurationIssues.length === 0,
    issues: [...validation.issues, ...measuredDurationIssues],
  };
}

function validateProductionRefinementCandidate(params: {
  sourceScript: EpisodeScript;
  candidate: EpisodeScript;
  mainCharacterNames: readonly string[];
  durationExceededScenes?: readonly DurationExceededScene[];
}): ScriptValidationResult {
  const local = validateRefinementCandidate({
    ...params,
    minScenes: DEFAULT_PRODUCTION_MIN_SCENES,
    maxScenes: DEFAULT_PRODUCTION_MAX_SCENES,
    targetRuntimeMinutes: 5,
  });
  const authoritative = inspectProductionScript(
    params.candidate,
    params.mainCharacterNames,
  );
  const issues = [...new Set([...local.issues, ...authoritative.issues])];
  return { pass: issues.length === 0, issues };
}

async function runRefinementPipeline(params: {
  sourceScript: EpisodeScript;
  minScenes: number;
  maxScenes: number;
  targetRuntimeMinutes: number;
  mainCharacterNames?: readonly string[];
  canonicalContext?: CanonicalProductionContext;
  durationExceededScenes?: readonly DurationExceededScene[];
}): Promise<RefinementPipelineResult> {
  let refined = params.sourceScript;
  const warnings: string[] = [];

  try {
    const reviewResult = await rewriteScript({
      script: params.sourceScript,
      minScenes: params.minScenes,
      maxScenes: params.maxScenes,
      targetRuntimeMinutes: params.targetRuntimeMinutes,
      mainCharacterNames: params.mainCharacterNames,
      canonicalContext: params.canonicalContext,
      issues: durationRepairIssues(
        params.sourceScript,
        params.sourceScript,
        params.durationExceededScenes ?? [],
      ),
      mode: "review",
    });
    refined = reviewResult.script;
    if (reviewResult.recoveredFromParseFailure) {
      warnings.push("Initial refinement response was invalid JSON and required one strict repair retry.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Script refinement failed; using original drafted script. Cause: ${message}`);
  }

  const validation = validateRefinementCandidate({
    sourceScript: params.sourceScript,
    candidate: refined,
    minScenes: params.minScenes,
    maxScenes: params.maxScenes,
    targetRuntimeMinutes: params.targetRuntimeMinutes,
    mainCharacterNames: params.mainCharacterNames,
    durationExceededScenes: params.durationExceededScenes,
  });
  if (validation.pass) {
    return { script: refined, validation, warnings };
  }

  try {
    refined = await repairTargetedScenes(refined, validation.issues);
    const targetedValidation = validateRefinementCandidate({
      sourceScript: params.sourceScript,
      candidate: refined,
      minScenes: params.minScenes,
      maxScenes: params.maxScenes,
      targetRuntimeMinutes: params.targetRuntimeMinutes,
      mainCharacterNames: params.mainCharacterNames,
      durationExceededScenes: params.durationExceededScenes,
    });
    if (targetedValidation.pass) {
      return { script: refined, validation: targetedValidation, warnings };
    }

    const repairResult = await rewriteScript({
      script: refined,
      minScenes: params.minScenes,
      maxScenes: params.maxScenes,
      targetRuntimeMinutes: params.targetRuntimeMinutes,
      mainCharacterNames: params.mainCharacterNames,
      canonicalContext: params.canonicalContext,
      issues: targetedValidation.issues,
      mode: "repair",
    });
    refined = repairResult.script;
    if (repairResult.recoveredFromParseFailure) {
      warnings.push("Repair refinement response was invalid JSON and required one strict repair retry.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Repair pass failed; keeping last valid script. Cause: ${message}`);
  }

  return {
    script: refined,
    validation: validateRefinementCandidate({
      sourceScript: params.sourceScript,
      candidate: refined,
      minScenes: params.minScenes,
      maxScenes: params.maxScenes,
      targetRuntimeMinutes: params.targetRuntimeMinutes,
      mainCharacterNames: params.mainCharacterNames,
      durationExceededScenes: params.durationExceededScenes,
    }),
    warnings,
  };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sceneContentSignature(scene: EpisodeScene): string {
  return JSON.stringify({
    narrationText: normalizeText(scene.narrationText),
    environmentDescription: normalizeText(scene.environmentDescription),
    action: normalizeText(scene.action),
    sceneDetails: normalizeText(scene.sceneDetails),
  });
}
function compactValidationEnvelope(
  validation: ScriptValidationResult,
  repairEvidence?: PersistedTimingEvidence,
): {
  pass: boolean;
  issues: string[];
  issueCount: number;
  omittedIssueCount: number;
  repairEvidence?: PersistedTimingEvidence;
} {
  const measuredDurationIssues = validation.issues.filter((issue) =>
    /(?:measured .* seconds in Groq audio|Measured total narration was)/u.test(issue)
  );
  const otherIssues = validation.issues.filter((issue) =>
    !/(?:measured .* seconds in Groq audio|Measured total narration was)/u.test(issue)
  );
  const issues = [...measuredDurationIssues, ...otherIssues]
    .slice(0, 12)
    .map((issue) => issue.length <= 256 ? issue : `${issue.slice(0, 253)}...`);
  const boundedDurationEvidence = (repairEvidence?.durationExceededScenes ?? [])
    .filter((scene) =>
      Number.isSafeInteger(scene.sceneNumber)
      && scene.sceneNumber > 0
      && Number.isFinite(scene.durationSeconds)
      && scene.durationSeconds > NARRATION_MAX_AUDIO_SECONDS
      && scene.durationSeconds <= 300
    )
    .slice(0, 60);
  const hasCompleteMeasuredTotal =
    repairEvidence?.measuredTotalNarrationSeconds !== undefined
    && repairEvidence.measuredTotalNarrationSeconds > 0
    && Number.isSafeInteger(repairEvidence.measuredNarrationSceneCount)
    && repairEvidence.measuredNarrationSceneCount! > 0
    && repairEvidence.measuredNarrationSceneCount! <= DEFAULT_PRODUCTION_MAX_SCENES;
  const boundedRepairEvidence = repairEvidence && (
    boundedDurationEvidence.length > 0
    || hasCompleteMeasuredTotal
  )
    ? {
        durationExceededScenes: boundedDurationEvidence,
        ...(hasCompleteMeasuredTotal
          ? {
              measuredTotalNarrationSeconds: repairEvidence.measuredTotalNarrationSeconds,
              measuredNarrationSceneCount: repairEvidence.measuredNarrationSceneCount,
            }
          : {}),
      }
    : undefined;
  return {
    pass: validation.pass,
    issues,
    issueCount: validation.issues.length,
    omittedIssueCount: Math.max(0, validation.issues.length - issues.length),
    ...(boundedRepairEvidence ? { repairEvidence: boundedRepairEvidence } : {}),
  };
}

function compactProductionValidationEnvelope(
  script: EpisodeScript,
  validation: ScriptValidationResult,
  repairEvidence?: PersistedTimingEvidence,
) {
  return {
    ...compactValidationEnvelope(validation, repairEvidence),
    sceneCount: script.scenes.length,
    totalSpokenWords: totalNarrationWords(script),
  };
}

function compactWarnings(warnings: readonly string[]): string[] {
  return warnings.slice(0, 4).map((warning) =>
    warning.length <= 300 ? warning : `${warning.slice(0, 297)}...`
  );
}

function publicValidationReceipt<T extends { repairEvidence?: PersistedTimingEvidence }>(
  validation: T,
): Omit<T, "repairEvidence"> {
  const { repairEvidence: _privateRepairEvidence, ...receipt } = validation;
  return receipt;
}

function durableTimingEvidenceCount(
  validation: { repairEvidence?: PersistedTimingEvidence },
): number {
  const evidence = validation.repairEvidence;
  if (!evidence) return 0;
  return evidence.durationExceededScenes.length
    + (evidence.measuredTotalNarrationSeconds === undefined ? 0 : 1);
}

function durationExceededScenesFromValidation(value: unknown): DurationExceededScene[] {
  if (!isRecord(value)) return [];
  const scenes = new Map<number, DurationExceededScene>();
  const repairEvidence = isRecord(value.repairEvidence) ? value.repairEvidence : undefined;
  if (repairEvidence && Array.isArray(repairEvidence.durationExceededScenes)) {
    for (const entry of repairEvidence.durationExceededScenes) {
      if (!isRecord(entry)) continue;
      const sceneNumber = Number(entry.sceneNumber);
      const durationSeconds = Number(entry.durationSeconds);
      if (!Number.isSafeInteger(sceneNumber) || sceneNumber <= 0) continue;
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300) continue;
      scenes.set(sceneNumber, { sceneNumber, durationSeconds });
    }
  }
  const issues = Array.isArray(value.issues) ? value.issues : [];
  for (const issue of issues) {
    if (typeof issue !== "string") continue;
    const match = issue.match(/^Scene\s+(\d+)\s+measured\s+([\d.]+)\s+seconds in Groq audio/iu);
    if (!match) continue;
    const sceneNumber = Number(match[1]);
    const durationSeconds = Number(match[2]);
    if (!Number.isSafeInteger(sceneNumber) || sceneNumber <= 0) continue;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) continue;
    scenes.set(sceneNumber, { sceneNumber, durationSeconds });
  }
  return [...scenes.values()].slice(0, 60);
}

function measuredTotalNarrationSecondsFromValidation(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const repairEvidence = isRecord(value.repairEvidence) ? value.repairEvidence : undefined;
  const directDuration = repairEvidence?.measuredTotalNarrationSeconds;
  if (
    typeof directDuration === "number"
    && Number.isFinite(directDuration)
    && directDuration > 0
    && directDuration <= 3_600
  ) return directDuration;
  const issues = Array.isArray(value.issues) ? value.issues : [];
  for (const issue of issues) {
    if (typeof issue !== "string") continue;
    const match = issue.match(/^Measured total narration was\s+([\d.]+)\s+seconds/iu);
    if (!match) continue;
    const duration = Number(match[1]);
    if (Number.isFinite(duration) && duration > 0) return duration;
  }
  return undefined;
}

function measuredNarrationSceneCountFromValidation(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const repairEvidence = isRecord(value.repairEvidence) ? value.repairEvidence : undefined;
  const directCount = repairEvidence?.measuredNarrationSceneCount;
  return typeof directCount === "number"
    && Number.isSafeInteger(directCount)
    && directCount > 0
    && directCount <= DEFAULT_PRODUCTION_MAX_SCENES
    ? directCount
    : undefined;
}

function mergeDurationExceededScenes(
  persisted: readonly DurationExceededScene[],
  supplied: readonly DurationExceededScene[],
): DurationExceededScene[] {
  const merged = new Map<number, DurationExceededScene>();
  for (const scene of [...persisted, ...supplied]) {
    merged.set(scene.sceneNumber, scene);
  }
  return [...merged.values()].slice(0, 60);
}

function filterApplicableDurationEvidence(
  script: EpisodeScript,
  evidence: readonly DurationExceededScene[],
): { durationExceededScenes: DurationExceededScene[]; ignoredCount: number } {
  const availableSceneNumbers = new Set(script.scenes.map((scene) => scene.sceneNumber));
  const accepted = new Map<number, DurationExceededScene>();
  let ignoredCount = 0;
  for (const item of evidence) {
    if (
      !availableSceneNumbers.has(item.sceneNumber)
      || item.durationSeconds <= NARRATION_MAX_AUDIO_SECONDS
      || item.durationSeconds > 300
      || !Number.isFinite(item.durationSeconds)
    ) {
      ignoredCount += 1;
      continue;
    }
    accepted.set(item.sceneNumber, item);
  }
  return {
    durationExceededScenes: [...accepted.values()]
      .sort((left, right) => left.sceneNumber - right.sceneNumber)
      .slice(0, 60),
    ignoredCount,
  };
}

const MAX_NARRATION_REPAIRS_PER_INVOCATION = 4;

const measuredNarrationReplacementSchema = z.object({
  sceneNumber: z.number().int().positive(),
  narrationText: z.string().trim().min(1).max(NARRATION_MAX_RAW_CHARACTERS),
}).strict();

type MeasuredNarrationReplacement = z.infer<typeof measuredNarrationReplacementSchema>;

function measuredNarrationTargetWords(
  narrationText: string,
  measuredSeconds: number,
): number {
  const currentWords = countNarrationSpokenWords(narrationText);
  const projected = Math.floor(
    currentWords * (NARRATION_MAX_AUDIO_SECONDS / measuredSeconds) * 0.88,
  );
  return Math.max(1, Math.min(
    currentWords > 1 ? currentWords - 1 : 1,
    NARRATION_MAX_SPOKEN_WORDS,
    projected,
  ));
}

const NARRATION_SEMANTIC_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "had", "has", "he", "her", "his", "in", "is", "it", "of", "on", "or",
  "she", "that", "the", "their", "then", "they", "this", "to", "was",
  "were", "while", "with",
]);

function narrationSemanticTokens(text: string): Set<string> {
  return new Set(
    text
      .replace(/\[[^\]]*\]/gu, " ")
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/gu)
      .filter((token) => token.length >= 2 && !NARRATION_SEMANTIC_STOP_WORDS.has(token)),
  );
}

function narrationHasQuotedSpeech(text: string): boolean {
  return /["“][^"”]+["”]/u.test(text);
}

function assertNarrationMeaningPreserved(
  sourceScene: EpisodeScene,
  replacementText: string,
  targetWords: number,
): void {
  const sourceTokens = narrationSemanticTokens(sourceScene.narrationText);
  const replacementTokens = narrationSemanticTokens(replacementText);
  const overlapCount = [...replacementTokens]
    .filter((token) => sourceTokens.has(token)).length;
  const requiredOverlap = Math.min(3, sourceTokens.size);
  const overlapRatio = replacementTokens.size === 0
    ? 0
    : overlapCount / replacementTokens.size;
  if (overlapCount < requiredOverlap || overlapRatio < 0.6) {
    throw new Error("Narration repair changed too much of the original story meaning.");
  }

  const lockedIdentityTokens = [
    ...sourceScene.characterNames,
    ...(sourceScene.supportingEntities ?? []).map((descriptor) => descriptor.split(":", 1)[0]!),
  ]
    .flatMap((name) => [...narrationSemanticTokens(name)])
    .filter((token) => sourceTokens.has(token));
  if (lockedIdentityTokens.some((token) => !replacementTokens.has(token))) {
    throw new Error("Narration repair removed a named character or supporting entity.");
  }
  if (
    narrationHasQuotedSpeech(sourceScene.narrationText)
    && !narrationHasQuotedSpeech(replacementText)
  ) {
    throw new Error("Narration repair removed quoted dialogue.");
  }

  const minimumReplacementWords = Math.max(1, Math.floor(targetWords * 0.65));
  if (countNarrationSpokenWords(replacementText) < minimumReplacementWords) {
    throw new Error("Narration repair removed too much story detail.");
  }
}

function parseMeasuredNarrationReplacement(params: {
  raw: string;
  sourceScene: EpisodeScene;
  measuredSeconds: number;
}): MeasuredNarrationReplacement {
  const replacement = measuredNarrationReplacementSchema.parse(
    JSON.parse(extractJsonObject(params.raw)),
  );
  if (replacement.sceneNumber !== params.sourceScene.sceneNumber) {
    throw new Error("Narration repair returned a different scene number.");
  }
  const inspection = inspectNarrationText(replacement.narrationText, { production: true });
  if (inspection.issues.length > 0 || countNarrativeBeats(replacement.narrationText) >= 2) {
    throw new Error("Narration repair violated the one-scene narration contract.");
  }
  const sourceWords = countNarrationSpokenWords(params.sourceScene.narrationText);
  const targetWords = measuredNarrationTargetWords(
    params.sourceScene.narrationText,
    params.measuredSeconds,
  );
  const replacementWords = countNarrationSpokenWords(replacement.narrationText);
  const isShorter = sourceWords > 1
    ? replacementWords < sourceWords
    : replacement.narrationText.length < params.sourceScene.narrationText.length;
  if (!isShorter || replacementWords > targetWords) {
    throw new Error("Narration repair did not meet the conservative shortening target.");
  }
  assertNarrationMeaningPreserved(
    params.sourceScene,
    replacement.narrationText,
    targetWords,
  );
  return replacement;
}

async function requestMeasuredNarrationReplacement(params: {
  script: EpisodeScript;
  scene: EpisodeScene;
  measuredSeconds: number;
}): Promise<MeasuredNarrationReplacement> {
  const sceneIndex = params.script.scenes.findIndex(
    (scene) => scene.sceneNumber === params.scene.sceneNumber,
  );
  const previousNarration = sceneIndex > 0
    ? params.script.scenes[sceneIndex - 1]!.narrationText.slice(0, NARRATION_MAX_RAW_CHARACTERS)
    : null;
  const nextNarration = sceneIndex >= 0 && sceneIndex + 1 < params.script.scenes.length
    ? params.script.scenes[sceneIndex + 1]!.narrationText.slice(0, NARRATION_MAX_RAW_CHARACTERS)
    : null;
  const targetWords = measuredNarrationTargetWords(
    params.scene.narrationText,
    params.measuredSeconds,
  );
  const systemPrompt =
    "Shorten exactly one children's-story narration that measured longer than the video limit. " +
    "Return ONLY one JSON object with exactly: {\"sceneNumber\": number, \"narrationText\": string}. " +
    "Preserve the same visible moment, story fact, character names, emotional intent, quoted dialogue, and age-appropriate voice. " +
    "Keep useful vocal expression when it fits, but remove long pauses or expendable wording first. " +
    "Do not add events, characters, props, metadata, markdown, or commentary.";
  const userText = JSON.stringify({
    episodeTitle: params.script.title.slice(0, 160),
    episodePremise: (params.script.premise ?? "").slice(0, 300),
    sceneNumber: params.scene.sceneNumber,
    measuredSeconds: Number(params.measuredSeconds.toFixed(3)),
    maximumSeconds: NARRATION_MAX_AUDIO_SECONDS,
    maximumSpokenWords: targetWords,
    maximumRawCharacters: NARRATION_MAX_RAW_CHARACTERS,
    previousNarration,
    narrationToShorten: params.scene.narrationText,
    nextNarration,
  });
  return chatStructuredNarrationRepair({
    systemPrompt,
    userText,
    parse: (raw) => parseMeasuredNarrationReplacement({
      raw,
      sourceScene: params.scene,
      measuredSeconds: params.measuredSeconds,
    }),
  });
}

function applyMeasuredNarrationReplacement(
  script: EpisodeScript,
  replacement: MeasuredNarrationReplacement,
): EpisodeScript {
  return {
    ...script,
    scenes: script.scenes.map((scene) => scene.sceneNumber === replacement.sceneNumber
      ? { ...scene, narrationText: replacement.narrationText }
      : scene),
  };
}

function parseDraftScriptInput(value: unknown):
  | { success: true; script: EpisodeScript }
  | { success: false; error: z.ZodError } {
  const parsed = draftScriptSchema.safeParse(decodeJsonInput(value));
  if (!parsed.success) return parsed;
  return {
    success: true,
    script: normalizeSceneNumbers(parsed.data as EpisodeScript),
  };
}

function staleDraftReceipt(params: {
  episodeId: number;
  requestedRevision?: number;
  currentDraft: EpisodeScriptDraftRow | null;
}): string {
  const authoringProgress = params.currentDraft
    ? getEpisodeScriptChunkAuthoringProgress(
        params.currentDraft.scriptJson,
        params.currentDraft.validation,
      )
    : null;
  return JSON.stringify({
    status: params.currentDraft ? "stale_draft_revision" : "draft_missing",
    persisted: false,
    retryable: Boolean(params.currentDraft),
    retryThisInvocation: false,
    episodeId: params.episodeId,
    ...(params.requestedRevision === undefined
      ? {}
      : { requestedDraftRevision: params.requestedRevision }),
    ...(params.currentDraft ? { draftRevision: params.currentDraft.revision } : {}),
    ...(authoringProgress?.status === "in_progress" ? { authoringProgress } : {}),
    nextAction: authoringProgress?.status === "in_progress"
      ? "Stop this invocation. On a later fresh run obey resumeAction=script_authoring and append only the exact next range from the durable authoring progress; do not call refinement yet."
      : params.currentDraft
      ? `Stop this invocation. On a later fresh run call refine_episode_script with episodeId=${params.episodeId} and draftRevision=${params.currentDraft.revision}; do not resend scriptJson.`
      : `Stop this invocation. On a later fresh run begin bounded authoring with write_episode_script_chunk operation=start for episodeId=${params.episodeId}.`,
  });
}

async function reviseDurableDraft(params: {
  seriesState: ScriptDraftPersistence;
  episodeId: number;
  expectedRevision: number;
  script: EpisodeScript;
  validation: unknown;
}): Promise<EpisodeScriptDraftRow | string> {
  try {
    return await params.seriesState.reviseEpisodeScriptDraft(
      params.episodeId,
      params.expectedRevision,
      params.script,
      params.validation,
    );
  } catch (error) {
    const currentDraft = await params.seriesState.getEpisodeScriptDraft(params.episodeId);
    if (!currentDraft || currentDraft.revision !== params.expectedRevision) {
      return staleDraftReceipt({
        episodeId: params.episodeId,
        requestedRevision: params.expectedRevision,
        currentDraft,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Agnes submission has started")) {
      return JSON.stringify({
        status: "repair_blocked",
        persisted: false,
        retryable: false,
        retryThisInvocation: false,
        episodeId: params.episodeId,
        draftRevision: currentDraft.revision,
        message: message.length <= 300 ? message : `${message.slice(0, 297)}...`,
        nextAction:
          "Do not replace the script or draft after Agnes has started; resume verification/download for the existing submitted generation instead.",
      });
    }
    throw error;
  }
}

type EpisodeScriptChunkInput = z.infer<typeof episodeScriptChunkInputSchema>;

function canonicalComparableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

function chunkValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalComparableJson(left) === canonicalComparableJson(right);
}

function scriptChunkOperationIssues(input: EpisodeScriptChunkInput): string[] {
  if (input.operation === "start") {
    return [
      ...(input.expectedDraftRevision === undefined
        ? []
        : ["expectedDraftRevision is forbidden for operation=start."]),
      ...(input.targetSceneCount === undefined
        ? ["targetSceneCount is required for operation=start."]
        : []),
      ...(input.authoringPlan === undefined
        ? ["authoringPlan is required for operation=start."]
        : []),
    ];
  }
  if (input.operation === "append") {
    return [
      ...(input.expectedDraftRevision === undefined
        ? ["expectedDraftRevision is required for operation=append."]
        : []),
    ];
  }
  return [
    ...(input.expectedDraftRevision === undefined
      ? ["expectedDraftRevision is required for operation=restart."]
      : []),
    ...(input.targetSceneCount === undefined
      ? ["targetSceneCount is required for operation=restart."]
      : []),
    ...(input.authoringPlan === undefined
      ? ["authoringPlan is required for operation=restart."]
      : []),
  ];
}

function compactChunkInputFailure(params: {
  episodeId?: number;
  status?: string;
  issues: readonly string[];
  invalidPaths?: readonly string[];
  omittedIssueCount?: number;
  nextAction?: string;
}): string {
  const issues = params.issues.slice(0, 8).map((issue) =>
    issue.length <= 256 ? issue : `${issue.slice(0, 253)}...`
  );
  return JSON.stringify({
    status: params.status ?? "invalid_input",
    persisted: false,
    retryable: true,
    retryThisInvocation: false,
    ...(params.episodeId === undefined ? {} : { episodeId: params.episodeId }),
    validation: {
      pass: false,
      issues,
      ...(params.invalidPaths === undefined ? {} : { invalidPaths: params.invalidPaths }),
      omittedIssueCount: params.omittedIssueCount
        ?? Math.max(0, params.issues.length - issues.length),
    },
    nextAction: params.nextAction
      ?? "Start a fresh run, reload the durable authoring progress, and send only the exact requested scene range.",
  });
}

function scriptChunkTargetSerializedCharacters(
  operation: EpisodeScriptChunkInput["operation"],
): number {
  return operation === "append"
    ? EPISODE_SCRIPT_CHUNK_APPEND_TARGET_SERIALIZED_CHARACTERS
    : EPISODE_SCRIPT_CHUNK_START_TARGET_SERIALIZED_CHARACTERS;
}

/**
 * Exact redundant append metadata is safe to omit from the content budget only
 * after redundantAppendImmutableIssues has compared it with durable state. The
 * separate raw transport ceiling still bounds what the provider may send.
 */
function canonicalScriptChunkBudgetInput(input: EpisodeScriptChunkInput): unknown {
  if (input.operation !== "append") return input;
  return {
    operation: input.operation,
    episodeId: input.episodeId,
    expectedDraftRevision: input.expectedDraftRevision,
    scenes: input.scenes,
  };
}

function oversizedScriptChunkReceipt(params: {
  operation: EpisodeScriptChunkInput["operation"];
  episodeId: number;
  expectedDraftRevision?: number;
  targetSceneCount: number;
  startScene: number;
  endScene: number;
  canonicalSerializedCharacters: number;
  rawTransportSerializedCharacters: number;
  correctionRetryNumber: number;
  retryThisInvocation: boolean;
  durablePrefixPreserved: boolean;
}): string {
  const targetCharacters = scriptChunkTargetSerializedCharacters(params.operation);
  const overHardLimitByCharacters =
    params.canonicalSerializedCharacters - EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS;
  const correctionInstruction =
    `Shorten repeated prose to the advertised per-field TARGET budgets and keep the whole call at or below ` +
    `${targetCharacters} serialized characters, leaving at least ` +
    `${EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS - targetCharacters} characters of hard-limit headroom. ` +
    "Keep every required scene field and all concrete identity, action, environment, continuity, camera, and lighting facts.";

  let invocationAction: string;
  if (params.operation === "append") {
    invocationAction =
      `call write_episode_script_chunk with operation=append, episodeId=${params.episodeId}, ` +
      `expectedDraftRevision=${params.expectedDraftRevision}, and exactly scenes ` +
      `${params.startScene}-${params.endScene}. Omit targetSceneCount and authoringPlan. ` +
      correctionInstruction;
  } else if (params.operation === "start") {
    invocationAction =
      `call write_episode_script_chunk with operation=start, episodeId=${params.episodeId}, ` +
      `targetSceneCount=${params.targetSceneCount}, the same complete authoringPlan, and exactly scenes ` +
      `${params.startScene}-${params.endScene}. ${correctionInstruction}`;
  } else {
    invocationAction =
      `call write_episode_script_chunk with operation=restart, episodeId=${params.episodeId}, ` +
      `expectedDraftRevision=${params.expectedDraftRevision}, targetSceneCount=${params.targetSceneCount}, ` +
      `the same complete authoringPlan, and exactly scenes ${params.startScene}-${params.endScene}. ` +
      correctionInstruction;
  }

  return JSON.stringify({
    status: "script_chunk_too_large",
    persisted: false,
    scenePrefixPreserved: params.durablePrefixPreserved,
    retryable: true,
    retryThisInvocation: params.retryThisInvocation,
    noProgress: true,
    episodeId: params.episodeId,
    ...(params.expectedDraftRevision === undefined
      ? {}
      : { draftRevision: params.expectedDraftRevision }),
    operation: params.operation,
    requestedSceneRange: {
      startScene: params.startScene,
      endScene: params.endScene,
    },
    canonicalSerializedCharacters: params.canonicalSerializedCharacters,
    rawTransportSerializedCharacters: params.rawTransportSerializedCharacters,
    hardMaximumSerializedCharacters: EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS,
    targetSerializedCharacters: targetCharacters,
    overHardLimitByCharacters,
    correctionRetryNumber: params.correctionRetryNumber,
    correctionRetryLimit: EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
    validation: {
      pass: false,
      issues: [
        `This ${params.operation} chunk has ${params.canonicalSerializedCharacters} canonical serialized characters, ` +
        `${overHardLimitByCharacters} above the hard maximum of ` +
        `${EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS}. Target at most ${targetCharacters} on correction.`,
      ],
      omittedIssueCount: 0,
    },
    nextAction: params.retryThisInvocation
      ? `Immediately ${invocationAction}`
      : `Start a fresh run and ${invocationAction}`,
  });
}

function inputScenesAreInternallySequential(scenes: readonly EpisodeScene[]): boolean {
  const first = scenes[0]?.sceneNumber;
  return first !== undefined
    && scenes.every((scene, index) => scene.sceneNumber === first + index);
}

function storedScenesContainIdenticalChunk(
  storedScenes: readonly EpisodeScene[],
  submittedScenes: readonly EpisodeScene[],
): boolean {
  if (!inputScenesAreInternallySequential(submittedScenes)) return false;
  return submittedScenes.every((scene) => {
    const stored = storedScenes[scene.sceneNumber - 1];
    return stored !== undefined && chunkValuesEqual(stored, scene);
  });
}

function redundantAppendImmutableIssues(
  input: EpisodeScriptChunkInput,
  envelope: EpisodeScriptChunkDraftEnvelope,
): { issues: string[]; invalidPaths: string[] } {
  if (input.operation !== "append") return { issues: [], invalidPaths: [] };

  const issues: string[] = [];
  const invalidPaths: string[] = [];
  if (
    input.targetSceneCount !== undefined
    && input.targetSceneCount !== envelope.authoring.targetSceneCount
  ) {
    issues.push(
      `targetSceneCount is immutable for operation=append: submitted ${input.targetSceneCount}, ` +
      `but the durable draft requires ${envelope.authoring.targetSceneCount}. Omit targetSceneCount on append.`,
    );
    invalidPaths.push("targetSceneCount");
  }
  if (
    input.authoringPlan !== undefined
    && !chunkValuesEqual(input.authoringPlan, envelope.authoring.plan)
  ) {
    issues.push(
      "authoringPlan is immutable for operation=append and does not exactly match the durable draft. " +
      "Omit authoringPlan on append.",
    );
    invalidPaths.push("authoringPlan");
  }
  return { issues, invalidPaths };
}

function expectedScriptChunkRange(completed: number, target: number): {
  startScene: number;
  endScene: number;
  sceneCount: number;
} {
  const startScene = completed + 1;
  const endScene = Math.min(target, completed + EPISODE_SCRIPT_SCENES_PER_CHUNK);
  return { startScene, endScene, sceneCount: Math.max(0, endScene - startScene + 1) };
}

function exactChunkRangeIssues(params: {
  completed: number;
  target: number;
  scenes: readonly EpisodeScene[];
}): string[] {
  const expected = expectedScriptChunkRange(params.completed, params.target);
  const issues: string[] = [];
  if (params.scenes.length !== expected.sceneCount) {
    issues.push(
      `This write must contain exactly ${expected.sceneCount} scenes for range ` +
      `${expected.startScene}-${expected.endScene}.`,
    );
  }
  params.scenes.forEach((scene, index) => {
    const expectedNumber = expected.startScene + index;
    if (scene.sceneNumber !== expectedNumber) {
      issues.push(
        `scenes[${index}].sceneNumber must be ${expectedNumber}; received ${scene.sceneNumber}.`,
      );
    }
  });
  return issues;
}

function isDeferredPartialAuthoritativeIssue(issue: string): boolean {
  return /^Scene count \d+ is below the production minimum of \d+\.$/u.test(issue)
    || /^Episode narration has \d+ spoken words; at least \d+ are required /u.test(issue);
}

/**
 * Applies every production scene and cross-scene rule to the accumulated
 * prefix. Only the not-yet-possible minimum scene/word totals are deferred.
 */
function validateEpisodeScriptChunkPrefix(params: {
  script: EpisodeScript;
  targetSceneCount: number;
  mainCharacterNames: readonly string[];
}): ScriptValidationResult {
  const local = validateEpisodeScript(
    params.script,
    0,
    params.targetSceneCount,
    5,
    params.mainCharacterNames,
    { productionSceneContract: true, deferAggregateMinimums: true },
  );
  const authoritative = inspectProductionScript(
    params.script,
    params.mainCharacterNames,
  );
  const issues = [
    ...local.issues,
    ...authoritative.issues.filter((issue) => !isDeferredPartialAuthoritativeIssue(issue)),
  ];
  const totalWords = params.script.scenes.reduce(
    (total, scene) => total + countNarrationSpokenWords(scene.narrationText),
    0,
  );
  const remainingScenes = params.targetSceneCount - params.script.scenes.length;
  const minimumWords = minimumNarrationWords(5);
  const maximumReachableWords = totalWords + remainingScenes * NARRATION_MAX_SPOKEN_WORDS;
  if (maximumReachableWords < minimumWords) {
    issues.push(
      `The accepted prefix plus ${remainingScenes} remaining scenes can reach at most ` +
      `${maximumReachableWords} spoken words; at least ${minimumWords} are required. ` +
      "Rewrite this chunk with more meaningful narration while keeping every scene within its cap.",
    );
  }
  const uniqueIssues = [...new Set(issues)];
  return { pass: uniqueIssues.length === 0, issues: uniqueIssues };
}

function normalCompletedChunkScript(value: unknown): EpisodeScript | null {
  const parsed = completedChunkScriptSchema.safeParse(decodeJsonInput(value));
  return parsed.success ? parsed.data as EpisodeScript : null;
}

function chunkProgressReceipt(
  draft: EpisodeScriptDraftRow,
): EpisodeScriptChunkAuthoringProgress | null {
  return getEpisodeScriptChunkAuthoringProgress(draft.scriptJson, draft.validation);
}

/**
 * A same-invocation correction already has the submitted range and immutable
 * authoring plan in conversation history. Returning them again bloats context
 * and encourages some providers to echo forbidden append metadata. Fresh-run
 * receipts continue to use the complete durable progress view.
 */
function immediateChunkCorrectionProgress(
  draft: EpisodeScriptDraftRow,
): Pick<
  EpisodeScriptChunkAuthoringProgress,
  | "completedSceneCount"
  | "nextSceneNumber"
  | "nextSceneEnd"
  | "totalSpokenWords"
  | "remainingMinimumSpokenWords"
  | "requiredAverageWordsPerRemainingScene"
> | null {
  const progress = chunkProgressReceipt(draft);
  if (!progress) return null;
  return {
    completedSceneCount: progress.completedSceneCount,
    nextSceneNumber: progress.nextSceneNumber,
    nextSceneEnd: progress.nextSceneEnd,
    totalSpokenWords: progress.totalSpokenWords,
    remainingMinimumSpokenWords: progress.remainingMinimumSpokenWords,
    requiredAverageWordsPerRemainingScene: progress.requiredAverageWordsPerRemainingScene,
  };
}

function scriptChunkAlreadyPresentReceipt(params: {
  episodeId: number;
  draft: EpisodeScriptDraftRow;
  complete: boolean;
}): string {
  const progress = chunkProgressReceipt(params.draft);
  return JSON.stringify({
    status: "script_chunk_already_present",
    persisted: true,
    retryable: true,
    retryThisInvocation: false,
    noProgress: true,
    episodeId: params.episodeId,
    draftRevision: params.draft.revision,
    contentDigest: params.draft.contentDigest,
    ...(params.complete
      ? { scriptComplete: true }
      : { authoringProgress: progress }),
    nextAction: params.complete
      ? `On the next fresh run call refine_episode_script with episodeId=${params.episodeId} and draftRevision=${params.draft.revision}.`
      : "The chunk was already durable. Start a fresh run and continue from get_next_episode's exact next range.",
  });
}

function staleScriptChunkReceipt(params: {
  episodeId: number;
  requestedRevision?: number;
  currentDraft: EpisodeScriptDraftRow | null;
}): string {
  return JSON.stringify({
    status: params.currentDraft ? "stale_draft_revision" : "draft_missing",
    persisted: false,
    retryable: Boolean(params.currentDraft),
    retryThisInvocation: false,
    noProgress: true,
    episodeId: params.episodeId,
    ...(params.requestedRevision === undefined
      ? {}
      : { requestedDraftRevision: params.requestedRevision }),
    ...(params.currentDraft
      ? {
          draftRevision: params.currentDraft.revision,
          contentDigest: params.currentDraft.contentDigest,
          authoringProgress: chunkProgressReceipt(params.currentDraft),
        }
      : {}),
    nextAction: "Start a fresh run and reload the authoritative draft revision with get_next_episode.",
  });
}

function draftHasDurableOverlongNarration(draft: EpisodeScriptDraftRow): boolean {
  if (!isRecord(draft.validation)) return false;
  const evidence = isRecord(draft.validation.repairEvidence)
    ? draft.validation.repairEvidence
    : null;
  return Boolean(evidence)
    && Array.isArray(evidence!.durationExceededScenes)
    && evidence!.durationExceededScenes.length > 0;
}

async function persistRejectedChunkPrefix(params: {
  seriesState: ScriptDraftPersistence;
  episodeId: number;
  currentDraft: EpisodeScriptDraftRow | null;
  envelope: EpisodeScriptChunkDraftEnvelope;
  validation: ScriptValidationResult;
}): Promise<EpisodeScriptDraftRow | null> {
  const persistedValidation = compactProductionValidationEnvelope(
    {
      title: params.envelope.title,
      premise: params.envelope.premise,
      scenes: params.envelope.scenes as EpisodeScene[],
    },
    params.validation,
  );
  if (params.currentDraft) {
    return params.seriesState.reviseEpisodeScriptDraft(
      params.episodeId,
      params.currentDraft.revision,
      params.envelope,
      persistedValidation,
    );
  }
  const staged = await params.seriesState.stageEpisodeScriptDraft(
    params.episodeId,
    params.envelope,
    persistedValidation,
  );
  return staged.matches ? staged.draft : null;
}

/**
 * Bounded, resumable episode authoring. The model submits at most eight full
 * scenes per call; the tool merges them with the private Turso prefix. The
 * final write removes the authoring marker so the existing deterministic
 * refine/promotion tool receives an ordinary complete EpisodeScript.
 */
export function buildEpisodeScriptChunkTool(
  seriesState: ScriptDraftPersistence,
): DynamicStructuredTool {
  const guardedSchema = episodeScriptChunkInputSchema.catch(({ error, input }) =>
    recoverScriptChunkInput(input, error) as unknown as EpisodeScriptChunkInput
  );
  // This state is intentionally scoped to one tool instance, which is one
  // production agent invocation. A fresh run starts with a fresh budget while
  // durable draft revision/CAS state remains the source of truth.
  const correctionRetriesByRange = new Map<string, number>();
  const oversizeCorrectionRetriesByRange = new Map<string, number>();

  return new DynamicStructuredTool({
    name: "write_episode_script_chunk",
    description:
      `Durably writes exactly the next ${EPISODE_SCRIPT_SCENES_PER_CHUNK} complete episode scenes ` +
      "(or the shorter final range) without transporting the full script. Use operation=start once with " +
      "targetSceneCount and authoringPlan; for operation=append, send the exact latest draft revision and " +
      "omit targetSceneCount and authoringPlan; or use " +
      "operation=restart only for a deterministically rejected complete draft. Wait for each receipt before " +
      "the next call; never issue chunk writes in parallel. When a persisted semantic rejection says " +
      "retryThisInvocation=true, immediately correct only its exact range using the returned revision; this " +
      "in-run correction path is bounded to three retries. Keep each scene near 2000 serialized characters, " +
      `each append call at or below the TARGET ${EPISODE_SCRIPT_CHUNK_APPEND_TARGET_SERIALIZED_CHARACTERS}, ` +
      `and each start/restart call at or below the TARGET ${EPISODE_SCRIPT_CHUNK_START_TARGET_SERIALIZED_CHARACTERS}; ` +
      `the hard content maximum is ${EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS}. ` +
      "Use the advertised per-field TARGET budgets: concise concrete facts, not repeated prose. Every scene field is required and preserved.",
    schema: guardedSchema,
    func: async (rawInput) => {
      if (isInvalidScriptChunkInput(rawInput)) {
        return compactChunkInputFailure({
          episodeId: rawInput.episodeId,
          issues: rawInput.issues.length > 0
            ? rawInput.issues
            : ["The chunk call must match the advertised object schema and include complete scene objects."],
          invalidPaths: rawInput.invalidPaths,
          omittedIssueCount: rawInput.omittedIssueCount,
        });
      }
      const input = rawInput as EpisodeScriptChunkInput;
      const rawTransportSerializedCharacters = JSON.stringify(input).length;
      const operationIssues = scriptChunkOperationIssues(input);
      if (
        input.operation !== "append"
        && input.authoringPlan
        && input.targetSceneCount !== undefined
      ) {
        operationIssues.push(...validateAuthoringPlanCoverage(
          input.authoringPlan,
          input.targetSceneCount,
        ));
      }
      if (!inputScenesAreInternallySequential(input.scenes as EpisodeScene[])) {
        operationIssues.push("Submitted scenes must have contiguous ascending sceneNumber values.");
      }
      if (rawTransportSerializedCharacters > EPISODE_SCRIPT_CHUNK_MAX_RAW_TRANSPORT_CHARACTERS) {
        operationIssues.push(
          `One raw chunk transport must be at most ${EPISODE_SCRIPT_CHUNK_MAX_RAW_TRANSPORT_CHARACTERS} ` +
          "serialized characters for memory safety.",
        );
      }
      if (operationIssues.length > 0) {
        return compactChunkInputFailure({
          episodeId: input.episodeId,
          issues: operationIssues,
        });
      }

      const episode = await seriesState.getEpisodeById(input.episodeId);
      if (!episode) {
        return JSON.stringify({
          status: "episode_missing",
          persisted: false,
          retryable: false,
          retryThisInvocation: false,
          noProgress: true,
          episodeId: input.episodeId,
          nextAction: "Start a fresh run and reload the ready episode with get_next_episode.",
        });
      }

      let currentDraft = await seriesState.getEpisodeScriptDraft(input.episodeId);
      let currentEnvelope = currentDraft
        ? parseEpisodeScriptChunkDraftEnvelope(currentDraft.scriptJson)
        : null;
      const currentCompleteScript = currentDraft
        ? normalCompletedChunkScript(currentDraft.scriptJson)
        : null;
      const submittedScenes = input.scenes as EpisodeScene[];

      // Some tool-call providers echo immutable start metadata while applying
      // an append correction. Tolerate that transport quirk only when both
      // supplied values exactly match the durable envelope. The durable values
      // remain authoritative and the redundant input is never persisted.
      if (input.operation === "append" && currentEnvelope) {
        const immutable = redundantAppendImmutableIssues(input, currentEnvelope);
        if (immutable.issues.length > 0) {
          const nextSceneNumber = currentEnvelope.scenes.length + 1;
          const nextSceneEnd = Math.min(
            currentEnvelope.authoring.targetSceneCount,
            currentEnvelope.scenes.length + EPISODE_SCRIPT_SCENES_PER_CHUNK,
          );
          return compactChunkInputFailure({
            episodeId: input.episodeId,
            status: "invalid_script_chunk",
            issues: immutable.issues,
            invalidPaths: immutable.invalidPaths,
            nextAction:
              `Start a fresh run, reload durable draft revision ${currentDraft!.revision}, and call ` +
              `write_episode_script_chunk with operation=append, episodeId=${input.episodeId}, ` +
              `expectedDraftRevision=${currentDraft!.revision}, and exactly scenes ` +
              `${nextSceneNumber}-${nextSceneEnd}. Omit targetSceneCount and authoringPlan.`,
          });
        }
      }

      // Lost-response retries are accepted before checking the caller's now-
      // stale revision. No retry can overwrite or duplicate an accepted scene.
      if (currentEnvelope && storedScenesContainIdenticalChunk(
        currentEnvelope.scenes as EpisodeScene[],
        submittedScenes,
      )) {
        const planMatches = input.operation === "append" || (
          input.targetSceneCount === currentEnvelope.authoring.targetSceneCount
          && chunkValuesEqual(input.authoringPlan, currentEnvelope.authoring.plan)
        );
        if (planMatches) {
          return scriptChunkAlreadyPresentReceipt({
            episodeId: input.episodeId,
            draft: currentDraft!,
            complete: false,
          });
        }
      }
      if (
        currentCompleteScript
        && input.operation === "append"
        && storedScenesContainIdenticalChunk(currentCompleteScript.scenes, submittedScenes)
      ) {
        return scriptChunkAlreadyPresentReceipt({
          episodeId: input.episodeId,
          draft: currentDraft!,
          complete: true,
        });
      }

      let baseEnvelope: EpisodeScriptChunkDraftEnvelope;
      let writeKind: "stage" | "revise";
      let writeExpectedRevision: number | undefined;

      if (input.operation === "start") {
        if (currentDraft) {
          const canResumeEmptyStart = currentEnvelope
            && currentEnvelope.scenes.length === 0
            && input.targetSceneCount === currentEnvelope.authoring.targetSceneCount
            && chunkValuesEqual(input.authoringPlan, currentEnvelope.authoring.plan);
          if (!canResumeEmptyStart) {
            return JSON.stringify({
              status: "draft_conflict",
              persisted: false,
              retryable: true,
              retryThisInvocation: false,
              noProgress: true,
              episodeId: input.episodeId,
              draftRevision: currentDraft.revision,
              authoringProgress: chunkProgressReceipt(currentDraft),
              nextAction: "A durable draft already exists. Start a fresh run and obey get_next_episode.",
            });
          }
          writeKind = "revise";
          writeExpectedRevision = currentDraft.revision;
          baseEnvelope = currentEnvelope!;
        } else {
          if (episode.scriptJson != null) {
            return JSON.stringify({
              status: "script_already_persisted",
              persisted: false,
              retryable: false,
              retryThisInvocation: false,
              noProgress: true,
              episodeId: input.episodeId,
              nextAction: "Do not start authoring again; resume the persisted production script.",
            });
          }
          writeKind = "stage";
          baseEnvelope = {
            title: episode.title,
            premise: episode.premise,
            scenes: [],
            authoring: {
              protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
              targetSceneCount: input.targetSceneCount!,
              plan: input.authoringPlan!,
            },
          };
        }
      } else if (input.operation === "append") {
        if (!currentDraft) {
          return staleScriptChunkReceipt({
            episodeId: input.episodeId,
            requestedRevision: input.expectedDraftRevision,
            currentDraft: null,
          });
        }
        if (!currentEnvelope) {
          return JSON.stringify({
            status: currentCompleteScript ? "script_draft_complete" : "draft_not_chunked",
            persisted: false,
            retryable: Boolean(currentCompleteScript),
            retryThisInvocation: false,
            noProgress: true,
            episodeId: input.episodeId,
            draftRevision: currentDraft.revision,
            nextAction: currentCompleteScript
              ? `On the next fresh run call refine_episode_script with episodeId=${input.episodeId} and draftRevision=${currentDraft.revision}.`
              : "The durable draft is not a valid chunk envelope; start a fresh run and obey its repair receipt.",
          });
        }
        if (currentDraft.revision !== input.expectedDraftRevision) {
          return staleScriptChunkReceipt({
            episodeId: input.episodeId,
            requestedRevision: input.expectedDraftRevision,
            currentDraft,
          });
        }
        writeKind = "revise";
        writeExpectedRevision = currentDraft.revision;
        baseEnvelope = currentEnvelope;
      } else {
        if (!currentDraft || currentDraft.revision !== input.expectedDraftRevision) {
          return staleScriptChunkReceipt({
            episodeId: input.episodeId,
            requestedRevision: input.expectedDraftRevision,
            currentDraft,
          });
        }
        if (currentEnvelope) {
          return JSON.stringify({
            status: "restart_blocked",
            persisted: false,
            retryable: true,
            retryThisInvocation: false,
            noProgress: true,
            episodeId: input.episodeId,
            draftRevision: currentDraft.revision,
            authoringProgress: chunkProgressReceipt(currentDraft),
            nextAction: "This draft is already being assembled in chunks; append its exact next range instead.",
          });
        }
        if (
          !isRecord(currentDraft.validation)
          || currentDraft.validation.pass !== false
          || draftHasDurableOverlongNarration(currentDraft)
        ) {
          return JSON.stringify({
            status: "restart_blocked",
            persisted: false,
            retryable: false,
            retryThisInvocation: false,
            noProgress: true,
            episodeId: input.episodeId,
            draftRevision: currentDraft.revision,
            nextAction:
              "Restart is allowed only for a deterministically rejected complete draft without pending narration-only timing repair.",
          });
        }
        writeKind = "revise";
        writeExpectedRevision = currentDraft.revision;
        baseEnvelope = {
          title: episode.title,
          premise: episode.premise,
          scenes: [],
          authoring: {
            protocol: EPISODE_SCRIPT_CHUNK_PROTOCOL,
            targetSceneCount: input.targetSceneCount!,
            plan: input.authoringPlan!,
          },
        };
      }

      const targetSceneCount = baseEnvelope.authoring.targetSceneCount;
      const expectedRangeStart = baseEnvelope.scenes.length + 1;
      const expectedRangeEnd = Math.min(
        targetSceneCount,
        baseEnvelope.scenes.length + EPISODE_SCRIPT_SCENES_PER_CHUNK,
      );
      const correctionRangeKey = `${input.episodeId}:${expectedRangeStart}-${expectedRangeEnd}`;
      const oversizeCorrectionRangeKey =
        `${input.episodeId}:${input.operation}:${expectedRangeStart}-${expectedRangeEnd}`;
      const rangeIssues = exactChunkRangeIssues({
        completed: baseEnvelope.scenes.length,
        target: targetSceneCount,
        scenes: submittedScenes,
      });
      if (rangeIssues.length > 0) {
        return compactChunkInputFailure({
          episodeId: input.episodeId,
          status: "invalid_script_chunk",
          issues: rangeIssues,
        });
      }

      const canonicalSerializedCharacters = JSON.stringify(
        canonicalScriptChunkBudgetInput(input),
      ).length;
      if (
        canonicalSerializedCharacters > EPISODE_SCRIPT_CHUNK_MAX_SERIALIZED_CHARACTERS
      ) {
        const correctionRetryNumber =
          (oversizeCorrectionRetriesByRange.get(oversizeCorrectionRangeKey) ?? 0) + 1;
        const retryThisInvocation =
          correctionRetryNumber <= EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES;
        oversizeCorrectionRetriesByRange.set(
          oversizeCorrectionRangeKey,
          correctionRetryNumber,
        );
        return oversizedScriptChunkReceipt({
          operation: input.operation,
          episodeId: input.episodeId,
          expectedDraftRevision: input.expectedDraftRevision,
          targetSceneCount,
          startScene: expectedRangeStart,
          endScene: expectedRangeEnd,
          canonicalSerializedCharacters,
          rawTransportSerializedCharacters,
          correctionRetryNumber,
          retryThisInvocation,
          durablePrefixPreserved: Boolean(currentDraft),
        });
      }

      const candidate: EpisodeScript = {
        title: episode.title,
        premise: episode.premise,
        scenes: [...baseEnvelope.scenes, ...submittedScenes] as EpisodeScene[],
      };
      const characters = await seriesState.getSeriesCharacters(episode.seriesId);
      const mainCharacterNames = characters.map((character) => character.name);
      const isComplete = candidate.scenes.length === targetSceneCount;
      const validation = isComplete
        ? validateProductionRefinementCandidate({
            sourceScript: candidate,
            candidate,
            mainCharacterNames,
            durationExceededScenes: [],
          })
        : validateEpisodeScriptChunkPrefix({
            script: candidate,
            targetSceneCount,
            mainCharacterNames,
          });

      if (!validation.pass) {
        let durablePrefix: EpisodeScriptDraftRow | null = currentEnvelope ? currentDraft : null;
        // Keep a valid existing full draft intact when a restart's first chunk
        // is bad. For start/append, retain the immutable plan and accepted scene
        // prefix plus a bounded error receipt for an immediate correction or,
        // after the local retry budget is exhausted, the next fresh invocation.
        if (input.operation !== "restart") {
          try {
            durablePrefix = await persistRejectedChunkPrefix({
              seriesState,
              episodeId: input.episodeId,
              currentDraft: currentEnvelope ? currentDraft : null,
              envelope: baseEnvelope,
              validation,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("revision conflict")) {
              return staleScriptChunkReceipt({
                episodeId: input.episodeId,
                requestedRevision: writeExpectedRevision,
                currentDraft: await seriesState.getEpisodeScriptDraft(input.episodeId),
              });
            }
            if (message.includes("Agnes submission has started")) {
              return JSON.stringify({
                status: "script_chunk_write_blocked",
                persisted: false,
                retryable: false,
                retryThisInvocation: false,
                noProgress: true,
                episodeId: input.episodeId,
                nextAction: "Resume the accepted Agnes work; never change this script.",
              });
            }
            throw error;
          }
        }
        const correctionRetryNumber = durablePrefix
          ? (correctionRetriesByRange.get(correctionRangeKey) ?? 0) + 1
          : 0;
        const retryThisInvocation = Boolean(durablePrefix)
          && correctionRetryNumber <= EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES;
        if (durablePrefix) {
          correctionRetriesByRange.set(correctionRangeKey, correctionRetryNumber);
        }
        const authoringProgress = durablePrefix
          ? retryThisInvocation
            ? immediateChunkCorrectionProgress(durablePrefix)
            : chunkProgressReceipt(durablePrefix)
          : null;
        let nextAction: string;
        if (retryThisInvocation) {
          nextAction =
            `Immediately call write_episode_script_chunk with operation=append, episodeId=${input.episodeId}, ` +
            `expectedDraftRevision=${durablePrefix!.revision}, and exactly scenes ` +
            `${expectedRangeStart}-${expectedRangeEnd}. Correct only the listed validation issues while ` +
            "preserving every already-valid field. Omit targetSceneCount and authoringPlan.";
        } else if (input.operation === "restart") {
          nextAction =
            "Start a fresh run and call write_episode_script_chunk with operation=restart, " +
            `episodeId=${input.episodeId}, expectedDraftRevision=${currentDraft!.revision}, ` +
            `targetSceneCount=${targetSceneCount}, the same authoringPlan, and exactly scenes ` +
            `${expectedRangeStart}-${expectedRangeEnd}. Correct only the listed validation issues; ` +
            "the rejected complete draft remains unchanged.";
        } else if (durablePrefix) {
          nextAction =
            `Start a fresh run and reload durable draft revision ${durablePrefix.revision}; then call ` +
            `write_episode_script_chunk with operation=append, episodeId=${input.episodeId}, ` +
            `expectedDraftRevision=${durablePrefix.revision}, and exactly scenes ` +
            `${expectedRangeStart}-${expectedRangeEnd} while preserving every already-valid field. ` +
            "Omit targetSceneCount and authoringPlan.";
        } else {
          nextAction =
            "Start a fresh run and rewrite only the rejected exact scene range from durable authoring progress.";
        }
        return JSON.stringify({
          status: "invalid_script_chunk",
          persisted: Boolean(durablePrefix),
          scenePrefixPreserved: true,
          retryable: true,
          retryThisInvocation,
          noProgress: true,
          episodeId: input.episodeId,
          ...(durablePrefix
            ? {
                draftRevision: durablePrefix.revision,
                contentDigest: durablePrefix.contentDigest,
                authoringProgress,
                correctionRetryNumber,
                correctionRetryLimit: EPISODE_SCRIPT_CHUNK_MAX_IN_RUN_CORRECTION_RETRIES,
              }
            : input.operation === "restart" && currentDraft
              ? {
                  draftRevision: currentDraft.revision,
                  contentDigest: currentDraft.contentDigest,
                  restartPlan: {
                    targetSceneCount,
                    authoringPlan: input.authoringPlan,
                    nextSceneNumber: expectedRangeStart,
                    nextSceneEnd: expectedRangeEnd,
                  },
                }
              : {}),
          validation: publicValidationReceipt(
            compactProductionValidationEnvelope(candidate, validation),
          ),
          nextAction,
        });
      }

      const valueToPersist: EpisodeScript | EpisodeScriptChunkDraftEnvelope = isComplete
        ? candidate
        : {
            ...baseEnvelope,
            scenes: candidate.scenes,
          };
      const validationToPersist = compactProductionValidationEnvelope(candidate, validation);
      let written: EpisodeScriptDraftRow;
      let created = false;
      try {
        if (writeKind === "stage") {
          const staged = await seriesState.stageEpisodeScriptDraft(
            input.episodeId,
            valueToPersist,
            validationToPersist,
          );
          if (!staged.matches) {
            return staleScriptChunkReceipt({
              episodeId: input.episodeId,
              currentDraft: staged.draft,
            });
          }
          written = staged.draft;
          created = staged.created;
          if (!created) {
            return scriptChunkAlreadyPresentReceipt({
              episodeId: input.episodeId,
              draft: written,
              complete: isComplete,
            });
          }
        } else {
          written = await seriesState.reviseEpisodeScriptDraft(
            input.episodeId,
            writeExpectedRevision!,
            valueToPersist,
            validationToPersist,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("revision conflict")) {
          return staleScriptChunkReceipt({
            episodeId: input.episodeId,
            requestedRevision: writeExpectedRevision,
            currentDraft: await seriesState.getEpisodeScriptDraft(input.episodeId),
          });
        }
        if (
          message.includes("Agnes submission has started")
          || message.includes("completed episode")
        ) {
          return JSON.stringify({
            status: "script_chunk_write_blocked",
            persisted: false,
            retryable: false,
            retryThisInvocation: false,
            noProgress: true,
            episodeId: input.episodeId,
            nextAction: message.includes("Agnes")
              ? "Resume the accepted Agnes work; never change this script."
              : "The episode is already complete; do not regenerate it.",
          });
        }
        throw error;
      }

      correctionRetriesByRange.delete(correctionRangeKey);
      oversizeCorrectionRetriesByRange.delete(oversizeCorrectionRangeKey);

      if (isComplete) {
        return JSON.stringify({
          status: "script_draft_complete",
          persisted: true,
          retryable: true,
          retryThisInvocation: true,
          episodeId: input.episodeId,
          draftRevision: written.revision,
          contentDigest: written.contentDigest,
          sceneCount: candidate.scenes.length,
          totalSpokenWords: candidate.scenes.reduce(
            (total, scene) => total + countNarrationSpokenWords(scene.narrationText),
            0,
          ),
          validation: { pass: true, issues: [] },
          nextAction:
            `Call refine_episode_script with episodeId=${input.episodeId} and draftRevision=${written.revision}; never resend scene JSON.`,
        });
      }

      // The provider already has the immutable plan and the just-accepted
      // scenes in this invocation's transcript. Returning them again after
      // every successful append makes context grow quadratically. Fresh-run
      // get_next_episode still returns the full durable plan, active beat, and
      // two-scene handoff; same-run continuation needs only the compact cursor.
      const authoringProgress = immediateChunkCorrectionProgress(written);
      return JSON.stringify({
        status: created ? "script_chunk_staged" : "script_chunk_appended",
        persisted: true,
        retryable: true,
        retryThisInvocation: true,
        episodeId: input.episodeId,
        draftRevision: written.revision,
        contentDigest: written.contentDigest,
        authoringProgress,
        nextAction: authoringProgress
          ? `Call write_episode_script_chunk once with operation=append, episodeId=${input.episodeId}, ` +
            `expectedDraftRevision=${written.revision}, and exactly scenes ` +
            `${authoringProgress.nextSceneNumber}-${authoringProgress.nextSceneEnd}. ` +
            "Omit targetSceneCount and authoringPlan."
          : "Start a fresh run and reload durable authoring progress.",
      });
    },
  });
}

/**
 * Stages the one large agent-authored script payload exactly once. All later
 * production refinement calls use only episodeId + draftRevision.
 */
export function buildScriptDraftTool(seriesState: ScriptDraftPersistence): DynamicStructuredTool {
  const baseSchema = z.object({
    episodeId: z.number().int().positive().describe("The ready episode id returned by get_next_episode."),
    expectedDraftRevision: z.number().int().positive().optional().describe(
      "Use only on a fresh run after needs_reauthor, with the exact replacementExpectedDraftRevision receipt.",
    ),
    scriptJson: z.preprocess(decodeJsonInput, draftScriptSchema).describe(
      "The complete episode draft object. Preserve every scene narration, environment, action, cast visual, supporting entity, continuity anchor, scene detail, camera angle, and lighting field.",
    ),
  }).strict();
  const guardedSchema = baseSchema.catch(({ error, input }) =>
    invalidRefinementInput(input, error) as unknown as z.infer<typeof baseSchema>
  );

  return new DynamicStructuredTool({
    name: "stage_episode_script_draft",
    description:
      "Durably stages one complete episode-script draft and returns only a compact revision receipt. " +
      "Call this once after drafting; after a needs_reauthor receipt, a fresh run may replace that invalid draft by supplying its exact expectedDraftRevision. " +
      "Then call refine_episode_script with only episodeId and draftRevision. " +
      "Valid drafts retain the full detailed scene schema while malformed input produces a compact retry receipt instead of echoing the payload.",
    schema: guardedSchema,
    func: async (input) => {
      if (isInvalidRefinementInput(input)) {
        return compactInvalidInputResult(input);
      }

      const { episodeId, expectedDraftRevision, scriptJson } = input;
      // DynamicStructuredTool.call validates this already. Keep the guard so
      // direct func callers cannot turn malformed large text into an exception.
      const parsedDraft = parseDraftScriptInput(scriptJson);
      if (!parsedDraft.success) {
        return compactInvalidInputResult(
          invalidRefinementInput({ episodeId, scriptJson }, parsedDraft.error),
        );
      }

      const episode = await seriesState.getEpisodeById(episodeId);
      if (!episode) {
        return JSON.stringify({
          status: "episode_missing",
          persisted: false,
          retryable: false,
          retryThisInvocation: false,
          episodeId,
          nextAction: "Reload the ready episode from get_next_episode before staging a script.",
        });
      }

      const characters = await seriesState.getSeriesCharacters(episode.seriesId);
      const validation = validateEpisodeScript(
        parsedDraft.script,
        DEFAULT_PRODUCTION_MIN_SCENES,
        DEFAULT_PRODUCTION_MAX_SCENES,
        5,
        characters.map((character) => character.name),
      );
      let staged: Awaited<ReturnType<ScriptDraftPersistence["stageEpisodeScriptDraft"]>>;
      let replacedInvalidDraft = false;
      try {
        if (expectedDraftRevision !== undefined) {
          const existing = await seriesState.getEpisodeScriptDraft(episodeId);
          if (!existing || existing.revision !== expectedDraftRevision) {
            return staleDraftReceipt({
              episodeId,
              requestedRevision: expectedDraftRevision,
              currentDraft: existing,
            });
          }
          const existingRepairEvidence = isRecord(existing.validation)
            && isRecord(existing.validation.repairEvidence)
            ? existing.validation.repairEvidence
            : undefined;
          const hasDurableOverlongNarration = Array.isArray(
            existingRepairEvidence?.durationExceededScenes,
          ) && existingRepairEvidence.durationExceededScenes.length > 0;
          if (
            !isRecord(existing.validation)
            || existing.validation.pass !== false
            || hasDurableOverlongNarration
          ) {
            return JSON.stringify({
              status: "draft_replacement_blocked",
              persisted: false,
              retryable: false,
              retryThisInvocation: false,
              episodeId,
              draftRevision: existing.revision,
              nextAction:
                "Do not replace a draft unless deterministic validation requires a complete re-author. Resume refine_episode_script for durable overlong-narration evidence.",
            });
          }
          const revised = await seriesState.reviseEpisodeScriptDraft(
            episodeId,
            expectedDraftRevision,
            parsedDraft.script,
            compactProductionValidationEnvelope(parsedDraft.script, validation),
          );
          staged = { draft: revised, created: false, matches: true };
          replacedInvalidDraft = true;
        } else {
          staged = await seriesState.stageEpisodeScriptDraft(
            episodeId,
            parsedDraft.script,
            compactProductionValidationEnvelope(parsedDraft.script, validation),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (expectedDraftRevision !== undefined && message.includes("revision conflict")) {
          return staleDraftReceipt({
            episodeId,
            requestedRevision: expectedDraftRevision,
            currentDraft: await seriesState.getEpisodeScriptDraft(episodeId),
          });
        }
        const agnesStarted = message.includes("Agnes submission has started");
        return JSON.stringify({
          status: "draft_stage_blocked",
          persisted: false,
          retryable: !agnesStarted,
          retryThisInvocation: false,
          episodeId,
          message: message.length <= 300 ? message : `${message.slice(0, 297)}...`,
          nextAction: agnesStarted
            ? "Do not replace the script. Resume verification/download for the existing Agnes generation."
            : "Do not resend the script in this invocation. Reload the current draft revision and retry on a later run.",
        });
      }
      const status = replacedInvalidDraft
        ? "draft_replaced"
        : staged.created
        ? "draft_staged"
        : staged.matches
          ? "draft_already_staged"
          : "draft_conflict";
      const stagedScript = parseDraftScriptInput(staged.draft.scriptJson);

      return JSON.stringify({
        status,
        persisted: true,
        draftMatchesSubmitted: staged.matches,
        ...(replacedInvalidDraft ? { replacedInvalidDraft: true } : {}),
        ...(staged.created || staged.matches ? {} : {
          submittedDraftAccepted: false,
          existingDraftPreserved: true,
        }),
        episodeId,
        draftRevision: staged.draft.revision,
        contentDigest: staged.draft.contentDigest,
        sceneCount: stagedScript.success
          ? stagedScript.script.scenes.length
          : parsedDraft.script.scenes.length,
        validation: {
          ...(staged.created || staged.matches
            ? { pass: validation.pass, issueCount: validation.issues.length }
            : { source: "existing_durable_draft" }),
        },
        nextAction:
          `Call refine_episode_script with episodeId=${episodeId} and draftRevision=${staged.draft.revision}; do not resend scriptJson.`,
      });
    },
  });
}

function buildDeterministicProductionScriptRefinementTool(
  seriesState: ScriptDraftPersistence,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "refine_episode_script",
    description:
      "Loads and deterministically validates a durable episode draft. It never accepts or returns scriptJson. " +
      `Only a measured Groq narration above ${NARRATION_MAX_AUDIO_SECONDS} seconds may invoke a model, and that model may return only a shorter narrationText. ` +
      "All visual, character, environment, action, continuity, camera, and lighting fields remain unchanged.",
    schema: z.object({
      episodeId: z.number().int().positive().describe("The episode id in the draft-staging receipt."),
      draftRevision: z.number().int().positive().optional().describe(
        "The exact revision from a prior receipt. Omit on a later fresh run to resume the latest durable draft.",
      ),
      durationExceededScenes: z.array(z.object({
        sceneNumber: z.number().int().positive(),
        durationSeconds: z.number().positive().max(300),
      })).max(DEFAULT_PRODUCTION_MAX_SCENES).default([]).describe(
        `Compact authoritative Groq measurements only for scene WAVs above ${NARRATION_MAX_AUDIO_SECONDS} seconds.`,
      ),
      measuredTotalNarrationSeconds: z.number().nonnegative().max(3_600).optional().describe(
        "The positive sum of every successfully measured scene WAV. Never send zero or a partial sum.",
      ),
      measuredNarrationSceneCount: z.number().int().nonnegative()
        .max(DEFAULT_PRODUCTION_MAX_SCENES).optional().describe(
          "Number of scene WAVs included in measuredTotalNarrationSeconds; it must equal the current script scene count.",
        ),
    }).strict(),
    func: async ({
      episodeId,
      draftRevision,
      durationExceededScenes,
      measuredTotalNarrationSeconds,
      measuredNarrationSceneCount,
    }) => {
      const episode = await seriesState.getEpisodeById(episodeId);
      if (!episode) {
        return JSON.stringify({
          status: "episode_missing",
          persisted: false,
          retryable: false,
          retryThisInvocation: false,
          episodeId,
          nextAction: "Reload the ready episode from get_next_episode.",
        });
      }

      let draft = await seriesState.getEpisodeScriptDraft(episodeId);
      if (!draft && episode.scriptJson != null) {
        const parsedPersistedScript = parseDraftScriptInput(episode.scriptJson);
        if (!parsedPersistedScript.success) {
          const compactPaths = compactIssuePaths(parsedPersistedScript.error);
          return JSON.stringify({
            status: "stored_script_invalid",
            persisted: false,
            retryable: false,
            retryThisInvocation: false,
            episodeId,
            validation: { pass: false, invalidPaths: compactPaths.issuePaths },
            nextAction: "The persisted script is not a recoverable complete draft and requires state maintenance.",
          });
        }
        const characters = await seriesState.getSeriesCharacters(episode.seriesId);
        const seedScript = normalizeSceneNumbers({
          ...parsedPersistedScript.script,
          title: episode.title,
          premise: episode.premise,
        });
        const seedValidation = validateProductionRefinementCandidate({
          sourceScript: seedScript,
          candidate: seedScript,
          mainCharacterNames: characters.map((character) => character.name),
          durationExceededScenes: [],
        });
        try {
          const seeded = await seriesState.stageEpisodeScriptDraft(
            episodeId,
            seedScript,
            compactProductionValidationEnvelope(seedScript, seedValidation),
          );
          if (!seeded.matches) {
            return JSON.stringify({
              status: "draft_conflict",
              persisted: false,
              retryable: true,
              retryThisInvocation: false,
              episodeId,
              draftRevision: seeded.draft.revision,
              contentDigest: seeded.draft.contentDigest,
              nextAction:
                `A different durable draft won the staging race. On a later run call refine_episode_script with episodeId=${episodeId} and draftRevision=${seeded.draft.revision}; do not apply timing evidence from this stale script snapshot.`,
            });
          }
          draft = seeded.draft;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const agnesStarted = message.includes("Agnes submission has started");
          return JSON.stringify({
            status: "repair_blocked",
            persisted: false,
            retryable: !agnesStarted,
            retryThisInvocation: false,
            episodeId,
            message: message.length <= 300 ? message : `${message.slice(0, 297)}...`,
            nextAction: agnesStarted
              ? "Do not replace the script. Resume verification/download for the existing Agnes generation."
              : "Retry durable staging on a later run.",
          });
        }
      }

      if (!draft || (draftRevision !== undefined && draft.revision !== draftRevision)) {
        return staleDraftReceipt({ episodeId, requestedRevision: draftRevision, currentDraft: draft });
      }

      const authoringProgress = getEpisodeScriptChunkAuthoringProgress(
        draft.scriptJson,
        draft.validation,
      );
      if (authoringProgress?.status === "in_progress") {
        return JSON.stringify({
          status: "script_authoring_in_progress",
          persisted: true,
          retryable: true,
          retryThisInvocation: false,
          noProgress: true,
          episodeId,
          draftRevision: draft.revision,
          contentDigest: draft.contentDigest,
          authoringProgress,
          nextAction:
            "The durable draft is an unfinished bounded prefix. Start a fresh run, obey resumeAction=script_authoring, and append only its exact next scene range; refinement cannot modify a partial draft.",
        });
      }

      const parsedDraft = parseDraftScriptInput(draft.scriptJson);
      if (!parsedDraft.success) {
        const compactPaths = compactIssuePaths(parsedDraft.error);
        return JSON.stringify({
          status: "stored_draft_invalid",
          persisted: false,
          retryable: false,
          retryThisInvocation: false,
          episodeId,
          draftRevision: draft.revision,
          validation: { pass: false, invalidPaths: compactPaths.issuePaths },
          nextAction: "The durable draft is corrupt and requires state maintenance.",
        });
      }

      const characters = await seriesState.getSeriesCharacters(episode.seriesId);
      const mainCharacterNames = characters.map((character) => character.name);
      const canonicalSourceScript = normalizeSceneNumbers({
        ...parsedDraft.script,
        title: episode.title,
        premise: episode.premise,
      });
      let activeDraftRevision = draft.revision;
      let activeDraftContentDigest = draft.contentDigest;
      let ignoredTimingEvidenceCount = 0;

      const suppliedApplicableOverlongTiming = durationExceededScenes.some((item: DurationExceededScene) =>
        item.durationSeconds > NARRATION_MAX_AUDIO_SECONDS
        && canonicalSourceScript.scenes.some((scene) => scene.sceneNumber === item.sceneNumber)
      );
      const suppliedAnyAggregateTiming = measuredTotalNarrationSeconds !== undefined
        || measuredNarrationSceneCount !== undefined;
      const suppliedCompleteAggregateTiming =
        measuredTotalNarrationSeconds !== undefined
        && measuredTotalNarrationSeconds > 0
        && measuredNarrationSceneCount === canonicalSourceScript.scenes.length;
      const invalidAggregateTiming = (suppliedAnyAggregateTiming || suppliedApplicableOverlongTiming)
        && !suppliedCompleteAggregateTiming;
      if (invalidAggregateTiming) ignoredTimingEvidenceCount += 1;

      const persistedMeasuredTotal = measuredTotalNarrationSecondsFromValidation(draft.validation);
      const persistedMeasuredSceneCount = measuredNarrationSceneCountFromValidation(draft.validation);
      const persistedAggregateIsComplete = persistedMeasuredTotal !== undefined
        && persistedMeasuredSceneCount === canonicalSourceScript.scenes.length;
      const effectiveMeasuredTotal = suppliedCompleteAggregateTiming
        ? measuredTotalNarrationSeconds
        : persistedAggregateIsComplete
          ? persistedMeasuredTotal
          : undefined;
      const effectiveMeasuredSceneCount = effectiveMeasuredTotal === undefined
        ? undefined
        : canonicalSourceScript.scenes.length;

      const persistedDurations = durationExceededScenesFromValidation(draft.validation);
      const mergedDurations = mergeDurationExceededScenes(
        persistedDurations,
        durationExceededScenes,
      );
      const filteredDurations = filterApplicableDurationEvidence(
        canonicalSourceScript,
        mergedDurations,
      );
      ignoredTimingEvidenceCount += filteredDurations.ignoredCount;

      // This validation is deliberately free of timing evidence. If it fails,
      // no repair provider is allowed to see or rewrite any part of the script.
      const staticValidation = validateProductionRefinementCandidate({
        sourceScript: canonicalSourceScript,
        candidate: canonicalSourceScript,
        mainCharacterNames,
        durationExceededScenes: [],
      });
      if (!staticValidation.pass) {
        const durableValidation = compactProductionValidationEnvelope(
          canonicalSourceScript,
          staticValidation,
        );
        const revised = await reviseDurableDraft({
          seriesState,
          episodeId,
          expectedRevision: activeDraftRevision,
          script: canonicalSourceScript,
          validation: durableValidation,
        });
        if (typeof revised === "string") return revised;
        return JSON.stringify({
          status: "needs_reauthor",
          reason: "deterministic_script_validation_failed",
          persisted: false,
          draftPersisted: true,
          retryable: true,
          retryThisInvocation: false,
          episodeId,
          draftRevision: revised.revision,
          replacementExpectedDraftRevision: revised.revision,
          sceneCount: canonicalSourceScript.scenes.length,
          narrationRepairCallCount: 0,
          ...(ignoredTimingEvidenceCount > 0 ? { ignoredTimingEvidenceCount } : {}),
          validation: publicValidationReceipt(durableValidation),
          nextAction:
            `Stop this invocation. On the next fresh run call write_episode_script_chunk with operation=restart, episodeId=${episodeId}, expectedDraftRevision=${revised.revision}, a complete immutable authoring plan, and corrected scenes 1-8.`,
        });
      }

      if (invalidAggregateTiming) {
        return JSON.stringify({
          status: "invalid_timing_evidence",
          reason: measuredTotalNarrationSeconds === 0
            ? "zero_total_duration"
            : "incomplete_total_duration",
          persisted: false,
          retryable: true,
          retryThisInvocation: false,
          episodeId,
          draftRevision: activeDraftRevision,
          ignoredTimingEvidenceCount,
          narrationRepairCallCount: 0,
          nextAction:
            `Generate or verify all ${canonicalSourceScript.scenes.length} exact-text scene WAVs first. Then call refine_episode_script with a positive measuredTotalNarrationSeconds and measuredNarrationSceneCount=${canonicalSourceScript.scenes.length}; never send zero or a partial sum.`,
        });
      }

      if (effectiveMeasuredTotal !== undefined && effectiveMeasuredTotal < 300) {
        const currentWords = totalNarrationWords(canonicalSourceScript);
        const suggestedWords = Math.min(
          DEFAULT_PRODUCTION_MAX_SCENES * NARRATION_MAX_SPOKEN_WORDS,
          Math.max(800, Math.ceil((currentWords * 300 * 1.05) / effectiveMeasuredTotal)),
        );
        const runtimeValidation: ScriptValidationResult = {
          pass: false,
          issues: [
            `Complete measured narration is ${effectiveMeasuredTotal.toFixed(3)} seconds across ${effectiveMeasuredSceneCount} scenes, below the required 300 seconds. Author a new complete script with at least ${suggestedWords} meaningful spoken words distributed across distinct visual beats.`,
          ],
        };
        const durableValidation = compactProductionValidationEnvelope(
          canonicalSourceScript,
          runtimeValidation,
          {
            durationExceededScenes: [],
            measuredTotalNarrationSeconds: effectiveMeasuredTotal,
            measuredNarrationSceneCount: effectiveMeasuredSceneCount,
          },
        );
        const revised = await reviseDurableDraft({
          seriesState,
          episodeId,
          expectedRevision: activeDraftRevision,
          script: canonicalSourceScript,
          validation: durableValidation,
        });
        if (typeof revised === "string") return revised;
        return JSON.stringify({
          status: "needs_reauthor",
          reason: "measured_runtime_too_short",
          persisted: false,
          draftPersisted: true,
          retryable: true,
          retryThisInvocation: false,
          episodeId,
          draftRevision: revised.revision,
          replacementExpectedDraftRevision: revised.revision,
          measuredTotalNarrationSeconds: effectiveMeasuredTotal,
          measuredNarrationSceneCount: effectiveMeasuredSceneCount,
          minimumReplacementSpokenWords: suggestedWords,
          narrationRepairCallCount: 0,
          validation: publicValidationReceipt(durableValidation),
          nextAction:
            `Stop this invocation. On the next fresh run call write_episode_script_chunk with operation=restart, episodeId=${episodeId}, expectedDraftRevision=${revised.revision}, a plan targeting at least ${suggestedWords} meaningful spoken words, and corrected scenes 1-8 with every visual field.`,
        });
      }

      let candidate = canonicalSourceScript;
      let remainingDurations = filteredDurations.durationExceededScenes;
      const warnings: string[] = [];
      let narrationRepairCallCount = 0;
      let shorteningWouldBreakContract = false;

      if (remainingDurations.length > 0) {
        const timingValidation = validateProductionRefinementCandidate({
          sourceScript: canonicalSourceScript,
          candidate,
          mainCharacterNames,
          durationExceededScenes: remainingDurations,
        });
        const checkpointed = await reviseDurableDraft({
          seriesState,
          episodeId,
          expectedRevision: activeDraftRevision,
          script: candidate,
          validation: compactProductionValidationEnvelope(
            candidate,
            timingValidation,
            {
              durationExceededScenes: remainingDurations,
              ...(effectiveMeasuredTotal === undefined
                ? {}
                : {
                    measuredTotalNarrationSeconds: effectiveMeasuredTotal,
                    measuredNarrationSceneCount: effectiveMeasuredSceneCount,
                  }),
            },
          ),
        });
        if (typeof checkpointed === "string") return checkpointed;
        activeDraftRevision = checkpointed.revision;
        activeDraftContentDigest = checkpointed.contentDigest;

        for (const exceeded of remainingDurations.slice(0, MAX_NARRATION_REPAIRS_PER_INVOCATION)) {
          const scene = candidate.scenes.find(
            (item) => item.sceneNumber === exceeded.sceneNumber,
          );
          if (!scene) continue;
          try {
            narrationRepairCallCount += 1;
            const replacement = await requestMeasuredNarrationReplacement({
              script: candidate,
              scene,
              measuredSeconds: exceeded.durationSeconds,
            });
            const proposed = applyMeasuredNarrationReplacement(candidate, replacement);
            const proposedValidation = validateProductionRefinementCandidate({
              sourceScript: proposed,
              candidate: proposed,
              mainCharacterNames,
              durationExceededScenes: [],
            });
            if (!proposedValidation.pass) {
              shorteningWouldBreakContract = true;
              warnings.push(
                "The measured narration could not be shortened without violating the complete production contract; the provider output was discarded.",
              );
              break;
            }
            candidate = proposed;
            remainingDurations = remainingDurations.filter(
              (item) => item.sceneNumber !== exceeded.sceneNumber,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(
              `Narration-only repair was not applied: ${message.length <= 220 ? message : `${message.slice(0, 217)}...`}`,
            );
            break;
          }
        }
      }

      if (shorteningWouldBreakContract) {
        const reauthorValidation = compactProductionValidationEnvelope(
          candidate,
          {
            pass: false,
            issues: [
              "A measured-overlong narration cannot be shortened safely without making the complete episode violate its word-count or story contract.",
            ],
          },
        );
        const revised = await reviseDurableDraft({
          seriesState,
          episodeId,
          expectedRevision: activeDraftRevision,
          script: candidate,
          validation: reauthorValidation,
        });
        if (typeof revised === "string") return revised;
        return JSON.stringify({
          status: "needs_reauthor",
          reason: "narration_shortening_breaks_contract",
          persisted: false,
          draftPersisted: true,
          retryable: true,
          retryThisInvocation: false,
          episodeId,
          draftRevision: revised.revision,
          replacementExpectedDraftRevision: revised.revision,
          narrationRepairCallCount,
          validation: publicValidationReceipt(reauthorValidation),
          warnings: compactWarnings(warnings),
          nextAction:
            `Stop this invocation. On the next fresh run call write_episode_script_chunk with operation=restart, episodeId=${episodeId}, expectedDraftRevision=${revised.revision}, a new bounded plan with more timing headroom, and corrected scenes 1-8.`,
        });
      }

      const finalValidation = validateProductionRefinementCandidate({
        sourceScript: candidate,
        candidate,
        mainCharacterNames,
        durationExceededScenes: remainingDurations,
      });
      if (remainingDurations.length > 0 || !finalValidation.pass) {
        const narrationChanged = !jsonEqual(candidate, canonicalSourceScript);
        const durableValidation = compactProductionValidationEnvelope(
          candidate,
          finalValidation,
          {
            durationExceededScenes: remainingDurations,
            ...(
              narrationChanged || effectiveMeasuredTotal === undefined
                ? {}
                : {
                    measuredTotalNarrationSeconds: effectiveMeasuredTotal,
                    measuredNarrationSceneCount: effectiveMeasuredSceneCount,
                  }
            ),
          },
        );
        const revised = await reviseDurableDraft({
          seriesState,
          episodeId,
          expectedRevision: activeDraftRevision,
          script: candidate,
          validation: durableValidation,
        });
        if (typeof revised === "string") return revised;
        return JSON.stringify({
          status: "needs_timing_repair",
          persisted: false,
          draftPersisted: true,
          retryable: true,
          retryThisInvocation: false,
          episodeId,
          draftRevision: revised.revision,
          sceneCount: candidate.scenes.length,
          narrationRepairCallCount,
          remainingOverlongSceneCount: remainingDurations.length,
          ...(ignoredTimingEvidenceCount > 0 ? { ignoredTimingEvidenceCount } : {}),
          durableTimingEvidenceCount: durableTimingEvidenceCount(durableValidation),
          validation: publicValidationReceipt(durableValidation),
          warnings: compactWarnings(warnings),
          nextAction:
            `Stop this invocation. On the next run call refine_episode_script with episodeId=${episodeId} and draftRevision=${revised.revision}; do not resend scriptJson.`,
        });
      }

      if (!jsonEqual(candidate, canonicalSourceScript)) {
        const revised = await reviseDurableDraft({
          seriesState,
          episodeId,
          expectedRevision: activeDraftRevision,
          script: candidate,
          validation: compactProductionValidationEnvelope(candidate, finalValidation),
        });
        if (typeof revised === "string") return revised;
        activeDraftRevision = revised.revision;
        activeDraftContentDigest = revised.contentDigest;
      }

      let promotion: PromoteEpisodeScriptDraftResult;
      try {
        promotion = await seriesState.promoteEpisodeScriptDraft({
          episodeId,
          expectedRevision: activeDraftRevision,
          expectedContentDigest: activeDraftContentDigest,
          scriptJson: candidate,
        });
      } catch (error) {
        if (!(error instanceof ProductionScriptContractError)) throw error;
        const authoritativeValidation = compactProductionValidationEnvelope(
          candidate,
          {
            pass: false,
            issues: error.inspection.issues,
          },
        );
        const revised = await reviseDurableDraft({
          seriesState,
          episodeId,
          expectedRevision: activeDraftRevision,
          script: candidate,
          validation: authoritativeValidation,
        });
        if (typeof revised === "string") return revised;
        return JSON.stringify({
          status: "needs_reauthor",
          reason: "authoritative_contract_rejected",
          persisted: false,
          draftPersisted: true,
          retryable: true,
          retryThisInvocation: false,
          episodeId,
          draftRevision: revised.revision,
          replacementExpectedDraftRevision: revised.revision,
          narrationRepairCallCount,
          validation: publicValidationReceipt(authoritativeValidation),
          nextAction:
            `Stop this invocation. On the next fresh run call write_episode_script_chunk with operation=restart, episodeId=${episodeId}, expectedDraftRevision=${revised.revision}, a complete immutable authoring plan, and corrected scenes 1-8.`,
        });
      }

      if (promotion.status === "stale") {
        return JSON.stringify({
          status: promotion.currentDraft ? "stale_draft_revision" : "draft_missing",
          persisted: false,
          retryable: Boolean(promotion.currentDraft),
          retryThisInvocation: false,
          episodeId,
          ...(promotion.currentDraft
            ? {
                draftRevision: promotion.currentDraft.revision,
                contentDigest: promotion.currentDraft.contentDigest,
              }
            : {}),
          nextAction: promotion.currentDraft
            ? `Retry on a later run with episodeId=${episodeId} and draftRevision=${promotion.currentDraft.revision}.`
            : `Begin bounded authoring with write_episode_script_chunk operation=start for episodeId=${episodeId}.`,
        });
      }
      if (promotion.status === "blocked") {
        return JSON.stringify({
          status: "promotion_blocked",
          persisted: false,
          retryable: false,
          retryThisInvocation: false,
          episodeId,
          draftRevision: promotion.sourceDraft.revision,
          reason: promotion.reason,
          nextAction: promotion.reason === "agnes_started"
            ? "Do not replace the script. Resume verification/download for the existing Agnes generation."
            : "The episode is already complete; do not regenerate or upload it again.",
        });
      }

      const existingProduction = episode.scriptJson == null
        ? null
        : parseDraftScriptInput(episode.scriptJson);
      const scriptReloadRequired = existingProduction === null
        || !existingProduction.success
        || !jsonEqual(existingProduction.script, candidate);
      return JSON.stringify({
        status: "ready",
        persisted: true,
        episodeId,
        draftRevision: activeDraftRevision,
        sourceDraftRevision: activeDraftRevision,
        sceneCount: candidate.scenes.length,
        narrationRepairCallCount,
        scriptReloadRequired,
        ...(ignoredTimingEvidenceCount > 0 ? { ignoredTimingEvidenceCount } : {}),
        validation: { pass: true, issues: [] },
        warnings: compactWarnings(warnings),
        nextAction: scriptReloadRequired
          ? "Call get_next_episode once to load the exact promoted script. If narration changed, regenerate every narration WAV from its exact text before any Agnes submission."
          : "Continue with the exact production script already returned by this run's get_next_episode call; do not reload or retransmit scriptJson.",
      });
    },
  });
}

/**
 * Legacy fixture harness retained only for the pre-production unit cases in
 * scriptRefinementTool.test.ts. It is deliberately not selected by the
 * production factory, even when a caller passes an undefined state at runtime.
 */
export function buildLegacyStandaloneScriptRefinementFixtureTool(): DynamicStructuredTool {
  const mainCharacterNamesSchema = z.preprocess(
    parseJsonArrayInput,
    z.array(z.string().trim().min(1)).min(1),
  );

  return new DynamicStructuredTool({
    name: "refine_episode_script",
    description:
      "Refines an initially drafted episode into one-scene/one-audio/one-video units. It splits overloaded " +
      `narration into <=${NARRATION_MAX_RAW_CHARACTERS} raw characters and <=${NARRATION_MAX_SPOKEN_WORDS} spoken words per production scene, ` +
      "locks characterNames to the supplied fixed roster, preserves scene continuity metadata, and validates total runtime. " +
      "Standalone mode returns scriptJson only when the requested validation contract passes.",
    schema: z.object({
      episodeId: z.number().int().positive().optional(),
      scriptJson: z.preprocess(decodeJsonInput, draftScriptSchema),
      minScenes: z.number().int().positive().default(DEFAULT_PRODUCTION_MIN_SCENES),
      maxScenes: z.number().int().positive().default(DEFAULT_PRODUCTION_MAX_SCENES),
      targetRuntimeMinutes: z.number().positive().default(5),
      mainCharacterNames: mainCharacterNamesSchema.optional().describe(
          "The exact fixed main-character names returned by get_or_create_series. Required for production refinement.",
        ),
    }),
    func: async ({ episodeId, scriptJson, minScenes, maxScenes, targetRuntimeMinutes, mainCharacterNames }) => {
      const normalizedInput = decodeJsonInput(scriptJson) as EpisodeScript;
      const sourceScript = normalizeSceneNumbers(normalizedInput);
      const result = await runRefinementPipeline({
        sourceScript,
        minScenes,
        maxScenes,
        targetRuntimeMinutes,
        mainCharacterNames,
      });
      if (minScenes >= 15 && !result.validation.pass) {
        return JSON.stringify({
          status: "needs_repair",
          persisted: false,
          retryThisInvocation: false,
          ...(episodeId === undefined ? {} : { episodeId }),
          validation: {
            pass: false,
            issues: result.validation.issues,
            issueCount: result.validation.issues.length,
            omittedIssueCount: 0,
          },
          warnings: [
            ...result.warnings,
            "No scriptJson was returned because the final production narration contract did not pass.",
          ],
          nextAction:
            "Revise the draft using the reported issues, then call refine_episode_script again for the same episodeId. Do not start audio or Agnes work.",
        });
      }
      if (result.validation.pass) {
        return JSON.stringify({
          status: "ready",
          scriptJson: result.script,
          validation: result.validation,
          warnings: result.warnings,
        });
      }
      return JSON.stringify({
        status: "invalid_fixture",
        scriptJson: result.script,
        validation: result.validation,
        warnings: result.warnings,
      });
    },
  });
}

export function buildScriptRefinementTool(
  seriesState: ScriptDraftPersistence,
): DynamicStructuredTool {
  if (!seriesState) {
    throw new Error(
      "Production script refinement requires SeriesState; the broad standalone repair pipeline is disabled.",
    );
  }
  return buildDeterministicProductionScriptRefinementTool(seriesState);
}
