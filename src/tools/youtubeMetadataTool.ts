import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "../config.js";
import { SeriesState } from "../state/seriesState.js";
import { chatText } from "../providers/aiClient.js";

/**
 * Generates YouTube metadata (title, description, tags, keywords) for publishing
 * episodes and series playlists. Analyzes episode content (script, characters, themes)
 * to create SEO-optimized, engaging metadata suitable for kids content.
 */

interface EpisodeMetadata {
  title: string;
  description: string;
  tags: string[];
  keywords: string[];
}

interface SeriesMetadata {
  playlistTitle: string;
  playlistDescription: string;
  seriesTags: string[];
  seriesKeywords: string[];
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function scriptScenes(script: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = script.scenes;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (scene): scene is Record<string, unknown> => Boolean(scene) && typeof scene === "object" && !Array.isArray(scene),
  );
}

/**
 * Builds a system prompt for generating YouTube metadata based on episode content.
 */
function buildMetadataGenerationSystemPrompt(): string {
  return (
    "You are a YouTube SEO and metadata expert specializing in kids educational content. " +
    "Your task is to generate engaging, SEO-optimized metadata for children's story videos (age 2-5). " +
    "Follow these guidelines:\n\n" +
    "TITLE:\n" +
    "- Keep it under 60 characters for optimal display\n" +
    "- Include the series name and episode number\n" +
    "- Make it catchy and descriptive\n" +
    "- Use title case\n" +
    "- Example: 'Tiny Heroes Club #3: The Missing Acorn Adventure'\n\n" +
    "DESCRIPTION:\n" +
    "- First 2-3 sentences should hook viewers (appears in search results)\n" +
    "- Include a brief episode summary (3-4 sentences)\n" +
    "- Mention key characters and the lesson learned\n" +
    "- Add a call-to-action (subscribe, like, comment)\n" +
    "- Include relevant hashtags at the end\n" +
    "- Keep it under 500 characters for optimal engagement\n\n" +
    "TAGS:\n" +
    "- Generate 10-15 relevant tags\n" +
    "- Include: series name, character names, themes, age group, content type\n" +
    "- Use both specific and broad tags\n" +
    "- Examples: 'kids stories', 'educational', 'preschool', 'teamwork', character names\n\n" +
    "KEYWORDS:\n" +
    "- Generate 5-10 keyword phrases for SEO\n" +
    "- Focus on what parents/educators would search for\n" +
    "- Examples: 'educational stories for toddlers', 'kids teamwork videos', 'preschool learning'\n\n" +
    "Reply ONLY with valid JSON in this exact format:\n" +
    "{\n" +
    '  "title": "...",\n' +
    '  "description": "...",\n' +
    '  "tags": ["tag1", "tag2", ...],\n' +
    '  "keywords": ["keyword1", "keyword2", ...]\n' +
    "}\n\n" +
    "No markdown, no code blocks, no explanation - just the raw JSON object."
  );
}

/**
 * Builds a system prompt for generating series-level YouTube metadata.
 */
function buildSeriesMetadataSystemPrompt(): string {
  return (
    "You are a YouTube SEO expert creating playlist metadata for a kids educational series. " +
    "Generate engaging, SEO-optimized playlist information.\n\n" +
    "PLAYLIST TITLE:\n" +
    "- Keep it under 60 characters\n" +
    "- Include series name and episode count\n" +
    "- Example: 'Tiny Heroes Club - Complete Series (25 Episodes)'\n\n" +
    "PLAYLIST DESCRIPTION:\n" +
    "- Describe the series concept and main characters\n" +
    "- Highlight educational value and themes\n" +
    "- Mention target age group\n" +
    "- Include call-to-action\n" +
    "- Keep under 1000 characters\n\n" +
    "TAGS & KEYWORDS:\n" +
    "- Broader than episode-level tags\n" +
    "- Focus on series themes and educational value\n\n" +
    "Reply ONLY with valid JSON:\n" +
    "{\n" +
    '  "playlistTitle": "...",\n' +
    '  "playlistDescription": "...",\n' +
    '  "seriesTags": ["tag1", "tag2", ...],\n' +
    '  "seriesKeywords": ["keyword1", "keyword2", ...]\n' +
    "}\n\n" +
    "No markdown, no code blocks - just raw JSON."
  );
}

/**
 * Tool for generating YouTube metadata for a specific episode.
 */
export function buildYoutubeEpisodeMetadataTool(seriesState: SeriesState): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "generate_youtube_episode_metadata",
    description:
      "Generates YouTube metadata (title, description, tags, keywords) for a specific episode by analyzing " +
      "its script content, characters, and themes. Creates SEO-optimized, engaging metadata suitable for " +
      "kids educational content (age 2-5). Saves metadata to a JSON file for later use with YouTube API.",
    schema: z.object({
      seriesId: z.number().describe("The series ID"),
      episodeNumber: z.number().describe("The episode number to generate metadata for"),
    }),
    func: async ({ seriesId, episodeNumber }) => {
      const seriesInfo = await seriesState.getSeriesInfo(seriesId);
      if (!seriesInfo) {
        throw new Error(`Series ${seriesId} not found`);
      }
      const seriesName = seriesInfo.conceptName;
      const seriesDescription = seriesInfo.episodeFormula;

      const episode = await seriesState.getEpisodeByNumber(seriesId, episodeNumber);
      if (!episode) {
        throw new Error(`Episode ${episodeNumber} not found for series ${seriesId}`);
      }

      const scriptJson = objectValue(episode.scriptJson);

      // Extract episode info
      const episodeTitle = typeof scriptJson.title === "string" && scriptJson.title.trim()
        ? scriptJson.title.trim()
        : episode.title || `Episode ${episodeNumber}`;
      const scenes = scriptScenes(scriptJson);
      const characterNames = new Set<string>();
      let fullNarration = "";

      scenes.forEach((scene) => {
        if (Array.isArray(scene.characterNames)) {
          scene.characterNames.forEach((name) => {
            if (typeof name === "string" && name.trim()) characterNames.add(name.trim());
          });
        }
        if (typeof scene.narrationText === "string" && scene.narrationText.trim()) {
          fullNarration += `${scene.narrationText.trim()} `;
        }
      });

      // Build context for LLM
      const userText =
        `Generate YouTube metadata for this kids educational episode:\n\n` +
        `Series: ${seriesName}\n` +
        `Series Description: ${seriesDescription}\n` +
        `Episode Number: ${episodeNumber}\n` +
        `Episode Title: ${episodeTitle}\n` +
        `Characters: ${Array.from(characterNames).join(", ")}\n` +
        `Number of Scenes: ${scenes.length}\n\n` +
        `Episode Summary (from narration):\n${fullNarration.slice(0, 1000)}\n\n` +
        `Generate engaging YouTube metadata following the guidelines. Include "kids stories" and "educational" tags.`;

      // Generate metadata using LLM
      const rawResponse = await chatText({
        systemPrompt: buildMetadataGenerationSystemPrompt(),
        userText,
      });

      // Parse JSON response
      let metadata: EpisodeMetadata;
      try {
        // Clean up response (remove markdown code blocks if present)
        const cleaned = rawResponse
          .replace(/```json\s*/g, "")
          .replace(/```\s*/g, "")
          .trim();
        metadata = JSON.parse(cleaned);
      } catch (error) {
        throw new Error(`Failed to parse metadata JSON: ${rawResponse}`);
      }

      // Ensure required tags are present
      if (!metadata.tags.includes("kids stories")) {
        metadata.tags.unshift("kids stories");
      }
      if (!metadata.tags.includes("educational")) {
        metadata.tags.splice(1, 0, "educational");
      }

      // Save metadata to file
      const metadataDir = path.join(
        CONFIG.outputDir,
        `series_${seriesId}`,
        `episode_${episodeNumber}`,
        "metadata"
      );
      await mkdir(metadataDir, { recursive: true });
      const metadataPath = path.join(metadataDir, "youtube_metadata.json");

      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            seriesId,
            episodeNumber,
            seriesName,
            episodeTitle,
            ...metadata,
            generatedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );

      return JSON.stringify({
        path: metadataPath,
        metadata,
        status: "generated",
      });
    },
  });
}

/**
 * Tool for generating YouTube metadata for the entire series (playlist level).
 */
export function buildYoutubeSeriesMetadataTool(seriesState: SeriesState): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "generate_youtube_series_metadata",
    description:
      "Generates YouTube playlist metadata (title, description, tags, keywords) for the entire series. " +
      "Analyzes series concept, all episodes, and characters to create SEO-optimized playlist information. " +
      "Saves metadata to a JSON file for later use with YouTube API when creating/updating the series playlist.",
    schema: z.object({
      seriesId: z.number().describe("The series ID to generate playlist metadata for"),
    }),
    func: async ({ seriesId }) => {
      const seriesInfo = await seriesState.getSeriesInfo(seriesId);
      if (!seriesInfo) {
        throw new Error(`Series ${seriesId} not found`);
      }
      const seriesName = seriesInfo.conceptName;
      const seriesDescription = seriesInfo.episodeFormula;
      const characters = seriesInfo.charactersJson
        .map((character) => character.name.trim())
        .filter(Boolean);
      const episodes = await seriesState.listEpisodes(seriesId);
      const episodeCount = episodes.length;
      const episodeTitles = episodes.map((episode) => {
        const scriptJson = objectValue(episode.scriptJson);
        return typeof scriptJson.title === "string" && scriptJson.title.trim()
          ? scriptJson.title.trim()
          : episode.title || `Episode ${episode.episodeNumber}`;
      });

      // Build context for LLM
      const userText =
        `Generate YouTube playlist metadata for this kids educational series:\n\n` +
        `Series Name: ${seriesName}\n` +
        `Series Description: ${seriesDescription}\n` +
        `Number of Episodes: ${episodeCount}\n` +
        `Main Characters: ${characters.length > 0 ? characters.join(", ") : "Various"}\n\n` +
        `Episode Titles:\n${episodeTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n` +
        `Generate engaging playlist metadata. Target age: 2-5 years. Include "kids stories" and "educational" tags.`;

      // Generate metadata using LLM
      const rawResponse = await chatText({
        systemPrompt: buildSeriesMetadataSystemPrompt(),
        userText,
      });

      // Parse JSON response
      let metadata: SeriesMetadata;
      try {
        const cleaned = rawResponse
          .replace(/```json\s*/g, "")
          .replace(/```\s*/g, "")
          .trim();
        metadata = JSON.parse(cleaned);
      } catch (error) {
        throw new Error(`Failed to parse series metadata JSON: ${rawResponse}`);
      }

      // Ensure required tags for children's content
      const requiredTags = ["kids stories", "educational", "Children stories", "stories for kids", "stories for children"];
      for (const tag of requiredTags) {
        if (!metadata.seriesTags.includes(tag)) {
          metadata.seriesTags.unshift(tag);
        }
      }

      // Save metadata to file
      const metadataDir = path.join(CONFIG.outputDir, `series_${seriesId}`, "metadata");
      await mkdir(metadataDir, { recursive: true });
      const metadataPath = path.join(metadataDir, "youtube_series_metadata.json");

      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            seriesId,
            seriesName,
            episodeCount,
            ...metadata,
            generatedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );

      return JSON.stringify({
        path: metadataPath,
        metadata,
        status: "generated",
      });
    },
  });
}
