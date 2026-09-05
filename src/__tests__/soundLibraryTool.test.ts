import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const readdirMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readdir: (...args: unknown[]) => readdirMock(...args),
}));

vi.mock("../config.js", () => ({
  CONFIG: {
    assetsDir: "/tmp/assets",
  },
}));

import { buildSoundLibraryTool } from "../tools/soundLibraryTool.js";

describe("soundLibraryTool", () => {
  it("normalizes stringified sceneKeywords via the tool schema", async () => {
    readdirMock
      .mockResolvedValueOnce(["forest_birds.wav"])
      .mockResolvedValueOnce(["forest_theme.mp3"]);

    const tool = buildSoundLibraryTool();
    const result = await (tool as any).call({
      sceneKeywords: JSON.stringify(["forest", "birds"]),
    });

    expect(JSON.parse(result)).toEqual({
      sfxPath: path.join("/tmp/assets", "sfx", "forest_birds.wav"),
      musicPath: path.join("/tmp/assets", "music", "forest_theme.mp3"),
    });
  });
});
