import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildSupabaseCharacterReferenceObjectKey,
  canonicalCharacterImageName,
  deleteSupabaseSeriesCharacterReferences,
  downloadSupabaseCharacterReference,
  uploadSupabaseCharacterReference,
} from "../providers/supabaseCharacterReferenceStore.js";

const baseOptions = {
  projectUrl: "https://project.supabase.co",
  bucket: "character-refs",
  serviceRoleKey: "service-role-secret",
  objectPrefix: "production/portraits",
};

describe("Supabase character-reference storage", () => {
  it("uses stable clear filenames and a series-scoped object path", () => {
    expect(canonicalCharacterImageName("  Bóbó, the Backpack!  ")).toBe("bobo_the_backpack");
    expect(buildSupabaseCharacterReferenceObjectKey(
      { seriesId: 12, characterName: "Bobo the Backpack" },
      "production/portraits",
    )).toBe("production/portraits/series_12/characters/bobo_the_backpack.png");
  });

  it("treats definite Supabase missing-object responses as an absent portrait", async () => {
    const fetch = vi.fn(async () => new Response("missing", { status: 404 }));
    await expect(downloadSupabaseCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).resolves.toBeNull();

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      statusCode: "404",
      error: "not_found",
      message: "Object not found",
      code: "NoSuchKey",
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    await expect(downloadSupabaseCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).resolves.toBeNull();

    fetch.mockResolvedValueOnce(new Response("policy denied", { status: 403 }));
    await expect(downloadSupabaseCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).rejects.toThrow("public");

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      statusCode: "404",
      error: "not_found",
      message: "Bucket not found",
      code: "NoSuchBucket",
    }), { status: 400 }));
    await expect(downloadSupabaseCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).rejects.toThrow("public");
  });

  it("retries a transient fetch transport failure before classifying absence", async () => {
    const transportError = new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const fetch = vi.fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));

    await expect(downloadSupabaseCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uploads raw bytes with server credentials then re-downloads and hash-verifies", async () => {
    const bytes = Buffer.from("png-image-bytes");
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Key: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(bytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }));

    const result = await uploadSupabaseCharacterReference(
      { seriesId: 12, characterName: "Bobo the Backpack" },
      bytes,
      { ...baseOptions, fetch },
    );

    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.publicUrl).toContain("bobo_the_backpack.png");
    expect(fetch).toHaveBeenCalledTimes(2);
    const [uploadUrl, init] = fetch.mock.calls[0];
    expect(String(uploadUrl)).toContain("/storage/v1/object/character-refs/");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      apikey: "service-role-secret",
      authorization: "Bearer service-role-secret",
      "x-upsert": "true",
    });
    expect(init.headers).not.toHaveProperty("content-length");
    expect(init.body).toEqual(bytes);
  });

  it("does not retry deterministic Undici request-argument failures", async () => {
    const invalidArgument = new TypeError("fetch failed", {
      cause: Object.assign(new Error("invalid content-length header"), {
        code: "UND_ERR_INVALID_ARG",
      }),
    });
    const fetch = vi.fn().mockRejectedValue(invalidArgument);

    await expect(downloadSupabaseCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).rejects.toThrow("UND_ERR_INVALID_ARG: invalid content-length header");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("deletes only exact canonical objects for the completed series", async () => {
    const fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    const result = await deleteSupabaseSeriesCharacterReferences({
      seriesId: 12,
      characterNames: ["Mia", "Bobo the Backpack"],
    }, { ...baseOptions, fetch });

    expect(result.deletedObjectKeys).toEqual([
      "production/portraits/series_12/characters/mia.png",
      "production/portraits/series_12/characters/bobo_the_backpack.png",
    ]);
    const [, init] = fetch.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ prefixes: result.deletedObjectKeys });
  });
});
