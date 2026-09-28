import "dotenv/config";
import { existsSync, statSync, createReadStream, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { CONFIG } from "../src/config.js";
import { SeriesState } from "../src/state/seriesState.js";
import { chatText } from "../src/providers/aiClient.js";
import { sanitizeAndLimitTags, sanitizeDescriptionHashtags } from "../src/tools/youtubeUploadTool.js";

function getLocalDate(date: Date, timeZone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return formatter.format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

interface UploadCandidate {
  id: number;
  seriesId: number;
  episodeNumber: number;
  title: string;
  premise: string;
  status: string;
  outputPath: string;
  scriptJson?: string | null;
}

/**
 * Builds the SEO metadata prompt for generating YouTube metadata when not cached.
 */
function buildMetadataPrompt(seriesName: string, episodeTitle: string, premise: string, scriptText: string): string {
  return [
    "You are a YouTube SEO and metadata expert specializing in kids educational content.",
    "Generate engaging, SEO-optimized metadata for a children's story video (age 4-8).",
    `Series: ${seriesName}`,
    `Episode Title: ${episodeTitle}`,
    `Premise: ${premise}`,
    `Story excerpt: ${scriptText.slice(0, 1200)}`,
    "\nReply ONLY with valid JSON in this exact format:",
    "{",
    '  "title": "catchy title under 60 chars including series and episode number",',
    '  "description": "2-3 sentences hook, brief summary, characters, lesson, 2-3 hashtags (#KidsStories #MoralStories)",',
    '  "tags": ["kids stories", "educational", "4 to 6 specific tags total"],',
    '  "keywords": ["educational stories for kids", "preschool adventure"]',
    "}",
  ].join("\n");
}

export async function uploadNextAvailableEpisode(options: {
  targetSeriesId?: number;
  forceUpload?: boolean;
} = {}): Promise<{
  uploaded: boolean;
  seriesId?: number;
  episodeNumber?: number;
  videoId?: string;
  videoUrl?: string;
  reason?: string;
}> {
  console.log("=================================================");
  console.log(">>> STANDALONE YOUTUBE UPLOADER (1/DAY GATE) <<<");
  console.log("=================================================");

  // 1. Verify YouTube API Credentials
  if (!CONFIG.youtubeClientId || !CONFIG.youtubeClientSecret || !CONFIG.youtubeRefreshToken) {
    const msg = "YouTube API credentials not configured. Please set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_REFRESH_TOKEN.";
    console.error(`[YouTube Uploader] Error: ${msg}`);
    return { uploaded: false, reason: msg };
  }

  const seriesState = new SeriesState();
  await seriesState.initialize();

  const now = new Date();
  const timeZone = CONFIG.episodeDailyTimezone || "Asia/Kolkata";
  const today = getLocalDate(now, timeZone);
  console.log(`[YouTube Uploader] Calendar Date: ${today} (${timeZone})`);

  // 2. Check 1 video per day quota
  if (!options.forceUpload) {
    const recentUploads = await (seriesState as any).client.execute({
      sql: `SELECT series_id, episode_number, uploaded_at, youtube_video_id
            FROM episodes
            WHERE uploaded_at IS NOT NULL AND trim(uploaded_at) <> ''
              AND youtube_video_id IS NOT NULL AND trim(youtube_video_id) <> ''
            ORDER BY julianday(uploaded_at) DESC`,
      args: [],
    });

    for (const row of recentUploads.rows) {
      const uploadedAt = String(row.uploaded_at);
      const uploadDate = getLocalDate(new Date(uploadedAt), timeZone);
      if (uploadDate === today) {
        const reason = `Daily upload limit reached (1 video per day). Series ${row.series_id} Episode ${row.episode_number} was already uploaded today (${uploadedAt}).`;
        console.log(`[YouTube Uploader] ⚠️ ${reason}`);
        return { uploaded: false, reason };
      }
    }
  }

  // 3. Find candidates on disk that need upload
  const seriesFilter = options.targetSeriesId ? "AND series_id = ?" : "";
  const queryArgs = options.targetSeriesId ? [options.targetSeriesId] : [];

  const candidatesResult = await (seriesState as any).client.execute({
    sql: `SELECT id, series_id, episode_number, title, premise, status, output_path, script_json
          FROM episodes
          WHERE output_path IS NOT NULL AND trim(output_path) <> ''
            AND (uploaded_at IS NULL OR trim(uploaded_at) = '')
            AND (youtube_video_id IS NULL OR trim(youtube_video_id) = '')
            ${seriesFilter}
          ORDER BY series_id ASC, episode_number ASC`,
    args: queryArgs,
  });

  const candidates: UploadCandidate[] = [];
  for (const row of candidatesResult.rows) {
    const rawPath = String(row.output_path || "").trim();
    if (!rawPath) continue;
    const resolvedPath = path.resolve(rawPath);
    if (existsSync(resolvedPath)) {
      candidates.push({
        id: Number(row.id),
        seriesId: Number(row.series_id),
        episodeNumber: Number(row.episode_number),
        title: String(row.title || `Episode ${row.episode_number}`),
        premise: String(row.premise || ""),
        status: String(row.status || ""),
        outputPath: resolvedPath,
        scriptJson: row.script_json ? String(row.script_json) : null,
      });
    } else {
      console.warn(`[YouTube Uploader] Skipping Series ${row.series_id} Episode ${row.episode_number}: output file ${resolvedPath} not found on disk.`);
    }
  }

  if (candidates.length === 0) {
    const reason = "No available on-disk episode videos pending upload.";
    console.log(`[YouTube Uploader] ${reason}`);
    return { uploaded: false, reason };
  }

  // 4. Select exactly one episode to upload
  const candidate = candidates[0]!;
  console.log(`\n[YouTube Uploader] Selected for upload: Series ${candidate.seriesId}, Episode ${candidate.episodeNumber} ("${candidate.title}")`);
  console.log(`[YouTube Uploader] Video File: ${candidate.outputPath}`);

  const seriesInfo = await seriesState.getSeriesInfo(candidate.seriesId);
  const seriesName = seriesInfo?.conceptName || `Series ${candidate.seriesId}`;

  // 5. Generate or load metadata
  const metadataDir = path.join(
    CONFIG.outputDir,
    `series_${candidate.seriesId}`,
    `episode_${candidate.episodeNumber}`,
    "metadata",
  );
  const metadataPath = path.join(metadataDir, "youtube_metadata.json");

  let metadata: { title: string; description: string; tags: string[] } | null = null;
  if (existsSync(metadataPath)) {
    try {
      const raw = JSON.parse(readFileSync(metadataPath, "utf8"));
      metadata = {
        title: raw.title || `${seriesName} - Episode ${candidate.episodeNumber}: ${candidate.title}`,
        description: raw.description || candidate.premise || "",
        tags: Array.isArray(raw.tags) ? raw.tags : ["kids stories", "educational"],
      };
      console.log(`[YouTube Uploader] ✓ Loaded existing metadata from ${metadataPath}`);
    } catch {
      // Re-generate if unreadable
    }
  }

  if (!metadata) {
    console.log("[YouTube Uploader] Generating SEO metadata via LLM...");
    let scriptText = candidate.premise;
    if (candidate.scriptJson) {
      try {
        const parsed = JSON.parse(candidate.scriptJson);
        const scenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
        scriptText = scenes.map((s: any) => s.narrationText || s.action || "").join(" ");
      } catch { }
    }

    try {
      const llmResponse = await chatText({
        systemPrompt: "You are a professional kids YouTube SEO assistant. Return only valid JSON.",
        userText: buildMetadataPrompt(seriesName, candidate.title, candidate.premise, scriptText),
      });
      const cleaned = llmResponse.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const parsed = JSON.parse(cleaned);
      metadata = {
        title: parsed.title || `${seriesName} - Episode ${candidate.episodeNumber}: ${candidate.title}`,
        description: parsed.description || candidate.premise || "",
        tags: Array.isArray(parsed.tags) ? parsed.tags : ["kids stories", "educational"],
      };
      mkdirSync(metadataDir, { recursive: true });
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, generatedAt: new Date().toISOString() }, null, 2));
      console.log(`[YouTube Uploader] ✓ Generated and saved metadata to ${metadataPath}`);
    } catch (err) {
      console.warn("[YouTube Uploader] LLM metadata generation failed; using fallback title and description.");
      metadata = {
        title: `${seriesName} - Episode ${candidate.episodeNumber}: ${candidate.title}`.slice(0, 100),
        description: `${candidate.title}\n\n${candidate.premise}\n\n#KidsStories #BedtimeStories #Educational`,
        tags: ["kids stories", "educational", "bedtime stories", seriesName.toLowerCase()],
      };
    }
  }

  // 6. Sanitize fields according to YouTube constraints
  const cleanTitle = (metadata.title || candidate.title).replace(/[<>]/g, "").trim().slice(0, 100);
  const cleanDescription = sanitizeDescriptionHashtags(
    (metadata.description || "").replace(/[<>]/g, "").trim().slice(0, 5000),
    3,
  );
  const combinedTags = sanitizeAndLimitTags(
    [...metadata.tags, "kids stories", "educational", seriesName.toLowerCase()],
    400,
    6,
  );

  // 7. Check for Thumbnail Image
  const potentialThumbnails = [
    path.join(CONFIG.outputDir, `series_${candidate.seriesId}`, `episode_${candidate.episodeNumber}`, "key_art", "episode_key_art.png"),
    path.join(CONFIG.outputDir, `series_${candidate.seriesId}`, `episode_${candidate.episodeNumber}`, "thumbnail.png"),
    path.join(CONFIG.outputDir, `series_${candidate.seriesId}`, `episode_${candidate.episodeNumber}`, "thumbnail.jpg"),
  ];
  const thumbnailPath = potentialThumbnails.find((p) => existsSync(p));
  if (thumbnailPath) {
    console.log(`[YouTube Uploader] Thumbnail found: ${thumbnailPath}`);
  }

  // 8. OAuth2 Client Setup
  const oauth2Client = new google.auth.OAuth2(
    CONFIG.youtubeClientId,
    CONFIG.youtubeClientSecret,
    "http://localhost",
  );
  oauth2Client.setCredentials({ refresh_token: CONFIG.youtubeRefreshToken });

  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  // 9. Upload Video as PRIVATE
  console.log(`[YouTube Uploader] Starting upload to YouTube (privacyStatus: private, categoryId: 27, selfDeclaredMadeForKids: true)...`);
  const stats = statSync(candidate.outputPath);
  console.log(`[YouTube Uploader] Upload file size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);

  const uploadResponse = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: cleanTitle,
        description: cleanDescription,
        tags: combinedTags,
        categoryId: "27", // Education
        defaultLanguage: "en",
        defaultAudioLanguage: "en",
      },
      status: {
        privacyStatus: "private", // STRICT REQUIREMENT: private visibility
        selfDeclaredMadeForKids: true,
        embeddable: true,
        publicStatsViewable: true,
      },
    },
    media: {
      body: createReadStream(candidate.outputPath),
    },
  });

  const videoId = uploadResponse.data.id;
  if (!videoId) {
    throw new Error("YouTube upload succeeded but no video ID was returned.");
  }

  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[YouTube Uploader] ✅ Upload successful! Video ID: ${videoId} | URL: ${videoUrl}`);

  // 10. Upload Thumbnail if present
  if (thumbnailPath) {
    try {
      console.log(`[YouTube Uploader] Uploading custom thumbnail...`);
      const thumbBytes = readFileSync(thumbnailPath);
      await youtube.thumbnails.set({
        videoId,
        media: {
          mimeType: thumbnailPath.endsWith(".png") ? "image/png" : "image/jpeg",
          body: thumbBytes as any,
        },
      });
      console.log(`[YouTube Uploader] ✓ Thumbnail uploaded successfully.`);
    } catch (thumbErr: any) {
      console.warn(`[YouTube Uploader] Warning: Thumbnail upload failed: ${thumbErr.message}`);
    }
  }

  // 11. Record in DB and mark completed
  console.log("[YouTube Uploader] Finalizing upload state in database...");
  await seriesState.finalizeEpisodeUpload({
    seriesId: candidate.seriesId,
    episodeNumber: candidate.episodeNumber,
    videoId,
    url: videoUrl,
  });

  console.log("=================================================");
  console.log(`>>> UPLOAD COMPLETE: Series ${candidate.seriesId} Episode ${candidate.episodeNumber} <<<`);
  console.log(`Private URL: ${videoUrl}`);
  console.log("=================================================\n");

  return {
    uploaded: true,
    seriesId: candidate.seriesId,
    episodeNumber: candidate.episodeNumber,
    videoId,
    videoUrl,
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("uploadEpisodesToYoutube.ts")) {
  uploadNextAvailableEpisode()
    .then((result) => {
      if (!result.uploaded) {
        console.log(`[Result]: ${result.reason}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Fatal Error]:", err);
      process.exit(1);
    });
}
