export interface ContinuityScene {
  sceneNumber: number;
  narrationText?: string;
  environmentDescription?: string;
  action?: string;
  characterNames?: string[];
  supportingEntities?: string[];
  continuityAnchors?: string[];
  sceneDetails?: string;
  cameraAngle?: string;
  lighting?: string;
}

export interface PlannedStoryBeat {
  startScene: number;
  endScene: number;
  storyBeat: string;
  setting: string;
  continuityOutcome: string;
}

export interface SceneContinuityInspectionOptions {
  mainCharacterNames?: readonly string[];
  plannedBeats?: readonly PlannedStoryBeat[];
}

export interface LightingContinuityNormalizationChange {
  sceneNumber: number;
  previousSceneNumber: number;
  submittedLighting: string | undefined;
  reusedLighting: string | undefined;
}

export interface LightingContinuityNormalizationResult<TScene extends ContinuityScene> {
  scenes: TScene[];
  changes: LightingContinuityNormalizationChange[];
}

const SEMANTIC_STOP_WORDS = new Set([
  "a", "about", "above", "across", "after", "again", "against", "all", "along", "also",
  "an", "and", "another", "around", "as", "at", "away", "back", "be", "because", "been",
  "before", "behind", "below", "beside", "between", "both", "but", "by", "can", "carefully",
  "child", "children", "clear", "close", "does", "down", "each", "every", "face", "for",
  "forward", "friend", "friends", "from", "gently", "group", "has", "have", "he", "her",
  "here", "hers", "him", "his", "in", "into", "is", "it", "its", "little", "near",
  "nearby", "of", "off", "on", "one", "only", "other", "out", "over", "quietly", "scene",
  "she", "slowly", "softly", "some", "stands", "stays", "still", "subtly", "than", "that",
  "the", "their", "them", "then", "there", "they", "this", "through", "to", "together",
  "toward", "towards", "two", "up", "very", "visible", "while", "with", "within",
]);

const LOW_INFORMATION_VISUAL_WORDS = new Set([
  "arm", "arms", "body", "brow", "eye", "eyes", "finger", "fingers", "gaze", "hand", "hands",
  "head", "leg", "legs", "look", "looks", "looking", "nearby", "pose", "react", "reaction",
  "smile", "smiles", "smiling", "stand", "standing", "watch", "watches", "watching",
]);

const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  bread: "bread",
  loaf: "bread",
  loaves: "bread",
  carving: "symbol",
  carvings: "symbol",
  hieroglyph: "symbol",
  hieroglyphic: "symbol",
  hieroglyphics: "symbol",
  mark: "symbol",
  marks: "symbol",
  sign: "symbol",
  signs: "symbol",
  symbol: "symbol",
  symbols: "symbol",
  discover: "find",
  discovered: "find",
  discovers: "find",
  finding: "find",
  finds: "find",
  found: "find",
  press: "touch",
  pressed: "touch",
  presses: "touch",
  pressing: "touch",
  tap: "touch",
  tapped: "touch",
  tapping: "touch",
  taps: "touch",
  touch: "touch",
  touched: "touch",
  touches: "touch",
  touching: "touch",
  trace: "touch",
  traced: "touch",
  traces: "touch",
  tracing: "touch",
  unlock: "open",
  unlocked: "open",
  unlocking: "open",
  unlocks: "open",
};

const INTENTIONAL_CALLBACK_PATTERN =
  /\b(?:again|back|callback|compare|earlier|recall|remember|return|revisit|review|same clue|this time)\b/iu;
const EXPLAINED_LIGHTING_CHANGE_PATTERN =
  /\b(?:brighten(?:s|ed|ing)?|clouds? (?:cover|cross|part)|dawn|dim(?:s|med|ming)?|dusk|extinguish(?:es|ed|ing)?|fade(?:s|d|ing)?|flash(?:es|ed|ing)?|glow (?:appears|begins|changes|fades|replaces)|lamp (?:lights|turns)|light (?:changes|switches|turns)|lightning|night falls|portal (?:closes|dims|fades|glows|opens)|shadow (?:covers|crosses|passes)|sun (?:appears|emerges|sets)|sunrise|sunset|torch (?:dims|flares|ignites|lights)|turns? (?:off|on))\b/iu;
const CONSTRAINED_CAMERA_PATTERN =
  /\b(?:close[ -]?up|detail shot|insert shot|macro|over[ -]?the[ -]?shoulder|portrait|split[ -]?screen)\b/iu;

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase()
    : "";
}

function hasSameNormalizedEnvironment(
  previous: ContinuityScene,
  current: ContinuityScene,
): boolean {
  return normalizedText(previous.environmentDescription)
    === normalizedText(current.environmentDescription);
}

/**
 * A lighting change is intentional only when the current shot visibly stages
 * its source or time transition. Keep this predicate shared by normalization
 * and validation so the two boundaries cannot disagree about the exception.
 */
export function hasExplainedLightingTransition(scene: ContinuityScene): boolean {
  const transitionText = `${scene.narrationText ?? ""} ${scene.action ?? ""} ` +
    `${scene.sceneDetails ?? ""} ${scene.lighting ?? ""}`;
  return EXPLAINED_LIGHTING_CHANGE_PATTERN.test(transitionText);
}

function hasUnstagedLightingChange(
  previous: ContinuityScene,
  current: ContinuityScene,
): boolean {
  return hasSameNormalizedEnvironment(previous, current)
    && normalizedText(previous.lighting) !== normalizedText(current.lighting)
    && !hasExplainedLightingTransition(current);
}

/**
 * Reuses the immediately preceding shot's exact lighting string when an LLM
 * changes only the lighting treatment in an unchanged environment without
 * staging that transition. The input objects are never mutated, and no field
 * other than `lighting` can change.
 *
 * `previousScene` is the last accepted/canonical scene before this sequence,
 * which makes the same rule work across a durable chunk boundary.
 */
export function normalizeUnstagedLightingContinuity<TScene extends ContinuityScene>(
  scenes: readonly TScene[],
  previousScene?: ContinuityScene,
): LightingContinuityNormalizationResult<TScene> {
  const normalizedScenes: TScene[] = [];
  const changes: LightingContinuityNormalizationChange[] = [];
  let previous = previousScene;

  for (const input of scenes) {
    let scene = input;
    if (previous && hasUnstagedLightingChange(previous, input)) {
      scene = {
        ...input,
        lighting: previous.lighting,
      };
      changes.push({
        sceneNumber: input.sceneNumber,
        previousSceneNumber: previous.sceneNumber,
        submittedLighting: input.lighting,
        reusedLighting: previous.lighting,
      });
    }
    normalizedScenes.push(scene);
    previous = scene;
  }

  return { scenes: normalizedScenes, changes };
}

function supportingIdentity(descriptor: string): string {
  return descriptor.split(":", 1)[0]!.replace(/\s+/gu, " ").trim();
}

function canonicalToken(rawToken: string): string {
  const token = rawToken.toLocaleLowerCase().replace(/(?:'s|’s)$/u, "");
  const aliased = TOKEN_ALIASES[token];
  if (aliased) return aliased;
  if (/^\d+$/u.test(token)) return token;
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ied")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function identityTokens(
  scenes: readonly ContinuityScene[],
  mainCharacterNames: readonly string[],
): Set<string> {
  const names = [
    ...mainCharacterNames,
    ...scenes.flatMap((scene) => scene.characterNames ?? []),
    ...scenes.flatMap((scene) => (scene.supportingEntities ?? []).map(supportingIdentity)),
  ];
  return new Set(names.flatMap((name) => (
    normalizedText(name).match(/[\p{L}\p{N}]+/gu) ?? []
  )).map(canonicalToken));
}

function semanticTokens(text: string, ignoredTokens: ReadonlySet<string>): Set<string> {
  const tokens = normalizedText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens
    .map(canonicalToken)
    .filter((token) => (
      token.length > 2
      && !SEMANTIC_STOP_WORDS.has(token)
      && !LOW_INFORMATION_VISUAL_WORDS.has(token)
      && !ignoredTokens.has(token)
    )));
}

function numericTokens(text: string): Set<string> {
  return new Set(normalizedText(text).match(/\b\d+\b/gu) ?? []);
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function haveConflictingNumericProgression(left: string, right: string): boolean {
  const leftNumbers = numericTokens(left);
  const rightNumbers = numericTokens(right);
  return leftNumbers.size > 0 && rightNumbers.size > 0 && !setsEqual(leftNumbers, rightNumbers);
}

function overlapStats(left: ReadonlySet<string>, right: ReadonlySet<string>): {
  shared: number;
  dice: number;
  containment: number;
} {
  if (left.size === 0 || right.size === 0) return { shared: 0, dice: 0, containment: 0 };
  const shared = [...left].filter((token) => right.has(token)).length;
  return {
    shared,
    dice: (2 * shared) / (left.size + right.size),
    containment: shared / Math.min(left.size, right.size),
  };
}

interface SceneFingerprint {
  sceneNumber: number;
  fullText: string;
  normalizedNarration: string;
  normalizedAction: string;
  narrationTokens: Set<string>;
  actionTokens: Set<string>;
  combinedTokens: Set<string>;
}

function fingerprintScene(
  scene: ContinuityScene,
  ignoredTokens: ReadonlySet<string>,
): SceneFingerprint {
  const narration = scene.narrationText ?? "";
  const action = scene.action ?? "";
  const details = scene.sceneDetails ?? "";
  const narrationTokens = semanticTokens(narration, ignoredTokens);
  const actionTokens = semanticTokens(`${action} ${details}`, ignoredTokens);
  return {
    sceneNumber: scene.sceneNumber,
    fullText: `${narration} ${action} ${details}`,
    normalizedNarration: normalizedText(narration),
    normalizedAction: normalizedText(action),
    narrationTokens,
    actionTokens,
    combinedTokens: new Set([...narrationTokens, ...actionTokens]),
  };
}

function isHighConfidenceSemanticRepeat(
  left: SceneFingerprint,
  right: SceneFingerprint,
): boolean {
  if (haveConflictingNumericProgression(left.fullText, right.fullText)) return false;
  const narration = overlapStats(left.narrationTokens, right.narrationTokens);
  const action = overlapStats(left.actionTokens, right.actionTokens);
  const combined = overlapStats(left.combinedTokens, right.combinedTokens);
  const exactNarration = left.normalizedNarration.length >= 24
    && left.normalizedNarration === right.normalizedNarration;
  const exactAction = left.normalizedAction.length >= 18
    && left.normalizedAction === right.normalizedAction;
  return (
    (exactNarration && action.shared >= 3 && action.containment >= 0.6)
    || (exactAction && narration.shared >= 3 && narration.containment >= 0.55)
    || (
      narration.shared >= 3
      && narration.containment >= 0.58
      && action.shared >= 4
      && action.containment >= 0.58
      && combined.shared >= 6
      && combined.dice >= 0.55
      && combined.containment >= 0.68
    )
  );
}

function semanticRepeatIssues(
  scenes: readonly ContinuityScene[],
  ignoredTokens: ReadonlySet<string>,
): string[] {
  const fingerprints = scenes.map((scene) => fingerprintScene(scene, ignoredTokens));
  const issues: string[] = [];
  for (let laterIndex = 0; laterIndex < fingerprints.length; laterIndex += 1) {
    const later = fingerprints[laterIndex]!;
    // Consecutive shots may deliberately split one action into start/result.
    // Search earlier non-adjacent material for high-confidence replay instead.
    for (let earlierIndex = 0; earlierIndex <= laterIndex - 2; earlierIndex += 1) {
      const earlier = fingerprints[earlierIndex]!;
      if (!isHighConfidenceSemanticRepeat(earlier, later)) continue;
      issues.push(
        `Scene ${later.sceneNumber} semantically repeats the narration/action beat from Scene ${earlier.sceneNumber}; ` +
        "advance to a new cause, visible action, or result instead of paraphrasing an earlier shot.",
      );
      break;
    }
  }
  return issues;
}

function plannedRegressionIssues(
  scenes: readonly ContinuityScene[],
  plannedBeats: readonly PlannedStoryBeat[],
  ignoredTokens: ReadonlySet<string>,
): string[] {
  if (plannedBeats.length < 2) return [];
  const beatTokens = plannedBeats.map((beat) => semanticTokens(
    `${beat.storyBeat} ${beat.continuityOutcome}`,
    ignoredTokens,
  ));
  const issues: string[] = [];
  for (const scene of scenes) {
    const expectedIndex = plannedBeats.findIndex((beat) => (
      beat.startScene <= scene.sceneNumber && beat.endScene >= scene.sceneNumber
    ));
    if (expectedIndex <= 0) continue;
    const sceneText = `${scene.narrationText ?? ""} ${scene.action ?? ""} ${scene.sceneDetails ?? ""}`;
    if (INTENTIONAL_CALLBACK_PATTERN.test(sceneText)) continue;
    const sceneTokens = semanticTokens(sceneText, ignoredTokens);
    const expected = overlapStats(sceneTokens, beatTokens[expectedIndex]!);
    let strongestEarlier: { index: number; shared: number; containment: number } | null = null;
    for (let earlierIndex = 0; earlierIndex < expectedIndex; earlierIndex += 1) {
      const overlap = overlapStats(sceneTokens, beatTokens[earlierIndex]!);
      if (!strongestEarlier || overlap.containment > strongestEarlier.containment) {
        strongestEarlier = { index: earlierIndex, ...overlap };
      }
    }
    if (
      strongestEarlier
      && strongestEarlier.shared >= 4
      && strongestEarlier.containment >= 0.58
      && strongestEarlier.containment >= expected.containment + 0.3
    ) {
      const earlierBeat = plannedBeats[strongestEarlier.index]!;
      issues.push(
        `Scene ${scene.sceneNumber} appears to regress to planned scenes ${earlierBeat.startScene}-${earlierBeat.endScene} ` +
        `instead of advancing its assigned scenes ${plannedBeats[expectedIndex]!.startScene}-${plannedBeats[expectedIndex]!.endScene}; ` +
        "rewrite the scene as the next causal beat, or explicitly stage an intentional callback/return.",
      );
    }
  }
  return issues;
}

function lightingContinuityIssues(scenes: readonly ContinuityScene[]): string[] {
  const issues: string[] = [];
  for (let index = 1; index < scenes.length; index += 1) {
    const previous = scenes[index - 1]!;
    const current = scenes[index]!;
    if (!hasUnstagedLightingChange(previous, current)) continue;
    issues.push(
      `Scene ${current.sceneNumber} changes lighting while the environment is unchanged from Scene ${previous.sceneNumber}, ` +
      "but no visible lighting transition is staged. Reuse the previous lighting verbatim or explicitly show the source/time change.",
    );
  }
  return issues;
}

function fullRosterDefaultIssues(
  scenes: readonly ContinuityScene[],
  mainCharacterNames: readonly string[],
): string[] {
  const roster = new Set(mainCharacterNames.map(normalizedText).filter(Boolean));
  if (roster.size < 2 || scenes.length < 8) return [];
  const usesFullRoster = (scene: ContinuityScene): boolean => {
    const names = (scene.characterNames ?? []).map(normalizedText).filter(Boolean);
    return names.length === roster.size
      && new Set(names).size === roster.size
      && names.every((name) => roster.has(name));
  };
  if (!scenes.every(usesFullRoster)) return [];
  const constrainedScenes = scenes
    .filter((scene) => CONSTRAINED_CAMERA_PATTERN.test(scene.cameraAngle ?? ""))
    .map((scene) => scene.sceneNumber);
  if (constrainedScenes.length === 0) return [];
  return [
    `Every authored scene defaults characterNames to the complete series roster, including constrained shot${constrainedScenes.length === 1 ? "" : "s"} ` +
    `${constrainedScenes.slice(0, 4).join(", ")}. This is not a cast-size ceiling: keep any number genuinely visible, ` +
    "but omit each off-screen roster member and stage the exact shot-specific cast only.",
  ];
}

/**
 * High-confidence deterministic checks for the accumulated chunk prefix. The
 * checks intentionally prefer a missed subtle repeat over rejecting normal
 * preschool callbacks or consecutive start/result shots.
 */
export function inspectSceneContinuity(
  scenes: readonly ContinuityScene[],
  options: SceneContinuityInspectionOptions = {},
): string[] {
  const mainCharacterNames = options.mainCharacterNames ?? [];
  const ignoredTokens = identityTokens(scenes, mainCharacterNames);
  return [...new Set([
    ...semanticRepeatIssues(scenes, ignoredTokens),
    ...plannedRegressionIssues(scenes, options.plannedBeats ?? [], ignoredTokens),
    ...lightingContinuityIssues(scenes),
    ...fullRosterDefaultIssues(scenes, mainCharacterNames),
  ])];
}

function compactCue(value: string | undefined, maximum: number): string {
  const text = (value ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= maximum) return text;
  const shortened = text.slice(0, maximum - 1);
  const wordBoundary = shortened.lastIndexOf(" ");
  return `${shortened.slice(0, wordBoundary >= maximum / 2 ? wordBoundary : shortened.length)}…`;
}

/** Compact full-prefix memory: enough to avoid replay without retransmitting scene JSON. */
export function buildCompletedSceneBeatLedger(
  scenes: readonly ContinuityScene[],
): string[] {
  return scenes.map((scene) => {
    const cast = [
      ...(scene.characterNames ?? []),
      ...(scene.supportingEntities ?? []).map(supportingIdentity),
    ].join(", ") || "figure-free";
    return `S${scene.sceneNumber} [${compactCue(cast, 70)}] ` +
      `${compactCue(scene.narrationText, 72)} -> ${compactCue(scene.action, 96)}`;
  });
}
