import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AGNES_CREATE_VIDEO_URL,
  AGNES_RETRIEVE_VIDEO_URL,
  AGNES_VIDEO_MODEL,
  AgnesError,
  AgnesVideoClient,
  completedAgnesVideoUrl,
  fingerprintAgnesKey,
  loadAgnesApiKeys,
  type AgnesVideoTask,
} from "../providers/agnes/index.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function providerTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    task_id: "task-1",
    video_id: "video-1",
    object: "video",
    model: AGNES_VIDEO_MODEL,
    status: "queued",
    progress: 0,
    created_at: 1_788_000_000,
    seconds: "8",
    size: "720P",
    ...overrides,
  };
}

function persistedTask(key: string, overrides: Partial<AgnesVideoTask> = {}): AgnesVideoTask {
  return {
    id: "task-1",
    task_id: "task-1",
    video_id: "video-1",
    model: AGNES_VIDEO_MODEL,
    status: "queued",
    progress: 0,
    keyLabel: "key-1",
    keyFingerprint: fingerprintAgnesKey(key),
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("AgnesVideoClient", () => {
  it.each(["submitted", "pending"] as const)(
    "accepts the provider's %s pre-queue task state",
    async (status) => {
      const client = new AgnesVideoClient({
        apiKeys: ["agnes-secret"],
        fetch: async () => jsonResponse(providerTask({ status })),
      });
      await expect(client.submitVideo({ mode: "text", prompt: "Forest", seconds: 6 }))
        .resolves.toMatchObject({ status, video_id: "video-1" });
    },
  );

  it("sends exact text and reference payloads without truncating the prompt", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["agnes-secret"],
      fetch: async (input, init) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) });
        return jsonResponse(providerTask());
      },
    });
    const longPrompt = `A cinematic children's scene. ${"continuity detail ".repeat(350)}`;

    const textTask = await client.submitVideo({
      mode: "text",
      prompt: longPrompt,
      seconds: 12,
      seed: 1101,
    });
    await client.submitVideo({
      mode: "reference",
      prompt: "Use <Picture 1> as the exact character and art-style reference.",
      seconds: 5,
      seed: 1101,
      images: ["https://media.example.com/scene.png?signature=durable"],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(AGNES_CREATE_VIDEO_URL);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
      "Bearer agnes-secret",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: longPrompt.trim(),
      seconds: "12",
      mode: "text",
      size: "720P",
      aspect_ratio: "16:9",
      n: 1,
      seed: 1101,
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: "Use <Picture 1> as the exact character and art-style reference.",
      seconds: "5",
      mode: "reference",
      size: "720P",
      aspect_ratio: "16:9",
      n: 1,
      seed: 1101,
      images: ["https://media.example.com/scene.png?signature=durable"],
    });
    expect(textTask.keyFingerprint).toBe(
      createHash("sha256").update("agnes-secret").digest("hex"),
    );
    expect(JSON.stringify(textTask)).not.toContain("agnes-secret");
  });

  it("validates Flash duration, seed, and public reference-image requirements before I/O", async () => {
    let calls = 0;
    const client = new AgnesVideoClient({
      apiKeys: ["key"],
      fetch: async () => {
        calls += 1;
        return jsonResponse(providerTask());
      },
    });

    for (const seconds of [3, 4.5, 13]) {
      await expect(client.submitVideo({ mode: "text", prompt: "scene", seconds }))
        .rejects.toMatchObject({ kind: "validation" });
    }
    await expect(client.submitVideo({
      mode: "text",
      prompt: "scene",
      seconds: 5,
      seed: 2.5,
    })).rejects.toMatchObject({ kind: "validation" });
    await expect(client.submitVideo({
      mode: "reference",
      prompt: "scene",
      seconds: 5,
      images: [],
    })).rejects.toMatchObject({ kind: "validation" });
    await expect(client.submitVideo({
      mode: "reference",
      prompt: "scene",
      seconds: 5,
      images: Array.from({ length: 6 }, (_, index) => `https://cdn.example.com/${index}.png`),
    })).rejects.toMatchObject({ kind: "validation" });
    for (const image of [
      "data:image/png;base64,AAAA",
      "file:///tmp/scene.png",
      "http://localhost/scene.png",
      "https://192.168.1.2/scene.png",
    ]) {
      await expect(client.submitVideo({
        mode: "reference",
        prompt: "scene",
        seconds: 5,
        images: [image],
      })).rejects.toMatchObject({ kind: "validation" });
    }
    expect(calls).toBe(0);
  });

  it("discovers and safely rotates numbered keys only for definite key-scoped rejection", async () => {
    expect(loadAgnesApiKeys({
      AGNES_API_KEY_10: " ten ",
      AGNES_API_KEY_2: "two",
      AGNES_API_KEY_7: "two",
      AGNES_API_KEY: "ignored",
    })).toEqual(["ignored", "two", "ten"]);

    const bearerValues: Array<string | null> = [];
    const bodies: string[] = [];
    let call = 0;
    const client = new AgnesVideoClient({
      apiKeys: ["first-key", "first-key", "second-key"],
      fetch: async (_input, init) => {
        bearerValues.push(new Headers(init?.headers).get("authorization"));
        bodies.push(String(init?.body));
        call += 1;
        return call === 1
          ? jsonResponse({ code: "rate_limit", message: "Rate limited" }, 429)
          : jsonResponse(providerTask());
      },
    });

    const task = await client.submitVideo({ mode: "text", prompt: "Forest", seconds: 6 });
    expect(bearerValues).toEqual(["Bearer first-key", "Bearer second-key"]);
    expect(new Set(bodies).size).toBe(1);
    expect(task.keyLabel).toBe("key-2");
    expect(task.keyFingerprint).toBe(fingerprintAgnesKey("second-key"));

    let authCalls = 0;
    const unauthorized = new AgnesVideoClient({
      apiKeys: ["bad-key", "unused-key"],
      fetch: async () => {
        authCalls += 1;
        return jsonResponse({ error: { message: "Invalid API key" } }, 401);
      },
    });
    await expect(unauthorized.submitVideo({ mode: "text", prompt: "Forest", seconds: 6 }))
      .rejects.toMatchObject({ kind: "authentication", ambiguousOutcome: false });
    expect(authCalls).toBe(1);
  });

  it("does not rotate credentials when the Agnes render queue is full", async () => {
    const bearers: Array<string | null> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["primary-key", "secondary-key"],
      fetch: async (_input, init) => {
        bearers.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse({ message: "video queue is full, please retry later" });
      },
    });

    await expect(client.submitVideo({ mode: "text", prompt: "Forest", seconds: 6 }))
      .rejects.toMatchObject({ kind: "provider_capacity", ambiguousOutcome: false });
    expect(bearers).toEqual(["Bearer primary-key"]);
  });

  it.each([
    {
      label: "invalid task JSON with quota prose",
      response: () => jsonResponse({ message: "quota exceeded; try another key" }, 200),
    },
    {
      label: "non-JSON success with rate-limit prose",
      response: () => new Response("rate limit exceeded; try another key", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    },
  ])("treats $label as ambiguous and never rotates keys", async ({ response }) => {
    const bearers: Array<string | null> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["primary-key", "secondary-key"],
      fetch: async (_input, init) => {
        bearers.push(new Headers(init?.headers).get("authorization"));
        return response();
      },
    });

    await expect(client.submitVideo({ mode: "text", prompt: "Forest", seconds: 6 }))
      .rejects.toMatchObject({
        kind: "ambiguous_submission",
        ambiguousOutcome: true,
        keyLabel: "key-1",
      });
    expect(bearers).toEqual(["Bearer primary-key"]);
  });

  it.each([
    { payload: { message: "video queue is full, please retry later" }, status: 503 },
    { payload: { error: { message: "render server is temporarily busy" } }, status: 503 },
  ])("keeps an HTTP $status capacity rejection pending without key rotation", async ({ payload, status }) => {
    const bearers: Array<string | null> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["primary-key", "secondary-key"],
      fetch: async (_input, init) => {
        bearers.push(new Headers(init?.headers).get("authorization"));
        return jsonResponse(payload, status);
      },
    });

    await expect(client.submitVideo({ mode: "text", prompt: "Forest", seconds: 6 }))
      .rejects.toMatchObject({ kind: "provider_capacity", ambiguousOutcome: false });
    expect(bearers).toEqual(["Bearer primary-key"]);
  });

  it("retrieves with the exact persisted submission key and recommended model query", async () => {
    const calls: Array<{ url: string; bearer: string | null }> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["first-key", "submission-key", "third-key"],
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          bearer: new Headers(init?.headers).get("authorization"),
        });
        return jsonResponse(providerTask({ status: "in_progress", progress: 45 }));
      },
    });

    const result = await client.retrieveVideo(persistedTask("submission-key"));
    expect(calls).toEqual([{
      url: `${AGNES_RETRIEVE_VIDEO_URL}?video_id=video-1&model_name=agnes-video-2.5-flash`,
      bearer: "Bearer submission-key",
    }]);
    expect(result.status).toBe("in_progress");
    expect(result.keyLabel).toBe("key-2");
  });

  it("polls immediately at 30-second intervals through the inclusive eight-minute window", async () => {
    let instant = 0;
    const sleeps: number[] = [];
    let retrievals = 0;
    const client = new AgnesVideoClient({
      apiKeys: ["poll-key"],
      now: () => instant,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        instant += milliseconds;
      },
      fetch: async () => {
        retrievals += 1;
        return jsonResponse(providerTask({ status: "in_progress", progress: retrievals }));
      },
    });

    const result = await client.pollUntilTerminal(persistedTask("poll-key"));
    expect(result.outcome).toBe("timed_out");
    expect(retrievals).toBe(17);
    expect(sleeps).toEqual(Array.from({ length: 16 }, () => 30_000));
    expect(instant).toBe(480_000);
  });

  it("keeps polling completed tasks until metadata or live top-level URL appears", async () => {
    let instant = 0;
    let retrievals = 0;
    const finalUrl = "https://cdn.agnes.test/final.mp4?token=capability";
    const client = new AgnesVideoClient({
      apiKeys: ["poll-key"],
      pollIntervalMs: 30_000,
      pollWindowMs: 60_000,
      now: () => instant,
      sleep: async (milliseconds) => { instant += milliseconds; },
      fetch: async () => {
        retrievals += 1;
        return jsonResponse(providerTask({
          status: "completed",
          progress: 100,
          ...(retrievals === 1 ? {} : { url: finalUrl }),
        }));
      },
    });

    const result = await client.pollUntilTerminal(persistedTask("poll-key"));
    expect(result.outcome).toBe("completed");
    expect(retrievals).toBe(2);
    expect(instant).toBe(30_000);
    expect(completedAgnesVideoUrl(result.task)).toBe(finalUrl);
  });

  it("downloads signed media atomically, bounded, hashed, and without API authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agnes-client-test-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, "nested", "video.mp4");
    const media = Buffer.from("finished-agnes-video");
    const mediaUrl = "https://cdn.agnes.test/video.mp4?signed=secret-capability";
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const client = new AgnesVideoClient({
      apiKeys: ["agnes-api-secret"],
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return new Response(media, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      },
    });
    const task = persistedTask("agnes-api-secret", {
      status: "completed",
      progress: 100,
      metadata: { url: mediaUrl },
    });

    const result = await client.downloadCompletedVideo(task, outputPath, { maxBytes: 128 });
    expect(calls).toEqual([{ url: mediaUrl, authorization: null }]);
    expect(await readFile(outputPath, "utf8")).toBe(media.toString());
    expect(await readdir(join(directory, "nested"))).toEqual(["video.mp4"]);
    expect(result.sha256).toBe(createHash("sha256").update(media).digest("hex"));
    expect(result.bytes).toBe(media.byteLength);

    await writeFile(outputPath, "keep-existing");
    const oversized = new AgnesVideoClient({
      apiKeys: ["agnes-api-secret"],
      fetch: async () => new Response("too-large", {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
    });
    await expect(oversized.downloadCompletedVideo(task, outputPath, { maxBytes: 4 }))
      .rejects.toBeInstanceOf(AgnesError);
    expect(await readFile(outputPath, "utf8")).toBe("keep-existing");
    expect(await readdir(join(directory, "nested"))).toEqual(["video.mp4"]);
  });

  it("marks a timed-out POST ambiguous and never rotates or exposes keys", async () => {
    let calls = 0;
    const client = new AgnesVideoClient({
      apiKeys: ["timeout-secret-one", "timeout-secret-two"],
      requestTimeoutMs: 5,
      fetch: async (_input, init) => {
        calls += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timeout-secret-one")), {
            once: true,
          });
        });
      },
    });

    await expect(client.submitVideo({ mode: "text", prompt: "scene", seconds: 5 }))
      .rejects.toMatchObject({
        kind: "timeout",
        ambiguousOutcome: true,
        keyLabel: "key-1",
      });
    expect(calls).toBe(1);
  });
});
