import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAgnesCharacterReferenceImageObjectKey,
  publishAgnesReferenceImage,
} from "../providers/agnesReferenceImagePublisher.js";

describe("Agnes approved-character reference publication", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  it("builds an episode-independent content-addressed character key", () => {
    const key = buildAgnesCharacterReferenceImageObjectKey({
      seriesId: 13,
      characterName: "Bobo the Backpack",
      sha256: "a".repeat(64),
      extension: ".png",
    });
    expect(key).toBe(`series_13/characters/Bobo_the_Backpack_${"a".repeat(64)}.png`);
  });

  it("publishes a local portrait once and verifies its anonymous HTTPS URL", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agnes-character-reference-"));
    temporaryDirectories.push(directory);
    const portraitPath = path.join(directory, "portrait.png");
    await writeFile(portraitPath, Buffer.from("approved portrait bytes"));
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => (
      new Response(null, {
        status: 200,
        headers: init?.method === "HEAD" ? { "content-type": "image/png" } : undefined,
      })
    ));

    const publicUrl = await publishAgnesReferenceImage({
      source: portraitPath,
      seriesId: 13,
      characterName: "Bobo the Backpack",
    }, {
      uploadBaseUrl: "https://upload.example.test/agnes",
      publicBaseUrl: "https://cdn.example.test/agnes",
      bearerToken: "publisher-secret",
      fetch: fetchMock,
    });

    expect(publicUrl).toMatch(
      /^https:\/\/cdn\.example\.test\/agnes\/series_13\/characters\/Bobo_the_Backpack_[a-f0-9]{64}\.png$/u,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0]!;
    expect(String(uploadUrl)).toContain("/series_13/characters/Bobo_the_Backpack_");
    expect(uploadInit).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({
        authorization: "Bearer publisher-secret",
        "content-type": "image/png",
      }),
    });
    const [verificationUrl, verificationInit] = fetchMock.mock.calls[1]!;
    expect(String(verificationUrl)).toBe(publicUrl);
    expect(verificationInit).toMatchObject({ method: "HEAD" });
  });

  it("passes through an existing public HTTPS portrait without publisher credentials", async () => {
    const source = "https://cdn.example.test/portraits/mia.png";
    await expect(publishAgnesReferenceImage({
      source,
      seriesId: 13,
      characterName: "Mia",
    })).resolves.toBe(source);
  });
});
