/**
 * Safety gate for historical image-only utilities.
 *
 * These scripts are intentionally kept for bespoke diagnostics and recovery,
 * but their scene/key-art outputs are not consumed by the current Agnes-only
 * production pipeline. Requiring a conspicuous CLI flag prevents an old shell
 * command from spending provider quota or mutating legacy media by accident.
 */

export const LEGACY_IMAGE_FLOW_OPT_IN_FLAG = "--allow-legacy-image-flow";

let warningPrinted = false;

export function assertLegacyImageFlowOptIn(scriptName: string, operation: string): void {
  if (!warningPrinted) {
    console.warn(
      `[legacy/non-production] ${scriptName}: ${operation}. ` +
      "Current production generates only character images; scene visuals are Agnes text-to-video clips.",
    );
    warningPrinted = true;
  }

  if (!process.argv.includes(LEGACY_IMAGE_FLOW_OPT_IN_FLAG)) {
    throw new Error(
      `${scriptName} is disabled by default because it can make paid legacy image calls or mutate legacy image artifacts. ` +
      `If this historical diagnostic is genuinely intended, rerun it with ${LEGACY_IMAGE_FLOW_OPT_IN_FLAG}. ` +
      "Its key-art/scene-image outputs are not part of production assembly.",
    );
  }
}
