import { describe, expect, it, vi } from "vitest";
import { buildSeriesStateTools } from "../tools/seriesStateTools.js";

function getCreateTool() {
  const findSeriesIdByConceptName = vi.fn(async () => null);
  const getOrCreateSeries = vi.fn();
  const tool = buildSeriesStateTools({
    findSeriesIdByConceptName,
    getOrCreateSeries,
  } as never).find(({ name }) => name === "get_or_create_series")!;
  return { tool, getOrCreateSeries };
}

const environments = [{ name: "Meadow", description: "A sunny green meadow." }];

describe("get_or_create_series main-character roster boundary", () => {
  it("rejects more than five main characters before creating the series", async () => {
    const { tool, getOrCreateSeries } = getCreateTool();
    await expect(tool.call({
      conceptName: "Five Reference Friends",
      characters: Array.from({ length: 6 }, (_, index) => ({
        name: `Friend ${index + 1}`,
        description: "A clearly defined story character.",
      })),
      environments,
      episodeFormula: "The friends solve one gentle problem.",
    })).rejects.toThrow("at most five");
    expect(getOrCreateSeries).not.toHaveBeenCalled();
  });

  it("rejects duplicate names and canonical public filenames", async () => {
    const duplicate = getCreateTool();
    await expect(duplicate.tool.call({
      conceptName: "Duplicate Friends",
      characters: [
        { name: "Mia", description: "A young explorer." },
        { name: " mia ", description: "A second explorer." },
      ],
      environments,
      episodeFormula: "The friends solve one gentle problem.",
    })).rejects.toThrow("Duplicate main-character name");
    expect(duplicate.getOrCreateSeries).not.toHaveBeenCalled();

    const collision = getCreateTool();
    await expect(collision.tool.call({
      conceptName: "Filename Friends",
      characters: [
        { name: "Bobo!", description: "A red backpack." },
        { name: "Bobo?", description: "A blue backpack." },
      ],
      environments,
      episodeFormula: "The friends solve one gentle problem.",
    })).rejects.toThrow("collides at public filename");
    expect(collision.getOrCreateSeries).not.toHaveBeenCalled();
  });
});
