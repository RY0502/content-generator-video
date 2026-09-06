import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { DeepAgentRunner } from "freetier-deepagent-framework";
import { createDeepAgent, createSummarizationMiddleware } from "deepagents";
import {
  createDeepAgentBackend,
  installDeepAgentBackend,
} from "../services/deepAgentBackend.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deep-agent-backend-"));
  tempDirs.push(dir);
  return dir;
}

describe("deepAgentBackend", () => {
  it("routes internal offloads to writable storage and preserves ordinary absolute paths", async () => {
    const tempRoot = await makeTempDir();
    const storageRoot = path.join(tempRoot, "agent-state");
    const backend = createDeepAgentBackend(storageRoot);

    const historyWrite = await backend.write(
      "/conversation_history/session_test.md",
      "saved conversation",
    );
    expect(historyWrite.error).toBeUndefined();
    expect(await readFile(
      path.join(storageRoot, "conversation_history", "session_test.md"),
      "utf8",
    )).toBe("saved conversation");

    const toolUpload = await backend.uploadFiles([[
      "/large_tool_results/tool_call_test.txt",
      new TextEncoder().encode("large result"),
    ]]);
    expect(toolUpload[0]?.error).toBeNull();
    expect(await readFile(
      path.join(storageRoot, "large_tool_results", "tool_call_test.txt"),
      "utf8",
    )).toBe("large result");

    const ordinaryAbsolutePath = path.join(tempRoot, "ordinary.txt");
    const ordinaryWrite = await backend.write(ordinaryAbsolutePath, "ordinary data");
    expect(ordinaryWrite.error).toBeUndefined();
    expect(await readFile(ordinaryAbsolutePath, "utf8")).toBe("ordinary data");
  });

  it("installs the routed backend into the pinned runner runtime contract", async () => {
    const tempRoot = await makeTempDir();
    // The constructor stores the database client without using it until run(),
    // so a stub is enough to verify the pinned framework integration seam.
    const runner = new DeepAgentRunner({} as any);

    const backend = installDeepAgentBackend(runner, path.join(tempRoot, "agent-state"));

    expect(Reflect.get(runner, "backend")).toBe(backend);
    expect((await backend.write(
      "/conversation_history/session_install.md",
      "installed",
    )).error).toBeUndefined();
  });

  it("fails fast if a framework upgrade removes the backend seam", async () => {
    const tempRoot = await makeTempDir();

    expect(() => installDeepAgentBackend({}, tempRoot)).toThrow(
      "DeepAgentRunner no longer exposes its runtime backend",
    );
  });

  it("offloads a real summarization event through the routed backend", async () => {
    const tempRoot = await makeTempDir();
    const storageRoot = path.join(tempRoot, "agent-state");
    const backend = createDeepAgentBackend(storageRoot);
    const model = new FakeListChatModel({
      responses: ["compact summary", "handler result"],
    });
    const agent = createDeepAgent({
      model,
      backend,
      tools: [],
      subagents: [],
      middleware: [createSummarizationMiddleware({
        backend,
        model,
        trigger: { type: "messages", value: 2 },
        keep: { type: "messages", value: 1 },
        historyPathPrefix: "/conversation_history",
      })],
    });

    const result = await agent.invoke({
      messages: [
        new HumanMessage("first"),
        new AIMessage("second"),
        new HumanMessage("third"),
      ],
    });

    const historyDir = path.join(storageRoot, "conversation_history");
    const names = await readdir(historyDir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^session_[a-f0-9]{8}\.md$/u);
    expect(await readFile(path.join(historyDir, names[0]!), "utf8"))
      .toContain("Human: first\nAI: second");
    expect(result.messages.at(-1)?.content).toBe("handler result");
  });
});
