import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { createReadStream, statSync } from "node:fs";
import { google, youtube_v3 } from "googleapis";
import { CONFIG } from "../config.js";
import { logStep } from "../utils/logger.js";

function parseJsonArrayInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const DEFAULT_TAGS = ["Children stories", "stories for kids", "stories for children", "educational"];

export interface YoutubeUploadReceipt {
  seriesId: number;
  episodeNumber: number;
  videoPath: string;
  videoId: string;
  url: string;
  privacyStatus: "public" | "unlisted" | "private";
}

export interface YoutubeUploadToolOptions {
  /** Return an existing durable receipt so reruns never upload a second copy. */
  getExistingUpload?: (input: {
    seriesId: number;
    episodeNumber: number;
  }) => Promise<{ videoId: string; url: string } | null>;
  /** Fail-closed validation performed before the irreversible YouTube request. */
  beforeUpload?: (input: {
    seriesId: number;
    episodeNumber: number;
    videoPath: string;
  }) => Promise<void>;
  /**
   * Optional durable finalization hook. It runs only after YouTube has returned
   * a video id, allowing the caller to mark the episode done and clean its
   * transient database rows without coupling this provider tool to SeriesState.
   */
  onUploaded?: (receipt: YoutubeUploadReceipt) => Promise<void>;
}

/**
 * Deep-agent tool: uploads the final episode video to YouTube with metadata.
 * Uses OAuth2 authentication with refresh token for unattended uploads.
 * Returns the video ID and public URL.
 */
export function buildYoutubeUploadTool(options: YoutubeUploadToolOptions = {}): DynamicStructuredTool {
  const requiresEpisodeIdentity = Boolean(
    options.getExistingUpload || options.beforeUpload || options.onUploaded,
  );
  const seriesIdSchema = z.number().int().positive().describe(
    requiresEpisodeIdentity
      ? "Required canonical series id returned by get_next_episode."
      : "Optional series id for standalone uploads.",
  );
  const episodeNumberSchema = z.number().int().positive().describe(
    requiresEpisodeIdentity
      ? "Required canonical episode number returned by get_next_episode."
      : "Optional episode number for standalone uploads.",
  );

  return new DynamicStructuredTool({
    name: "upload_to_youtube",
    description:
      "Uploads the final episode video to YouTube with title, description, tags, and thumbnail. " +
      (requiresEpisodeIdentity
        ? "This state-integrated production tool requires seriesId and episodeNumber from get_next_episode on every call. "
        : "Episode identity is optional only for standalone uploads without state integration. ") +
      "Requires YouTube API credentials configured in environment. Returns the video ID and public URL.",
    schema: z.object({
      videoPath: z.string().describe("Absolute path to the video file to upload."),
      seriesId: requiresEpisodeIdentity ? seriesIdSchema : seriesIdSchema.optional(),
      episodeNumber: requiresEpisodeIdentity
        ? episodeNumberSchema
        : episodeNumberSchema.optional(),
      title: z.string().describe("Video title (max 100 characters)."),
      description: z.string().describe("Video description with episode summary and credits."),
      tags: z
        .preprocess(parseJsonArrayInput, z.array(z.string()))
        .optional()
        .describe("Optional custom tags (in addition to default children's content tags). Can be JSON string or array."),
      thumbnailPath: z.string().nullable().optional().describe(
        "Optional custom thumbnail image (JPG/PNG, <2MB). If omitted, YouTube selects a frame automatically."
      ),
      privacyStatus: z.enum(["public", "unlisted", "private"]).default("public").describe("Video privacy status (default: public)."),
    }),
    func: async ({
      videoPath,
      seriesId,
      episodeNumber,
      title,
      description,
      tags,
      thumbnailPath,
      privacyStatus,
    }) => {
      if (requiresEpisodeIdentity && (!seriesId || !episodeNumber)) {
        throw new Error(
          "seriesId and episodeNumber are required when YouTube upload state integration is enabled."
        );
      }

      if (options.getExistingUpload) {
        const existing = await options.getExistingUpload({
          seriesId: seriesId!,
          episodeNumber: episodeNumber!,
        });
        if (existing) {
          return JSON.stringify({
            status: "already_uploaded",
            videoId: existing.videoId,
            url: existing.url,
            reused: true,
          });
        }
      }

      logStep(`Preparing YouTube upload: ${title}`);

      // Key art is video-only, so YouTube selects a frame automatically unless
      // the caller explicitly supplies a separate custom thumbnail image.
      const finalThumbnailPath = thumbnailPath || undefined;

      // Combine episode-specific tags with common default tags
      const customTags = tags || [];
      const combinedTags = Array.from(new Set([...customTags, ...DEFAULT_TAGS]));

      // Validate video file exists
      try {
        const stats = statSync(videoPath);
        if (!stats.isFile()) {
          throw new Error(`Video path is not a file: ${videoPath}`);
        }
        logStep(`Video file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      } catch (error) {
        throw new Error(`Video file not found or inaccessible: ${videoPath}`);
      }

      if (options.beforeUpload) {
        await options.beforeUpload({
          seriesId: seriesId!,
          episodeNumber: episodeNumber!,
          videoPath,
        });
      }

      // Initialize OAuth2 client with credentials from config
      if (!CONFIG.youtubeClientId || !CONFIG.youtubeClientSecret || !CONFIG.youtubeRefreshToken) {
        throw new Error(
          "YouTube API credentials not configured. Set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, " +
          "and YOUTUBE_REFRESH_TOKEN in your .env file."
        );
      }

      const oauth2Client = new google.auth.OAuth2(
        CONFIG.youtubeClientId,
        CONFIG.youtubeClientSecret,
        "http://localhost" // Redirect URI (not used for refresh token flow)
      );

      oauth2Client.setCredentials({
        refresh_token: CONFIG.youtubeRefreshToken,
      });

      const youtube = google.youtube({
        version: "v3",
        auth: oauth2Client,
      });

      // Prepare video metadata
      const videoMetadata: youtube_v3.Schema$Video = {
        snippet: {
          title: title.slice(0, 100), // YouTube max title length
          description: description,
          tags: combinedTags,
          categoryId: "22", // People & Blogs (use "24" for Entertainment)
          defaultLanguage: "en",
          defaultAudioLanguage: "en",
        },
        status: {
          privacyStatus: privacyStatus,
          selfDeclaredMadeForKids: true, // COPPA compliance for children's content
          embeddable: true,
          publicStatsViewable: true,
        },
      };

      try {
        // Upload video
        logStep("Starting video upload to YouTube...");
        const uploadResponse = await youtube.videos.insert({
          part: ["snippet", "status"],
          requestBody: videoMetadata,
          media: {
            body: createReadStream(videoPath),
          },
        });

        const videoId = uploadResponse.data.id;
        if (!videoId) {
          throw new Error("YouTube upload succeeded but no video ID was returned");
        }

        logStep(`Video uploaded successfully. Video ID: ${videoId}`);
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

        // Upload only an explicitly supplied thumbnail. Otherwise YouTube uses
        // its own automatically selected video frame.
        if (finalThumbnailPath) {
          try {
            logStep(`Uploading thumbnail: ${finalThumbnailPath}`);
            const thumbnailBuffer = await readFile(finalThumbnailPath);
            await youtube.thumbnails.set({
              videoId: videoId,
              media: {
                mimeType: finalThumbnailPath.endsWith(".png") ? "image/png" : "image/jpeg",
                body: thumbnailBuffer as any,
              },
            });
            logStep("Thumbnail uploaded successfully");
          } catch (thumbnailError) {
            const message = thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError);
            logStep(`Warning: Thumbnail upload failed: ${message}`);
          }
        }

        logStep(`✅ YouTube upload complete: ${videoUrl}`);

        if (options.onUploaded) {
          try {
            await options.onUploaded({
              seriesId: seriesId!,
              episodeNumber: episodeNumber!,
              videoPath,
              videoId,
              url: videoUrl,
              privacyStatus,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // The remote upload is irreversible. Report its receipt plainly so
            // the caller does not retry the upload and create a duplicate.
            return JSON.stringify({
              status: "uploaded_finalization_failed",
              videoId,
              url: videoUrl,
              privacyStatus,
              finalizationError: message,
              retryUpload: false,
            });
          }
        }

        return JSON.stringify({
          status: "uploaded",
          videoId,
          url: videoUrl,
          privacyStatus,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`YouTube upload failed: ${message}`);
      }
    },
  });
}
