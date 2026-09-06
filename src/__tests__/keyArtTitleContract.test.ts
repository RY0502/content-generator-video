import { describe, expect, it } from "vitest";
import {
  KEY_ART_TITLE_MAX_RAW_CHARACTERS,
  KEY_ART_TITLE_MAX_SPOKEN_WORDS,
  canonicalizeKeyArtTitle,
} from "../services/keyArtTitleContract.js";

describe("key-art title contract", () => {
  it("uses one canonical surrounding-whitespace trim", () => {
    expect(canonicalizeKeyArtTitle("  Tiny Heroes Club  ", "series"))
      .toBe("Tiny Heroes Club");
    expect(canonicalizeKeyArtTitle("\n The Berry Bridge\t", "episode"))
      .toBe("The Berry Bridge");
  });

  it("rejects titles outside the conservative character and spoken-word bounds", () => {
    expect(() => canonicalizeKeyArtTitle(
      "x".repeat(KEY_ART_TITLE_MAX_RAW_CHARACTERS + 1),
      "series",
    )).toThrow(`at most ${KEY_ART_TITLE_MAX_RAW_CHARACTERS}`);
    expect(() => canonicalizeKeyArtTitle(
      Array.from(
        { length: KEY_ART_TITLE_MAX_SPOKEN_WORDS + 1 },
        (_unused, index) => `word${index + 1}`,
      ).join(" "),
      "episode",
    )).toThrow(`at most ${KEY_ART_TITLE_MAX_SPOKEN_WORDS}`);
    expect(() => canonicalizeKeyArtTitle("   ", "series")).toThrow("must not be empty");
    expect(() => canonicalizeKeyArtTitle("---", "episode")).toThrow("at least one spoken word");
  });
});
