import { inspectEpisodeNarrationManifest } from "./narrationContract.js";
import { containsExactRosterOrAlias } from "./sceneCastCanonicalizer.js";
import { partitionSupportingEntities, isSupportingProp } from "../promptBuilder.js";

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
    if (characterNames.length === 0) {
      const actionText = normalizedText(scene.action);
      const narrationTextVal = normalizedText(scene.narrationText);
      const combinedText = `${actionText} ${narrationTextVal}`;
      const mentionedCharacters: string[] = [];
      for (const rosterName of roster) {
        if (containsExactRosterOrAlias(combinedText, rosterName)) {
          mentionedCharacters.push(rosterName);
        }
      }
      if (mentionedCharacters.length > 0) {
        issues.push(
          `${label} action/narration mentions main character ${mentionedCharacters.map((c) => `"${c}"`).join(", ")} ` +
          `but characterNames is empty; active main characters must be listed in characterNames.`,
        );
      }
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
    const { figures: supportingFigures, originalIndices } = partitionSupportingEntities(supportingEntities);
    const supportingNames = supportingFigures.map((entity, figureIdx) => {
      const origIndex = originalIndices.figures[figureIdx] ?? figureIdx;
      return supportingEntityName(entity, origIndex);
    });
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
    validateFocalPropContinuity(scene, label, issues);
    validatePropAnthropomorphization(scene, label, issues);
  });

  validateVisualCoPresence(scenes, (root as Record<string, unknown>).authoringPlan, rosterSet, issues);

  return {
    pass: issues.length === 0,
    sceneCount: narration.sceneCount,
    totalSpokenWords: narration.totalSpokenWords,
    issues,
  };
}

export const FOCAL_CONTINUITY_PATTERNS: Array<{ noun: string; pattern: RegExp; isStructure?: boolean }> = [
  { noun: "bridge", pattern: /\bbridges?\b/i, isStructure: true },
  { noun: "raft", pattern: /\brafts?\b/i, isStructure: true },
  { noun: "ladder", pattern: /\bladders?\b/i, isStructure: true },
  { noun: "treehouse", pattern: /\btreehouses?\b/i, isStructure: true },
  { noun: "shelter", pattern: /\bshelters?\b/i, isStructure: true },
  { noun: "refrigerator", pattern: /\b(?:refrigerator|fridge|freezer)s?\b/i, isStructure: true },
  { noun: "laundry basket", pattern: /\b(?:laundry|clothes)\s+baskets?\b/i, isStructure: true },
  { noun: "sock", pattern: /\b(?:socks?|stockings?)\b/i },
  { noun: "kite", pattern: /\bkites?\b/i },
  { noun: "ribbon", pattern: /\bribbons?\b/i },
  { noun: "basket", pattern: /(?<!(?:laundry|clothes)\s+)\b(?:picnic\s+)?baskets?\b/i },
  { noun: "map", pattern: /\bmaps?\b/i },
  { noun: "compass", pattern: /\bcompass(?:es)?\b/i },
  { noun: "cart", pattern: /\b(?:carts?|wagons?)\b/i },
  { noun: "key", pattern: /\bkeys?\b/i },
  { noun: "clock", pattern: /\bclocks?\b/i },
  { noun: "umbrella", pattern: /\bumbrellas?\b/i },
];

/**
 * Detects if a mention of a noun in narration is purely about an unfound / missing
 * item (the objective of an ongoing search) where the action does not physically
 * depict characters holding, retrieving, carrying, or interacting with it.
 */
export function isUnfoundMissingItemSearch(
  actionText: string,
  narrationText: string,
  noun: string,
): boolean {
  const nounPattern = new RegExp(`\\b${noun.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`, "i");
  if (nounPattern.test(actionText)) return false;
  const searchOrAbsence = /\b(?:missing|lost|disappeared|was\s+gone|is\s+gone|search(?:ing)?\s+for|look(?:ing)?\s+for|hoping\s+to\s+spot|wondered\s+where)\b/i;
  return searchOrAbsence.test(narrationText);
}

export function validateFocalPropContinuity(
  scene: Record<string, unknown>,
  label: string,
  issues: string[],
): void {
  const actionText = typeof scene.action === "string" ? scene.action.trim() : "";
  const narrationText = typeof scene.narrationText === "string" ? scene.narrationText.trim() : "";
  const combinedActionNarration = `${actionText} ${narrationText}`;
  if (!combinedActionNarration) return;

  const envText = (typeof scene.environmentDescription === "string" ? scene.environmentDescription : "").toLowerCase();
  const rawAnchors = Array.isArray(scene.continuityAnchors)
    ? scene.continuityAnchors.filter((a): a is string => typeof a === "string")
    : [];
  const anchorsText = rawAnchors.join(" ").toLowerCase();
  const rawSupporting = Array.isArray(scene.supportingEntities)
    ? scene.supportingEntities.filter((e): e is string => typeof e === "string")
    : [];
  const supportingText = rawSupporting.join(" ").toLowerCase();
  const combinedDefinedText = `${envText} ${anchorsText} ${supportingText}`;

  for (const { noun, pattern, isStructure } of FOCAL_CONTINUITY_PATTERNS) {
    if (pattern.test(combinedActionNarration)) {
      if (isUnfoundMissingItemSearch(actionText, narrationText, noun)) {
        continue;
      }
      const nounTokens = noun.split(/\s+/);
      const hasNoun = nounTokens.every((token) => combinedDefinedText.includes(token));
      if (!hasNoun) {
        if (isStructure) {
          issues.push(
            `${label} action/narration features focal structure/container "${noun}", but neither continuityAnchors nor environmentDescription defines it. Multi-scene structures and containers must have a locked visual descriptor in continuityAnchors to prevent visual morphing across scenes.`,
          );
        } else {
          issues.push(
            `${label} action/narration features focal prop "${noun}", but neither supportingEntities nor continuityAnchors defines it. Multi-scene props and quest items must have a locked visual descriptor in supportingEntities or continuityAnchors to prevent visual morphing or absence across scenes.`,
          );
        }
      }
    }
  }
}

export interface RegisteredSupportingEntityInfo {
  name: string;
  isProp: boolean;
  nounPattern: RegExp;
  descriptor: string;
}

export function collectRegisteredSupportingEntities(
  scenes: unknown[],
  plan?: unknown,
): RegisteredSupportingEntityInfo[] {
  const entityMap = new Map<string, RegisteredSupportingEntityInfo>();

  const rawEntries: string[] = [];
  if (plan && typeof plan === "object") {
    const bible = (plan as Record<string, unknown>).supportingEntityBible;
    if (Array.isArray(bible)) {
      bible.forEach((item) => {
        if (typeof item === "string" && item.trim()) rawEntries.push(item.trim());
      });
    }
  }
  scenes.forEach((entry) => {
    if (entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).supportingEntities)) {
      ((entry as Record<string, unknown>).supportingEntities as unknown[]).forEach((item) => {
        if (typeof item === "string" && item.trim()) rawEntries.push(item.trim());
      });
    }
  });

  for (const entry of rawEntries) {
    const colonIdx = entry.indexOf(":");
    const namePrefix = colonIdx >= 0 ? entry.slice(0, colonIdx).trim() : entry.trim();
    const cleanKey = namePrefix.toLowerCase();
    if (!cleanKey || entityMap.has(cleanKey)) continue;

    const isProp = isSupportingProp(entry);
    const descriptor = colonIdx >= 0 ? entry.slice(colonIdx + 1).trim() : entry.trim();

    let nounPattern: RegExp | null = null;
    if (!isProp) {
      const creatureMatch = /\b(?:mouse|mice|rat|rats|rabbit|bunny|bear|fox|owl|bird|sparrow|ant|bee|beetle|butterfly|caterpillar|frog|squirrel|chipmunk|hedgehog|mole|deer|puppy|dog|kitten|cat|dragon|dinosaur|duck|snail|cricket|firefly|hamster|turtle|ladybug|ladybird)\b/i.exec(cleanKey);
      if (creatureMatch) {
        const word = creatureMatch[0].toLowerCase();
        if (word === "mouse" || word === "mice") {
          nounPattern = /\b(?:mouse|mice)\b/i;
        } else if (word === "ladybug" || word === "ladybird") {
          nounPattern = /\b(?:ladybugs?|ladybirds?)\b/i;
        } else if (word === "bunny" || word === "rabbit") {
          nounPattern = /\b(?:bunn(?:y|ies)|rabbits?)\b/i;
        } else {
          nounPattern = new RegExp(`\\b${word}s?\\b`, "i");
        }
      } else if (cleanKey.includes("tick-tock")) {
        nounPattern = /\b(?:tick-tock|clockwork)\b/i;
      } else {
        const tokens = cleanKey.split(/\s+/).filter((w) => w.length > 2 && !["the", "old", "new", "tiny", "little", "big", "toy", "guest", "friend"].includes(w));
        if (tokens.length > 0) {
          nounPattern = new RegExp(`\\b(?:${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
        }
      }
    } else {
      const propMatch = /\b(?:socks?|stockings?|kites?|ribbons?|baskets?|maps?|compass(?:es)?|blankets?|carts?|wagons?|keys?|lanterns?|clocks?|umbrellas?|bridges?|rafts?|ladders?|shelters?)\b/i.exec(cleanKey);
      if (propMatch) {
        const word = propMatch[0].toLowerCase().replace(/s$/, "");
        nounPattern = new RegExp(`\\b${word}s?\\b`, "i");
      } else {
        const tokens = cleanKey.split(/\s+/).filter((w) => w.length > 2 && !["the", "old", "new", "tiny", "little", "big", "blue", "red", "green"].includes(w));
        if (tokens.length > 0) {
          nounPattern = new RegExp(`\\b(?:${tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");
        }
      }
    }

    if (nounPattern) {
      entityMap.set(cleanKey, {
        name: namePrefix,
        isProp,
        nounPattern,
        descriptor,
      });
    }
  }

  return Array.from(entityMap.values());
}

export function validateVisualCoPresence(
  scenes: unknown[],
  plan: unknown,
  rosterSet: Set<string>,
  issues: string[],
): void {
  const registeredEntities = collectRegisteredSupportingEntities(scenes, plan);
  if (registeredEntities.length === 0) return;

  scenes.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const scene = entry as Record<string, unknown>;
    const label = `Scene ${index + 1}`;

    const actionText = normalizedText(scene.action);
    const narrationText = normalizedText(scene.narrationText);
    const combinedActionNarration = `${actionText} ${narrationText}`;
    if (!combinedActionNarration) return;

    const rawSupporting = Array.isArray(scene.supportingEntities)
      ? scene.supportingEntities.filter((e): e is string => typeof e === "string")
      : [];
    const rawAnchors = Array.isArray(scene.continuityAnchors)
      ? scene.continuityAnchors.filter((a): a is string => typeof a === "string")
      : [];
    const envText = normalizedText(scene.environmentDescription).toLowerCase();
    const characterNames = Array.isArray(scene.characterNames)
      ? scene.characterNames.filter((c): c is string => typeof c === "string")
      : [];

    const combinedSupporting = rawSupporting.join(" ").toLowerCase();
    const combinedAnchors = rawAnchors.join(" ").toLowerCase();
    const combinedEnvAndAnchors = `${envText} ${combinedAnchors} ${combinedSupporting}`;

    for (const entity of registeredEntities) {
      const mentionsInAction = entity.nounPattern.test(actionText);
      const mentionsInNarration = entity.nounPattern.test(narrationText);
      if (!mentionsInAction && !mentionsInNarration) continue;

      if (!mentionsInAction && isUnfoundMissingItemSearch(actionText, narrationText, entity.name)) {
        continue;
      }

      if (!entity.isProp) {
        const isPresentInSupporting = entity.nounPattern.test(combinedSupporting);
        const isPresentInRoster = characterNames.some((name) => entity.nounPattern.test(name.toLowerCase()));
        if (!isPresentInSupporting && !isPresentInRoster) {
          const msg = `${label} action/narration mentions supporting figure "${entity.name}" but it is omitted from supportingEntities; active supporting figures must be declared so Agnes renders them.`;
          if (!issues.includes(msg)) {
            issues.push(msg);
          }
        }
      } else {
        const isPresent = entity.nounPattern.test(combinedEnvAndAnchors);
        if (!isPresent) {
          const alreadyFlagged = issues.some((i) => i.startsWith(label) && i.includes(`"${entity.name}"`));
          if (!alreadyFlagged) {
            issues.push(
              `${label} action/narration features focal prop "${entity.name}", but neither supportingEntities nor continuityAnchors defines it. Multi-scene props and quest items must have a locked visual descriptor in supportingEntities or continuityAnchors to prevent visual morphing or absence across scenes.`,
            );
          }
        }
      }
    }
  });
}

const PROP_ANTHROPOMORPHIZATION_PATTERNS: RegExp[] = [
  /\b(?:eyes?|eyeballs?|eyelashes?)\b/i,
  /\b(?:mouths?|lips?|teeth|smiles?|smiling|grins?|grinning|frowns?|frowning)\b/i,
  /\b(?:arms?|hands?|fingers?|legs?|feet|foot|toes?|limbs?)\b/i,
  /\b(?:faces?|cheeks?|noses?|snouts?|ears?)\b/i,
  /\b(?:speaks?|speaking|talks?|talking|whispers?|cries?|crying)\b/i,
];

export function validatePropAnthropomorphization(
  scene: Record<string, unknown>,
  label: string,
  issues: string[],
): void {
  const rawEntities = Array.isArray(scene.supportingEntities)
    ? scene.supportingEntities.filter((e): e is string => typeof e === "string")
    : [];
  if (rawEntities.length === 0) return;

  const { props } = partitionSupportingEntities(rawEntities);
  for (const prop of props) {
    const desc = prop.includes(":") ? prop.slice(prop.indexOf(":") + 1).trim() : "";
    if (!desc) continue;
    const propName = prop.split(":", 1)[0]?.trim() || "Prop";
    for (const pattern of PROP_ANTHROPOMORPHIZATION_PATTERNS) {
      const match = pattern.exec(desc);
      if (match) {
        issues.push(
          `${label} supporting prop "${propName}" contains forbidden creature/human anatomy token "${match[0]}" in its description ("${desc}"). Inanimate props and structures must have physical blueprints only, with strictly no eyes, face, limbs, or creature anatomy.`,
        );
        break;
      }
    }
  }
}

