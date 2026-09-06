import { describe, expect, it, vi } from "vitest";
import { runAgentBootstrap, type AgentBootstrapDependencies } from "../bootstrap.js";
import { runWithFinalizer } from "../services/runLifecycle.js";
import { buildVmPauseUrl, pauseVm } from "../services/vmPauseService.js";

function bootstrapDependencies(
  overrides: Partial<AgentBootstrapDependencies> = {},
): AgentBootstrapDependencies {
  return {
    cleanup: async () => undefined,
    validatePauseConfiguration: async () => undefined,
    loadAndRunAgent: async () => undefined,
    pause: async () => undefined,
    ...overrides,
  };
}

describe("canonical agent lifecycle", () => {
  it("runs full Neon cleanup first and pauses last after success", async () => {
    const events: string[] = [];
    await runAgentBootstrap(bootstrapDependencies({
      cleanup: async () => { events.push("cleanup"); },
      validatePauseConfiguration: async () => { events.push("validate-pause"); },
      loadAndRunAgent: async () => { events.push("agent"); },
      pause: async () => { events.push("pause"); },
    }));

    expect(events).toEqual(["cleanup", "validate-pause", "agent", "pause"]);
  });

  it.each(["cleanup", "validate-pause", "agent"] as const)(
    "still pauses exactly once when %s fails",
    async (failedPhase) => {
      const events: string[] = [];
      const failure = new Error(`${failedPhase} failed`);
      const dependencies = bootstrapDependencies({
        cleanup: async () => {
          events.push("cleanup");
          if (failedPhase === "cleanup") throw failure;
        },
        validatePauseConfiguration: async () => {
          events.push("validate-pause");
          if (failedPhase === "validate-pause") throw failure;
        },
        loadAndRunAgent: async () => {
          events.push("agent");
          if (failedPhase === "agent") throw failure;
        },
        pause: async () => { events.push("pause"); },
      });

      await expect(runAgentBootstrap(dependencies)).rejects.toBe(failure);
      expect(events.filter((event) => event === "pause")).toHaveLength(1);
      expect(events.at(-1)).toBe("pause");
    },
  );

  it("keeps the original agent error when the pause request also fails", async () => {
    const runError = new Error("agent failed");
    const pauseError = new Error("pause failed");
    const suppressed: unknown[] = [];

    await expect(runWithFinalizer({
      run: async () => { throw runError; },
      finalize: async () => { throw pauseError; },
      onSuppressedFinalizeError: (error) => suppressed.push(error),
    })).rejects.toBe(runError);
    expect(suppressed).toEqual([pauseError]);
  });

  it("keeps the original error even when failure diagnostics also throw", async () => {
    const runError = new Error("agent failed");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(runWithFinalizer({
        run: async () => { throw runError; },
        finalize: async () => { throw new Error("pause failed"); },
        onSuppressedFinalizeError: () => { throw new Error("logger failed"); },
      })).rejects.toBe(runError);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("surfaces a pause failure after an otherwise successful run", async () => {
    const pauseError = new Error("pause failed");
    await expect(runWithFinalizer({
      run: async () => "complete",
      finalize: async () => { throw pauseError; },
    })).rejects.toBe(pauseError);
  });
});

describe("VM pause callback", () => {
  it("joins the fixed route and URL-encodes MACHINE_NO", () => {
    const url = buildVmPauseUrl({
      PAUSE_BASE_URL: "https://controller.example.test/api/?discarded=yes#fragment",
      MACHINE_NO: "vm 7/blue",
    });

    expect(url.origin).toBe("https://controller.example.test");
    expect(url.pathname).toBe("/api/pause/vm");
    expect(url.searchParams.get("machine")).toBe("vm 7/blue");
    expect([...url.searchParams.keys()]).toEqual(["machine"]);
    expect(url.hash).toBe("");
  });

  it("supports the conventional MACHINE_NO casing as an alias", () => {
    const url = buildVmPauseUrl({
      PAUSE_BASE_URL: "http://controller.example.test/",
      MACHINE_NO: "12",
    });
    expect(url.toString()).toBe("http://controller.example.test/pause/vm?machine=12");
  });

  it("uses a non-empty MACHINE_NO alias when MACHINE_NO is present but blank", () => {
    const url = buildVmPauseUrl({
      PAUSE_BASE_URL: "http://controller.example.test",
      machine_NO: "   ",
      MACHINE_NO: "19",
    });
    expect(url.searchParams.get("machine")).toBe("19");
  });

  it("sends one GET and requires a successful HTTP response", async () => {
    const fetchMock = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(null, { status: 204 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await pauseVm({
        env: { PAUSE_BASE_URL: "https://controller.example.test", MACHINE_NO: "42" },
        fetch: fetchMock,
      });
    } finally {
      log.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://controller.example.test/pause/vm?machine=42");
    expect(init).toMatchObject({ method: "GET" });
  });

  it("rejects non-2xx responses", async () => {
    await expect(pauseVm({
      env: { PAUSE_BASE_URL: "https://controller.example.test", MACHINE_NO: "42" },
      fetch: vi.fn(async () => new Response("busy", { status: 503 })),
    })).rejects.toThrow("VM pause request returned HTTP 503");
  });

  it("aborts a pause request that exceeds its bounded timeout", async () => {
    const fetchMock = vi.fn((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
    }));

    await expect(pauseVm({
      env: { PAUSE_BASE_URL: "https://controller.example.test", MACHINE_NO: "42" },
      fetch: fetchMock,
      timeoutMs: 5,
    })).rejects.toThrow("request aborted");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
