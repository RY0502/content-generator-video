import dotenv from "dotenv";
dotenv.config();

/**
 * Generic utility to query and list stored files in Convex Storage.
 *
 * Usage:
 *   npx tsx scripts/queryConvexFiles.ts [bucket] [pathPrefix]
 *
 * Examples:
 *   npx tsx scripts/queryConvexFiles.ts
 *   npx tsx scripts/queryConvexFiles.ts agnes-character-references series-characters/series_21
 */
async function main() {
  const root = process.env.CONVEX_URL?.replace(/\/+$/gu, "");
  if (!root) {
    throw new Error("CONVEX_URL environment variable is missing.");
  }

  const queryUrl = `${root}/api/query`;
  const deployKey = process.env.CONVEX_DEPLOY_KEY;
  if (!deployKey) {
    throw new Error("CONVEX_DEPLOY_KEY environment variable is missing.");
  }

  const authHeader = (deployKey.startsWith("dev:") || deployKey.startsWith("prod:") || deployKey.includes("|"))
    ? `Convex ${deployKey}`
    : `Bearer ${deployKey}`;

  const bucket = process.argv[2] || process.env.CONVEX_STORAGE_BUCKET || "agnes-character-references";
  const prefix = process.argv[3];

  console.log(`Querying Convex files: bucket="${bucket}", prefix="${prefix || "(all)"}"...`);

  const res = await fetch(queryUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: authHeader,
    },
    body: JSON.stringify({
      path: "files:listFiles",
      args: {
        bucket,
        ...(prefix ? { prefix } : {}),
      },
      format: "json",
    }),
  });

  if (!res.ok) {
    throw new Error(`Convex query failed with HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { status?: string; value?: unknown[]; errorMessage?: string };
  if (data.status === "error") {
    throw new Error(`Convex query error: ${data.errorMessage}`);
  }

  const files = data.value || [];
  console.log(`\nFound ${files.length} stored file(s) in Convex:`);
  for (const f of files as any[]) {
    console.log(`- Path: ${f.path}`);
    console.log(`  Size: ${(f.size / 1024).toFixed(1)} KB | Content-Type: ${f.contentType}`);
    console.log(`  Storage ID: ${f.storageId}`);
    console.log(`  Public URL: ${f.url}`);
    if (f.metadata) console.log(`  Metadata:`, f.metadata);
    console.log();
  }
}

main().catch(console.error);
