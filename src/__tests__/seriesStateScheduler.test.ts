import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_AGNES_SERIES_SEED,
  SeriesState,
} from "../state/seriesState.js";

const openStates: SeriesState[] = [];
const temporaryDirectories: string[] = [];

function memoryState(): SeriesState {
  const state = new SeriesState("file::memory:", "");
  openStates.push(state);
  return state;
}

async function fileState(databasePath: string): Promise<SeriesState> {
  const state = new SeriesState(`file:${databasePath}`, "");
  openStates.push(state);
  await state.initialize();
  return state;
}

afterEach(async () => {
  await Promise.all(openStates.splice(0).map((state) => state.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("SeriesState Agnes scheduler persistence", () => {
  it("atomically persists one preferred 31-bit series seed", async () => {
    const state = memoryState();
    const seriesId = await state.getOrCreateSeries("Seeded Stories", [], [], "Formula");

    expect(await state.getOrCreateSeriesAgnesSeed(seriesId, 0)).toBe(0);
    expect(await state.getOrCreateSeriesAgnesSeed(seriesId, MAX_AGNES_SERIES_SEED)).toBe(0);

    await expect(state.getOrCreateSeriesAgnesSeed(seriesId, -1))
      .rejects.toThrow("integer from 0 through");
    await expect(state.getOrCreateSeriesAgnesSeed(seriesId, MAX_AGNES_SERIES_SEED + 1))
      .rejects.toThrow("integer from 0 through");
    await expect(state.getOrCreateSeriesAgnesSeed(99_999, 1))
      .rejects.toThrow("Series 99999 was not found");
  });

  it("generates a valid random seed and reuses it on every later call", async () => {
    const state = memoryState();
    const seriesId = await state.getOrCreateSeries("Random Seed Stories", [], [], "Formula");

    const first = await state.getOrCreateSeriesAgnesSeed(seriesId);
    const second = await state.getOrCreateSeriesAgnesSeed(seriesId);

    expect(first).toBe(second);
    expect(Number.isInteger(first)).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(MAX_AGNES_SERIES_SEED);
  });

  it("converges concurrent seed candidates on one committed series value", async () => {
    const state = memoryState();
    const seriesId = await state.getOrCreateSeries("Concurrent Seed Stories", [], [], "Formula");
    const candidates = [17, 23, 42, 99];

    const seeds = await Promise.all(
      candidates.map((candidate) => state.getOrCreateSeriesAgnesSeed(seriesId, candidate)),
    );

    expect(new Set(seeds).size).toBe(1);
    expect(candidates).toContain(seeds[0]);
  });

  it("reserves ordered slots atomically and keeps account lanes independent", async () => {
    const state = memoryState();
    const nowMs = 1_000;
    const intervalMs = 31_000;

    const reservations = await Promise.all([
      state.reserveAgnesAccountRateSlot({ accountId: "account-a", lane: "submit", nowMs, intervalMs }),
      state.reserveAgnesAccountRateSlot({ accountId: "account-a", lane: "submit", nowMs, intervalMs }),
      state.reserveAgnesAccountRateSlot({ accountId: "account-a", lane: "submit", nowMs, intervalMs }),
    ]);
    expect(reservations.map(({ scheduledAtMs }) => scheduledAtMs).sort((a, b) => a - b)).toEqual([
      1_000,
      32_000,
      63_000,
    ]);

    const status = await state.reserveAgnesAccountRateSlot({
      accountId: "account-a",
      lane: "status",
      nowMs,
      intervalMs,
    });
    const otherAccount = await state.reserveAgnesAccountRateSlot({
      accountId: "account-b",
      lane: "submit",
      nowMs,
      intervalMs,
    });
    expect(status.scheduledAtMs).toBe(nowMs);
    expect(otherAccount.scheduledAtMs).toBe(nowMs);
  });

  it("schedules after a durable cooldown and never lets a stale block shorten it", async () => {
    const state = memoryState();
    await state.blockAgnesAccountRateLane({
      accountId: "account-a",
      lane: "submit",
      blockedUntilMs: 90_000,
      blockReason: "provider retry-after",
      nowMs: 1_000,
    });
    const staleBlock = await state.blockAgnesAccountRateLane({
      accountId: "account-a",
      lane: "submit",
      blockedUntilMs: 50_000,
      blockReason: "stale response",
      nowMs: 2_000,
    });
    expect(staleBlock.blockedUntilMs).toBe(90_000);
    expect(staleBlock.blockReason).toBe("provider retry-after");

    const reservation = await state.reserveAgnesAccountRateSlot({
      accountId: "account-a",
      lane: "submit",
      nowMs: 10_000,
      intervalMs: 31_000,
    });
    expect(reservation.scheduledAtMs).toBe(90_000);
    expect(reservation.nextSlotAtMs).toBe(121_000);
    expect(reservation.blockReason).toBe("provider retry-after");
  });

  it("persists reservation cursors across separate SeriesState lifetimes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agnes-rate-state-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "state.db");
    const firstState = await fileState(databasePath);
    const first = await firstState.reserveAgnesAccountRateSlot({
      accountId: "account-a",
      lane: "status",
      nowMs: 5_000,
      intervalMs: 31_000,
    });
    expect(first.scheduledAtMs).toBe(5_000);
    await firstState.close();
    openStates.splice(openStates.indexOf(firstState), 1);

    const secondState = await fileState(databasePath);
    const second = await secondState.reserveAgnesAccountRateSlot({
      accountId: "account-a",
      lane: "status",
      nowMs: 6_000,
      intervalMs: 31_000,
    });
    expect(second.scheduledAtMs).toBe(36_000);
    expect(await secondState.getAgnesAccountRateState("account-a", "status"))
      .toMatchObject({ nextSlotAtMs: 67_000, blockedUntilMs: 0 });
  });

  it("keeps global scheduler rows when uploaded episode tracking is cleaned", async () => {
    const state = memoryState();
    const seriesId = await state.getOrCreateSeries("Cleanup Stories", [], [], "Formula");
    const client = (state as unknown as {
      client: { execute(statement: string | { sql: string; args: unknown[] }): Promise<unknown> };
    }).client;
    await client.execute({
      sql: `INSERT INTO episodes (
              series_id, episode_number, title, premise, status,
              youtube_video_id, youtube_url, uploaded_at, completed_at
            ) VALUES (?, 1, 'Uploaded', 'Already published.', 'done',
                      'video-1', 'https://youtube.test/video-1',
                      '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')`,
      args: [seriesId],
    });
    await state.reserveAgnesAccountRateSlot({
      accountId: "account-a",
      lane: "submit",
      nowMs: 1_000,
      intervalMs: 31_000,
    });

    await state.cleanupUploadedEpisodeTracking(seriesId, 1);
    expect(await state.getAgnesAccountRateState("account-a", "submit"))
      .toMatchObject({ nextSlotAtMs: 32_000 });
  });
});
