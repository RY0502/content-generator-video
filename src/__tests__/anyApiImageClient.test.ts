import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../config.js", () => ({
  CONFIG: {
    anyApiBaseUrl: "https://custom.anyapi.example/v1/",
    anyApiKeys: ["test-key-one", "test-key-two"],
    anyApiImageModel: "google/gemini-3.1-flash-image-preview",
  },
}));

import {
  AnyApiAccessDeniedError,
  generateAnyApiSceneImage,
} from "../providers/anyApiImageClient.js";

describe("AnyAPI image client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("honors the configured versioned base URL and sends the documented image payload", async () => {
    const bytes = Buffer.from("generated-image");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ b64_json: bytes.toString("base64") }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(generateAnyApiSceneImage("one safe portrait"))
      .resolves.toEqual(bytes);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.anyapi.example/v1/images/generations");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-key-one",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "one safe portrait",
      model: "google/gemini-3.1-flash-image-preview",
      n: 1,
      size: "1024x1024",
    });
  });

  it("tries each key only once for deterministic 403 access failures", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      error: { message: "Access denied", code: "403", type: "moderation_error" },
    }), {
      status: 403,
      headers: { "content-type": "application/json" },
    }));

    await expect(generateAnyApiSceneImage("one safe portrait"))
      .rejects.toBeInstanceOf(AnyApiAccessDeniedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
