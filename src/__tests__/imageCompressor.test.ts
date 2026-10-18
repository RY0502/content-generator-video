import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { compressPortraitImage } from "../utils/imageCompressor.js";

describe("compressPortraitImage", () => {
  it("returns small buffers unchanged", () => {
    const small = Buffer.from("small-buffer");
    expect(compressPortraitImage(small)).toBe(small);
  });

  it("returns non-image buffers unchanged even if large", () => {
    const largeNonImage = Buffer.alloc(400 * 1024, 0x41);
    expect(compressPortraitImage(largeNonImage)).toBe(largeNonImage);
  });

  it("compresses large real PNG images and outputs a valid smaller PNG", async () => {
    const samplePath = "assets/series_18/characters/Zara/66ae779a86040a10d7686e6c59f663cda640460eb1dc910dd758a8a398469b02/zara.png";
    if (!existsSync(samplePath)) {
      return;
    }
    const original = await readFile(samplePath);
    const compressed = compressPortraitImage(original);

    expect(compressed.length).toBeLessThan(original.length);
    // Standard PNG magic bytes
    expect(compressed[0]).toBe(0x89);
    expect(compressed[1]).toBe(0x50);
    expect(compressed[2]).toBe(0x4e);
    expect(compressed[3]).toBe(0x47);
  });
});
