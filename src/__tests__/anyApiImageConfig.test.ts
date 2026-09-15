import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ANYAPI_IMAGE_MODEL,
  resolveAnyApiImageModel,
} from "../config.js";

describe("AnyAPI image model configuration", () => {
  it("defaults portrait generation to the independent image model", () => {
    expect(DEFAULT_ANYAPI_IMAGE_MODEL).toBe("google/gemini-3.1-flash-image-preview");
    expect(resolveAnyApiImageModel(undefined, undefined)).toBe(DEFAULT_ANYAPI_IMAGE_MODEL);
    expect(resolveAnyApiImageModel(" custom/image-model ", "legacy/image-model"))
      .toBe("custom/image-model");
  });

  it("normalizes the retired Gemini 3.1 image alias to AnyAPI's live model id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(resolveAnyApiImageModel("google/gemini-3.1-flash-image", undefined))
        .toBe(DEFAULT_ANYAPI_IMAGE_MODEL);
      expect(warn).toHaveBeenCalledWith(
        "[AnyAPI] image_model_alias_normalized",
        expect.objectContaining({ effectiveModel: DEFAULT_ANYAPI_IMAGE_MODEL }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("retains the legacy image-model fallback without any video-QA model setting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(resolveAnyApiImageModel(undefined, "legacy/image-model"))
        .toBe("legacy/image-model");
      expect(warn).toHaveBeenCalledWith(
        "[AnyAPI] deprecated_image_model_env",
        expect.objectContaining({ replacement: "ANYAPI_IMAGE_MODEL" }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
