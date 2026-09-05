import { beforeEach, describe, expect, it, vi } from "vitest";

const chatTextMock = vi.fn();
vi.mock("../providers/aiClient.js", () => ({
  chatText: (...args: unknown[]) => chatTextMock(...args),
}));

import { buildScriptRefinementTool, validateEpisodeScript } from "../tools/scriptRefinementTool.js";
import {
  DEFAULT_PRODUCTION_MAX_SCENES,
  DEFAULT_PRODUCTION_MIN_SCENES,
  NARRATION_MAX_RAW_CHARACTERS,
  NARRATION_MAX_SPOKEN_WORDS,
} from "../services/narrationContract.js";

describe("scriptRefinementTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes nested stringified scene arrays and nested scene arrays inside scriptJson", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 9,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: JSON.stringify(["Chip the Squirrel"]),
            characterVisuals: JSON.stringify([{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }]),
            supportingEntities: JSON.stringify(["Ladybug friend: tiny red ladybug with black dots"]),
            continuityAnchors: JSON.stringify(["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."]),
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).call({
      scriptJson: JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: JSON.stringify([
          {
            sceneNumber: 1,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: JSON.stringify(["Chip the Squirrel"]),
            characterVisuals: JSON.stringify([{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }]),
            supportingEntities: JSON.stringify(["Ladybug friend: tiny red ladybug with black dots"]),
            continuityAnchors: JSON.stringify(["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."]),
          },
        ]),
      }),
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].characterNames).toEqual(["Chip the Squirrel"]);
    expect(parsed.scriptJson.scenes[0].characterVisuals).toEqual([
      { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
    ]);
    expect(parsed.scriptJson.scenes[0].supportingEntities).toEqual([
      "Ladybug friend: tiny red ladybug with black dots",
    ]);
    expect(parsed.scriptJson.scenes[0].continuityAnchors).toEqual([
      "Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass.",
    ]);
    expect(parsed.validation.pass).toBe(true);
  });

  it("asks the refinement model to preserve explicit continuity anchors with visual specifics", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel searched under the oak roots.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel peers under the roots.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
            continuityAnchors: ["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."],
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    await (tool as any).func({
      scriptJson: {
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel looked high and low.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel searches for the acorn.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const request = chatTextMock.mock.calls[0][0];
    expect(request.systemPrompt).toContain("continuityAnchors");
    expect(request.systemPrompt).toContain("characterVisuals");
    expect(request.systemPrompt).toContain("visualForm");
    expect(request.systemPrompt).toContain("color, pattern, material, shape, size, placement, and current state/change");
    expect(request.userText).toContain("add or preserve continuityAnchors");
    expect(request.userText).toContain("characterVisuals entries aligned 1:1 with characterNames");
    expect(request.userText).toContain("color, pattern, material, shape, placement, and current state");
    expect(request.systemPrompt).toContain("ONE SCENE = ONE AUDIO = ONE VIDEO");
    expect(request.systemPrompt).toContain(`no more than ${NARRATION_MAX_RAW_CHARACTERS} raw characters`);
    expect(request.systemPrompt).toContain(`no more than ${NARRATION_MAX_SPOKEN_WORDS} spoken words`);
    expect(request.systemPrompt).toContain("preserve its environmentDescription verbatim");
    expect(request.systemPrompt).toContain("Copy every supportingEntities descriptor verbatim");
    expect(request.systemPrompt).toContain("Copy continuityAnchors verbatim through all children");
    expect(request.userText).toContain("For every split, preserve the source environmentDescription");
  });

  it("normalizes stringified scriptJson and renumbers refined scenes", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 9,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
            continuityAnchors: ["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."],
            sceneDetails: "Chip the Squirrel: alert, crouching beside the pale gray oak roots, scanning the short green grass for the missing acorn.",
          },
          {
            sceneNumber: 10,
            narrationText: "Pip the Ant arrives to help.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Pip the Ant waves up at Chip the Squirrel.",
            characterNames: ["Pip the Ant", "Chip the Squirrel"],
            characterVisuals: [
              { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
              { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
            ],
            continuityAnchors: ["Acorn search setup: glossy chestnut-brown acorn tucked beside a pale gray oak root in short green grass."],
            sceneDetails: "Pip the Ant: helpful, waving beside the pale gray oak roots. Chip the Squirrel: hopeful, leaning down toward the grass while the same search area stays visible.",
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: JSON.stringify({
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "It was a bright morning in Meadow Meadow.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel looks around the roots.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      }),
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].sceneNumber).toBe(1);
    expect(parsed.scriptJson.scenes[1].sceneNumber).toBe(2);
    expect(parsed.validation.pass).toBe(true);
  });

  it("accepts draft scenes with missing required fields and reports validation issues instead of failing schema parsing", async () => {
    chatTextMock
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("still not json")
      .mockResolvedValueOnce("repair prose")
      .mockResolvedValueOnce("still invalid");

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "The Firefly Lights the Way Home",
        premise: "Luna helps guide friends home at dusk.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Luna glows brighter as dusk settles over the meadow.",
            characterVisuals: [{ name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].sceneNumber).toBe(1);
    expect(parsed.scriptJson.scenes[0].environmentDescription).toBe("");
    expect(parsed.scriptJson.scenes[0].action).toBe("");
    expect(parsed.scriptJson.scenes[0].characterNames).toEqual(["Luna the Firefly"]);
    expect(parsed.validation.pass).toBe(false);
    expect(parsed.validation.issues).toContain("Scene 1 is missing environmentDescription.");
    expect(parsed.validation.issues).toContain("Scene 1 is missing action.");
  });

  it("runs one repair pass when deterministic validation still fails after review", async () => {
    chatTextMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "The Lost Acorn",
          premise: "Chip loses a shiny acorn.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Chip the Squirrel looked high and low, then he ran to the wall, then he hurried to the creek, then he called to everyone for help.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Chip the Squirrel searches for the acorn.",
              characterNames: ["Chip the Squirrel"],
              characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "The Lost Acorn",
          premise: "Chip loses a shiny acorn.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Chip the Squirrel searched under the oak roots.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Chip the Squirrel peers under the roots.",
              characterNames: ["Chip the Squirrel"],
              characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
              continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
              sceneDetails: "Chip the Squirrel: focused, crouching low under the pale gray roots, brushing short green grass aside with both paws.",
            },
            {
              sceneNumber: 2,
              narrationText: "Then Pip the Ant hurried over to help.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Pip the Ant reaches Chip the Squirrel.",
              characterNames: ["Pip the Ant", "Chip the Squirrel"],
              characterVisuals: [
                { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
              ],
              continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
              sceneDetails: "Pip the Ant: eager, hurrying to the roots with one arm raised. Chip the Squirrel: relieved, pointing at the short green grass beneath the same roots.",
            },
          ],
        })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel looked high and low.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel searches for the acorn.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(chatTextMock).toHaveBeenCalledTimes(2);
    expect(chatTextMock.mock.calls[1][0].userText).toContain("Deterministic issues to fix");
    expect(parsed.scriptJson.scenes).toHaveLength(2);
    expect(parsed.validation.pass).toBe(true);
  });

  it("recovers when the first refinement response is prose instead of JSON", async () => {
    chatTextMock
      .mockResolvedValueOnce("We need to split the story into more scenes before returning JSON.")
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "The Lost Acorn",
          premise: "Chip loses a shiny acorn.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Chip the Squirrel searched under the oak roots.",
              environmentDescription: "Sunny meadow near the oak tree.",
              action: "Chip the Squirrel peers under the roots.",
               characterNames: ["Chip the Squirrel"],
               characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
               continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
               sceneDetails: "Chip the Squirrel: focused, crouching low under the pale gray roots, brushing short green grass aside with both paws.",
             },
             {
               sceneNumber: 2,
               narrationText: "Pip the Ant joins Chip the Squirrel.",
               environmentDescription: "Sunny meadow near the oak tree.",
               action: "Pip the Ant joins Chip the Squirrel.",
               characterNames: ["Pip the Ant", "Chip the Squirrel"],
               characterVisuals: [
                 { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                 { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
               ],
               continuityAnchors: ["Oak-root search setup: pale gray oak roots arching over short green grass where the lost acorn may be hidden."],
               sceneDetails: "Pip the Ant: eager, hurrying to the roots with one arm raised. Chip the Squirrel: hopeful, leaning toward the same short green grass search area.",
             },
           ],
         })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "The Lost Acorn",
        premise: "Chip loses a shiny acorn.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Chip the Squirrel looked high and low.",
            environmentDescription: "Sunny meadow near the oak tree.",
            action: "Chip the Squirrel searches for the acorn.",
            characterNames: ["Chip the Squirrel"],
            characterVisuals: [{ name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false }],
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(chatTextMock).toHaveBeenCalledTimes(2);
    expect(parsed.scriptJson.scenes).toHaveLength(2);
    expect(parsed.warnings).toContain("Initial refinement response was invalid JSON and required one strict repair retry.");
  });

  it("falls back to the original drafted script when refinement never returns parseable JSON", async () => {
    chatTextMock
      .mockResolvedValueOnce("We need to rethink the whole outline first.")
      .mockResolvedValueOnce("Still not JSON.")
      .mockResolvedValueOnce("This repair pass is also commentary.")
      .mockResolvedValueOnce("No JSON here either.");

    const originalScript = {
      title: "The Lost Acorn",
      premise: "Chip loses a shiny acorn.",
      scenes: [
        {
          sceneNumber: 1,
          narrationText: "Chip the Squirrel looked high and low.",
          environmentDescription: "Sunny meadow near the oak tree.",
          action: "Chip the Squirrel searches for the acorn.",
          characterNames: ["Chip the Squirrel"],
        },
      ],
    };

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: originalScript,
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson).toEqual(originalScript);
    expect(parsed.validation.pass).toBe(false);
    expect(parsed.warnings[0]).toContain("Script refinement failed; using original drafted script.");
    expect(parsed.warnings[1]).toContain("Repair pass failed; keeping last valid script.");
  });

  it("flags continuing setups without continuity anchors and weak sceneDetails for complex scenes", async () => {
    chatTextMock
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("still not json")
      .mockResolvedValueOnce("not json again")
      .mockResolvedValueOnce("still invalid");

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Storm Lantern",
        premise: "A storm darkens the treehouse.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Rain tapped the window while the lantern shook overhead.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "All six friends gather under the lantern.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            characterVisuals: [
              { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
              { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
              { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
              { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
              { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
              { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
            ],
            continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
            sceneDetails: "Pip worries while Nibbles watches the lantern. Sunny glances at the window as Luna glows softly beside the table.",
          },
          {
            sceneNumber: 2,
            narrationText: "The lantern flickered and the room dimmed.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "Lantern flickers as everyone looks up.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            characterVisuals: [
              { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
              { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
              { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
              { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
              { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
              { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
            ],
            sceneDetails: "Lantern flickering.",
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.pass).toBe(false);
    expect(parsed.validation.issues).toContain(
      "Scene 2 continues the same setup/location as the previous scene but is missing continuityAnchors."
    );
    expect(parsed.validation.issues).toContain(
      "Scene 2 needs richer sceneDetails for reliable video generation because it has a complex cast or important visual setup."
    );
  });

  it("repairs only targeted scene fields using previous-scene continuity context before full-script repair", async () => {
    chatTextMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "Storm Lantern",
          premise: "A storm darkens the treehouse.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Rain tapped the window while the lantern shook overhead.",
              environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
              action: "All six friends gather under the lantern.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
              characterVisuals: [
                { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
                { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
                { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
                { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
                { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
              ],
              continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
              sceneDetails: "Pip worries while Nibbles watches the lantern. Sunny glances at the window as Luna glows softly beside the table.",
            },
            {
              sceneNumber: 2,
              narrationText: "The lantern flickered and the room dimmed.",
              environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
              action: "Lantern flickers as everyone looks up.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
              characterVisuals: [
                { name: "Pip the Ant", visualForm: "real_creature", speciesOrType: "ant", humanoidAllowed: false },
                { name: "Nibbles the Hamster", visualForm: "real_creature", speciesOrType: "hamster", humanoidAllowed: false },
                { name: "Sunny the Sparrow", visualForm: "real_creature", speciesOrType: "sparrow", humanoidAllowed: false },
                { name: "Pebble the Turtle", visualForm: "real_creature", speciesOrType: "turtle", humanoidAllowed: false },
                { name: "Luna the Firefly", visualForm: "real_creature", speciesOrType: "firefly", humanoidAllowed: false },
                { name: "Chip the Squirrel", visualForm: "real_creature", speciesOrType: "squirrel", humanoidAllowed: false },
              ],
              sceneDetails: "Lantern flickering.",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
          sceneDetails: "Pip the Ant, Nibbles the Hamster, Sunny the Sparrow, Pebble the Turtle, Luna the Firefly, and Chip the Squirrel all look up from the round wooden table as the warm brass lantern flickers above them and rain streaks the side window.",
        })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Storm Lantern",
        premise: "A storm darkens the treehouse.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Rain tapped the window while the lantern shook overhead.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "All six friends gather under the lantern.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            continuityAnchors: ["Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors."],
            sceneDetails: "Pip worries while Nibbles watches the lantern. Sunny glances at the window as Luna glows softly beside the table.",
          },
          {
            sceneNumber: 2,
            narrationText: "The lantern flickered and the room dimmed.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "Lantern flickers as everyone looks up.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster", "Sunny the Sparrow", "Pebble the Turtle", "Luna the Firefly", "Chip the Squirrel"],
            sceneDetails: "Lantern flickering.",
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.pass).toBe(true);
    expect(chatTextMock).toHaveBeenCalledTimes(2);
    expect(parsed.scriptJson.scenes[1].continuityAnchors).toEqual([
      "Storm treehouse setup: warm brass lantern above a round wooden table, rain streaking the side window, and six tiny animal friends gathered indoors.",
    ]);
    expect(parsed.scriptJson.scenes[1].sceneDetails).toContain("warm brass lantern flickers above them");
    expect(parsed.scriptJson.scenes[1].sceneDetails).toContain("rain streaks the side window");
  });

  it("does not instruct targeted scene repair to carry forward continuity anchors across environment changes", async () => {
    chatTextMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "From Treehouse To Meadow",
          premise: "The friends run outside after the storm eases.",
          scenes: [
            {
              sceneNumber: 1,
              narrationText: "Inside the treehouse, the lantern still swayed gently.",
              environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
              action: "Friends glance at the lantern.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster"],
              continuityAnchors: ["Treehouse setup: warm brass lantern above a round wooden table inside dark brown treehouse walls."],
              sceneDetails: "Pip the Ant and Nibbles the Hamster stand beside the round wooden table while the warm brass lantern sways above them.",
            },
            {
              sceneNumber: 2,
              narrationText: "Outside, the wet meadow sparkled after the rain.",
              environmentDescription: "A bright meadow with wet green grass, shining puddles, and fresh sunlight after the storm.",
              action: "Pip the Ant and Nibbles the Hamster step into the meadow.",
              characterNames: ["Pip the Ant", "Nibbles the Hamster"],
              sceneDetails: "Pip and Nibbles step outside.",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          continuityAnchors: ["Post-storm meadow setup: wet bright-green grass, silver puddles reflecting sunlight, and a fresh blue sky opening above the field."],
          sceneDetails: "Pip the Ant and Nibbles the Hamster stand in the wet bright-green grass beside silver puddles, fresh sunlight glinting across the puddle edges, while the clearing blue sky opens above the meadow.",
        })
      );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "From Treehouse To Meadow",
        premise: "The friends run outside after the storm eases.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Inside the treehouse, the lantern still swayed gently.",
            environmentDescription: "Inside the treehouse during the storm, a lantern hangs over the table.",
            action: "Friends glance at the lantern.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster"],
            continuityAnchors: ["Treehouse setup: warm brass lantern above a round wooden table inside dark brown treehouse walls."],
            sceneDetails: "Pip the Ant and Nibbles the Hamster stand beside the round wooden table while the warm brass lantern sways above them.",
          },
          {
            sceneNumber: 2,
            narrationText: "Outside, the wet meadow sparkled after the rain.",
            environmentDescription: "A bright meadow with wet green grass, shining puddles, and fresh sunlight after the storm.",
            action: "Pip the Ant and Nibbles the Hamster step into the meadow.",
            characterNames: ["Pip the Ant", "Nibbles the Hamster"],
            sceneDetails: "Pip and Nibbles step outside.",
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.pass).toBe(false);
    const targetedRepairRequest = chatTextMock.mock.calls.find(
      (call) => typeof call[0]?.userText === "string" && call[0].userText.includes("Same environment as previous scene: no")
    )?.[0];
    expect(targetedRepairRequest).toBeDefined();
    expect(targetedRepairRequest.userText).toContain("Same environment as previous scene: no");
    expect(targetedRepairRequest.userText).toContain("Because the environment changed, generate continuityAnchors from the current scene itself");
    expect(parsed.validation.issues.some((issue: string) => issue.includes("sceneDetails"))).toBe(true);
  });

  it("validates scripts containing 0-character scenery-only scenes without error", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "Meadow At Night",
        premise: "Fireflies light up the meadow after sunset.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "As dusk settled over the meadow, tiny yellow fireflies began to blink into the evening sky.",
            environmentDescription: "A bright green meadow filled with colorful wildflowers, soft grass, and fireflies.",
            action: "Fireflies glow softly over the darkening meadow grass.",
            characterNames: [],
            cameraAngle: "establishing",
            lighting: "cool blue dusk with fireflies",
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Meadow At Night",
        premise: "Fireflies light up the meadow after sunset.",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "As dusk settled over the meadow, tiny yellow fireflies began to blink into the evening sky.",
            environmentDescription: "A bright green meadow filled with colorful wildflowers, soft grass, and fireflies.",
            action: "Fireflies glow softly over the darkening meadow grass.",
            characterNames: [],
            cameraAngle: "establishing",
            lighting: "cool blue dusk with fireflies",
          },
        ],
      },
      minScenes: 1,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.scriptJson.scenes[0].characterNames).toEqual([]);
    expect(parsed.validation.pass).toBe(true);
    expect(parsed.validation.issues).toEqual([]);
  });

  it("flags validation issue when a scene continues interacting with supporting entities from previous scene but drops supportingEntities", async () => {
    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "Egyptian Adventure",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Cleo the Scribe pointed to the glowing hieroglyph.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Cleo points to the wall while Mia looks on.",
            characterNames: ["Mia"],
            characterVisuals: [{ name: "Mia", visualForm: "humanoid", speciesOrType: "little girl", humanoidAllowed: true }],
            supportingEntities: ["Cleo the Scribe: young Egyptian girl in white linen"],
            continuityAnchors: ["Chamber setup: glowing stone pedestal"],
            sceneDetails: "Mia and Cleo the Scribe examine the stone hieroglyph on the wall together.",
          },
          {
            sceneNumber: 2,
            narrationText: "Mia smiled as Cleo the Scribe explained the ancient symbols.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Mia listens as Cleo points.",
            characterNames: ["Mia"],
            characterVisuals: [{ name: "Mia", visualForm: "humanoid", speciesOrType: "little girl", humanoidAllowed: true }],
            continuityAnchors: ["Chamber setup: glowing stone pedestal"],
            sceneDetails: "Mia and Cleo the Scribe stand by the chamber wall examining the symbols.",
          },
        ],
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Egyptian Adventure",
        scenes: [
          {
            sceneNumber: 1,
            narrationText: "Cleo the Scribe pointed to the glowing hieroglyph.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Cleo points to the wall while Mia looks on.",
            characterNames: ["Mia"],
            supportingEntities: ["Cleo the Scribe: young Egyptian girl in white linen"],
          },
          {
            sceneNumber: 2,
            narrationText: "Mia smiled as Cleo the Scribe explained the ancient symbols.",
            environmentDescription: "Inside the ancient stone chamber.",
            action: "Mia listens as Cleo points.",
            characterNames: ["Mia"],
          },
        ],
      },
      minScenes: 2,
      maxScenes: 4,
      targetRuntimeMinutes: 5,
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.issues.some((issue: string) => issue.includes("supporting entities"))).toBe(true);
  });

  it("flags validation issue when a production script has insufficient total narration words for a 5-minute episode", async () => {
    const briefScenes = Array.from({ length: 20 }, (_, i) => ({
      sceneNumber: i + 1,
      narrationText: `Mia looked at the old tree on step ${i + 1}.`,
      environmentDescription: "Sunny green meadow.",
      action: `Mia inspects step ${i + 1}.`,
      characterNames: ["Mia"],
      characterVisuals: [{ name: "Mia", visualForm: "humanoid" as const, speciesOrType: "little girl", humanoidAllowed: true }],
      continuityAnchors: ["Meadow setup: tall green grass"],
      sceneDetails: "Mia stands near the tree in the sunny green meadow.",
    }));

    chatTextMock.mockResolvedValueOnce(
      JSON.stringify({
        title: "Short Narration Episode",
        scenes: briefScenes,
      })
    );

    const tool = buildScriptRefinementTool();
    const result = await (tool as any).func({
      scriptJson: {
        title: "Short Narration Episode",
        scenes: briefScenes,
      },
      minScenes: 20,
      maxScenes: 30,
      targetRuntimeMinutes: 5,
      mainCharacterNames: ["Mia"],
    });

    const parsed = JSON.parse(result);
    expect(parsed.validation.issues.some((issue: string) => issue.includes("narration word count too low"))).toBe(true);
    expect(parsed.status).toBe("needs_repair");
    expect(parsed.scriptJson).toBeUndefined();
  });

  it("deterministically rejects narration over 200 raw characters and over 20 spoken words", () => {
    const overCharacterValidation = validateEpisodeScript({
      title: "Long input",
      scenes: [{
        sceneNumber: 1,
        narrationText: "x".repeat(NARRATION_MAX_RAW_CHARACTERS + 1),
        environmentDescription: "A sunny meadow clearing.",
        action: "Mia watches the meadow.",
        characterNames: [],
      }],
    }, 1, 4, 5);

    const longNarration = `${Array.from(
      { length: NARRATION_MAX_SPOKEN_WORDS + 1 },
      (_, index) => `word${index}`,
    ).join(" ")}.`;
    const productionScenes = Array.from({ length: 15 }, (_, index) => ({
      sceneNumber: index + 1,
      narrationText: longNarration,
      environmentDescription: `A distinct meadow clearing ${index + 1}.`,
      action: `Mia observes clearing ${index + 1}.`,
      characterNames: [],
    }));
    const overWordValidation = validateEpisodeScript({
      title: "Too many words per scene",
      scenes: productionScenes,
    }, 15, DEFAULT_PRODUCTION_MAX_SCENES, 5);

    expect(overCharacterValidation.issues.some((issue) => issue.includes("200-character"))).toBe(true);
    expect(overWordValidation.issues.some((issue) => issue.includes("maximum is 20"))).toBe(true);
  });

  it("accepts a feasible five-minute production script made of bounded one-video scenes", () => {
    const boundedNarration =
      "Mia watches the golden lantern glow softly while friendly fireflies dance above the quiet meadow and everyone smiles together happily.";
    const scenes = Array.from({ length: DEFAULT_PRODUCTION_MIN_SCENES }, (_, index) => ({
      sceneNumber: index + 1,
      narrationText: boundedNarration,
      environmentDescription: `A distinct moonlit meadow clearing number ${index + 1}.`,
      action: `Mia watches the lantern in clearing ${index + 1}.`,
      characterNames: [],
      characterVisuals: [],
      sceneDetails: "The golden lantern remains centered while soft fireflies trace one gentle arc above the quiet grass.",
      cameraAngle: "medium wide child-eye-level shot",
      lighting: "warm golden twilight",
    }));

    const validation = validateEpisodeScript(
      { title: "The Lantern Trail", scenes },
      DEFAULT_PRODUCTION_MIN_SCENES,
      DEFAULT_PRODUCTION_MAX_SCENES,
      5,
      ["Mia"],
    );

    expect(validation).toEqual({ pass: true, issues: [] });
  });

  it("rejects a renumbered duplicate narration/action beat", () => {
    const scene = {
      sceneNumber: 1,
      narrationText: "Pip lifts the little berry and smiles.",
      environmentDescription: "A sunny meadow beside the clubhouse.",
      action: "Pip lifts one red berry.",
      characterNames: ["Pip"],
      characterVisuals: [{
        name: "Pip",
        visualForm: "real_creature" as const,
        speciesOrType: "ant",
        humanoidAllowed: false,
      }],
      sceneDetails: "Pip stands beside the clubhouse and lifts the berry with a warm smile.",
      cameraAngle: "medium",
      lighting: "warm morning light",
    };
    const validation = validateEpisodeScript({
      title: "Duplicate Beat",
      scenes: [scene, { ...structuredClone(scene), sceneNumber: 2 }],
    }, 1, 4);

    expect(validation.pass).toBe(false);
    expect(validation.issues.join(" ")).toContain("duplicates the complete narration/action beat");
  });
});
