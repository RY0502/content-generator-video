import { inspectEpisodeNarrationManifest } from "./narrationContract.js";

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
  let previousEnvironment = "";

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
    supportingEntities.forEach((descriptor) => {
      if (!descriptor.includes(":")) {
        issues.push(
          `${label} supporting entity "${descriptor}" must use "Stable name: locked visual descriptor" format.`,
        );
      }
      const identity = descriptorIdentity(descriptor);
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
    if (index > 0 && environment && environment === previousEnvironment && anchors.length === 0) {
      issues.push(`${label} continues the same environment but has no continuityAnchors.`);
    }
    previousEnvironment = environment;
  });

  return {
    pass: issues.length === 0,
    sceneCount: narration.sceneCount,
    totalSpokenWords: narration.totalSpokenWords,
    issues,
  };
}
