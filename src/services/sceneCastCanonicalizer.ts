/**
 * Deterministic, side-effect-free normalization for the invariant parts of an
 * authored scene cast. This module intentionally owns no episode/state types so
 * callers can use it at authoring, persistence, or preflight boundaries.
 */

export type SceneCastRecord = Readonly<Record<string, unknown>>;

export interface SceneCastLike {
  sceneNumber?: unknown;
  narrationText?: unknown;
  environmentDescription?: unknown;
  action?: unknown;
  sceneDetails?: unknown;
  characterNames?: unknown;
  characterVisuals?: unknown;
  supportingEntities?: unknown;
  continuityAnchors?: unknown;
  cameraAngle?: unknown;
  lighting?: unknown;
}

export type CanonicalCharacterVisualSource =
  | ReadonlyMap<string, SceneCastRecord>
  | Readonly<Record<string, SceneCastRecord>>;

export type CanonicalSupportingDescriptorSource =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>;

export interface SceneCastCanonicalizationOptions {
  /** Already accepted scenes, in durable order. First established metadata wins. */
  durableAcceptedScenes?: readonly SceneCastLike[];
  /** Explicit canonical metadata has precedence over metadata discovered in accepted scenes. */
  canonicalCharacterVisuals?: CanonicalCharacterVisualSource;
  /** Locked `Stable name: descriptor` entries used when no accepted scene established that identity. */
  supportingEntityBible?: readonly string[];
  /** Explicit descriptors have precedence over the bible and accepted scenes. */
  canonicalSupportingDescriptors?: CanonicalSupportingDescriptorSource;
  /** Protect the script tool's production sceneDetails bound. Defaults to 2,500. */
  maximumSceneDetailsLength?: number;
}

export type SceneCastAppliedChange =
  | {
      kind: "canonical_character_visual";
      field: "characterVisuals";
      name: string;
      index: number;
      source: "explicit" | "durable";
    }
  | {
      kind: "canonical_supporting_descriptor";
      field: "supportingEntities";
      name: string;
      index: number;
      source: "explicit" | "bible" | "durable";
    }
  | {
      kind: "safe_object_alias";
      field: "action" | "sceneDetails";
      before: string;
      after: string;
      occurrences: number;
    }
  | {
      kind: "exact_visible_presence";
      field: "sceneDetails";
      names: string[];
    };

export type SceneCastUnresolvedIssue =
  | {
      kind: "canonical_source_conflict";
      field: "characterVisuals" | "supportingEntities";
      name: string;
      keptSource: "explicit" | "bible" | "durable";
      ignoredSource: "explicit" | "bible" | "durable";
    }
  | {
      kind: "missing_character_visual";
      field: "characterVisuals";
      name: string;
    }
  | {
      kind: "missing_supporting_descriptor";
      field: "supportingEntities";
      name: string;
    }
  | {
      kind: "invalid_cast_entry";
      field: "characterNames" | "characterVisuals" | "supportingEntities";
      index: number;
    }
  | {
      kind: "ambiguous_object_alias";
      field: "action" | "sceneDetails";
      alias: string;
      candidates: string[];
    }
  | {
      kind: "generic_or_group_alias";
      field: "action" | "sceneDetails";
      alias: string;
    }
  | {
      kind: "presence_clause_too_large";
      field: "sceneDetails";
      names: string[];
      maximumLength: number;
    };

export interface SceneCastCanonicalizationAudit {
  applied: SceneCastAppliedChange[];
  unresolved: SceneCastUnresolvedIssue[];
}

export interface SceneCastCanonicalizationResult<TScene extends SceneCastLike> {
  /** A new shallow scene object. The input and its arrays are never mutated. */
  scene: TScene;
  /** Exact, de-duplicated visible names in declared order after descriptor locking. */
  exactCastNames: string[];
  audit: SceneCastCanonicalizationAudit;
  changed: boolean;
}

type VisualSource = {
  value: SceneCastRecord;
  source: "explicit" | "durable";
};

type DescriptorSource = {
  value: string;
  source: "explicit" | "bible" | "durable";
};

const DEFAULT_MAXIMUM_SCENE_DETAILS_LENGTH = 2_500;
const SAFE_OBJECT_ALIAS_PATTERN = /\bthe\s+(?:backpack|bag|satchel)\b/giu;
const GENERIC_OR_GROUP_ALIAS_PATTERN =
  /\b(?:animals?|bab(?:y|ies)|backpacks?|bags?|boys?|calves?|children|companions?|creatures?|crew|crowds?|dinos?|dinosaurs?|duo|everyone|famil(?:y|ies)|flocks?|friends?|girls?|groups?|herds?|kids?|mammoths?|others?|pairs?|people|satchels?|teams?|trios?)\b/giu;
const COLLECTIVE_SUPPORTING_IDENTITY_PATTERN =
  /\b(?:animals|babies|backpacks|bags|boys|calves|children|clusters?|companions|creatures|crew|crowds?|dinos|dinosaurs|duos?|famil(?:y|ies)|fireflies|flocks?|friends|girls|groups?|herds?|kids|mammoths|others|pairs?|people|satchels|teams?|trios?)\b/iu;
const OBJECT_ENTITY_NOUN_PATTERN = /\b(?:backpack|bag|satchel)\b/iu;
const OBJECT_ENTITY_DESCRIPTION_PATTERN =
  /(?:\b(?:animated|enchanted|living|magic(?:al)?|sentient|talking)\b.{0,60}\b(?:backpack|bag|satchel)\b|\b(?:backpack|bag|satchel)\b.{0,60}\b(?:character|face|living|sentient|speaks|talking|talks)\b)/iu;

function normalizedText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function identityKey(value: string): string {
  return normalizedText(value).toLocaleLowerCase();
}

function descriptorIdentity(descriptor: string): string {
  return normalizedText(descriptor.split(":", 1)[0]);
}

function isRecord(value: unknown): value is SceneCastRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function containsExactName(text: string, name: string): boolean {
  if (!name || name.length > 500) return false;
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapedPattern(name)}(?![\\p{L}\\p{N}_])`,
    "iu",
  ).test(text);
}

function textWithoutExactNames(text: string, names: readonly string[]): string {
  return [...names]
    .filter((name) => name && name.length <= 500)
    .sort((left, right) => right.length - left.length)
    .reduce((output, name) => output.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapedPattern(name)}(?![\\p{L}\\p{N}_])`,
        "giu",
      ),
      " ",
    ), text);
}

/**
 * Finds known figures that remain after every declared exact name is masked.
 * Long names are removed first, so legacy `Bobo` does not match inside the
 * declared `Bobo the Backpack`; a separate visible `Bobo` still remains and is
 * correctly reported as an extra body.
 */
export function findMentionedUnlistedFigureNames(
  text: string,
  knownNames: readonly string[],
  declaredExactNames: readonly string[],
): string[] {
  const declaredKeys = new Set(declaredExactNames.map(identityKey));
  const unlistedNames = uniqueNames(knownNames.map(normalizedText))
    .filter((name) => !declaredKeys.has(identityKey(name)));
  const withoutDeclaredNames = textWithoutExactNames(text, declaredExactNames);
  return unlistedNames.filter((name) => containsExactName(withoutDeclaredNames, name));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function sourceEntries<T>(
  source: ReadonlyMap<string, T> | Readonly<Record<string, T>> | undefined,
): Array<readonly [string, T]> {
  if (!source) return [];
  return source instanceof Map
    ? [...source.entries()]
    : Object.entries(source);
}

function pushConflictOnce(
  unresolved: SceneCastUnresolvedIssue[],
  issue: Extract<SceneCastUnresolvedIssue, { kind: "canonical_source_conflict" }>,
): void {
  if (unresolved.some((entry) => (
    entry.kind === issue.kind
    && entry.field === issue.field
    && identityKey(entry.name) === identityKey(issue.name)
    && entry.keptSource === issue.keptSource
    && entry.ignoredSource === issue.ignoredSource
  ))) return;
  unresolved.push(issue);
}

function collectVisualSources(
  options: SceneCastCanonicalizationOptions,
  unresolved: SceneCastUnresolvedIssue[],
): Map<string, VisualSource> {
  const output = new Map<string, VisualSource>();

  const add = (rawName: string, value: unknown, source: VisualSource["source"]): void => {
    if (!isRecord(value)) return;
    const name = normalizedText(value.name) || normalizedText(rawName);
    const key = identityKey(name);
    if (!key) return;
    const candidate: SceneCastRecord = { ...value, name };
    const prior = output.get(key);
    if (!prior) {
      output.set(key, { value: candidate, source });
    } else if (!sameValue(prior.value, candidate)) {
      pushConflictOnce(unresolved, {
        kind: "canonical_source_conflict",
        field: "characterVisuals",
        name,
        keptSource: prior.source,
        ignoredSource: source,
      });
    }
  };

  // Explicit maps are authoritative regardless of accepted-scene ordering.
  sourceEntries(options.canonicalCharacterVisuals).forEach(([name, value]) => {
    add(name, value, "explicit");
  });
  options.durableAcceptedScenes?.forEach((scene) => {
    if (!Array.isArray(scene.characterVisuals)) return;
    scene.characterVisuals.forEach((visual) => {
      if (isRecord(visual)) add(normalizedText(visual.name), visual, "durable");
    });
  });
  return output;
}

function collectDescriptorSources(
  options: SceneCastCanonicalizationOptions,
  unresolved: SceneCastUnresolvedIssue[],
): Map<string, DescriptorSource> {
  const output = new Map<string, DescriptorSource>();

  const add = (rawName: string, rawDescriptor: unknown, source: DescriptorSource["source"]): void => {
    const descriptor = normalizedText(rawDescriptor);
    const name = descriptorIdentity(descriptor) || normalizedText(rawName);
    const key = identityKey(name);
    if (!key || !descriptor) return;
    const prior = output.get(key);
    if (!prior) {
      output.set(key, { value: descriptor, source });
    } else if (prior.value !== descriptor) {
      pushConflictOnce(unresolved, {
        kind: "canonical_source_conflict",
        field: "supportingEntities",
        name,
        keptSource: prior.source,
        ignoredSource: source,
      });
    }
  };

  sourceEntries(options.canonicalSupportingDescriptors).forEach(([name, descriptor]) => {
    add(name, descriptor, "explicit");
  });
  // A durable accepted scene is already part of the episode's visual history,
  // so it outranks a conflicting legacy plan entry. This prevents every later
  // chunk being normalized into descriptor drift that can never be repaired.
  options.durableAcceptedScenes?.forEach((scene) => {
    if (!Array.isArray(scene.supportingEntities)) return;
    scene.supportingEntities.forEach((descriptor) => {
      add(descriptorIdentity(normalizedText(descriptor)), descriptor, "durable");
    });
  });
  options.supportingEntityBible?.forEach((descriptor) => {
    add(descriptorIdentity(descriptor), descriptor, "bible");
  });
  return output;
}

function uniqueNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((name) => {
    const key = identityKey(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function replaceSafeObjectAliases(
  rawText: unknown,
  field: "action" | "sceneDetails",
  objectCharacterNames: readonly string[],
  applied: SceneCastAppliedChange[],
  unresolved: SceneCastUnresolvedIssue[],
): unknown {
  if (typeof rawText !== "string") return rawText;
  let normalized = rawText;

  if (objectCharacterNames.length === 1) {
    const exactName = objectCharacterNames[0]!;
    const firstToken = normalizedText(exactName).split(/\s+/u)[0] ?? "";
    const redundantPatterns = [
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapedPattern(exactName)}\\s+${escapedPattern(exactName)}` +
          `(?![\\p{L}\\p{N}_])`,
        "giu",
      ),
      ...(firstToken && identityKey(firstToken) !== identityKey(exactName)
        ? [new RegExp(
            `(?<![\\p{L}\\p{N}_])${escapedPattern(firstToken)}\\s+${escapedPattern(exactName)}` +
              `(?![\\p{L}\\p{N}_])`,
            "giu",
          )]
        : []),
      new RegExp(
        `(?<![\\p{L}\\p{N}_])${escapedPattern(exactName)}\\s+the\\s+` +
          `(?:backpack|bag|satchel)(?![\\p{L}\\p{N}_])`,
        "giu",
      ),
    ];
    for (const pattern of redundantPatterns) {
      const redundantMatches = [...normalized.matchAll(pattern)];
      if (redundantMatches.length === 0) continue;
      normalized = normalized.replace(pattern, exactName);
      applied.push({
        kind: "safe_object_alias",
        field,
        before: redundantMatches[0]![0],
        after: exactName,
        occurrences: redundantMatches.length,
      });
    }
  }

  const exactNameSpans = objectCharacterNames.flatMap((name) => {
    if (!name || name.length > 500) return [];
    return [...normalized.matchAll(new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapedPattern(name)}(?![\\p{L}\\p{N}_])`,
      "giu",
    ))].flatMap((match) => (
      match.index === undefined
        ? []
        : [{ start: match.index, end: match.index + match[0].length }]
    ));
  });
  const matches = [...normalized.matchAll(SAFE_OBJECT_ALIAS_PATTERN)].filter((match) => {
    if (match.index === undefined) return false;
    const start = match.index;
    const end = start + match[0].length;
    return !exactNameSpans.some((span) => start >= span.start && end <= span.end);
  });
  if (matches.length === 0) return normalized;

  if (objectCharacterNames.length !== 1) {
    uniqueNames(matches.map((match) => match[0])).forEach((alias) => {
      unresolved.push({
        kind: "ambiguous_object_alias",
        field,
        alias,
        candidates: [...objectCharacterNames],
      });
    });
    return normalized;
  }

  const exactName = objectCharacterNames[0]!;
  const countByAlias = new Map<string, { display: string; count: number }>();
  matches.forEach((match) => {
    const display = match[0];
    const key = identityKey(display);
    const current = countByAlias.get(key);
    countByAlias.set(key, { display: current?.display ?? display, count: (current?.count ?? 0) + 1 });
  });
  const output = normalized.replace(
    SAFE_OBJECT_ALIAS_PATTERN,
    (match, ...args: unknown[]) => {
      const offset = args.at(-2);
      if (typeof offset !== "number") return match;
      const end = offset + match.length;
      return exactNameSpans.some((span) => offset >= span.start && end <= span.end)
        ? match
        : exactName;
    },
  );
  countByAlias.forEach(({ display, count }) => {
    applied.push({
      kind: "safe_object_alias",
      field,
      before: display,
      after: exactName,
      occurrences: count,
    });
  });
  return output;
}

/**
 * Finds cast aliases after removing exact stable names. Keeping this lexicon in
 * one pure helper prevents authoring and persisted-script validators drifting.
 */
export function findGenericVisualCastAliases(
  text: string,
  exactCastNames: readonly string[] = [],
): string[] {
  const withoutNames = textWithoutExactNames(text, exactCastNames);
  return uniqueNames([...withoutNames.matchAll(GENERIC_OR_GROUP_ALIAS_PATTERN)]
    .map((match) => match[0]));
}

/** True when a purported stable identity describes multiple possible bodies. */
export function isCollectiveSupportingIdentity(identity: string): boolean {
  return COLLECTIVE_SUPPORTING_IDENTITY_PATTERN.test(normalizedText(identity));
}

function auditGenericAliases(
  rawText: unknown,
  field: "action" | "sceneDetails",
  exactCastNames: readonly string[],
  unresolved: SceneCastUnresolvedIssue[],
): void {
  if (typeof rawText !== "string") return;
  const hasSpecializedObjectAliasIssue = unresolved.some((issue) => (
    issue.kind === "ambiguous_object_alias" && issue.field === field
  ));
  const aliases = findGenericVisualCastAliases(rawText, exactCastNames).filter((alias) => (
    !hasSpecializedObjectAliasIssue || !OBJECT_ENTITY_NOUN_PATTERN.test(alias)
  ));
  aliases.forEach((alias) => {
    unresolved.push({ kind: "generic_or_group_alias", field, alias });
  });
}

/**
 * Locks cast metadata and performs only mechanical, meaning-preserving text
 * edits. In particular, narrative, environment, cast arrays, anchors, camera,
 * and lighting pass through untouched. Action changes are limited to replacing
 * a definite bag/backpack alias when exactly one declared object character can
 * possibly be its referent.
 */
export function canonicalizeSceneCast<TScene extends SceneCastLike>(
  input: TScene,
  options: SceneCastCanonicalizationOptions = {},
): SceneCastCanonicalizationResult<TScene> {
  const applied: SceneCastAppliedChange[] = [];
  const unresolved: SceneCastUnresolvedIssue[] = [];
  const visualSources = collectVisualSources(options, unresolved);
  const descriptorSources = collectDescriptorSources(options, unresolved);
  const next = { ...input } as Record<string, unknown>;

  const characterNames: string[] = [];
  if (Array.isArray(input.characterNames)) {
    input.characterNames.forEach((value, index) => {
      const name = normalizedText(value);
      if (name) characterNames.push(name);
      else unresolved.push({ kind: "invalid_cast_entry", field: "characterNames", index });
    });
  }

  const currentVisualsByName = new Map<string, SceneCastRecord>();
  if (Array.isArray(input.characterVisuals)) {
    input.characterVisuals.forEach((visual, index) => {
      if (!isRecord(visual)) {
        unresolved.push({ kind: "invalid_cast_entry", field: "characterVisuals", index });
        return;
      }
      const name = normalizedText(visual.name);
      if (name) currentVisualsByName.set(identityKey(name), visual);
    });
  }

  const resolvedVisuals: Array<SceneCastRecord | undefined> = characterNames.map((name, index) => {
    const canonical = visualSources.get(identityKey(name));
    const current = currentVisualsByName.get(identityKey(name));
    const resolved = canonical?.value ?? current;
    if (!resolved) {
      unresolved.push({ kind: "missing_character_visual", field: "characterVisuals", name });
      return undefined;
    }
    const aligned: SceneCastRecord = { ...resolved, name };
    if (canonical && !sameValue(current, aligned)) {
      applied.push({
        kind: "canonical_character_visual",
        field: "characterVisuals",
        name,
        index,
        source: canonical.source,
      });
    }
    return aligned;
  });
  // Metadata alignment is atomic. Never replace a malformed partial array with
  // another partial array; the semantic validator can report unresolved names.
  if (resolvedVisuals.every((visual): visual is SceneCastRecord => Boolean(visual))) {
    const canonicalVisuals = resolvedVisuals;
    if (!sameValue(input.characterVisuals, canonicalVisuals)) next.characterVisuals = canonicalVisuals;
  }

  const supportingNames: string[] = [];
  const resolvedSupportingDescriptors: string[] = [];
  if (Array.isArray(input.supportingEntities)) {
    const supportingEntities = input.supportingEntities.map((value, index) => {
      const descriptor = normalizedText(value);
      const name = descriptorIdentity(descriptor);
      if (!descriptor || !name) {
        unresolved.push({ kind: "invalid_cast_entry", field: "supportingEntities", index });
        return value;
      }
      const canonical = descriptorSources.get(identityKey(name));
      if (!canonical) {
        unresolved.push({ kind: "missing_supporting_descriptor", field: "supportingEntities", name });
        supportingNames.push(name);
        resolvedSupportingDescriptors.push(descriptor);
        return value;
      }
      const canonicalName = descriptorIdentity(canonical.value);
      supportingNames.push(canonicalName);
      resolvedSupportingDescriptors.push(canonical.value);
      if (canonical.value !== value) {
        applied.push({
          kind: "canonical_supporting_descriptor",
          field: "supportingEntities",
          name: canonicalName,
          index,
          source: canonical.source,
        });
      }
      return canonical.value;
    });
    if (!sameValue(input.supportingEntities, supportingEntities)) {
      next.supportingEntities = supportingEntities;
    }
  }

  const exactCastNames = uniqueNames([...characterNames, ...supportingNames]);
  const mainObjectCharacterNames = characterNames.filter((name) => {
    const index = characterNames.indexOf(name);
    const resolved = resolvedVisuals[index];
    return resolved?.visualForm === "object_character";
  });
  const supportingObjectCharacterNames = resolvedSupportingDescriptors
    .filter((descriptor) => {
      const name = descriptorIdentity(descriptor);
      const description = descriptor.includes(":")
        ? descriptor.slice(descriptor.indexOf(":") + 1)
        : "";
      return OBJECT_ENTITY_NOUN_PATTERN.test(name)
        || OBJECT_ENTITY_DESCRIPTION_PATTERN.test(description);
    })
    .map(descriptorIdentity);
  const objectCharacterNames = uniqueNames([
    ...mainObjectCharacterNames,
    ...supportingObjectCharacterNames,
  ]);

  const canonicalAction = replaceSafeObjectAliases(
    input.action,
    "action",
    objectCharacterNames,
    applied,
    unresolved,
  );
  if (canonicalAction !== input.action) next.action = canonicalAction;
  const canonicalSceneDetails = replaceSafeObjectAliases(
    input.sceneDetails,
    "sceneDetails",
    objectCharacterNames,
    applied,
    unresolved,
  );
  if (canonicalSceneDetails !== input.sceneDetails) next.sceneDetails = canonicalSceneDetails;

  const visibleText = `${typeof next.action === "string" ? next.action : ""} ${
    typeof next.sceneDetails === "string" ? next.sceneDetails : ""
  }`;
  const missingNames = exactCastNames.filter((name) => !containsExactName(visibleText, name));
  if (missingNames.length > 0) {
    const clause = `Visible exactly once: ${missingNames.join("; ")}.`;
    const currentDetails = typeof next.sceneDetails === "string" ? next.sceneDetails : "";
    const separator = currentDetails.length === 0 || /\s$/u.test(currentDetails) ? "" : " ";
    const withClause = `${currentDetails}${separator}${clause}`;
    const maximumLength = options.maximumSceneDetailsLength
      ?? DEFAULT_MAXIMUM_SCENE_DETAILS_LENGTH;
    if (withClause.length <= maximumLength) {
      next.sceneDetails = withClause;
      applied.push({
        kind: "exact_visible_presence",
        field: "sceneDetails",
        names: [...missingNames],
      });
    } else {
      unresolved.push({
        kind: "presence_clause_too_large",
        field: "sceneDetails",
        names: [...missingNames],
        maximumLength,
      });
    }
  }

  auditGenericAliases(next.action, "action", exactCastNames, unresolved);
  auditGenericAliases(next.sceneDetails, "sceneDetails", exactCastNames, unresolved);

  const changed = !sameValue(input, next);
  return {
    scene: next as TScene,
    exactCastNames,
    audit: { applied, unresolved },
    changed,
  };
}
