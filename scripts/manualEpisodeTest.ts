/**
 * @deprecated
 *
 * The former manual episode test generated series/episode key art and scene
 * images, then assembled those stills with transition padding. Those production
 * branches have been removed. Character portraits/sheets are now the only image
 * generation step; story visuals come from one Agnes clip per <=12-second scene.
 *
 * This fail-closed shim prevents an old direct invocation from spending image
 * generation quota or creating output that looks compatible with the current
 * production state when it is not.
 */

export const MANUAL_EPISODE_TEST_DISABLED_MESSAGE = [
  "scripts/manualEpisodeTest.ts is disabled because it exercises the retired key-art and scene-image pipeline.",
  "Use the production agent, which creates character assets only, then generates one canonical WAV and one Agnes video for every scene with no transition padding.",
].join(" ");

export function runManualEpisodeTest(): never {
  throw new Error(MANUAL_EPISODE_TEST_DISABLED_MESSAGE);
}

function isDirectInvocation(): boolean {
  return /(?:^|[/\\])manualEpisodeTest\.(?:[cm]?[jt]s)$/.test(process.argv[1] ?? "");
}

if (isDirectInvocation()) {
  console.error(MANUAL_EPISODE_TEST_DISABLED_MESSAGE);
  process.exitCode = 1;
}
