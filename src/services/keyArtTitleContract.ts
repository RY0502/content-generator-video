import { countNarrationSpokenWords } from "./narrationContract.js";

export type KeyArtTitleKind = "series" | "episode";

/**
 * Title narration is intentionally much shorter than the general 20-word scene
 * ceiling. Twelve ordinary title words at the configured narrator's pace leave
 * substantial headroom below Agnes's measured 12-second hard limit; the WAV is
 * still measured after synthesis because text alone cannot guarantee duration.
 */
export const KEY_ART_TITLE_MAX_RAW_CHARACTERS = 100;
export const KEY_ART_TITLE_MAX_SPOKEN_WORDS = 12;

/** Canonical persisted/spoken title used at every key-art provenance boundary. */
export function canonicalizeKeyArtTitle(value: string, kind: KeyArtTitleKind): string {
  const title = value.trim();
  const label = kind === "series" ? "Series title" : "Episode title";
  if (!title) throw new Error(`${label} must not be empty.`);
  if (title.length > KEY_ART_TITLE_MAX_RAW_CHARACTERS) {
    throw new Error(
      `${label} has ${title.length} characters; key-art titles allow at most ` +
      `${KEY_ART_TITLE_MAX_RAW_CHARACTERS} to leave headroom below the 12-second TTS limit.`,
    );
  }
  const spokenWordCount = countNarrationSpokenWords(title);
  if (spokenWordCount === 0) {
    throw new Error(`${label} must contain at least one spoken word.`);
  }
  if (spokenWordCount > KEY_ART_TITLE_MAX_SPOKEN_WORDS) {
    throw new Error(
      `${label} has ${spokenWordCount} spoken words; key-art titles allow at most ` +
      `${KEY_ART_TITLE_MAX_SPOKEN_WORDS} to leave headroom below the 12-second TTS limit.`,
    );
  }
  return title;
}
