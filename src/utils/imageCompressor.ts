import { spawnSync } from "node:child_process";
import { CONFIG } from "../config.js";

export interface CompressPortraitOptions {
  maxDimension?: number;
  maxBytesThreshold?: number;
  ffmpegPath?: string;
}

/**
 * Compresses a character portrait image buffer to reduce storage egress.
 * - Resizes to maxDimension (default: 1024x1024, keeping aspect ratio).
 * - Generates an adaptive 256-color palette with dithering to output an optimized PNG.
 * - If input is already small (< maxBytesThreshold, default 300KB) or non-image, returns original buffer.
 * - Gracefully falls back to original buffer on any error or if compressed size is larger.
 */
export function compressPortraitImage(
  buffer: Buffer,
  options?: CompressPortraitOptions,
): Buffer {
  const maxBytesThreshold = options?.maxBytesThreshold ?? 300 * 1024;
  if (!buffer || buffer.length <= maxBytesThreshold) {
    return buffer;
  }

  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
  const isJpg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
  if (!isPng && !isJpg) {
    return buffer;
  }

  const maxDim = options?.maxDimension ?? 1024;
  const ffmpegPath = options?.ffmpegPath ?? CONFIG.ffmpegPath;
  if (!ffmpegPath) {
    return buffer;
  }

  try {
    const scaleFilter = `scale=w='min(${maxDim},iw)':h='min(${maxDim},ih)':force_original_aspect_ratio=decrease`;
    const filter = `${scaleFilter},split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=floyd_steinberg`;

    const result = spawnSync(
      ffmpegPath,
      [
        "-y",
        "-f", isPng ? "png_pipe" : "mjpeg",
        "-i", "pipe:0",
        "-vf", filter,
        "-f", "image2",
        "-c:v", "png",
        "pipe:1",
      ],
      {
        input: buffer,
        maxBuffer: 25 * 1024 * 1024,
      },
    );

    if (
      result.status === 0
      && result.stdout
      && result.stdout.length > 0
      && result.stdout.length < buffer.length
    ) {
      return result.stdout;
    }
  } catch (err) {
    console.warn(`[imageCompressor] Portrait compression skipped: ${(err as Error).message}`);
  }

  return buffer;
}
