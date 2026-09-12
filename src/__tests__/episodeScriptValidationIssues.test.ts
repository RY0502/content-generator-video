import { describe, expect, it } from "vitest";
import {
  compareEpisodeScriptValidationProgress,
  dedupeEpisodeScriptValidationIssues,
  episodeScriptValidationIssueFingerprint,
  groupEpisodeScriptValidationIssues,
  parseEpisodeScriptValidationIssue,
  summarizeEpisodeScriptValidationIssues,
} from "../services/episodeScriptValidationIssues.js";

describe("episodeScriptValidationIssues", () => {
  it("parses scene, field, path, stable code, and numeric narration evidence", () => {
    const issue = parseEpisodeScriptValidationIssue(
      "Scene 17 narrationText has 24 spoken words; the production maximum is 20 so one Groq narration can fit one 12-second Agnes scene.",
    );

    expect(issue).toMatchObject({
      code: "narration.too_many_spoken_words",
      sceneNumber: 17,
      field: "narrationText",
      path: "scenes[16].narrationText",
      observedValue: 24,
      limitValue: 20,
      excess: 4,
    });
  });

  it("deduplicates the two current word-cap phrasings without losing either message", () => {
    const first =
      "Scene 17 narrationText has 23 spoken words; the production maximum is 20 so one Groq narration can fit one 12-second Agnes scene.";
    const second =
      "Scene 17: Narration has 23 spoken words; production scenes allow at most 20 to leave headroom under the 12-second audio limit.";
    const issues = dedupeEpisodeScriptValidationIssues([first, second, first]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "narration.too_many_spoken_words",
      sceneNumber: 17,
      occurrenceCount: 3,
      messages: [first, second],
    });
  });

  it("groups every affected scene while retaining per-scene occurrences", () => {
    const groups = groupEpisodeScriptValidationIssues([
      "Scene 17 declares figure \"Mother Mammoth\" but never names it in action/sceneDetails.",
      "Scene 19 declares figure \"Mother Mammoth\" but never names it in action/sceneDetails.",
      "Scene 20 declares figure \"Mother Mammoth\" but never names it in action/sceneDetails.",
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      code: "cast.declared_figure_unstaged",
      field: "action/sceneDetails",
      affectedSceneNumbers: [17, 19, 20],
      occurrenceCount: 3,
    });
    expect(groups[0]!.occurrences).toHaveLength(3);
  });

  it("uses a wording-independent, order-independent stable fingerprint", () => {
    const first = summarizeEpisodeScriptValidationIssues([
      "Scene 2 action/sceneDetails uses a collective or generic cast alias.",
      "Scene 1 narrationText has 24 spoken words; the production maximum is 20.",
    ]);
    const reorderedAndReworded = summarizeEpisodeScriptValidationIssues([
      "Scene 1: Narration has 21 spoken words; production scenes allow at most 20.",
      "Scene 2 action/sceneDetails uses a collective or generic cast alias. Use exact stable names.",
    ]);

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(reorderedAndReworded.fingerprint).toBe(first.fingerprint);
    expect(episodeScriptValidationIssueFingerprint([
      "Scene 1: Narration has 25 spoken words; production scenes allow at most 20.",
      "Scene 2 action/sceneDetails uses a collective or generic cast alias.",
    ])).toBe(first.fingerprint);
  });

  it("recognizes lower remaining narration overage as progress even with the same fingerprint", () => {
    const previous = [
      "Scene 4 narrationText has 29 spoken words; the production maximum is 20.",
    ];
    const current = [
      "Scene 4: Narration has 21 spoken words; production scenes allow at most 20.",
    ];

    const comparison = compareEpisodeScriptValidationProgress(previous, current);
    expect(comparison).toMatchObject({
      direction: "improved",
      madeProgress: true,
      uniqueIssueCountDelta: 0,
    });
    expect(comparison.currentFingerprint).toBe(comparison.previousFingerprint);
    expect(comparison.weightedScoreDelta).toBeLessThan(0);
  });

  it("recognizes large overage reductions after the bounded severity score is saturated", () => {
    const veryLong = [
      "Scene 4 narrationText has 132 spoken words; the production maximum is 20.",
    ];
    const lessLong = [
      "Scene 4 narrationText has 70 spoken words; the production maximum is 20.",
    ];

    const improvement = compareEpisodeScriptValidationProgress(veryLong, lessLong);
    expect(improvement).toMatchObject({
      direction: "improved",
      madeProgress: true,
      weightedScoreDelta: 0,
      numericExcessDelta: -62,
    });
    expect(compareEpisodeScriptValidationProgress(lessLong, veryLong)).toMatchObject({
      direction: "regressed",
      madeProgress: false,
      weightedScoreDelta: 0,
      numericExcessDelta: 62,
    });
  });

  it("does not mistake duplicate reporting or a same-weight issue swap for progress", () => {
    const alias = "Scene 3 action/sceneDetails uses a collective or generic cast alias.";
    const duplicateReporting = compareEpisodeScriptValidationProgress(
      [alias],
      [alias, alias],
    );
    expect(duplicateReporting).toMatchObject({
      direction: "unchanged",
      madeProgress: false,
      occurrenceCountDelta: 1,
    });

    const issueSwap = compareEpisodeScriptValidationProgress(
      ["Scene 3 action/sceneDetails uses a collective or generic cast alias."],
      ["Scene 4 action/sceneDetails uses a collective or generic cast alias."],
    );
    expect(issueSwap).toMatchObject({ direction: "changed", madeProgress: false });
    expect(issueSwap.resolvedKeys).toHaveLength(1);
    expect(issueSwap.introducedKeys).toHaveLength(1);
  });

  it("keeps non-equivalent unknown messages separate and preserves their prose", () => {
    const first = "Scene 6 has an unusual but important custom violation.";
    const second = "Scene 6 violates an unrelated downstream custom rule.";
    const issues = dedupeEpisodeScriptValidationIssues([first, second]);

    expect(issues).toHaveLength(2);
    expect(issues.flatMap((issue) => issue.messages).sort()).toEqual([first, second].sort());
    expect(new Set(issues.map((issue) => issue.code)).size).toBe(2);
  });

  it("keeps distinct quoted cast subjects independently repairable", () => {
    const issues = dedupeEpisodeScriptValidationIssues([
      "Scene 9 declares figure \"Mother Mammoth\" but never names it in action/sceneDetails.",
      "Scene 9 declares figure \"Calf Mammoth\" but never names it in action/sceneDetails.",
    ]);

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.subject).sort()).toEqual([
      "calf mammoth",
      "mother mammoth",
    ]);
  });

  it("classifies semantic continuity replays as a whole-beat correction", () => {
    const issue = parseEpisodeScriptValidationIssue(
      "Scene 19 semantically repeats the narration/action beat from Scene 7; advance to a new cause, visible action, or result.",
    );

    expect(issue).toMatchObject({
      code: "scene.duplicate_beat",
      sceneNumber: 19,
      subject: "scene:7",
    });
  });
});
