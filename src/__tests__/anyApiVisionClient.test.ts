import { describe, expect, it, vi } from "vitest";
import {
  analyzeImagesWithAnyApi,
  AnyApiRequestRejectedError,
} from "../providers/anyApiVisionClient.js";
import {
  DEFAULT_ANYAPI_IMAGE_MODEL,
  DEFAULT_ANYAPI_VIDEO_QA_MODEL,
  resolveAnyApiImageModel,
  resolveAnyApiVideoQaModel,
} from "../config.js";

function okResponse(content = '{"assets":[]}'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const request = {
  systemPrompt: "Return strict JSON.",
  userText: "Review the batch.",
  images: [
    { bytes: Buffer.from("sheet"), mimeType: "image/jpeg" as const, label: "CONTACT SHEET" },
    { bytes: Buffer.from("refs"), mimeType: "image/jpeg" as const, label: "PORTRAITS" },
  ],
  model: "google/gemini-3.1-pro-preview",
};

describe("AnyAPI multi-image vision client", () => {
  it("keeps image-generation and video-analysis model settings independent", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveAnyApiImageModel(undefined, undefined)).toBe(DEFAULT_ANYAPI_IMAGE_MODEL);
    expect(resolveAnyApiImageModel(" custom/image-model ", "legacy/image-model"))
      .toBe("custom/image-model");
    expect(resolveAnyApiImageModel(undefined, "legacy/image-model"))
      .toBe("legacy/image-model");
    expect(resolveAnyApiVideoQaModel(undefined)).toBe(DEFAULT_ANYAPI_VIDEO_QA_MODEL);
    expect(DEFAULT_ANYAPI_IMAGE_MODEL).toBe("google/gemini-3.1-flash-image");
    expect(DEFAULT_ANYAPI_VIDEO_QA_MODEL).toBe("google/gemini-3.1-pro-preview");
    warn.mockRestore();
  });

  it("defaults QA to the documented Gemini vision-chat model and normalizes the old image model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveAnyApiVideoQaModel(undefined)).toBe(DEFAULT_ANYAPI_VIDEO_QA_MODEL);
    expect(resolveAnyApiVideoQaModel("gemini-2.5-pro")).toBe("google/gemini-2.5-pro");
    expect(resolveAnyApiVideoQaModel("gemini-3.1-pro-preview")).toBe(DEFAULT_ANYAPI_VIDEO_QA_MODEL);
    expect(resolveAnyApiVideoQaModel("google/gemini-3.1-flash-image"))
      .toBe(DEFAULT_ANYAPI_VIDEO_QA_MODEL);
    expect(resolveAnyApiVideoQaModel(" openai/gpt-5-image ")).toBe(DEFAULT_ANYAPI_VIDEO_QA_MODEL);
    expect(resolveAnyApiVideoQaModel("custom/vision-chat-model")).toBe("custom/vision-chat-model");
    expect(warn).toHaveBeenCalledWith(
      "[AgnesVideoQA] incompatible_analysis_model_fallback",
      expect.objectContaining({
        configuredModel: "openai/gpt-5-image",
        effectiveModel: "google/gemini-3.1-pro-preview",
      }),
    );
    warn.mockRestore();
  });

  it("sends Gemini structured analysis with both base64 images", async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => (
      okResponse('{"assets":[{"sceneNumber":1}]}')
    ));
    const result = await analyzeImagesWithAnyApi(request, {
      apiKeys: ["qa-key"],
      fetchImpl: fetchImpl as typeof fetch,
      retriesPerKey: 1,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    });

    expect(result).toBe('{"assets":[{"sceneNumber":1}]}');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(init).toBeDefined();
    expect(url).toBe("https://api.anyapi.ai/v1/chat/completions");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer qa-key");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      model: "google/gemini-3.1-pro-preview",
      stream: false,
      max_tokens: 8_192,
      thinking_level: "low",
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("temperature");
    const content = body.messages[1].content as Array<any>;
    expect(content.filter((part) => part.type === "image_url")).toHaveLength(2);
    expect(content[2].image_url.url).toMatch(/^data:image\/jpeg;base64,/u);
  });

  it("rotates to another key after a definite rate limit", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "rate limit", code: "429" },
      }), { status: 429 }))
      .mockResolvedValueOnce(okResponse("{\"assets\":[]}"));

    await expect(analyzeImagesWithAnyApi(request, {
      apiKeys: ["limited-key", "working-key"],
      fetchImpl: fetchImpl as typeof fetch,
      retriesPerKey: 1,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    })).resolves.toBe("{\"assets\":[]}");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[0]![1].headers as Record<string, string>).Authorization)
      .not.toBe((fetchImpl.mock.calls[1]![1].headers as Record<string, string>).Authorization);
  });

  it("rejects a known image-generation model before sending private QA images", async () => {
    const fetchImpl = vi.fn();
    await expect(analyzeImagesWithAnyApi({
      ...request,
      model: "openai/gpt-5-image",
    }, {
      apiKeys: ["qa-key"],
      fetchImpl: fetchImpl as typeof fetch,
      requestIntervalMs: 0,
    })).rejects.toThrow("not supported by the documented");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry or rotate keys after a deterministic bad request", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "Unsupported request field for this model" },
    }), { status: 400, statusText: "Bad Request" }));
    const sleep = vi.fn();

    const analysis = analyzeImagesWithAnyApi(request, {
      apiKeys: ["qa-key-a", "qa-key-b", "qa-key-c"],
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
      retriesPerKey: 3,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    });

    await expect(analysis).rejects.toBeInstanceOf(AnyApiRequestRejectedError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rotates immediately to a different key after a plain 403 even with per-key retries enabled", async () => {
    const apiKeys = ["qa-key-a", "qa-key-b"];
    let primedAuthorization = "";
    await analyzeImagesWithAnyApi(request, {
      apiKeys,
      fetchImpl: vi.fn(async (_input, init) => {
        primedAuthorization = (init!.headers as Record<string, string>).Authorization;
        return okResponse("{\"assets\":[]}");
      }) as typeof fetch,
      retriesPerKey: 1,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    });

    // The successful probe advances the module cursor to the other key. This
    // makes the assertion independent of whichever slot earlier tests left as
    // the starting slot.
    const deniedAuthorization = primedAuthorization === "Bearer qa-key-a"
      ? "Bearer qa-key-b"
      : "Bearer qa-key-a";
    const workingAuthorization = deniedAuthorization === "Bearer qa-key-a"
      ? "Bearer qa-key-b"
      : "Bearer qa-key-a";
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const authorization = (init!.headers as Record<string, string>).Authorization;
      return authorization === deniedAuthorization
        ? new Response(JSON.stringify({ error: { message: "403 Access denied" } }), {
            status: 403,
          })
        : okResponse("{\"assets\":[]}");
    });

    await expect(analyzeImagesWithAnyApi(request, {
      apiKeys,
      fetchImpl: fetchImpl as typeof fetch,
      retriesPerKey: 3,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    })).resolves.toBe("{\"assets\":[]}");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const authorizations = fetchImpl.mock.calls.map((call) => (
      (call[1]!.headers as Record<string, string>).Authorization
    ));
    expect(authorizations).toEqual([deniedAuthorization, workingAuthorization]);
  });

  it("rotates the starting key after every successful sequential analysis", async () => {
    const apiKeys = ["round-robin-a", "round-robin-b", "round-robin-c"];
    const authorizations: string[] = [];
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      authorizations.push((init!.headers as Record<string, string>).Authorization);
      return okResponse("{\"assets\":[]}");
    });

    for (let callNumber = 0; callNumber < 4; callNumber += 1) {
      await analyzeImagesWithAnyApi(request, {
        apiKeys,
        fetchImpl: fetchImpl as typeof fetch,
        retriesPerKey: 3,
        requestIntervalMs: 0,
        requestTimeoutMs: 1_000,
      });
    }

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(new Set(authorizations.slice(0, 3))).toEqual(new Set(
      apiKeys.map((apiKey) => `Bearer ${apiKey}`),
    ));
    expect(authorizations[3]).toBe(authorizations[0]);
  });

  it("fails closed on an empty successful response", async () => {
    const fetchImpl = vi.fn(async () => okResponse(""));
    await expect(analyzeImagesWithAnyApi(request, {
      apiKeys: ["qa-key"],
      fetchImpl: fetchImpl as typeof fetch,
      sleep: vi.fn(),
      retriesPerKey: 1,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    })).rejects.toThrow("empty analysis response");
  });

  it("retries a length-limited response once with a larger completion budget", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{
          message: { content: '{"assets":[' },
          finish_reason: "length",
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(okResponse('{"assets":[]}'));
    await expect(analyzeImagesWithAnyApi(request, {
      apiKeys: ["qa-key-a"],
      fetchImpl: fetchImpl as typeof fetch,
      retriesPerKey: 2,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    })).resolves.toBe('{"assets":[]}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const maxTokens = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]!.body)).max_tokens);
    expect(maxTokens).toEqual([8_192, 16_384]);
  });

  it("returns a final length-limited body only for strict local parsing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { content: '{"assets":[' },
        finish_reason: "length",
      }],
    }), { status: 200 }));
    await expect(analyzeImagesWithAnyApi(request, {
      apiKeys: ["qa-key-a"],
      fetchImpl: fetchImpl as typeof fetch,
      retriesPerKey: 1,
      requestIntervalMs: 0,
      requestTimeoutMs: 1_000,
    })).resolves.toBe('{"assets":[');
  });

  it("refuses to send credentials and private frames to an unsafe base URL", async () => {
    const fetchImpl = vi.fn();
    await expect(analyzeImagesWithAnyApi(request, {
      apiKeys: ["qa-key"],
      baseUrl: "http://api.anyapi.ai?redirect=elsewhere",
      fetchImpl: fetchImpl as typeof fetch,
      requestIntervalMs: 0,
    })).rejects.toThrow("must use HTTPS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
