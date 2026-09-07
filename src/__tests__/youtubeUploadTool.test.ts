import { beforeEach, describe, expect, it, vi } from "vitest";

const statSyncMock = vi.fn();
const createReadStreamMock = vi.fn();
const readFileMock = vi.fn();
const insertMock = vi.fn();
const thumbnailSetMock = vi.fn();
const setCredentialsMock = vi.fn();

vi.mock("node:fs", () => ({
  statSync: (...args: unknown[]) => statSyncMock(...args),
  createReadStream: (...args: unknown[]) => createReadStreamMock(...args),
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: setCredentialsMock,
      })),
    },
    youtube: vi.fn(() => ({
      videos: {
        insert: insertMock,
      },
      thumbnails: {
        set: thumbnailSetMock,
      },
    })),
  },
}));

vi.mock("../config.js", () => ({
  CONFIG: {
    youtubeClientId: "client-id",
    youtubeClientSecret: "client-secret",
    youtubeRefreshToken: "refresh-token",
  },
}));

import { buildYoutubeUploadTool } from "../tools/youtubeUploadTool.js";

describe("youtubeUploadTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statSyncMock.mockReturnValue({ isFile: () => true, size: 1024 });
    createReadStreamMock.mockReturnValue({});
    readFileMock.mockResolvedValue(Buffer.from("png"));
    thumbnailSetMock.mockResolvedValue({});
  });

  it("normalizes stringified tags via the tool schema", async () => {
    insertMock.mockResolvedValue({ data: { id: "video-123" } });

    const tool = buildYoutubeUploadTool();
    const result = await (tool as any).call({
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 1",
      description: "A gentle story for preschoolers.",
      tags: JSON.stringify(["kids", "storytime"]),
      privacyStatus: "unlisted",
    });

    expect(insertMock.mock.calls[0][0].requestBody.snippet.tags).toEqual([
      "kids",
      "storytime",
      "Children stories",
      "stories for kids",
      "stories for children",
      "educational",
    ]);
    expect(JSON.parse(result)).toEqual({
      status: "uploaded",
      videoId: "video-123",
      url: "https://www.youtube.com/watch?v=video-123",
      privacyStatus: "unlisted",
    });
    expect(thumbnailSetMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("uploads only an explicitly supplied custom thumbnail", async () => {
    insertMock.mockResolvedValue({ data: { id: "video-456" } });

    const tool = buildYoutubeUploadTool();
    await (tool as any).call({
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 2",
      description: "Another story.",
      thumbnailPath: "/tmp/custom_thumbnail.png",
    });

    expect(thumbnailSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: "video-456",
        media: expect.objectContaining({
          mimeType: "image/png",
          body: Buffer.from("png"),
        }),
      })
    );
    expect(readFileMock).toHaveBeenCalledWith("/tmp/custom_thumbnail.png");
  });

  it("runs the optional finalization hook after a successful upload", async () => {
    insertMock.mockResolvedValue({ data: { id: "video-789" } });
    const onUploaded = vi.fn().mockResolvedValue(undefined);
    const tool = buildYoutubeUploadTool({ onUploaded });

    await (tool as any).call({
      seriesId: 7,
      episodeNumber: 4,
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 4",
      description: "A new story.",
      privacyStatus: "private",
    });

    expect(onUploaded).toHaveBeenCalledWith({
      seriesId: 7,
      episodeNumber: 4,
      videoPath: "/tmp/video.mp4",
      videoId: "video-789",
      url: "https://www.youtube.com/watch?v=video-789",
      privacyStatus: "private",
    });
  });

  it("returns a durable existing receipt without validating or uploading again", async () => {
    const getExistingUpload = vi.fn().mockResolvedValue({
      videoId: "existing-video",
      url: "https://www.youtube.com/watch?v=existing-video",
    });
    const beforeUpload = vi.fn();
    const onUploaded = vi.fn();
    const tool = buildYoutubeUploadTool({
      getExistingUpload,
      beforeUpload,
      onUploaded,
    });

    const result = JSON.parse(await (tool as any).call({
      seriesId: 7,
      episodeNumber: 4,
      videoPath: "/tmp/no-longer-needed.mp4",
      title: "Tiny Heroes Club Episode 4",
      description: "A previously uploaded story.",
    }));

    expect(getExistingUpload).toHaveBeenCalledWith({
      seriesId: 7,
      episodeNumber: 4,
    });
    expect(result).toEqual({
      status: "already_uploaded",
      videoId: "existing-video",
      url: "https://www.youtube.com/watch?v=existing-video",
      reused: true,
    });
    expect(statSyncMock).not.toHaveBeenCalled();
    expect(createReadStreamMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(beforeUpload).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("runs fail-closed validation before the irreversible upload", async () => {
    insertMock.mockResolvedValue({ data: { id: "validated-video" } });
    const beforeUpload = vi.fn().mockResolvedValue(undefined);
    const tool = buildYoutubeUploadTool({ beforeUpload });

    await (tool as any).call({
      seriesId: 11,
      episodeNumber: 2,
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 2",
      description: "A validated story.",
    });

    expect(beforeUpload).toHaveBeenCalledWith({
      seriesId: 11,
      episodeNumber: 2,
      videoPath: "/tmp/video.mp4",
    });
    expect(beforeUpload.mock.invocationCallOrder[0]).toBeLessThan(
      insertMock.mock.invocationCallOrder[0],
    );
  });

  it("does not upload when beforeUpload rejects", async () => {
    const beforeUpload = vi.fn().mockRejectedValue(new Error("episode is not ready"));
    const tool = buildYoutubeUploadTool({ beforeUpload });

    await expect((tool as any).call({
      seriesId: 11,
      episodeNumber: 3,
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 3",
      description: "An incomplete story.",
    })).rejects.toThrow("episode is not ready");

    expect(beforeUpload).toHaveBeenCalledOnce();
    expect(createReadStreamMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns the irreversible upload receipt when finalization fails", async () => {
    insertMock.mockResolvedValue({ data: { id: "uploaded-once" } });
    const onUploaded = vi.fn().mockRejectedValue(new Error("Turso cleanup unavailable"));
    const tool = buildYoutubeUploadTool({ onUploaded });

    const result = JSON.parse(await (tool as any).call({
      seriesId: 15,
      episodeNumber: 6,
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 6",
      description: "A story whose finalization needs attention.",
      privacyStatus: "unlisted",
    }));

    expect(insertMock).toHaveBeenCalledOnce();
    expect(onUploaded).toHaveBeenCalledWith({
      seriesId: 15,
      episodeNumber: 6,
      videoPath: "/tmp/video.mp4",
      videoId: "uploaded-once",
      url: "https://www.youtube.com/watch?v=uploaded-once",
      privacyStatus: "unlisted",
    });
    expect(result).toEqual({
      status: "uploaded_finalization_failed",
      videoId: "uploaded-once",
      url: "https://www.youtube.com/watch?v=uploaded-once",
      privacyStatus: "unlisted",
      finalizationError: "Turso cleanup unavailable",
      retryUpload: false,
    });
  });

  it("requires episode identity when upload state integration is configured", async () => {
    const tool = buildYoutubeUploadTool({ onUploaded: vi.fn() });

    expect((tool as any).schema.safeParse({
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 5",
      description: "A new story.",
    }).success).toBe(false);

    await expect((tool as any).call({
      videoPath: "/tmp/video.mp4",
      title: "Tiny Heroes Club Episode 5",
      description: "A new story.",
    })).rejects.toThrow("Received tool input did not match expected schema");

    expect(insertMock).not.toHaveBeenCalled();
  });

  it("advertises and accepts required identity for every state-integration hook", async () => {
    insertMock.mockResolvedValue({ data: { id: "stateful-video" } });
    const beforeUpload = vi.fn().mockResolvedValue(undefined);
    const tool = buildYoutubeUploadTool({ beforeUpload });
    const input = {
      seriesId: 13,
      episodeNumber: 1,
      videoPath: "/tmp/video.mp4",
      title: "Time-Travel Backpack #1: Dino Egg Rescue",
      description: "A dinosaur rescue adventure.",
    };

    expect(tool.description).toContain("requires seriesId and episodeNumber");
    expect((tool as any).schema.safeParse(input).success).toBe(true);

    const result = JSON.parse(await (tool as any).call(input));

    expect(result.status).toBe("uploaded");
    expect(beforeUpload).toHaveBeenCalledWith({
      seriesId: 13,
      episodeNumber: 1,
      videoPath: "/tmp/video.mp4",
    });
    expect(insertMock).toHaveBeenCalledOnce();
  });

  it("keeps episode identity optional for legitimate standalone uploads", () => {
    const tool = buildYoutubeUploadTool();

    expect((tool as any).schema.safeParse({
      videoPath: "/tmp/video.mp4",
      title: "Standalone story",
      description: "Uploaded without production state integration.",
    }).success).toBe(true);
    expect(tool.description).toContain("optional only for standalone uploads");
  });
});
