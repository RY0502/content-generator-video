import { describe, expect, it, vi } from "vitest";
import type { SeriesState } from "../state/seriesState.js";

const { ensureSeriesCharacterPortraits } = vi.hoisted(() => ({
  ensureSeriesCharacterPortraits: vi.fn(),
}));

vi.mock("../services/seriesCharacterPortraitService.js", () => ({
  ensureSeriesCharacterPortraits,
}));

import { buildEnsureSeriesCharacterPortraitsTool } from "../tools/seriesCharacterPortraitTool.js";

describe("ensure_series_character_portraits tool", () => {
  it("runs the whole durable roster as one operation and exposes clear public image names", async () => {
    ensureSeriesCharacterPortraits.mockResolvedValueOnce({
      seriesId: 7,
      rosterCount: 1,
      generatedCount: 0,
      restoredCount: 1,
      reusedCount: 1,
      characters: [{
        name: "Bobo the Backpack",
        imageName: "bobo_the_backpack.png",
        status: "restored_from_supabase",
        localPath: "/assets/bobo_the_backpack.png",
        publicUrl: "https://project.supabase.co/bobo_the_backpack.png",
        publicObjectKey: "series_7/characters/bobo_the_backpack.png",
        sha256: "abc",
      }],
    });
    const seriesState = {} as SeriesState;
    const tool = buildEnsureSeriesCharacterPortraitsTool(seriesState);

    const raw = await (tool as unknown as { func: (input: { seriesId: number }) => Promise<string> })
      .func({ seriesId: 7 });
    const result = JSON.parse(raw);

    expect(tool.name).toBe("ensure_series_character_portraits");
    expect(ensureSeriesCharacterPortraits).toHaveBeenCalledWith({ seriesState, seriesId: 7 });
    expect(result).toMatchObject({
      status: "complete_roster_portraits_ready",
      rosterCount: 1,
      characters: [{
        name: "Bobo the Backpack",
        imageName: "bobo_the_backpack.png",
        publicUrl: "https://project.supabase.co/bobo_the_backpack.png",
      }],
    });
  });
});
