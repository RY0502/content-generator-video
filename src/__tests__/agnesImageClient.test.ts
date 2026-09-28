import { describe, expect, it, vi } from "vitest";
import { generateAgnesImage, AgnesImageAllKeysFailedError, AgnesImageClientError } from "../providers/agnesImageClient.js";

describe("agnesImageClient", () => {
  it("generates an image and returns downloaded bytes and model info", async () => {
    const fakeImageBytes = Buffer.from("fake-png-bytes");
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/images/generations")) {
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("agnes-image-2.5-flash");
        expect(body.prompt).toBe("A colorful cartoon butterfly");
        expect(body.aspect_ratio).toBe("1:1");
        expect(body.size).toBe("1K");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            data: [{ url: "https://platform-outputs.agnes-ai.space/images/t2i/task_123/out.png" }],
          }),
        };
      }
      if (urlStr.includes("out.png")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => fakeImageBytes.buffer.slice(fakeImageBytes.byteOffset, fakeImageBytes.byteOffset + fakeImageBytes.byteLength),
        };
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const result = await generateAgnesImage("A colorful cartoon butterfly", {
        apiKeys: ["key-test-1"],
        model: "agnes-image-2.5-flash",
      });

      expect(result.bytes.toString()).toBe("fake-png-bytes");
      expect(result.model).toBe("agnes-image-2.5-flash");
      expect(result.url).toBe("https://platform-outputs.agnes-ai.space/images/t2i/task_123/out.png");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rotates to next key when the first key encounters an error", async () => {
    const fakeImageBytes = Buffer.from("key2-image-bytes");
    let key1Tried = false;
    let key2Tried = false;

    const fetchMock = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/images/generations")) {
        const auth = (init?.headers as Record<string, string>)?.["Authorization"];
        if (auth === "Bearer key-fail") {
          key1Tried = true;
          return {
            ok: false,
            status: 429,
            text: async () => JSON.stringify({ error: { message: "Rate limit reached" } }),
          };
        }
        if (auth === "Bearer key-success") {
          key2Tried = true;
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              data: [{ url: "https://platform-outputs.agnes-ai.space/images/t2i/task_success/out.png" }],
            }),
          };
        }
      }
      if (urlStr.includes("out.png")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => fakeImageBytes.buffer.slice(fakeImageBytes.byteOffset, fakeImageBytes.byteOffset + fakeImageBytes.byteLength),
        };
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const result = await generateAgnesImage("Test prompt", {
        apiKeys: ["key-fail", "key-success"],
      });

      expect(key1Tried).toBe(true);
      expect(key2Tried).toBe(true);
      expect(result.bytes.toString()).toBe("key2-image-bytes");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws AgnesImageAllKeysFailedError when all keys fail", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: { message: "Internal server error" } }),
      };
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      await expect(
        generateAgnesImage("Test prompt", {
          apiKeys: ["key-1", "key-2"],
        }),
      ).rejects.toThrow(AgnesImageAllKeysFailedError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
