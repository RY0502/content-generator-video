import { describe, expect, it, vi } from "vitest";
import {
  ErrorKind,
  type LlmInput,
  type Logger,
  type Provider,
} from "@freetier/orchestrator";
import { buildNarrationRepairOrchestrator } from "../providers/aiClient.js";

function fakeProvider(
  name: string,
  invoke: (input: LlmInput) => Promise<string>,
  classifyError?: (error: unknown) => ErrorKind | undefined,
): Provider<LlmInput, string> {
  return {
    name,
    invoke,
    ...(classifyError === undefined ? {} : { classifyError }),
  };
}

function collectingLogger(messages: string[]): Logger {
  return {
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
    error: (message) => messages.push(message),
  };
}

describe("narration-only repair provider rotation", () => {
  it("orders every Cloudflare account before NVIDIA and excludes unrelated providers", async () => {
    const groq = vi.fn().mockResolvedValue('{"provider":"groq"}');
    const nvidia = vi.fn().mockResolvedValue('{"provider":"nvidia"}');
    const nvidiaSecond = vi.fn().mockResolvedValue('{"provider":"nvidia-2"}');
    const cloudflare = vi.fn().mockResolvedValue('{"provider":"cloudflare"}');
    const huggingFace = vi.fn().mockResolvedValue('{"provider":"huggingface"}');
    const cloudflareSecond = vi.fn().mockResolvedValue('{"provider":"cloudflare-2"}');
    const orchestrator = buildNarrationRepairOrchestrator([
      fakeProvider("Groq", groq),
      fakeProvider("NVIDIA #2", nvidiaSecond),
      fakeProvider("Cloudflare", cloudflare),
      fakeProvider("HuggingFace", huggingFace),
      fakeProvider("NVIDIA", nvidia),
      fakeProvider("Cloudflare #2", cloudflareSecond),
    ], { logger: collectingLogger([]) });

    const result = await orchestrator.invoke({
      system: "Return tiny JSON.",
      prompt: "Shorten one narration.",
      parse: (raw) => JSON.parse(raw) as { provider: string },
    });

    expect(result).toEqual({ provider: "cloudflare" });
    expect(cloudflare).toHaveBeenCalledTimes(1);
    expect(cloudflareSecond).not.toHaveBeenCalled();
    expect(nvidia).not.toHaveBeenCalled();
    expect(nvidiaSecond).not.toHaveBeenCalled();
    expect(groq).not.toHaveBeenCalled();
    expect(huggingFace).not.toHaveBeenCalled();
    expect(orchestrator.getStatus().map(({ provider }) => provider)).toEqual([
      "Cloudflare",
      "Cloudflare #2",
      "NVIDIA",
      "NVIDIA #2",
    ]);
  });

  it("falls through invalid Cloudflare JSON to the next Cloudflare account and then NVIDIA", async () => {
    const first = vi.fn().mockResolvedValue("not json");
    const second = vi.fn().mockResolvedValue('{"wrong":true}');
    const nvidia = vi.fn().mockResolvedValue('{"sceneNumber":4,"narrationText":"Short and warm."}');
    const unrelated = vi.fn().mockResolvedValue("{}");
    const messages: string[] = [];
    const orchestrator = buildNarrationRepairOrchestrator([
      fakeProvider("NVIDIA", nvidia),
      fakeProvider("Cloudflare #2", second),
      fakeProvider("Groq", unrelated),
      fakeProvider("Cloudflare", first),
    ], { logger: collectingLogger(messages) });
    const parse = (raw: string) => {
      const value = JSON.parse(raw) as { sceneNumber?: number; narrationText?: string };
      if (value.sceneNumber !== 4 || typeof value.narrationText !== "string") {
        throw new Error(`invalid raw output ${raw}`);
      }
      return value;
    };

    const result = await orchestrator.invoke({
      system: "Return tiny JSON.",
      prompt: "Shorten scene 4.",
      parse,
    });

    expect(result).toEqual({ sceneNumber: 4, narrationText: "Short and warm." });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(nvidia).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    expect(messages.join("\n")).not.toContain("invalid raw output");
    expect(orchestrator.getCurrentProvider()).toBe("NVIDIA");
  });

  it("falls back from a Cloudflare quota response to NVIDIA without retrying it", async () => {
    const quotaError = new Error("Cloudflare quota exhausted");
    const cloudflare = vi.fn().mockRejectedValue(quotaError);
    const classifyError = vi.fn((error: unknown) =>
      error === quotaError ? ErrorKind.Quota : undefined
    );
    const nvidia = vi.fn().mockResolvedValue('{"status":"nvidia-fallback"}');
    const orchestrator = buildNarrationRepairOrchestrator([
      fakeProvider("Cloudflare", cloudflare, classifyError),
      fakeProvider("NVIDIA", nvidia),
    ], { logger: collectingLogger([]) });

    const result = await orchestrator.invoke({
      system: "Return tiny JSON.",
      prompt: "Shorten one narration.",
      parse: (raw) => JSON.parse(raw),
    });

    expect(result).toEqual({ status: "nvidia-fallback" });
    expect(cloudflare).toHaveBeenCalledTimes(1);
    expect(nvidia).toHaveBeenCalledTimes(1);
    expect(classifyError).toHaveBeenCalledWith(quotaError);
  });

  it("starts the next independent repair at Cloudflare after a transient NVIDIA fallback", async () => {
    const transient = Object.assign(new Error("Cloudflare API error (503): temporarily unavailable"), {
      status: 503,
    });
    const cloudflare = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('{"status":"cloudflare-primary"}');
    const nvidia = vi.fn().mockResolvedValue('{"status":"nvidia-fallback"}');
    const orchestrator = buildNarrationRepairOrchestrator([
      fakeProvider("Cloudflare", cloudflare),
      fakeProvider("NVIDIA", nvidia),
    ], { logger: collectingLogger([]) });
    const invocation = {
      system: "Return tiny JSON.",
      prompt: "Shorten one narration.",
      parse: (raw: string) => JSON.parse(raw) as { status: string },
    };

    await expect(orchestrator.invoke(invocation)).resolves.toEqual({
      status: "nvidia-fallback",
    });
    await expect(orchestrator.invoke(invocation)).resolves.toEqual({
      status: "cloudflare-primary",
    });

    expect(cloudflare).toHaveBeenCalledTimes(2);
    expect(nvidia).toHaveBeenCalledTimes(1);
    expect(orchestrator.getCurrentProvider()).toBe("Cloudflare");
  });

  it("falls through a Cloudflare account-level client rejection to NVIDIA", async () => {
    const accountError = Object.assign(new Error("Cloudflare API error (403): invalid token"), {
      status: 403,
    });
    const cloudflare = vi.fn().mockRejectedValue(accountError);
    const nvidia = vi.fn().mockResolvedValue('{"status":"nvidia-fallback"}');
    const orchestrator = buildNarrationRepairOrchestrator([
      fakeProvider("Cloudflare", cloudflare, () => ErrorKind.Fatal),
      fakeProvider("NVIDIA", nvidia),
    ], { logger: collectingLogger([]) });

    const result = await orchestrator.invoke({
      system: "Return tiny JSON.",
      prompt: "Shorten one narration.",
      parse: (raw) => JSON.parse(raw),
    });

    expect(result).toEqual({ status: "nvidia-fallback" });
    expect(cloudflare).toHaveBeenCalledTimes(1);
    expect(nvidia).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when neither Cloudflare nor NVIDIA is configured", () => {
    expect(() => buildNarrationRepairOrchestrator([
      fakeProvider("Groq", vi.fn().mockResolvedValue("{}")),
      fakeProvider("HuggingFace", vi.fn().mockResolvedValue("{}")),
    ], { logger: collectingLogger([]) })).toThrow(
      "Narration repair requires at least one Cloudflare or NVIDIA text provider",
    );
  });
});
