import { inspectEpisodeNarrationManifest } from "./narrationContract.js";

const COLLECTIVE_SUPPORTING_IDENTITY_PATTERN =
  /\b(?:cluster|crowd|duo|family|flock|group|herd|pair|trio)\b/iu;
const AMBIGUOUS_VISUAL_CAST_ALIAS_PATTERN =
  /\b(?:animals?|bab(?:y|ies)|backpacks?|bags?|boys?|children|companions?|creatures?|crew|dinos?|dinosaurs?|duo|everyone|family|friends?|girls?|groups?|kids?|others?|pair|people|team|trio)\b/iu;
const UNCOUNTED_BACKGROUND_FIGURE_PATTERN =
  /\b(?:bystanders?|crowds?|flocks?|herds?|onlookers?|groups? of (?:animals|children|creatures|dinosaurs?|people)|grazing (?:animals|creatures|dinosaurs?|herbivores?))\b/iu;

const CHARACTER_VISUAL_FORMS = new Set([
  "real_creature",
  "humanoid",
  "anthropomorphic_creature",
  "object_character",
  "fantasy_creature",
]);

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

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function requiredText(
  scene: Record<string, unknown>,
  field: "environmentDescription" | "action" | "sceneDetails" | "cameraAngle" | "lighting",
  label: string,
  issues: string[],
): string {
  const text = normalizedText(scene[field]);
  if (!text) issues.push(`${label} is missing required ${field}.`);
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

function descriptorIdentity(descriptor: string): string {
  return descriptor.split(":", 1)[0]!.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function withoutStableFigureNames(text: string, names: readonly string[]): string {
  return [...names]
    .sort((left, right) => right.length - left.length)
    .reduce((output, name) => {
      // Malformed overlong names are reported elsewhere; never let one create
      // an engine-sized dynamic RegExp while producing a bounded verdict.
      if (!name || name.length > 500) return output;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return output.replace(new RegExp(`\\b${escaped}\\b`, "giu"), " ");
    }, text);
}

function mentionedStableFigureNames(text: string, names: readonly string[]): string[] {
  return names.filter((name) => {
    if (!name || name.length > 500) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "iu").test(text);
  });
}

/**
 * Validates the complete persisted production script, including the visual
 * metadata that must survive script-level splitting. This complements the
 * narration-only limits with a fixed-cast and direct-video prompt contract.
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

  const visualIdentityByCharacter = new Map<string, string>();
  const supportingDescriptorByIdentity = new Map<string, string>();
  const sceneBeatBySignature = new Map<string, number>();
  const knownFigureIdentities = new Set(roster.map((name) => name.toLocaleLowerCase()));
  scenes.forEach((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const raw = (entry as Record<string, unknown>).supportingEntities;
    if (!Array.isArray(raw)) return;
    raw.forEach((descriptor) => {
      const text = normalizedText(descriptor);
      if (text) knownFigureIdentities.add(descriptorIdentity(text));
    });
  });

  scenes.forEach((entry, index) => {
    const label = `Scene ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const scene = entry as Record<string, unknown>;
    const environment = requiredText(scene, "environmentDescription", label, issues);
    const action = requiredText(scene, "action", label, issues);
    const sceneDetails = requiredText(scene, "sceneDetails", label, issues);
    requiredText(scene, "cameraAngle", label, issues);
    requiredText(scene, "lighting", label, issues);

    // Renumbering a duplicated entry makes its sceneNumber look unique but does
    // not make it a new filmable beat. Reject byte-insensitive clones before
    // they can create a second TTS request, Agnes render, and assembly entry.
    const narrationText = normalizedText(scene.narrationText);
    const beatSignature = JSON.stringify([
      environment.toLocaleLowerCase(),
      action.toLocaleLowerCase(),
      sceneDetails.toLocaleLowerCase(),
      narrationText.toLocaleLowerCase(),
    ]);
    if (environment && action && sceneDetails && narrationText) {
      const duplicateOf = sceneBeatBySignature.get(beatSignature);
      if (duplicateOf !== undefined) {
        issues.push(
          `${label} duplicates the complete narration/action beat from Scene ${duplicateOf}; ` +
          "each scene must be a distinct visible beat.",
        );
      } else {
        sceneBeatBySignature.set(beatSignature, index + 1);
      }
    }

    const characterNames = stringArray(scene.characterNames, "characterNames", label, issues, true);
    for (const name of characterNames) {
      if (!rosterSet.has(name)) {
        issues.push(
          `${label} characterNames contains non-roster name "${name}"; guests belong in supportingEntities.`,
        );
      }
    }

    const rawVisuals = scene.characterVisuals;
    if (!Array.isArray(rawVisuals)) {
      issues.push(`${label} characterVisuals must be an array aligned 1:1 with characterNames.`);
    } else {
      if (rawVisuals.length !== characterNames.length) {
        issues.push(`${label} characterVisuals must align 1:1 with characterNames.`);
      }
      rawVisuals.forEach((visual, visualIndex) => {
        if (!visual || typeof visual !== "object" || Array.isArray(visual)) {
          issues.push(`${label} characterVisuals[${visualIndex}] must be an object.`);
          return;
        }
        const item = visual as Record<string, unknown>;
        const name = normalizedText(item.name);
        if (!name || name !== characterNames[visualIndex]) {
          issues.push(`${label} characterVisuals[${visualIndex}].name must exactly match characterNames order.`);
        }
        if (!CHARACTER_VISUAL_FORMS.has(String(item.visualForm))) {
          issues.push(`${label} characterVisuals[${visualIndex}] has an invalid visualForm.`);
        }
        if (item.speciesOrType !== undefined && !normalizedText(item.speciesOrType)) {
          issues.push(`${label} characterVisuals[${visualIndex}].speciesOrType must be non-empty when supplied.`);
        }
        if (item.humanoidAllowed !== undefined && typeof item.humanoidAllowed !== "boolean") {
          issues.push(`${label} characterVisuals[${visualIndex}].humanoidAllowed must be boolean when supplied.`);
        }
        if (name) {
          const identity = JSON.stringify({
            visualForm: item.visualForm,
            speciesOrType: normalizedText(item.speciesOrType) || null,
            humanoidAllowed: item.humanoidAllowed ?? null,
          });
          const prior = visualIdentityByCharacter.get(name);
          if (prior && prior !== identity) {
            issues.push(`${label} changes locked characterVisuals metadata for "${name}".`);
          } else {
            visualIdentityByCharacter.set(name, identity);
          }
        }
      });
    }

    const supportingEntities = stringArray(
      scene.supportingEntities,
      "supportingEntities",
      label,
      issues,
      false,
    );
    const supportingIdentities = supportingEntities.map(descriptorIdentity).filter(Boolean);
    if (new Set(supportingIdentities).size !== supportingIdentities.length) {
      issues.push(`${label} supportingEntities contains the same stable identity more than once.`);
    }
    supportingEntities.forEach((descriptor) => {
      if (!descriptor.includes(":")) {
        issues.push(
          `${label} supporting entity "${descriptor}" must use "Stable name: locked visual descriptor" format.`,
        );
      }
      const identity = descriptorIdentity(descriptor);
      if (COLLECTIVE_SUPPORTING_IDENTITY_PATTERN.test(identity)) {
        issues.push(
          `${label} supporting entity "${descriptor.split(":", 1)[0]}" is a group. ` +
          "Each supportingEntities entry must identify exactly one visible individual.",
        );
      }
      if (roster.some((name) => name.toLocaleLowerCase() === identity)) {
        issues.push(`${label} places main character "${descriptor.split(":", 1)[0]}" in supportingEntities.`);
      }
      const prior = supportingDescriptorByIdentity.get(identity);
      if (prior && prior !== descriptor) {
        issues.push(
          `${label} changes the supportingEntities descriptor for "${descriptor.split(":", 1)[0]}"; ` +
          "repeat recurring descriptors verbatim.",
        );
      } else if (identity) {
        supportingDescriptorByIdentity.set(identity, descriptor);
      }
    });

    const anchors = stringArray(
      scene.continuityAnchors,
      "continuityAnchors",
      label,
      issues,
      false,
    );
    anchors.forEach((anchor) => {
      const overlappingIdentities = mentionedStableFigureNames(anchor, [...knownFigureIdentities]);
      if (overlappingIdentities.length > 0) {
        issues.push(
          `${label} continuity anchor "${anchor.split(":", 1)[0]}" redefines a character or living entity. ` +
          "continuityAnchors are only for non-living props, layout, and environmental state; keep figure state in action or sceneDetails.",
        );
      }
    });
    const figuresInEnvironment = mentionedStableFigureNames(environment, [...knownFigureIdentities]);
    if (figuresInEnvironment.length > 0) {
      issues.push(
        `${label} environmentDescription mentions visible figure ${JSON.stringify(figuresInEnvironment[0])}. ` +
        "Keep environments figure-free and put every visible individual only in characterNames or supportingEntities.",
      );
    }
    if (UNCOUNTED_BACKGROUND_FIGURE_PATTERN.test(environment)) {
      issues.push(
        `${label} environmentDescription introduces uncounted background figures. ` +
        "Keep environments figure-free and list every visible individual in characterNames or supportingEntities.",
      );
    }
    const exactSceneFigureNames = [
      ...characterNames,
      ...supportingEntities.map((descriptor) => descriptor.split(":", 1)[0]!.trim()),
    ];
    const declaredButUnstagedFigures = exactSceneFigureNames.filter(
      (name) => mentionedStableFigureNames(`${action} ${sceneDetails}`, [name]).length === 0,
    );
    if (declaredButUnstagedFigures.length > 0) {
      issues.push(
        `${label} declares figure ${JSON.stringify(declaredButUnstagedFigures[0])} but never names it in action/sceneDetails. ` +
        "Explicitly stage every declared visible individual by its exact stable name so the cast count is unambiguous.",
      );
    }
    const exactSceneFigureIdentitySet = new Set(
      exactSceneFigureNames.map((name) => name.toLocaleLowerCase()),
    );
    const unlistedKnownFigures = [...knownFigureIdentities].filter(
      (identity) => !exactSceneFigureIdentitySet.has(identity),
    );
    const mentionedUnlistedFigures = mentionedStableFigureNames(
      `${action} ${sceneDetails}`,
      unlistedKnownFigures,
    );
    if (mentionedUnlistedFigures.length > 0) {
      issues.push(
        `${label} action/sceneDetails mentions unlisted figure ${JSON.stringify(mentionedUnlistedFigures[0])}. ` +
        "Every visible figure must be counted exactly once in characterNames or supportingEntities for this scene.",
      );
    }
    const visualTextWithoutStableNames = withoutStableFigureNames(
      `${action} ${sceneDetails}`,
      exactSceneFigureNames,
    );
    if (AMBIGUOUS_VISUAL_CAST_ALIAS_PATTERN.test(visualTextWithoutStableNames)) {
      issues.push(
        `${label} action/sceneDetails uses a collective or generic cast alias. ` +
        "Use the exact stable name of every visible figure, including object characters, so one alias cannot become a second body.",
      );
    }
  });

  return {
    pass: issues.length === 0,
    sceneCount: narration.sceneCount,
    totalSpokenWords: narration.totalSpokenWords,
    issues,
  };
}
