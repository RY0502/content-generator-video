import { inspectEpisodeNarrationManifest } from "./narrationContract.js";

/** Agnes accepts at most five named portrait references in one scene request. */
export const MAX_SCENE_MAIN_CHARACTER_COUNT = 5;

export interface ProductionScriptInspection {
  pass: boolean;
  sceneCount: number;
  totalSpokenWords: number;
  issues: string[];
}

/**
 * Typed boundary error used by media preflights. Tool wrappers may safely turn
 * this error into an actionable agent result; unrelated audio, filesystem, and
 * provider errors must continue to propagate.
 */
export class ProductionScriptContractError extends Error {
  readonly inspection: ProductionScriptInspection;

  constructor(
    inspection: ProductionScriptInspection,
    prefix = "Persisted episode script violates the production contract",
  ) {
    super(`${prefix}: ${inspection.issues.join(" | ")}`);
    this.name = "ProductionScriptContractError";
    this.inspection = inspection;
  }
}

export interface AgnesSubmissionEvidence {
  status: string;
  attemptCount: number;
  providerTaskId: string | null;
  providerReceipt: unknown | null;
  submittedAt: string | null;
}

export type ProductionScriptReadinessStatus =
  | "ready"
  | "repair_required"
  | "repair_blocked";

export interface ProductionScriptReadiness {
  status: ProductionScriptReadinessStatus;
  pass: boolean;
  sceneCount: number;
  totalSpokenWords: number;
  issueCount: number;
  /** A bounded sample keeps the agent context useful even for many bad scenes. */
  issues: string[];
  omittedIssueCount: number;
  agnesSubmissionStarted: boolean;
  startedAssetCount: number;
  canReplaceScript: boolean;
  nextAction: string;
}

const MAX_REPORTED_SCRIPT_ISSUES = 12;

/** Mirrors the durable script-replacement guard in SeriesState. */
export function hasStartedAgnesSubmission(row: AgnesSubmissionEvidence): boolean {
  return row.attemptCount > 0
    || row.providerTaskId !== null
    || row.providerReceipt !== null
    || row.submittedAt !== null
    || row.status !== "pending";
}

/**
 * Produces the same concise, non-mutating verdict for get_next_episode and the
 * Agnes phase tools. A script is repairable only before any provider work has
 * begun; this preserves accepted receipts across reruns.
 */
export function productionScriptReadiness(
  inspection: ProductionScriptInspection,
  agnesRows: readonly AgnesSubmissionEvidence[],
): ProductionScriptReadiness {
  const startedAssetCount = agnesRows.filter(hasStartedAgnesSubmission).length;
  const agnesSubmissionStarted = startedAssetCount > 0;
  const status: ProductionScriptReadinessStatus = inspection.pass
    ? "ready"
    : agnesSubmissionStarted
      ? "repair_blocked"
      : "repair_required";
  const issues = inspection.issues.slice(0, MAX_REPORTED_SCRIPT_ISSUES);

  return {
    status,
    pass: inspection.pass,
    sceneCount: inspection.sceneCount,
    totalSpokenWords: inspection.totalSpokenWords,
    issueCount: inspection.issues.length,
    issues,
    omittedIssueCount: Math.max(0, inspection.issues.length - issues.length),
    agnesSubmissionStarted,
    startedAssetCount,
    canReplaceScript: !agnesSubmissionStarted,
    nextAction: status === "ready"
      ? "Continue from the episode's persisted stage."
      : status === "repair_required"
        ? "Resume the durable draft by episodeId with refine_episode_script; pass only its compact draft revision when one is reported. Continue only when it returns status=ready and persisted=true, then regenerate exact-text narration audio before retrying Agnes. Never retransmit scriptJson through refinement or update_episode_status."
        : "Stop this run and report that the invalid script is locked by durable Agnes submission evidence; do not replace the script or submit any additional asset.",
  };
}

export function inspectProductionScriptReadiness(
  value: unknown,
  mainCharacterNames: readonly string[],
  agnesRows: readonly AgnesSubmissionEvidence[],
): ProductionScriptReadiness {
  return productionScriptReadiness(
    inspectProductionScript(value, mainCharacterNames),
    agnesRows,
  );
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function supportingEntityName(descriptor: string, index: number): string {
  const prefix = descriptor.split(":", 1)[0]?.replace(/\s+/gu, " ").trim();
  return prefix || `Supporting entity ${index + 1}`;
}

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}



/**
 * Rejects only unmistakable transport/authoring stubs. This intentionally does
 * not score prose quality: ordinary short scene text remains valid, while
 * values such as `...` and `scene 49 action` can never reach Agnes.
 */
function isSyntheticSceneFieldPlaceholder(
  text: string,
  field: "environmentDescription" | "action",
): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const label = field === "environmentDescription"
    ? "(?:environment|environment description)"
    : "action";
  return new RegExp(
    `^(?:scene\\s+\\d+\\s+${label}|${label}\\s+(?:for\\s+)?scene\\s+\\d+)[.!?\\u2026_-]*$`,
    "iu",
  ).test(text);
}

function requiredText(
  scene: Record<string, unknown>,
  field: "environmentDescription" | "action",
  label: string,
  issues: string[],
): string {
  const text = normalizedText(scene[field]);
  if (!text) {
    issues.push(`${label} is missing required ${field}.`);
  } else if (isSyntheticSceneFieldPlaceholder(text, field)) {
    issues.push(`${label} ${field} must be real filmable prose, not a placeholder.`);
  }
  return text;
}

function stringArray(
  value: unknown,
  field: string,
  label: string,
  issues: string[],
  required: boolean,
): string[] {
  if (!Array.isArray(value)) {
    if (required || value !== undefined) issues.push(`${label} ${field} must be an array of strings.`);
    return [];
  }
  const output: string[] = [];
  value.forEach((item, index) => {
    const text = normalizedText(item);
    if (!text) issues.push(`${label} ${field}[${index}] must be a non-empty string.`);
    else output.push(text);
  });
  if (new Set(output).size !== output.length) {
    issues.push(`${label} ${field} contains duplicate entries.`);
  }
  return output;
}

/**
 * Validates only the objective production boundary required by TTS and Agnes:
 * a 40-60 scene manifest, bounded narration, filmable action/environment text,
 * and an exact, unique main-character roster. Rich visual metadata remains
 * useful authoring input but is deliberately advisory because Agnes receives
 * canonical portrait references plus these exact character names.
 */
export function inspectProductionScript(
  value: unknown,
  mainCharacterNames: readonly string[],
): ProductionScriptInspection {
  const narration = inspectEpisodeNarrationManifest(value);
  const issues = [...narration.issues];
  const root = parseJson(value);
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return { ...narration, pass: false, issues };
  }
  const scenes = parseJson((root as Record<string, unknown>).scenes);
  if (!Array.isArray(scenes)) {
    return { ...narration, pass: false, issues };
  }

  const roster = mainCharacterNames.map((name) => normalizedText(name)).filter(Boolean);
  const rosterSet = new Set(roster);
  if (roster.length === 0 || rosterSet.size !== roster.length) {
    issues.push("The fixed main-character roster must contain unique, non-empty names.");
  }

  scenes.forEach((entry, index) => {
    const label = `Scene ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const scene = entry as Record<string, unknown>;
    requiredText(scene, "environmentDescription", label, issues);
    requiredText(scene, "action", label, issues);

    const characterNames = stringArray(scene.characterNames, "characterNames", label, issues, true);
    if (characterNames.length > MAX_SCENE_MAIN_CHARACTER_COUNT) {
      issues.push(
        `${label} characterNames contains ${characterNames.length} names; at most ` +
        `${MAX_SCENE_MAIN_CHARACTER_COUNT} exact roster names are allowed.`,
      );
    }
    for (const name of characterNames) {
      if (!rosterSet.has(name)) {
        issues.push(
          `${label} characterNames contains non-roster name "${name}"; guests belong in supportingEntities.`,
        );
      }
    }

    const supportingEntities = stringArray(
      scene.supportingEntities,
      "supportingEntities",
      label,
      issues,
      false,
    );
    const supportingNames = supportingEntities.map(supportingEntityName);
    const allCastNames = [...characterNames, ...supportingNames];
    if (new Set(allCastNames.map((name) => name.toLocaleLowerCase())).size !== allCastNames.length) {
      issues.push(
        `${label} visible cast must contain each main or supporting figure exactly once.`,
      );
    }
    stringArray(
      scene.continuityAnchors,
      "continuityAnchors",
      label,
      issues,
      false,
    );
  });

  return {
    pass: issues.length === 0,
    sceneCount: narration.sceneCount,
    totalSpokenWords: narration.totalSpokenWords,
    issues,
  };
}
