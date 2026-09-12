import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAgnesVideoQaPrompts,
  contactSheetSampleTimes,
  createAgnesVideoContactSheet,
  parseAgnesVideoQaVerdict,
  planAgnesVideoQaBatches,
  type AgnesVideoQaAsset,
} from "../services/agnesVideoQaService.js";

function asset(sceneNumber: number, kind: AgnesVideoQaAsset["kind"] = "scene"): AgnesVideoQaAsset {
  return {
    sceneNumber,
    kind,
    label: kind === "scene" ? `Scene ${sceneNumber}` : kind,
    videoPath: `/tmp/${sceneNumber}.mp4`,
    durationSeconds: 8,
    requestDigest: `${sceneNumber}`.padStart(64, "0"),
    renderRevision: 0,
    narrationText: "Mia carefully opens the glowing map.",
    environmentDescription: "A warm painted attic.",
    action: "Mia opens one map and smiles.",
    expectedCast: [{ name: "Mia", description: "Exactly six-year-old girl with black pigtails." }],
  };
}

describe("Agnes episode contact-sheet QA service", () => {
  it("keeps 50 scenes plus two title clips within about 20 calls", () => {
    const assets = [asset(-2, "series_key_art"), asset(-1, "episode_key_art")];
    assets.push(...Array.from({ length: 50 }, (_unused, index) => asset(index + 1)));
    const batches = planAgnesVideoQaBatches({ assets, preferredTargetsPerSheet: 3, maxVisionCalls: 20 });

    expect(batches).toHaveLength(18);
    expect(batches[0]!.targets.map(({ sceneNumber }) => sceneNumber)).toEqual([-2, -1]);
    expect(batches[1]!.context?.sceneNumber).toBe(-1);
    expect(batches[2]!.context?.sceneNumber).toBe(3);
    expect(batches.every(({ targets }) => targets.length <= 3)).toBe(true);
  });

  it("automatically uses four targets when 60 scenes would exceed the call ceiling", () => {
    const assets = [asset(-2, "series_key_art"), asset(-1, "episode_key_art")];
    assets.push(...Array.from({ length: 60 }, (_unused, index) => asset(index + 1)));
    const batches = planAgnesVideoQaBatches({ assets, preferredTargetsPerSheet: 3, maxVisionCalls: 20 });
    expect(batches).toHaveLength(16);
    expect(Math.max(...batches.slice(1).map(({ targets }) => targets.length))).toBe(4);
  });

  it("fails fast when a call ceiling would force an unreadable or over-limit sheet", () => {
    const assets = [asset(-2, "series_key_art"), asset(-1, "episode_key_art")];
    assets.push(...Array.from({ length: 60 }, (_unused, index) => asset(index + 1)));
    expect(() => planAgnesVideoQaBatches({ assets, maxVisionCalls: 2 }))
      .toThrow("Set VIDEO_QA_MAX_VISION_CALLS to at least 6");
  });

  it("samples inside the first and last frame instead of at container boundaries", () => {
    expect(contactSheetSampleTimes(4)).toEqual([0.24, 2, 3.76]);
    expect(contactSheetSampleTimes(12)).toEqual([0.35, 6, 11.65]);
  });

  it("strictly accepts one verdict per target and rejects contradictory output", () => {
    expect(parseAgnesVideoQaVerdict(JSON.stringify({
      assets: [{ sceneNumber: 1, pass: true, confidence: 0.97, issues: [] }],
    }), [1]).assets[0]?.pass).toBe(true);

    expect(() => parseAgnesVideoQaVerdict(JSON.stringify({
      assets: [{
        sceneNumber: 1,
        pass: true,
        confidence: 0.7,
        issues: [{
          code: "duplicate_entity",
          characterNames: ["Mia"],
          frames: ["middle"],
          description: "Mia appears twice.",
        }],
      }],
    }), [1])).toThrow("pass must be true exactly when issues is empty");
    expect(() => parseAgnesVideoQaVerdict('{"assets":[]}', [1])).toThrow();
  });

  it("repairs the observed Gemini quote token only before strict validation", () => {
    const verdict = parseAgnesVideoQaVerdict(
      '{<ctrl46>assets<ctrl46>:[{<ctrl46>sceneNumber<ctrl46>:1,<ctrl46>pass<ctrl46>:false,' +
      '<ctrl46>confidence<ctrl46>:0.9,<ctrl46>issues<ctrl46>:[{<ctrl46>code<ctrl46>:' +
      '<ctrl46>wrong_cast<ctrl46>,<ctrl46>characterNames<ctrl46>:[<ctrl46>Mia<ctrl46>],' +
      '<ctrl46>frames<ctrl46>:[<ctrl46>middle<ctrl46>],<ctrl46>description<ctrl46>:' +
      '<ctrl46>Mia is missing.<ctrl46>}]}]}',
      [1],
    );
    expect(verdict.assets[0]?.issues[0]?.code).toBe("wrong_cast");
  });

  it("rejects unknown or residual Gemini control tokens", () => {
    expect(() => parseAgnesVideoQaVerdict(
      '{"assets":[{"sceneNumber":1,"pass":true,"confidence":0.9,"issues":[],"extra":"<ctrl46>"}]}',
      [1],
    )).toThrow("unresolved control tokens");
    expect(() => parseAgnesVideoQaVerdict(
      '{"assets":[{"sceneNumber":1,"pass":false,"confidence":0.9,"issues":[' +
      '{"code":<ctrl95>wrong_cast<ctrl95>,"characterNames":[],"frames":[],"description":"Wrong cast."}]}]}',
      [1],
    )).toThrow("unsupported control token");
  });

  it("does not accept a repaired control-token response unless the strict schema passes", () => {
    expect(() => parseAgnesVideoQaVerdict(
      '{"assets":[{"sceneNumber":1,"pass":false,"confidence":0.9,"issues":[' +
      '{"code":<ctrl46>wrong_character<ctrl46>,"characterNames":[],"frames":[],"description":"Wrong."}]}]}',
      [1],
    )).toThrow();
  });

  it("builds a 3072-wide labeled start/middle/end sheet with prior-scene context", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "video-qa-sheet-"));
    const outputPath = path.join(directory, "sheet.jpg");
    const run = vi.fn(async (args: readonly string[]) => {
      expect(args.join(" ")).toContain("scale=1024:576");
      expect(args.join(" ")).toContain("CONTEXT SCENE 001 START");
      expect(args.join(" ")).toContain("SCENE 002 MIDDLE");
      expect(args.join(" ")).toContain("hstack=inputs=3");
      await writeFile(String(args.at(-1)), "jpeg-data");
    });
    await createAgnesVideoContactSheet({
      batch: { batchNumber: 2, context: asset(1), targets: [asset(2), asset(3), asset(4)] },
      outputPath,
      run,
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it("gives Gemini exact cast, age, semantic beat, and strict issue codes", () => {
    const prompts = buildAgnesVideoQaPrompts({ batchNumber: 1, targets: [asset(1)] });
    expect(prompts.systemPrompt).toContain("START, MIDDLE, END");
    expect(prompts.systemPrompt).toContain("duplicate_entity");
    expect(prompts.systemPrompt).toContain("2D hand-painted painterly storybook style");
    expect(prompts.userText).toContain("exact visible cast, each exactly once");
    expect(prompts.userText).toContain("Exactly six-year-old girl");
    expect(prompts.userText).toContain("Mia opens one map");
  });
});
