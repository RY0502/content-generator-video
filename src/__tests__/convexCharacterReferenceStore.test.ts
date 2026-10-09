import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildConvexCharacterReferenceObjectKey,
  canonicalCharacterImageName,
  deleteConvexSeriesCharacterReferences,
  downloadConvexCharacterReference,
  uploadConvexCharacterReference,
} from "../providers/convexCharacterReferenceStore.js";

const baseOptions = {
  convexUrl: "https://project.convex.cloud",
  bucket: "character-refs",
  deployKey: "deploy-key-secret",
  objectPrefix: "production/portraits",
};

describe("Convex character-reference storage", () => {
  it("uses stable clear filenames and a series-scoped object path", () => {
    expect(canonicalCharacterImageName("  Bóbó, the Backpack!  ")).toBe("bobo_the_backpack");
    expect(buildConvexCharacterReferenceObjectKey(
      { seriesId: 12, characterName: "Bobo the Backpack" },
      "production/portraits",
    )).toBe("production/portraits/series_12/characters/bobo_the_backpack.png");
  });

  it("treats missing Convex database record as an absent portrait", async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const urlStr = String(input);
      if (urlStr.endsWith("/api/query")) {
        return new Response(JSON.stringify({ status: "success", value: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(downloadConvexCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).resolves.toBeNull();
  });

  it("treats 404 on public URL as an absent portrait", async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const urlStr = String(input);
      if (urlStr.endsWith("/api/query")) {
        return new Response(JSON.stringify({
          status: "success",
          value: {
            storageId: "storage_123",
            url: "https://project.convex.cloud/api/storage/storage_123",
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(downloadConvexCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).resolves.toBeNull();
  });

  it("retries a transient fetch transport failure before classifying absence", async () => {
    const transportError = new TypeError("fetch failed", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    const fetch = vi.fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "success", value: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    await expect(downloadConvexCharacterReference(
      { seriesId: 12, characterName: "Mia" },
      { ...baseOptions, fetch },
    )).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uploads raw bytes with Convex mutations and upload URL then verifies", async () => {
    const bytes = Buffer.from("png-image-bytes");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const publicUrl = "https://project.convex.cloud/api/storage/stored_abc";

    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const urlStr = String(input);
      // 1. files:generateUploadUrl
      if (urlStr.endsWith("/api/mutation")) {
        const body = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown> };
        if (body.path === "files:generateUploadUrl") {
          return new Response(JSON.stringify({
            status: "success",
            value: "https://project.convex.cloud/api/storage/upload?token=xyz",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (body.path === "files:saveFile") {
          return new Response(JSON.stringify({
            status: "success",
            value: {
              storageId: "stored_abc",
              path: body.args.path,
              bucket: body.args.bucket,
              url: publicUrl,
              sha256: expectedSha,
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
      }
      // 2. Upload to upload URL
      if (urlStr.includes("/api/storage/upload")) {
        return new Response(JSON.stringify({ storageId: "stored_abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // 3. Query getFile for download verification
      if (urlStr.endsWith("/api/query")) {
        return new Response(JSON.stringify({
          status: "success",
          value: {
            storageId: "stored_abc",
            url: publicUrl,
            sha256: expectedSha,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // 4. Download file bytes
      if (urlStr.startsWith(publicUrl)) {
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }

      return new Response("not found", { status: 404 });
    });

    const result = await uploadConvexCharacterReference(
      { seriesId: 12, characterName: "Bobo the Backpack" },
      bytes,
      { ...baseOptions, fetch },
    );

    expect(result.sha256).toBe(expectedSha);
    expect(result.publicUrl).toBe(publicUrl);
    expect(result.objectKey).toBe("production/portraits/series_12/characters/bobo_the_backpack.png");
    expect(result.storageId).toBe("stored_abc");
  });

  it("deletes canonical objects for the completed series via Convex mutations", async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.endsWith("/api/mutation")) {
        const body = JSON.parse(String(init?.body)) as { path: string };
        if (body.path === "files:deleteFile") {
          return new Response(JSON.stringify({ status: "success", value: { deleted: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response("not found", { status: 404 });
    });

    const result = await deleteConvexSeriesCharacterReferences({
      seriesId: 12,
      characterNames: ["Mia", "Bobo the Backpack"],
    }, { ...baseOptions, fetch });

    expect(result.deletedObjectKeys).toEqual([
      "production/portraits/series_12/characters/mia.png",
      "production/portraits/series_12/characters/bobo_the_backpack.png",
    ]);
  });
});
