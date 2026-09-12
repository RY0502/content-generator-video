import { createHash } from "node:crypto";

/**
 * A machine-readable view of one existing string validation issue.  Validators
 * deliberately remain free to produce useful human prose; this module gives
 * retry/state code stable identities without coupling it to that prose.
 */
export interface ParsedEpisodeScriptValidationIssue {
  /** Stable semantic identity. Unknown messages use a hash of a normalized template. */
  code: string;
  sceneNumber?: number;
  field?: string;
  path?: string;
  /** Stable quoted identity/reference when separate subjects share one field. */
  subject?: string;
  /** The original, whitespace-normalized validator message. */
  message: string;
  /** Numeric evidence used to recognize progress within the same issue class. */
  observedValue?: number;
  limitValue?: number;
  excess?: number;
}

export interface DedupedEpisodeScriptValidationIssue
  extends ParsedEpisodeScriptValidationIssue {
  /** Stable identity for this issue at this scene/path. */
  key: string;
  /** All distinct original wordings, in first-seen order. */
  messages: string[];
  /** Includes repeated identical messages from overlapping validators. */
  occurrenceCount: number;
  /** Base semantic severity plus a bounded numeric-overage penalty. */
  weight: number;
}

export interface EpisodeScriptValidationIssueOccurrence {
  key: string;
  sceneNumber?: number;
  path?: string;
  subject?: string;
  messages: string[];
  occurrenceCount: number;
  weight: number;
}

export interface EpisodeScriptValidationIssueGroup {
  code: string;
  field?: string;
  occurrences: EpisodeScriptValidationIssueOccurrence[];
  occurrenceCount: number;
  affectedSceneNumbers: number[];
  weight: number;
}

export interface EpisodeScriptValidationIssueSummary {
  issues: DedupedEpisodeScriptValidationIssue[];
  groups: EpisodeScriptValidationIssueGroup[];
  /** Ignores prose and measured values; equivalent issue sets share a fingerprint. */
  fingerprint: string;
  weightedScore: number;
  uniqueIssueCount: number;
  occurrenceCount: number;
  affectedSceneCount: number;
}

export type EpisodeScriptValidationProgressDirection =
  | "improved"
  | "unchanged"
  | "regressed"
  | "changed";

export interface EpisodeScriptValidationProgressComparison {
  direction: EpisodeScriptValidationProgressDirection;
  madeProgress: boolean;
  previousFingerprint: string;
  currentFingerprint: string;
  weightedScoreDelta: number;
  /** Uncapped change in measured overage for issues which persist by key. */
  numericExcessDelta: number;
  uniqueIssueCountDelta: number;
  occurrenceCountDelta: number;
  resolvedKeys: string[];
  introducedKeys: string[];
  persistingKeys: string[];
}

interface IssueRule {
  code: string;
  pattern: RegExp;
  field?: string;
  weight: number;
}

// Keep more specific rules before broad missing/shape rules. These cover both
// productionScriptContract and scriptRefinementTool wording.
const ISSUE_RULES: readonly IssueRule[] = [
  {
    code: "narration.too_many_spoken_words",
    pattern: /narration(?:Text)? (?:has|contains) \d+ spoken words[^.]*?(?:at most|maximum is|maximum of|allow(?:s)? at most) \d+/iu,
    field: "narrationText",
    weight: 45,
  },
  {
    code: "narration.too_many_raw_characters",
    pattern: /narration(?:Text)? (?:has|contains) \d+ raw characters[^.]*?(?:limit|max(?:imum)?|exceeds)/iu,
    field: "narrationText",
    weight: 45,
  },
  {
    code: "narration.measured_duration_exceeded",
    pattern: /(?:narration audio is|measured .*? narration .*?)\s*[\d.]+\s*seconds[^.]*?(?:at most|limit|longer|exceed)/iu,
    field: "narrationText",
    weight: 50,
  },
  {
    code: "narration.multiple_beats",
    pattern: /narration appears overloaded with multiple beats/iu,
    field: "narrationText",
    weight: 35,
  },
  {
    code: "narration.episode_word_minimum",
    pattern: /(?:episode narration has|total episode narration word count too low|accepted prefix .* spoken words)[^.]*?(?:at least|minimum|required)/iu,
    field: "narrationText",
    weight: 50,
  },
  {
    code: "scene.duplicate_beat",
    pattern: /(?:duplicates the complete|semantically repeats the) narration\/action beat from Scene \d+/iu,
    weight: 65,
  },
  {
    code: "scene.planned_regression",
    pattern: /appears to regress to planned scenes \d+-\d+ instead of advancing/iu,
    weight: 60,
  },
  {
    code: "continuity.unstaged_lighting_change",
    pattern: /changes lighting while the environment is unchanged[^.]*no visible lighting transition/iu,
    field: "lighting",
    weight: 45,
  },
  {
    code: "cast.full_roster_default",
    pattern: /Every authored scene defaults characterNames to the complete series roster/iu,
    field: "characterNames",
    weight: 55,
  },
  {
    code: "cast.declared_figure_unstaged",
    pattern: /declares figure .+? but never names it in action\/sceneDetails/iu,
    field: "action/sceneDetails",
    weight: 60,
  },
  {
    code: "cast.generic_alias",
    pattern: /action\/sceneDetails uses a collective or generic cast alias/iu,
    field: "action/sceneDetails",
    weight: 65,
  },
  {
    code: "cast.unlisted_figure",
    pattern: /action\/sceneDetails mentions unlisted figure/iu,
    field: "action/sceneDetails",
    weight: 70,
  },
  {
    code: "cast.environment_visible_figure",
    pattern: /environmentDescription mentions visible figure/iu,
    field: "environmentDescription",
    weight: 65,
  },
  {
    code: "cast.environment_uncounted_figures",
    pattern: /environmentDescription introduces uncounted background figures/iu,
    field: "environmentDescription",
    weight: 70,
  },
  {
    code: "cast.collective_supporting_identity",
    pattern: /supporting entit(?:y|ies).+? is a group/iu,
    field: "supportingEntities",
    weight: 70,
  },
  {
    code: "cast.supporting_descriptor_drift",
    pattern: /changes the supportingEntities descriptor/iu,
    field: "supportingEntities",
    weight: 65,
  },
  {
    code: "cast.supporting_identity_duplicate",
    pattern: /supportingEntities contains (?:the same stable identity more than once|duplicate entries)/iu,
    field: "supportingEntities",
    weight: 65,
  },
  {
    code: "cast.main_character_in_supporting_entities",
    pattern: /places main character .+? in supportingEntities/iu,
    field: "supportingEntities",
    weight: 70,
  },
  {
    code: "cast.non_roster_character",
    pattern: /characterNames contains non-roster name/iu,
    field: "characterNames",
    weight: 70,
  },
  {
    code: "cast.character_visual_drift",
    pattern: /changes locked characterVisuals metadata/iu,
    field: "characterVisuals",
    weight: 65,
  },
  {
    code: "cast.character_visual_alignment",
    pattern: /characterVisuals (?:must (?:be an array )?align|entries matching characterNames|\[\d+\]\.name must exactly match)/iu,
    field: "characterVisuals",
    weight: 60,
  },
  {
    code: "continuity.living_entity_anchor",
    pattern: /continuity anchor .+? redefines a character or living entity/iu,
    field: "continuityAnchors",
    weight: 55,
  },
  {
    code: "continuity.missing_supporting_entities",
    pattern: /continues interacting with supporting entities .+? but is missing supportingEntities/iu,
    field: "supportingEntities",
    weight: 55,
  },
  {
    code: "scene.details_too_weak",
    pattern: /needs richer sceneDetails for reliable video generation/iu,
    field: "sceneDetails",
    weight: 20,
  },
  {
    code: "scene.missing_required_field",
    pattern: /(?:is missing|required )(?:(?:required )?(?:environmentDescription|action|sceneDetails|cameraAngle|lighting)|narrationText)/iu,
    weight: 50,
  },
  {
    code: "scene.non_sequential_number",
    pattern: /(?:must have sequential sceneNumber|scenes\[\d+\]\.sceneNumber must be)/iu,
    field: "sceneNumber",
    weight: 80,
  },
  {
    code: "scene.invalid_object",
    pattern: /Scene \d+ must be an object/iu,
    weight: 90,
  },
  {
    code: "script.scene_count_below_minimum",
    pattern: /Scene count (?:too low: )?\d+ (?:is below|\.|Minimum required is)/iu,
    field: "scenes",
    weight: 80,
  },
  {
    code: "script.scene_count_above_maximum",
    pattern: /Scene count (?:too high: )?\d+ (?:exceeds|\.|Maximum allowed is)/iu,
    field: "scenes",
    weight: 80,
  },
  {
    code: "script.invalid_root",
    pattern: /Episode script must be a JSON object/iu,
    weight: 100,
  },
  {
    code: "script.invalid_scenes_array",
    pattern: /Episode script must contain a scenes array/iu,
    field: "scenes",
    weight: 100,
  },
  {
    code: "authoring.invalid_plan",
    pattern: /authoringPlan/iu,
    field: "authoringPlan",
    weight: 85,
  },
  {
    code: "chunk.invalid_range",
    pattern: /(?:This write may contain at most|This write must contain exactly|exact requested scene range)/iu,
    field: "scenes",
    weight: 85,
  },
];

const FIELD_PATTERNS: readonly [string, RegExp][] = [
  ["action/sceneDetails", /action\/sceneDetails/iu],
  ["environmentDescription", /environmentDescription/iu],
  ["supportingEntities", /supportingEntities|supporting entit(?:y|ies)/iu],
  ["continuityAnchors", /continuityAnchors|continuity anchor/iu],
  ["characterVisuals", /characterVisuals/iu],
  ["characterNames", /characterNames/iu],
  ["narrationText", /narrationText|narration(?: audio)?/iu],
  ["sceneDetails", /sceneDetails/iu],
  ["cameraAngle", /cameraAngle/iu],
  ["lighting", /lighting/iu],
  ["sceneNumber", /sceneNumber/iu],
  ["authoringPlan", /authoringPlan/iu],
  ["scenes", /\bscenes?\b/iu],
  ["action", /\baction\b/iu],
];

const DEFAULT_ISSUE_WEIGHT = 40;
const MAX_NUMERIC_OVERAGE_PENALTY = 25;

function normalizeMessage(message: string): string {
  return message.replace(/\s+/gu, " ").trim();
}

function normalizeUnknownIssueTemplate(message: string): string {
  return message
    .toLocaleLowerCase()
    .replace(/^scene\s+\d+(?::|\b)\s*/iu, "")
    .replace(/"[^"]*"|'[^']*'/gu, "<value>")
    .replace(/\b\d+(?:\.\d+)?\b/gu, "<number>")
    .replace(/\s+/gu, " ")
    .trim();
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sceneNumberFromMessage(message: string): number | undefined {
  const match = message.match(/^Scene\s+(\d+)(?::|\b)/iu);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function explicitIndexedPath(message: string): string | undefined {
  const match = message.match(
    /\b(characterVisuals|characterNames|supportingEntities|continuityAnchors|scenes)\[(\d+)\](?:\.([A-Za-z][A-Za-z0-9]*))?/u,
  );
  if (!match?.[1] || !match[2]) return undefined;
  return `${match[1]}[${match[2]}]${match[3] ? `.${match[3]}` : ""}`;
}

function fieldFromMessage(message: string): string | undefined {
  return FIELD_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0];
}

function issuePath(
  message: string,
  sceneNumber: number | undefined,
  field: string | undefined,
): string | undefined {
  const indexed = explicitIndexedPath(message);
  if (sceneNumber !== undefined) {
    const prefix = `scenes[${sceneNumber - 1}]`;
    if (indexed && indexed !== "scenes") {
      return indexed.startsWith("scenes[") ? indexed : `${prefix}.${indexed}`;
    }
    return field ? `${prefix}.${field}` : prefix;
  }
  return indexed ?? field;
}

function narrationBounds(message: string): Pick<
  ParsedEpisodeScriptValidationIssue,
  "observedValue" | "limitValue" | "excess"
> {
  const wordMatch = message.match(
    /narration(?:Text)? (?:has|contains) (\d+) spoken words[\s\S]*?(?:at most|maximum is|maximum of|allow(?:s)? at most) (\d+)/iu,
  );
  const characterMatch = message.match(
    /narration(?:Text)? (?:has|contains) (\d+) raw characters[\s\S]*?(?:limit is|limit|max(?:imum)?(?: is| of)?|exceeds the)\s*(\d+)/iu,
  );
  const match = wordMatch ?? characterMatch;
  if (!match?.[1] || !match[2]) return {};
  const observedValue = Number(match[1]);
  const limitValue = Number(match[2]);
  if (!Number.isFinite(observedValue) || !Number.isFinite(limitValue)) return {};
  return {
    observedValue,
    limitValue,
    excess: Math.max(0, observedValue - limitValue),
  };
}

function ruleForMessage(message: string): IssueRule | undefined {
  return ISSUE_RULES.find((rule) => rule.pattern.test(message));
}

function semanticSubject(message: string, code: string): string | undefined {
  if (code === "scene.duplicate_beat") {
    const match = message.match(/from Scene (\d+)/iu);
    return match?.[1] ? `scene:${match[1]}` : undefined;
  }
  if (
    code === "cast.declared_figure_unstaged"
    || code === "cast.unlisted_figure"
    || code === "cast.collective_supporting_identity"
    || code === "cast.supporting_descriptor_drift"
    || code === "cast.main_character_in_supporting_entities"
    || code === "cast.non_roster_character"
    || code === "cast.character_visual_drift"
    || code === "continuity.living_entity_anchor"
  ) {
    const match = message.match(/"([^"]+)"|'([^']+)'/u);
    const value = normalizeMessage(match?.[1] ?? match?.[2] ?? "").toLocaleLowerCase();
    return value || undefined;
  }
  return undefined;
}

/** Parse one current validator message without discarding its original prose. */
export function parseEpisodeScriptValidationIssue(
  rawMessage: string,
): ParsedEpisodeScriptValidationIssue {
  const message = normalizeMessage(rawMessage);
  const sceneNumber = sceneNumberFromMessage(message);
  const rule = ruleForMessage(message);
  const field = rule?.field ?? fieldFromMessage(message);
  const code = rule?.code
    ?? `unclassified.${shortHash(normalizeUnknownIssueTemplate(message))}`;
  const path = issuePath(message, sceneNumber, field);
  const subject = semanticSubject(message, code);
  const bounds = code === "narration.too_many_spoken_words"
    || code === "narration.too_many_raw_characters"
    ? narrationBounds(message)
    : {};

  return {
    code,
    ...(sceneNumber === undefined ? {} : { sceneNumber }),
    ...(field === undefined ? {} : { field }),
    ...(path === undefined ? {} : { path }),
    ...(subject === undefined ? {} : { subject }),
    message,
    ...bounds,
  };
}

function issueIdentity(issue: ParsedEpisodeScriptValidationIssue): string {
  return JSON.stringify([
    issue.code,
    issue.sceneNumber ?? null,
    issue.path ?? null,
    issue.subject ?? null,
  ]);
}

function baseIssueWeight(code: string): number {
  return ISSUE_RULES.find((rule) => rule.code === code)?.weight ?? DEFAULT_ISSUE_WEIGHT;
}

function issueWeight(issue: ParsedEpisodeScriptValidationIssue): number {
  const excessPenalty = Math.min(
    MAX_NUMERIC_OVERAGE_PENALTY,
    Math.max(0, issue.excess ?? 0),
  );
  return baseIssueWeight(issue.code) + excessPenalty;
}

/**
 * Collapse overlapping validators that report the same semantic problem at the
 * same scene/path. Distinct wording is retained in `messages`; repeated exact
 * wording contributes only to occurrenceCount, never retry severity.
 */
export function dedupeEpisodeScriptValidationIssues(
  rawMessages: readonly string[],
): DedupedEpisodeScriptValidationIssue[] {
  const byKey = new Map<string, DedupedEpisodeScriptValidationIssue>();

  rawMessages.forEach((rawMessage) => {
    const parsed = parseEpisodeScriptValidationIssue(rawMessage);
    const key = issueIdentity(parsed);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, {
        ...parsed,
        key,
        messages: [parsed.message],
        occurrenceCount: 1,
        weight: issueWeight(parsed),
      });
      return;
    }

    current.occurrenceCount += 1;
    if (!current.messages.includes(parsed.message)) {
      current.messages.push(parsed.message);
    }
    // For equivalent numeric issues, retain the worst current evidence so the
    // score cannot depend on which overlapping validator ran first.
    if ((parsed.excess ?? -1) > (current.excess ?? -1)) {
      current.observedValue = parsed.observedValue;
      current.limitValue = parsed.limitValue;
      current.excess = parsed.excess;
      current.weight = issueWeight(parsed);
    }
  });

  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

/** Group every deduped scene occurrence under its stable semantic code/field. */
export function groupEpisodeScriptValidationIssues(
  rawMessages: readonly string[],
): EpisodeScriptValidationIssueGroup[] {
  const grouped = new Map<string, EpisodeScriptValidationIssueGroup>();

  dedupeEpisodeScriptValidationIssues(rawMessages).forEach((issue) => {
    const groupKey = JSON.stringify([issue.code, issue.field ?? null]);
    const current = grouped.get(groupKey) ?? {
      code: issue.code,
      ...(issue.field === undefined ? {} : { field: issue.field }),
      occurrences: [],
      occurrenceCount: 0,
      affectedSceneNumbers: [],
      weight: 0,
    };
    current.occurrences.push({
      key: issue.key,
      ...(issue.sceneNumber === undefined ? {} : { sceneNumber: issue.sceneNumber }),
      ...(issue.path === undefined ? {} : { path: issue.path }),
      ...(issue.subject === undefined ? {} : { subject: issue.subject }),
      messages: [...issue.messages],
      occurrenceCount: issue.occurrenceCount,
      weight: issue.weight,
    });
    current.occurrenceCount += issue.occurrenceCount;
    current.weight += issue.weight;
    if (
      issue.sceneNumber !== undefined
      && !current.affectedSceneNumbers.includes(issue.sceneNumber)
    ) {
      current.affectedSceneNumbers.push(issue.sceneNumber);
    }
    grouped.set(groupKey, current);
  });

  return [...grouped.values()]
    .map((group) => ({
      ...group,
      affectedSceneNumbers: group.affectedSceneNumbers.sort((left, right) => left - right),
      occurrences: group.occurrences.sort((left, right) => left.key.localeCompare(right.key)),
    }))
    .sort((left, right) => {
      const codeOrder = left.code.localeCompare(right.code);
      return codeOrder !== 0 ? codeOrder : (left.field ?? "").localeCompare(right.field ?? "");
    });
}

function fingerprintForIssues(issues: readonly DedupedEpisodeScriptValidationIssue[]): string {
  const identities = issues.map((issue) => issue.key).sort();
  return createHash("sha256").update(JSON.stringify(identities)).digest("hex");
}

/** Return only the stable lowercase SHA-256 identity for a current issue set. */
export function episodeScriptValidationIssueFingerprint(
  rawMessages: readonly string[],
): string {
  return fingerprintForIssues(dedupeEpisodeScriptValidationIssues(rawMessages));
}

/** Build a compact deterministic summary suitable for durable retry receipts. */
export function summarizeEpisodeScriptValidationIssues(
  rawMessages: readonly string[],
): EpisodeScriptValidationIssueSummary {
  const issues = dedupeEpisodeScriptValidationIssues(rawMessages);
  const sceneNumbers = new Set(
    issues.flatMap((issue) => issue.sceneNumber === undefined ? [] : [issue.sceneNumber]),
  );
  return {
    issues,
    groups: groupEpisodeScriptValidationIssues(rawMessages),
    fingerprint: fingerprintForIssues(issues),
    weightedScore: issues.reduce((total, issue) => total + issue.weight, 0),
    uniqueIssueCount: issues.length,
    occurrenceCount: issues.reduce((total, issue) => total + issue.occurrenceCount, 0),
    affectedSceneCount: sceneNumbers.size,
  };
}

function asSummary(
  value: readonly string[] | EpisodeScriptValidationIssueSummary,
): EpisodeScriptValidationIssueSummary {
  return Array.isArray(value)
    ? summarizeEpisodeScriptValidationIssues(value)
    : value as EpisodeScriptValidationIssueSummary;
}

/**
 * Compare attempts without mistaking reworded duplicate diagnostics for
 * progress. A lower weighted burden is progress. At equal weight, resolving a
 * strict subset is progress; a same-weight swap is reported as `changed` and
 * should not reset a no-progress guard.
 */
export function compareEpisodeScriptValidationProgress(
  previousValue: readonly string[] | EpisodeScriptValidationIssueSummary,
  currentValue: readonly string[] | EpisodeScriptValidationIssueSummary,
): EpisodeScriptValidationProgressComparison {
  const previous = asSummary(previousValue);
  const current = asSummary(currentValue);
  const previousKeys = new Set(previous.issues.map((issue) => issue.key));
  const currentKeys = new Set(current.issues.map((issue) => issue.key));
  const resolvedKeys = [...previousKeys].filter((key) => !currentKeys.has(key)).sort();
  const introducedKeys = [...currentKeys].filter((key) => !previousKeys.has(key)).sort();
  const persistingKeys = [...currentKeys].filter((key) => previousKeys.has(key)).sort();
  const weightedScoreDelta = current.weightedScore - previous.weightedScore;
  const previousIssueByKey = new Map(previous.issues.map((issue) => [issue.key, issue] as const));
  const currentIssueByKey = new Map(current.issues.map((issue) => [issue.key, issue] as const));
  const numericExcessDelta = persistingKeys.reduce((delta, key) => {
    const previousExcess = previousIssueByKey.get(key)?.excess;
    const currentExcess = currentIssueByKey.get(key)?.excess;
    return typeof previousExcess === "number" && typeof currentExcess === "number"
      ? delta + currentExcess - previousExcess
      : delta;
  }, 0);
  const uniqueIssueCountDelta = current.uniqueIssueCount - previous.uniqueIssueCount;
  const occurrenceCountDelta = current.occurrenceCount - previous.occurrenceCount;

  let direction: EpisodeScriptValidationProgressDirection;
  if (
    current.fingerprint === previous.fingerprint
    && weightedScoreDelta === 0
    && numericExcessDelta === 0
  ) {
    direction = "unchanged";
  } else if (
    weightedScoreDelta < 0
    || (
      weightedScoreDelta === 0
      && numericExcessDelta < 0
      && introducedKeys.length === 0
    )
    || (
      weightedScoreDelta === 0
      && numericExcessDelta === 0
      && resolvedKeys.length > 0
      && introducedKeys.length === 0
    )
  ) {
    direction = "improved";
  } else if (
    weightedScoreDelta > 0
    || (
      weightedScoreDelta === 0
      && numericExcessDelta > 0
      && resolvedKeys.length === 0
    )
    || (
      weightedScoreDelta === 0
      && numericExcessDelta === 0
      && introducedKeys.length > 0
      && resolvedKeys.length === 0
    )
  ) {
    direction = "regressed";
  } else {
    direction = "changed";
  }

  return {
    direction,
    madeProgress: direction === "improved",
    previousFingerprint: previous.fingerprint,
    currentFingerprint: current.fingerprint,
    weightedScoreDelta,
    numericExcessDelta,
    uniqueIssueCountDelta,
    occurrenceCountDelta,
    resolvedKeys,
    introducedKeys,
    persistingKeys,
  };
}
