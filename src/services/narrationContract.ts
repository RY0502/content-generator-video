/**
 * Shared, side-effect-free narration rules for one-scene/one-audio/one-video
 * alignment. Keep provider limits here so script validation, TTS, state gates,
 * and Agnes preflight cannot silently drift apart.
 */
export const NARRATION_MAX_RAW_CHARACTERS = 200;
export const NARRATION_AUTHORING_TARGET_MAX_RAW_CHARACTERS = 180;
export const NARRATION_AUTHORING_TARGET_MIN_SPOKEN_WORDS = 12;
export const NARRATION_MAX_SPOKEN_WORDS = 20;
export const NARRATION_MAX_AUDIO_SECONDS = 12;
export const NARRATION_TARGET_MAX_AUDIO_SECONDS = 10;
export const NARRATION_WORDS_PER_MINUTE = 150;
export const DEFAULT_PRODUCTION_MIN_SCENES = 40;
export const DEFAULT_PRODUCTION_MAX_SCENES = 60;

export type NarrationTextIssueCode =
  | "empty"
  | "too_many_raw_characters"
  // Kept in the public union for compatibility with older consumers. The
  // current contract no longer emits or enforces a per-scene minimum.
  | "too_few_spoken_words"
  | "too_many_spoken_words";

export interface NarrationTextIssue {
  code: NarrationTextIssueCode;
  message: string;
}

export interface NarrationTextInspection {
  rawCharacterCount: number;
  spokenWordCount: number;
  issues: NarrationTextIssue[];
  pass: boolean;
}

export interface NarrationTextContractOptions {
  /** Enables the production spoken-word cap. The provider character cap is always enforced. */
  production?: boolean;
}

/** Removes Orpheus performance directions because they are instructions, not spoken words. */
export function stripNarrationVocalDirections(text: string): string {
  return text.replace(/\[[^\]\r\n]*\]/gu, " ");
}

/** Counts natural-language words while keeping contractions and hyphenated words together. */
export function countNarrationSpokenWords(text: string): number {
  const spokenText = stripNarrationVocalDirections(text);
  return spokenText.match(/[\p{L}\p{N}]+(?:[\u2019'\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** Returns the deterministic text-only contract result used before any paid TTS call. */
export function inspectNarrationText(
  text: string,
  options: NarrationTextContractOptions = {},
): NarrationTextInspection {
  const rawCharacterCount = text.length;
  const spokenWordCount = countNarrationSpokenWords(text);
  const issues: NarrationTextIssue[] = [];

  if (!text.trim()) {
    issues.push({ code: "empty", message: "Narration text must not be empty." });
  }
  if (rawCharacterCount > NARRATION_MAX_RAW_CHARACTERS) {
    issues.push({
      code: "too_many_raw_characters",
      message:
        `Narration has ${rawCharacterCount} raw characters; the Groq one-request limit is ` +
        `${NARRATION_MAX_RAW_CHARACTERS}. Split it into consecutive scenes.`,
    });
  }
  if (options.production && spokenWordCount > NARRATION_MAX_SPOKEN_WORDS) {
    issues.push({
      code: "too_many_spoken_words",
      message:
        `Narration has ${spokenWordCount} spoken words; production scenes allow at most ` +
        `${NARRATION_MAX_SPOKEN_WORDS} to leave headroom under the 12-second audio limit. ` +
        "Split it into consecutive scenes.",
    });
  }

  return {
    rawCharacterCount,
    spokenWordCount,
    issues,
    pass: issues.length === 0,
  };
}

export interface NarrationDurationInspection {
  durationSeconds: number;
  maxDurationSeconds: number;
  pass: boolean;
  message?: string;
}

/** The measured WAV duration is the authoritative, non-heuristic scene limit. */
export function inspectNarrationDuration(durationSeconds: number): NarrationDurationInspection {
  const valid = Number.isFinite(durationSeconds) && durationSeconds > 0;
  const pass = valid && durationSeconds <= NARRATION_MAX_AUDIO_SECONDS;
  return {
    durationSeconds,
    maxDurationSeconds: NARRATION_MAX_AUDIO_SECONDS,
    pass,
    ...(pass
      ? {}
      : {
          message: valid
            ? `Narration audio is ${durationSeconds.toFixed(3)} seconds; one scene may be at most ${NARRATION_MAX_AUDIO_SECONDS} seconds. Split the script scene.`
            : "Narration audio duration must be a positive finite number.",
        }),
  };
}

export function minimumNarrationWords(targetRuntimeMinutes: number): number {
  if (!Number.isFinite(targetRuntimeMinutes) || targetRuntimeMinutes <= 0) return 0;
  return Math.ceil(targetRuntimeMinutes * NARRATION_WORDS_PER_MINUTE);
}

export interface EpisodeNarrationManifestInspection {
  pass: boolean;
  sceneCount: number;
  totalSpokenWords: number;
  issues: string[];
}

/**
 * Validates the persisted, production-sized narration manifest without any
 * provider calls. This is intentionally shared by the script-save gate and
 * media preflight so an agent cannot accidentally persist the old long-scene
 * format and later create multiple Agnes clips for it.
 */
export function inspectEpisodeNarrationManifest(
  value: unknown,
  options: {
    minScenes?: number;
    maxScenes?: number;
    targetRuntimeMinutes?: number;
  } = {},
): EpisodeNarrationManifestInspection {
  let root = value;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root) as unknown;
    } catch {
      root = null;
    }
  }

  const minScenes = options.minScenes ?? DEFAULT_PRODUCTION_MIN_SCENES;
  const maxScenes = options.maxScenes ?? DEFAULT_PRODUCTION_MAX_SCENES;
  const targetRuntimeMinutes = options.targetRuntimeMinutes ?? 5;
  const issues: string[] = [];
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return {
      pass: false,
      sceneCount: 0,
      totalSpokenWords: 0,
      issues: ["Episode script must be a JSON object."],
    };
  }

  let scenes: unknown = (root as Record<string, unknown>).scenes;
  if (typeof scenes === "string") {
    try {
      scenes = JSON.parse(scenes) as unknown;
    } catch {
      scenes = null;
    }
  }
  if (!Array.isArray(scenes)) {
    return {
      pass: false,
      sceneCount: 0,
      totalSpokenWords: 0,
      issues: ["Episode script must contain a scenes array."],
    };
  }

  if (scenes.length < minScenes) {
    issues.push(`Scene count ${scenes.length} is below the production minimum of ${minScenes}.`);
  }
  if (scenes.length > maxScenes) {
    issues.push(`Scene count ${scenes.length} exceeds the production maximum of ${maxScenes}.`);
  }

  let totalSpokenWords = 0;
  scenes.forEach((entry, index) => {
    const label = `Scene ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(`${label} must be an object.`);
      return;
    }
    const scene = entry as Record<string, unknown>;
    if (scene.sceneNumber !== index + 1) {
      issues.push(`${label} must have sequential sceneNumber ${index + 1}.`);
    }
    const narrationText = typeof scene.narrationText === "string" ? scene.narrationText : "";
    const inspection = inspectNarrationText(narrationText, { production: true });
    totalSpokenWords += inspection.spokenWordCount;
    for (const issue of inspection.issues) {
      issues.push(`${label}: ${issue.message}`);
    }
  });

  const minimumWords = minimumNarrationWords(targetRuntimeMinutes);
  if (totalSpokenWords < minimumWords) {
    issues.push(
      `Episode narration has ${totalSpokenWords} spoken words; at least ${minimumWords} are required ` +
      `for the ${targetRuntimeMinutes}-minute production target.`,
    );
  }

  return {
    pass: issues.length === 0,
    sceneCount: scenes.length,
    totalSpokenWords,
    issues,
  };
}
