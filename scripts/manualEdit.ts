import "dotenv/config";
import dns from "node:dns";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { CONFIG } from "../src/config.js";
import {
  assertLegacyImageFlowOptIn,
  LEGACY_IMAGE_FLOW_OPT_IN_FLAG,
} from "./legacyImageFlowGuard.js";

// Ensure IPv4 resolution is prioritized to prevent Node.js IPv6 connect timeouts on Windows
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Ignore if not supported in environment
}

// ============================================================================
// 🛠️ PLACEHOLDERS: Change these values for manual scene image editing
// ============================================================================
export const MANUAL_EDIT_CONFIG = {
  seriesId: 22,
  episodeNumber: 1,
  sceneNumber: 26,

  // Edit instruction prompt describing the targeted fix:
  // editPrompt:
  //   "Edit this children's storybook illustration to remove the extra hands of monkey character. " +
  //   "There should be ONLY two hands of the monkey (Mia the Monkey (with yellow backpack)) in the scene. " +
  //   "Preserve the exact storybook illustration style,  forest background, lighting, and colors. " +
  //   "Do not introduce any duplicate animals, clones, extra characters, or text.",
  editPrompt:
    "Edit this children's storybook illustration and Remove the duplicate girl inside the glowing portal. The portal should show the garden scenery behind it. Keep the girl on the left, the boy in the orange hoodie, the girl in the yellow shirt with backpack, and the dinosaur exactly as they are. " +
    "Preserve the exact storybook illustration style,  background, and colors. " +
    "Do not introduce any duplicate animals, clones, extra characters, or text.",
};

/**
 * Resolves the canonical scene image path and corrected output path based on series, episode, and scene numbers.
 */
function resolvePaths(seriesId: number, episodeNumber: number, sceneNumber: number) {
  const sceneStr = String(sceneNumber).padStart(3, "0");
  const sceneDir = path.resolve(`output/series_${seriesId}/episode_${episodeNumber}/scenes`);
  const inputPath = path.join(sceneDir, `scene_${sceneStr}.png`);
  const outputPath = path.join(sceneDir, `scene_${sceneStr}_corrected.png`);
  return { inputPath, outputPath };
}

/**
 * Extracts image buffer from various OpenAI / Gemini / AnyAPI / OpenRouter REST response shapes.
 */
async function extractImageBuffer(responseData: unknown, responseText: string, authHeader?: string): Promise<Buffer> {
  const data = responseData as any;

  // 1. OpenAI Chat Completions multimodal images array: choices[0].message.images
  const chatImages = data?.choices?.[0]?.message?.images;
  if (Array.isArray(chatImages) && chatImages.length > 0) {
    const url = chatImages[0]?.image_url?.url || chatImages[0]?.url || chatImages[0];
    if (typeof url === "string") {
      if (url.startsWith("data:image/")) {
        const cleanB64 = url.replace(/^data:image\/\w+;base64,/, "");
        return Buffer.from(cleanB64, "base64");
      }
      if (url.startsWith("http")) {
        const headers: Record<string, string> = {};
        if (authHeader) headers["Authorization"] = authHeader;
        const imgRes = await fetch(url, { headers });
        if (!imgRes.ok) throw new Error(`Failed to download image from URL: ${imgRes.status} ${imgRes.statusText}`);
        return Buffer.from(await imgRes.arrayBuffer());
      }
    }
  }

  // 2. OpenAI Image API format: { data: [{ b64_json: "..." }] } or { data: [{ url: "..." }] }
  if (Array.isArray(data?.data) && data.data.length > 0) {
    const first = data.data[0];
    if (first.b64_json) {
      return Buffer.from(first.b64_json, "base64");
    }
    if (typeof first === "string" && first.startsWith("http")) {
      console.log(`Fetching generated image from URL: ${first}`);
      const headers: Record<string, string> = {};
      if (authHeader) headers["Authorization"] = authHeader;
      const imgRes = await fetch(first, { headers });
      if (!imgRes.ok) throw new Error(`Failed to download image from URL: ${imgRes.status} ${imgRes.statusText}`);
      return Buffer.from(await imgRes.arrayBuffer());
    }
    if (first.url) {
      console.log(`Fetching generated image from URL: ${first.url}`);
      const headers: Record<string, string> = {};
      if (authHeader) headers["Authorization"] = authHeader;
      const imgRes = await fetch(first.url, { headers });
      if (!imgRes.ok) throw new Error(`Failed to download image from URL: ${imgRes.status} ${imgRes.statusText}`);
      return Buffer.from(await imgRes.arrayBuffer());
    }
  }

  // 3. Direct url or images array
  if (typeof data?.url === "string") {
    console.log(`Fetching generated image from URL: ${data.url}`);
    const headers: Record<string, string> = {};
    if (authHeader) headers["Authorization"] = authHeader;
    const imgRes = await fetch(data.url, { headers });
    if (!imgRes.ok) throw new Error(`Failed to download image from URL: ${imgRes.status} ${imgRes.statusText}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }

  if (Array.isArray(data?.images) && data.images.length > 0) {
    const first = data.images[0];
    if (typeof first === "string") {
      if (first.startsWith("http")) {
        const headers: Record<string, string> = {};
        if (authHeader) headers["Authorization"] = authHeader;
        const imgRes = await fetch(first, { headers });
        return Buffer.from(await imgRes.arrayBuffer());
      }
      const cleanB64 = first.replace(/^data:image\/\w+;base64,/, "");
      return Buffer.from(cleanB64, "base64");
    }
  }

  // 4. OpenAI Chat Completions text content: choices[0].message.content
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    // Check for markdown image format: ![...](data:image/png;base64,...)
    const base64Match = content.match(/!\[.*?\]\(data:image\/\w+;base64,([^)]+)\)/);
    if (base64Match && base64Match[1]) {
      return Buffer.from(base64Match[1], "base64");
    }

    // Check for direct data URI: data:image/png;base64,...
    const dataUriMatch = content.match(/data:image\/\w+;base64,([A-Za-z0-9+/=]+)/);
    if (dataUriMatch && dataUriMatch[1]) {
      return Buffer.from(dataUriMatch[1], "base64");
    }

    // Check for markdown URL: ![...](https://...)
    const urlMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
    if (urlMatch && urlMatch[1]) {
      console.log(`Fetching image from markdown URL: ${urlMatch[1]}`);
      const headers: Record<string, string> = {};
      if (authHeader) headers["Authorization"] = authHeader;
      const imgRes = await fetch(urlMatch[1], { headers });
      if (!imgRes.ok) throw new Error(`Failed to download image from URL: ${imgRes.status} ${imgRes.statusText}`);
      return Buffer.from(await imgRes.arrayBuffer());
    }

    // Check for raw URL
    const rawUrlMatch = content.trim().match(/^https?:\/\/\S+$/);
    if (rawUrlMatch) {
      console.log(`Fetching image from direct URL: ${content.trim()}`);
      const headers: Record<string, string> = {};
      if (authHeader) headers["Authorization"] = authHeader;
      const imgRes = await fetch(content.trim(), { headers });
      if (!imgRes.ok) throw new Error(`Failed to download image from URL: ${imgRes.status} ${imgRes.statusText}`);
      return Buffer.from(await imgRes.arrayBuffer());
    }

    // If the content is raw base64
    if (content.length > 500 && /^[A-Za-z0-9+/=\s]+$/.test(content.trim())) {
      return Buffer.from(content.trim(), "base64");
    }
  }

  // 5. Direct base64 field in response
  if (data?.image && typeof data.image === "string") {
    const cleanB64 = data.image.replace(/^data:image\/\w+;base64,/, "");
    return Buffer.from(cleanB64, "base64");
  }

  throw new Error(`Could not extract image from response. Response content:\n${responseText.slice(0, 500)}`);
}

export async function runManualEdit() {
  assertLegacyImageFlowOptIn(
    "manualEdit.ts",
    "targeted editing of a legacy scene PNG via paid image providers",
  );
  const positionalArgs = process.argv
    .slice(2)
    .filter((argument) => argument !== LEGACY_IMAGE_FLOW_OPT_IN_FLAG);
  const defaultPaths = resolvePaths(
    MANUAL_EDIT_CONFIG.seriesId,
    MANUAL_EDIT_CONFIG.episodeNumber,
    MANUAL_EDIT_CONFIG.sceneNumber
  );

  const inputPath = positionalArgs[0] ? path.resolve(positionalArgs[0]) : defaultPaths.inputPath;
  const outputPath = positionalArgs[1] ? path.resolve(positionalArgs[1]) : defaultPaths.outputPath;
  const prompt = positionalArgs[2] || MANUAL_EDIT_CONFIG.editPrompt;

  console.log("==================================================");
  console.log("🎨 Manual AI Image Edit & Targeted Correction");
  console.log("==================================================");
  console.log(`Series ID:   ${MANUAL_EDIT_CONFIG.seriesId}`);
  console.log(`Episode:     ${MANUAL_EDIT_CONFIG.episodeNumber}`);
  console.log(`Scene:       ${MANUAL_EDIT_CONFIG.sceneNumber}`);
  console.log(`Input Image: ${inputPath}`);
  console.log(`Output:      ${outputPath}`);
  console.log(`Prompt:      ${prompt.slice(0, 120)}...`);
  console.log("--------------------------------------------------");

  if (!existsSync(inputPath)) {
    console.error(`❌ Error: Input image file not found at: ${inputPath}`);
    process.exit(1);
  }

  console.log("📖 Reading input image...");
  const imageBuffer = await readFile(inputPath);
  const base64Image = imageBuffer.toString("base64");
  const dataUri = `data:image/png;base64,${base64Image}`;
  console.log(`✓ Image loaded (${(imageBuffer.length / 1024).toFixed(1)} KB)`);

  const strategies: Array<{
    name: string;
    authHeader: string;
    send: () => Promise<Response>;
  }> = [];

  // Strategy 1: AnyAPI with Gemini 3.1 Flash Image
  if (CONFIG.anyApiKeys.length > 0) {
    for (const key of CONFIG.anyApiKeys) {
      strategies.push({
        name: `AnyAPI (google/gemini-3.1-flash-image) [key: ...${key.slice(-4)}]`,
        authHeader: `Bearer ${key}`,
        send: () =>
          fetch("https://api.anyapi.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-3.1-flash-image",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: dataUri } },
                  ],
                },
              ],
            }),
          }),
      });
    }
  }

  // Strategy 2: OpenRouter with Gemini 2.5 Flash Image
  if (CONFIG.openRouterApiKeys.length > 0) {
    for (const key of CONFIG.openRouterApiKeys) {
      strategies.push({
        name: `OpenRouter (google/gemini-2.5-flash-image) [key: ...${key.slice(-4)}]`,
        authHeader: `Bearer ${key}`,
        send: () =>
          fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-image",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: dataUri } },
                  ],
                },
              ],
            }),
          }),
      });
    }
  }

  // Strategy 3: Free.ai image edit endpoint
  const freeAiKey = process.env.FREE_AI_API_KEY;
  if (freeAiKey) {
    strategies.push({
      name: "Free.ai (v1/image/edit/ multipart)",
      authHeader: `Bearer ${freeAiKey}`,
      send: () => {
        const formData = new FormData();
        formData.append("model", "qwen-image-edit");
        formData.append("prompt", prompt);
        formData.append("image", new Blob([imageBuffer], { type: "image/png" }), "image.png");
        return fetch("https://api.free.ai/v1/image/edit/", {
          method: "POST",
          headers: { Authorization: `Bearer ${freeAiKey}` },
          body: formData,
        });
      },
    });
  }

  if (strategies.length === 0) {
    console.error("❌ No API keys found (ANYAPI_KEY, OPENROUTER_API_KEY, or FREE_AI_API_KEY).");
    process.exit(1);
  }

  let successBuffer: Buffer | null = null;

  for (let i = 0; i < strategies.length; i++) {
    const strategy = strategies[i];
    console.log(`🚀 Sending request via Strategy ${i + 1}/${strategies.length}: ${strategy.name}...`);
    const startTime = Date.now();

    try {
      const response = await strategy.send();
      const responseText = await response.text();
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      if (!response.ok) {
        console.warn(`  ⚠️ Strategy ${i + 1} returned HTTP ${response.status}: ${responseText.slice(0, 150)}`);
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      console.log(`  ✓ Response received in ${duration}s via ${strategy.name}`);
      let parsed: any;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        parsed = responseText;
      }

      const imgBuf = await extractImageBuffer(parsed, responseText, strategy.authHeader);
      if (imgBuf && imgBuf.length > 0) {
        successBuffer = imgBuf;
        break;
      }
    } catch (err: any) {
      console.warn(`  ⚠️ Strategy ${i + 1} error: ${err.message || String(err)}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (!successBuffer) {
    console.error(`❌ All edit strategies failed.`);
    process.exit(1);
  }

  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, successBuffer);

    console.log("==================================================");
    console.log(`✅ Success! Corrected image saved to:`);
    console.log(`📁 ${outputPath}`);
    console.log(`📦 Size: ${(successBuffer.length / 1024).toFixed(1)} KB`);
    console.log("==================================================");
  } catch (error: any) {
    console.error("❌ Error saving image:", error);
    process.exit(1);
  }
}

// Execute if run directly via CLI
if (process.argv[1]?.includes("manualEdit")) {
  runManualEdit().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
