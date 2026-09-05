/**
 * @deprecated
 *
 * This preview runner belonged to the retired image/key-art Agnes evaluation
 * flow. It split a long scene narration into multiple Agnes jobs and appended
 * those jobs during assembly, which can make a scene appear to play twice.
 *
 * Production now owns the complete persisted lifecycle:
 *   one scene -> one canonical narrator WAV (<= 12 seconds)
 *             -> one Agnes text-to-video task
 *             -> one normalized Agnes clip
 *
 * Keep this file as a fail-closed marker for old shell history and bookmarks.
 * Do not restore its legacy scene-image, key-art, or multi-segment behavior.
 */

export const AGNES_EVALUATOR_DISABLED_MESSAGE = [
  "scripts/evaluateAgnesFirstScenes.ts is disabled because it uses the retired preview contract.",
  "That contract could submit multiple Agnes renders for one scene and append them, producing duplicate-looking footage.",
  "Run the production agent instead: it persists submit/verify/download state and enforces one <=12s WAV and one Agnes clip per scene.",
].join(" ");

export function runAgnesFirstScenesEvaluation(): never {
  throw new Error(AGNES_EVALUATOR_DISABLED_MESSAGE);
}

function isDirectInvocation(): boolean {
  return /(?:^|[/\\])evaluateAgnesFirstScenes\.(?:[cm]?[jt]s)$/.test(process.argv[1] ?? "");
}

if (isDirectInvocation()) {
  console.error(AGNES_EVALUATOR_DISABLED_MESSAGE);
  process.exitCode = 1;
}
