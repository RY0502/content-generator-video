import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  CONFIG: {
    groqApiKey: "test-groq-key",
    groqModel: "llama-3.3-70b-versatile",
  },
}));

import { groqChatText } from "../providers/groqClient.js";

describe("groqClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends a chat completion request to Groq API", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"voice":"en-US-GuyNeural","reason":"energetic"}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const result = await groqChatText({
      systemPrompt: "You are a casting director.",
      userText: "Pick a voice for Pip.",
    });

    expect(capturedUrl).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(capturedBody.model).toBe("llama-3.3-70b-versatile");
    expect(capturedBody.messages).toHaveLength(2);
    expect(result).toContain("en-US-GuyNeural");
  });

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof fetch;

    await expect(
      groqChatText({ systemPrompt: "test", userText: "fail" })
    ).rejects.toThrow("401");
  });

  it("returns empty string when response has no content", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: {} }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await groqChatText({ systemPrompt: "test", userText: "empty" });
    expect(result).toBe("");
  });
});
