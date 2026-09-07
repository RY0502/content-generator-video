import { describe, expect, it, vi } from "vitest";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { buildSeriesStateTools } from "../tools/seriesStateTools.js";
import { EpisodeAudioReadinessError } from "../state/seriesState.js";

function buildSeason() {
  return Array.from({ length: 25 }, (_unused, index) => ({
    episodeNumber: index + 1,
    title: `Episode ${index + 1}`,
    premise: `Pip solves gentle problem ${index + 1}.`,
  }));
}

function buildProductionScript() {
  const narration =
    "Pip gently carries the bright berry across the sunny meadow while patient friends smile beside their cozy little clubhouse today.";
  return {
    title: "The Windy Picnic",
    scenes: Array.from({ length: 40 }, (_unused, index) => ({
      sceneNumber: index + 1,
      narrationText: narration,
      environmentDescription: "A sunny green meadow beside the little wooden clubhouse.",
      action: `Pip the Ant takes careful step ${index + 1} while Ladybug friend watches the berry.`,
      characterNames: ["Pip the Ant"],
      characterVisuals: [{
        name: "Pip the Ant",
        visualForm: "real_creature",
        speciesOrType: "ant",
        humanoidAllowed: false,
      }],
      supportingEntities: ["Ladybug friend: tiny red ladybug with seven round black spots"],
      continuityAnchors: ["Berry: one glossy raspberry-red berry held above the grass."],
      sceneDetails: `Pip the Ant and Ladybug friend remain fully visible beside the berry during careful step ${index + 1}.`,
      cameraAngle: "medium wide shot at child eye level",
      lighting: "warm soft morning sunlight",
    })),
  };
}

describe("seriesStateTools", () => {
  it("normalizes stringified characters and environments for get_or_create_series", async () => {
    const findSeriesIdByConceptName = vi.fn().mockResolvedValue(null);
    const getOrCreateSeries = vi.fn().mockResolvedValue(42);
    const tools = buildSeriesStateTools({
      findSeriesIdByConceptName,
      getOrCreateSeries,
    } as any);

    const tool = tools.find((entry) => entry.name === "get_or_create_series");
    expect(tool).toBeDefined();

    const result = await (tool as any).call({
      conceptName: "Tiny Heroes Club",
      characters: JSON.stringify([
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ]),
      environments: JSON.stringify([
        {
          name: "Meadow Clearing",
          description: "A sunny open grass area dotted with wildflowers.",
        },
      ]),
      episodeFormula: "Teamwork rescue",
    });

    expect(getOrCreateSeries).toHaveBeenCalledWith(
      "Tiny Heroes Club",
      [
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ],
      [
        {
          name: "Meadow Clearing",
          description: "A sunny open grass area dotted with wildflowers.",
        },
      ],
      "Teamwork rescue"
    );
    expect(findSeriesIdByConceptName).toHaveBeenCalledWith("Tiny Heroes Club");
    expect(JSON.parse(result).seriesId).toEqual(42);
  });

  it("repairs malformed stringified environments for get_or_create_series", async () => {
    const findSeriesIdByConceptName = vi.fn().mockResolvedValue(null);
    const getOrCreateSeries = vi.fn().mockResolvedValue(42);
    const tools = buildSeriesStateTools({
      findSeriesIdByConceptName,
      getOrCreateSeries,
    } as any);

    const tool = tools.find((entry) => entry.name === "get_or_create_series");
    expect(tool).toBeDefined();

    const result = await (tool as any).call({
      conceptName: "Tiny Heroes Club",
      characters: JSON.stringify([
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ]),
      environments:
        '[{"name": "Meadow Clearing", "description": "A sunny open grass area dotted with wildflowers."}, {name: "Pond Edge", description: "A peaceful pond with lily pads and reeds."}]',
      episodeFormula: "Teamwork rescue",
    });

    expect(getOrCreateSeries).toHaveBeenCalledWith(
      "Tiny Heroes Club",
      [
        {
          name: "Pip the Ant",
          description: "A brave red ant who leads the Tiny Heroes Club.",
        },
      ],
      [
        {
          name: "Meadow Clearing",
          description: "A sunny open grass area dotted with wildflowers.",
        },
        {
          name: "Pond Edge",
          description: "A peaceful pond with lily pads and reeds.",
        },
      ],
      "Teamwork rescue"
    );
    expect(JSON.parse(result).seriesId).toEqual(42);
  });

  it("reuses an existing series from a conceptName-only bootstrap call", async () => {
    const findSeriesIdByConceptName = vi.fn().mockResolvedValue(42);
    const getOrCreateSeries = vi.fn();
    const getSeriesCharacters = vi.fn().mockResolvedValue([
      { name: "Pip the Ant", description: "A brave red ant." },
    ]);
    const getSeriesEnvironments = vi.fn().mockResolvedValue([
      { name: "Meadow", description: "A sunny wildflower meadow." },
    ]);
    const tools = buildSeriesStateTools({
      findSeriesIdByConceptName,
      getOrCreateSeries,
      getSeriesCharacters,
      getSeriesEnvironments,
    } as any);
    const tool = tools.find((entry) => entry.name === "get_or_create_series");

    const result = JSON.parse(await (tool as any).call({
      conceptName: "Tiny Heroes Club",
    }));

    expect(result).toEqual({
      seriesId: 42,
      characters: [{ name: "Pip the Ant", description: "A brave red ant." }],
      environments: [{ name: "Meadow", description: "A sunny wildflower meadow." }],
    });
    expect(getOrCreateSeries).not.toHaveBeenCalled();
    expect(getSeriesCharacters).toHaveBeenCalledWith(42);
    expect(getSeriesEnvironments).toHaveBeenCalledWith(42);
  });

  it("requests a complete definition only when a conceptName-only lookup is absent", async () => {
    const findSeriesIdByConceptName = vi.fn().mockResolvedValue(null);
    const getOrCreateSeries = vi.fn();
    const tools = buildSeriesStateTools({
      findSeriesIdByConceptName,
      getOrCreateSeries,
    } as any);
    const tool = tools.find((entry) => entry.name === "get_or_create_series");

    const result = JSON.parse(await (tool as any).call({
      conceptName: "New Story Club",
    }));

    expect(result).toMatchObject({
      status: "needs_definition",
      persisted: false,
      conceptName: "New Story Club",
      missingFields: ["characters", "environments", "episodeFormula"],
      retryThisInvocation: true,
    });
    expect(getOrCreateSeries).not.toHaveBeenCalled();
  });

  it("normalizes stringified episodes for bulk_insert_episode_list", async () => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({
      bulkInsertEpisodesIfEmpty,
    } as any);

    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");
    expect(tool).toBeDefined();

    const episodes = buildSeason();

    const result = await (tool as any).call({
      seriesId: 12,
      episodes: JSON.stringify(episodes),
    });

    expect(bulkInsertEpisodesIfEmpty).toHaveBeenCalledWith(12, episodes);
    expect(JSON.parse(result)).toEqual({ status: "ok" });
  });

  it("verifies an existing episode manifest from a seriesId-only bootstrap call", async () => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue("verified");
    const tools = buildSeriesStateTools({ bulkInsertEpisodesIfEmpty } as any);
    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");

    const result = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(result).toEqual({ status: "ok" });
    expect(bulkInsertEpisodesIfEmpty).toHaveBeenCalledWith(12, undefined);
  });

  it("requests the full manifest only when a seriesId-only bootstrap call finds none", async () => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue("manifest_required");
    const tools = buildSeriesStateTools({ bulkInsertEpisodesIfEmpty } as any);
    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");

    const result = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(result).toMatchObject({
      status: "manifest_required",
      persisted: false,
      seriesId: 12,
      retryThisInvocation: true,
    });
  });

  it("advertises only compact identifiers as required bootstrap arguments", () => {
    const tools = buildSeriesStateTools({} as any);
    const getOrCreate = tools.find((entry) => entry.name === "get_or_create_series");
    const bulkInsert = tools.find((entry) => entry.name === "bulk_insert_episode_list");
    const getOrCreateDefinition = convertToOpenAITool(getOrCreate as any) as any;
    const bulkInsertDefinition = convertToOpenAITool(bulkInsert as any) as any;

    expect(getOrCreateDefinition.function.parameters.required).toEqual(["conceptName"]);
    expect(bulkInsertDefinition.function.parameters.required).toEqual(["seriesId"]);
  });

  it("normalizes preprise to premise for bulk_insert_episode_list", async () => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({
      bulkInsertEpisodesIfEmpty,
    } as any);

    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");
    expect(tool).toBeDefined();

    const expectedEpisodes = buildSeason();
    expectedEpisodes[15] = {
      episodeNumber: 16,
      title: "Sunny's Dawn Chorus",
      premise: "Sunny learns that every voice matters in the choir.",
    };
    const suppliedEpisodes = expectedEpisodes.map((episode) =>
      episode.episodeNumber === 16
        ? {
            episodeNumber: episode.episodeNumber,
            title: episode.title,
            preprise: episode.premise,
          }
        : episode,
    );

    const result = await (tool as any).call({
      seriesId: 12,
      episodes: JSON.stringify(suppliedEpisodes),
    });

    expect(bulkInsertEpisodesIfEmpty).toHaveBeenCalledWith(12, expectedEpisodes);
    expect(JSON.parse(result)).toEqual({ status: "ok" });
  });

  it.each([
    {
      name: "a short season",
      mutate: (episodes: ReturnType<typeof buildSeason>) => episodes.slice(0, 24),
    },
    {
      name: "duplicate and non-sequential numbers",
      mutate: (episodes: ReturnType<typeof buildSeason>) => {
        episodes[15] = { ...episodes[15], episodeNumber: 15 };
        return episodes;
      },
    },
    {
      name: "a blank title",
      mutate: (episodes: ReturnType<typeof buildSeason>) => {
        episodes[8] = { ...episodes[8], title: "   " };
        return episodes;
      },
    },
    {
      name: "a blank premise",
      mutate: (episodes: ReturnType<typeof buildSeason>) => {
        episodes[8] = { ...episodes[8], premise: "   " };
        return episodes;
      },
    },
  ])("rejects $name before calling SeriesState", async ({ mutate }) => {
    const bulkInsertEpisodesIfEmpty = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({ bulkInsertEpisodesIfEmpty } as any);
    const tool = tools.find((entry) => entry.name === "bulk_insert_episode_list");

    await expect((tool as any).call({
      seriesId: 12,
      episodes: mutate(buildSeason()),
    })).rejects.toThrow();
    expect(bulkInsertEpisodesIfEmpty).not.toHaveBeenCalled();
  });

  it("returns the discriminated ready result from get_next_episode", async () => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "audio",
        scriptJson: buildProductionScript(),
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const getNextEpisodeAvailability = vi.fn().mockResolvedValue(availability);
    const getSeriesCharacters = vi.fn().mockResolvedValue([
      { name: "Pip the Ant", description: "A patient red ant." },
    ]);
    const listAgnesSceneGenerations = vi.fn().mockResolvedValue([]);
    const getEpisodeScriptDraft = vi.fn().mockResolvedValue({
      episodeId: 7,
      revision: 3,
      contentDigest: "a".repeat(64),
      scriptJson: { private: "must not be returned" },
      validation: {
        pass: false,
        sceneCount: 40,
        totalSpokenWords: 780,
        issueCount: 2,
        issues: ["Needs two repairs."],
        omittedIssueCount: 1,
        repairEvidence: {
          durationExceededScenes: Array.from({ length: 20 }, (_unused, index) => ({
            sceneNumber: index + 1,
            durationSeconds: 12.5,
          })),
          measuredTotalNarrationSeconds: 280,
          measuredNarrationSceneCount: 40,
          measuredNarrationRecoveryWordTarget: 830,
        },
      },
      createdAt: "2026-09-04T01:00:00.000Z",
      updatedAt: "2026-09-04T02:00:00.000Z",
    });
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability,
      getSeriesCharacters,
      listAgnesSceneGenerations,
      getEpisodeScriptDraft,
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 320 }),
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const result = await (tool as any).call({ seriesId: 12 });

    expect(getNextEpisodeAvailability).toHaveBeenCalledOnce();
    expect(getNextEpisodeAvailability).toHaveBeenCalledWith(12);
    const { scriptJson: _scriptJson, ...episodeReceipt } = availability.episode;
    expect(JSON.parse(result)).toMatchObject({
      ...availability,
      episode: episodeReceipt,
      resumeAction: "repair_script",
      scriptValidation: {
        status: "ready",
        pass: true,
        sceneCount: 40,
        agnesSubmissionStarted: false,
      },
      scriptDraft: {
        episodeId: 7,
        revision: 3,
        contentDigest: "a".repeat(64),
        validation: {
          pass: false,
          issueCount: 2,
          issues: ["Needs two repairs."],
          requiredAction: "resume_narration_repair",
          durableTimingEvidence: {
            durationExceededSceneCount: 20,
            hasMeasuredTotalNarrationSeconds: true,
            measuredNarrationSceneCount: 40,
          },
        },
      },
    });
    expect(JSON.parse(result).episode).not.toHaveProperty("scriptJson");
    expect(JSON.parse(result).scriptDraft).not.toHaveProperty("scriptJson");
    expect(JSON.parse(result).scriptDraft.validation).not.toHaveProperty("repairEvidence");
    expect(JSON.stringify(JSON.parse(result).scriptDraft).length).toBeLessThan(1_500);
    expect(getSeriesCharacters).toHaveBeenCalledWith(12);
    expect(listAgnesSceneGenerations).toHaveBeenCalledWith(12, 3);
    expect(getEpisodeScriptDraft).toHaveBeenCalledWith(7);
  });

  it.each([
    {
      label: "repairable before Agnes",
      agnesRows: [],
      expectedStatus: "repair_required",
      canReplaceScript: true,
    },
    {
      label: "blocked after an Agnes claim",
      agnesRows: [{
        status: "pending",
        attemptCount: 1,
        providerTaskId: null,
        providerReceipt: { claimToken: "durable-claim" },
        submittedAt: null,
      }],
      expectedStatus: "repair_blocked",
      canReplaceScript: false,
    },
  ])("reports a concise invalid-script verdict when $label", async ({
    agnesRows,
    expectedStatus,
    canReplaceScript,
  }) => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "audio",
        scriptJson: {
          scenes: Array.from({ length: 31 }, (_unused, index) => ({
            sceneNumber: index + 1,
            narrationText: "This narration contains far too many words for one short synchronized Agnes scene and must be divided into several clear visual beats today.",
          })),
        },
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([{ name: "Pip the Ant" }]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue(agnesRows),
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed.scriptValidation).toMatchObject({
      status: expectedStatus,
      pass: false,
      canReplaceScript,
      sceneCount: 31,
    });
    expect(parsed.resumeAction).toBe(
      expectedStatus === "repair_blocked" ? "stop" : "repair_script",
    );
    expect(parsed.scriptValidation.issueCount).toBeGreaterThan(12);
    expect(parsed.scriptValidation.issues).toHaveLength(12);
    expect(parsed.scriptValidation.omittedIssueCount).toBe(
      parsed.scriptValidation.issueCount - 12,
    );
  });

  it.each([
    ["assembly", "/tmp/episode.mp4", "youtube_upload"],
    ["assembly", null, "agnes"],
    ["audio", null, "agnes"],
    ["pending", null, "script_and_audio"],
  ])("returns resumeAction=%s/%s as %s", async (status, outputPath, expectedAction) => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status,
        scriptJson: buildProductionScript(),
        outputPath,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([
        { name: "Pip the Ant", description: "A patient red ant." },
      ]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([]),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 320 }),
      assertEpisodeReadyForDone: outputPath
        ? vi.fn().mockResolvedValue({ outputPath, durationSeconds: 325 })
        : vi.fn().mockRejectedValue(new Error("final Agnes video is not completed")),
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed.resumeAction).toBe(expectedAction);
  });

  it("routes a brand-new episode with no script or draft to first-time authoring", async () => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "pending",
        scriptJson: null,
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([
        { name: "Pip the Ant", description: "A patient red ant." },
      ]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([]),
      getEpisodeScriptDraft: vi.fn().mockResolvedValue(null),
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed.resumeAction).toBe("script_and_audio");
    expect(parsed.scriptValidation).toEqual({
      status: "not_started",
      pass: false,
      sceneCount: 0,
      nextAction:
        "Plan the complete episode, then call write_episode_script_chunk with operation=start and scenes 1-8 as real arrays/objects, never an encoded scriptJson string.",
    });
    expect(parsed.episode).not.toHaveProperty("scriptJson");
  });

  it("resumes a durable bounded script prefix at its exact next scene range", async () => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "pending",
        scriptJson: null,
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const acceptedPrefix = buildProductionScript().scenes.slice(0, 8);
    const getEpisodeScriptDraft = vi.fn().mockResolvedValue({
      episodeId: 7,
      revision: 2,
      contentDigest: "c".repeat(64),
      scriptJson: {
        title: availability.episode.title,
        premise: availability.episode.premise,
        scenes: acceptedPrefix,
        authoring: {
          protocol: "chunked_episode_script_v1",
          targetSceneCount: 40,
          plan: {
            storyArc: "The friends notice the wind, investigate it, protect the picnic, and celebrate together.",
            educationalIdea: "Heavy objects can hold light objects safely in place.",
            endingInsight: "Calm teamwork can turn a windy problem into a happy discovery.",
            beats: [
              {
                startScene: 1,
                endScene: 14,
                storyBeat: "The friends discover the windy picnic problem and observe what keeps blowing away.",
                setting: "The sunny clubhouse meadow and picnic blanket.",
                continuityOutcome: "They agree to test safe ways to hold the red blanket in place.",
              },
              {
                startScene: 15,
                endScene: 28,
                storyBeat: "They compare light and heavy objects and secure each corner together.",
                setting: "The same sunny clubhouse meadow.",
                continuityOutcome: "Four smooth gray stones now hold all four blanket corners.",
              },
              {
                startScene: 29,
                endScene: 40,
                storyBeat: "They confirm their solution and share the rescued picnic.",
                setting: "The same sunny clubhouse meadow beside the secured blanket.",
                continuityOutcome: "The secured blanket stays flat for the closing celebration.",
              },
            ],
            supportingEntityBible: [],
            continuityBible: [
              "Picnic setup: one red-and-white blanket spread beside four smooth gray stones.",
            ],
          },
        },
      },
      validation: {
        pass: true,
        sceneCount: 8,
        totalSpokenWords: 152,
        issueCount: 0,
        issues: [],
        omittedIssueCount: 0,
      },
      createdAt: "2026-09-04T01:00:00.000Z",
      updatedAt: "2026-09-04T02:00:00.000Z",
    });
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([
        { name: "Pip the Ant", description: "A patient red ant." },
      ]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([]),
      getEpisodeScriptDraft,
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed.resumeAction).toBe("script_authoring");
    expect(parsed.scriptValidation).toMatchObject({
      status: "authoring_in_progress",
      sceneCount: 8,
      targetSceneCount: 40,
    });
    expect(parsed.scriptValidation.nextAction).toContain("scenes 9-16");
    expect(parsed.scriptValidation.nextAction).toContain("Do not call refinement yet");
    expect(parsed.scriptDraft).toMatchObject({
      revision: 2,
      validation: {
        requiredAction: "continue_authoring",
      },
      authoringProgress: {
        status: "in_progress",
        targetSceneCount: 40,
        completedSceneCount: 8,
        nextSceneNumber: 9,
        nextSceneEnd: 16,
      },
    });
    expect(parsed.scriptDraft.authoringProgress.previousScenes).toEqual(
      acceptedPrefix.slice(-2),
    );
    expect(parsed.scriptDraft).not.toHaveProperty("scriptJson");
  });

  it("routes a validated completed output to YouTube even when the coarse stage is still audio", async () => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "audio",
        scriptJson: buildProductionScript(),
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const assertEpisodeReadyForDone = vi.fn().mockResolvedValue({
      outputPath: "/tmp/already-assembled.mp4",
      durationSeconds: 318.4,
    });
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([
        { name: "Pip the Ant", description: "A patient red ant." },
      ]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([]),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 310 }),
      listEpisodeVideoOutputs: vi.fn().mockResolvedValue([{
        variant: "agnes_text",
        status: "completed",
        outputPath: "/tmp/already-assembled.mp4",
      }]),
      assertEpisodeReadyForDone,
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed.resumeAction).toBe("youtube_upload");
    expect(parsed.assemblyValidation).toEqual({ status: "ready" });
    expect(assertEpisodeReadyForDone).toHaveBeenCalledWith(7);
  });

  it("keeps accepted Agnes media authoritative over a stray private draft", async () => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "audio",
        scriptJson: buildProductionScript(),
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([
        { name: "Pip the Ant", description: "A patient red ant." },
      ]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([{
        status: "queued",
        attemptCount: 1,
        providerTaskId: "task-1",
        providerReceipt: { video_id: "task-1" },
        submittedAt: "2026-09-04T01:00:00.000Z",
      }]),
      getEpisodeScriptDraft: vi.fn().mockResolvedValue({
        episodeId: 7,
        revision: 4,
        contentDigest: "b".repeat(64),
        validation: null,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
      }),
      assertEpisodeAudioReady: vi.fn().mockResolvedValue({ totalDurationSeconds: 320 }),
      assertEpisodeKeyArtAudioReady: vi.fn().mockResolvedValue(undefined),
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed.resumeAction).toBe("agnes");
    expect(parsed.scriptValidation.agnesSubmissionStarted).toBe(true);
  });

  it("resumes Agnes from durable claims even when the coarse episode status is stale", async () => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "failed",
        scriptJson: buildProductionScript(),
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const assertEpisodeAudioReady = vi.fn().mockResolvedValue({ totalDurationSeconds: 320 });
    const assertEpisodeKeyArtAudioReady = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([
        { name: "Pip the Ant", description: "A patient red ant." },
      ]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue([{
        status: "queued",
        attemptCount: 1,
        providerTaskId: "task-1",
        providerReceipt: { video_id: "task-1" },
        submittedAt: "2026-09-04T01:00:00.000Z",
      }]),
      getEpisodeScriptDraft: vi.fn().mockResolvedValue(null),
      assertEpisodeAudioReady,
      assertEpisodeKeyArtAudioReady,
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed.resumeAction).toBe("agnes");
    expect(assertEpisodeAudioReady).toHaveBeenCalledWith(7);
    expect(assertEpisodeKeyArtAudioReady).toHaveBeenCalledWith(12, 3);
  });

  it.each([
    { started: false, expectedAction: "audio_repair", expectedStatus: "repair_required" },
    { started: true, expectedAction: "stop", expectedStatus: "repair_blocked" },
  ])("routes recoverable audio drift with started=$started to $expectedAction", async ({
    started,
    expectedAction,
    expectedStatus,
  }) => {
    const availability = {
      kind: "ready",
      episode: {
        id: 7,
        seriesId: 12,
        episodeNumber: 3,
        title: "The Windy Picnic",
        premise: "Pip and friends save a picnic from the wind.",
        status: "audio",
        scriptJson: buildProductionScript(),
        outputPath: null,
        youtubeVideoId: null,
        youtubeUrl: null,
        uploadedAt: null,
        completedAt: null,
        completionLocalDate: null,
      },
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
    };
    const agnesRows = started
      ? [{
          status: "queued",
          attemptCount: 1,
          providerTaskId: "task-1",
          providerReceipt: { video_id: "task-1" },
          submittedAt: "2026-09-04T01:00:00.000Z",
        }]
      : [];
    const tools = buildSeriesStateTools({
      getNextEpisodeAvailability: vi.fn().mockResolvedValue(availability),
      getSeriesCharacters: vi.fn().mockResolvedValue([
        { name: "Pip the Ant", description: "A patient red ant." },
      ]),
      listAgnesSceneGenerations: vi.fn().mockResolvedValue(agnesRows),
      assertEpisodeAudioReady: vi.fn().mockRejectedValue(
        new EpisodeAudioReadinessError({
          reason: "artifact_missing_or_stale",
          sceneNumber: 8,
          message: "Scene 8 narration audio is missing.",
        }),
      ),
    } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const parsed = JSON.parse(await (tool as any).call({ seriesId: 12 }));

    expect(parsed).toMatchObject({
      resumeAction: expectedAction,
      audioValidation: {
        status: expectedStatus,
        reason: "artifact_missing_or_stale",
        sceneNumber: 8,
      },
    });
  });

  it("preserves the exact one-episode-per-day terminal response", async () => {
    const availability = {
      kind: "daily_limit",
      episode: null,
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
      completedEpisodeNumber: 2,
      completedAt: "2026-09-04 12:30:00",
      message: "Only 1 episode per day can be generated.",
    };
    const getNextEpisodeAvailability = vi.fn().mockResolvedValue(availability);
    const tools = buildSeriesStateTools({ getNextEpisodeAvailability } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const result = await (tool as any).call({ seriesId: 12 });

    expect(JSON.parse(result)).toEqual(availability);
    expect(JSON.parse(result).message).toBe("Only 1 episode per day can be generated.");
  });

  it.each([
    {
      kind: "no_episodes",
      message: "The series has no episode manifest yet.",
    },
    {
      kind: "series_complete",
      message: "Every episode in the series is complete.",
    },
    {
      kind: "series_missing",
      message: "Series 12 was not found.",
    },
  ])("preserves the $kind terminal result from get_next_episode", async ({ kind, message }) => {
    const availability = {
      kind,
      episode: null,
      timeZone: "Asia/Kolkata",
      localDate: "2026-09-04",
      message,
    };
    const getNextEpisodeAvailability = vi.fn().mockResolvedValue(availability);
    const tools = buildSeriesStateTools({ getNextEpisodeAvailability } as any);
    const tool = tools.find((entry) => entry.name === "get_next_episode");

    const result = await (tool as any).call({ seriesId: 12 });

    expect(JSON.parse(result)).toEqual(availability);
  });

  it("persists only lightweight resumable episode stages", async () => {
    const updateEpisodeStatus = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({ updateEpisodeStatus } as any);
    const tool = tools.find((entry) => entry.name === "update_episode_status");

    const result = await (tool as any).call({
      episodeId: 7,
      status: "assembly",
      outputPath: "/tmp/final.mp4",
    });

    expect(updateEpisodeStatus).toHaveBeenCalledWith(7, "assembly", {
      outputPath: "/tmp/final.mp4",
    });
    expect(JSON.parse(result)).toEqual({ status: "ok" });
  });

  it("does not advertise script content or the script stage on update_episode_status", () => {
    const tools = buildSeriesStateTools({} as any);
    const tool = tools.find((entry) => entry.name === "update_episode_status");
    expect(tool).toBeDefined();

    const openAiSchema = JSON.stringify(convertToOpenAITool(tool as any));
    expect(openAiSchema).not.toContain("scriptJson");
    expect(openAiSchema).not.toContain('"script"');
  });

  it("returns a bounded receipt instead of echoing a rejected large script", async () => {
    const updateEpisodeStatus = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({ updateEpisodeStatus } as any);
    const tool = tools.find((entry) => entry.name === "update_episode_status");
    const marker = "PRIVATE_FULL_SCRIPT_MARKER";

    const result = await (tool as any).call({
      episodeId: 10,
      status: "script",
      scriptJson: `${marker}${"x".repeat(100_000)}`,
    });
    const parsed = JSON.parse(result);

    expect(parsed).toMatchObject({
      status: "invalid_input",
      updated: false,
      episodeId: 10,
      retryThisInvocation: false,
    });
    expect(result.length).toBeLessThan(1_024);
    expect(result).not.toContain(marker);
    expect(updateEpisodeStatus).not.toHaveBeenCalled();
  });

  it("rejects extra script content even when the requested stage is valid", async () => {
    const updateEpisodeStatus = vi.fn().mockResolvedValue(undefined);
    const tools = buildSeriesStateTools({ updateEpisodeStatus } as any);
    const tool = tools.find((entry) => entry.name === "update_episode_status");

    const result = await (tool as any).call({
      episodeId: 11,
      status: "audio",
      scriptJson: buildProductionScript(),
    });
    const parsed = JSON.parse(result);

    expect(parsed).toMatchObject({
      status: "invalid_input",
      updated: false,
      episodeId: 11,
      retryThisInvocation: false,
    });
    expect(updateEpisodeStatus).not.toHaveBeenCalled();
  });

  it("still propagates unrelated persistence failures", async () => {
    const updateEpisodeStatus = vi.fn().mockRejectedValue(new Error("database unavailable"));
    const tools = buildSeriesStateTools({ updateEpisodeStatus } as any);
    const tool = tools.find((entry) => entry.name === "update_episode_status");

    await expect((tool as any).call({
      episodeId: 12,
      status: "audio",
    })).rejects.toThrow("database unavailable");
  });
});
