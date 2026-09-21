import { createClient } from "@libsql/client";
import dotenv from "dotenv";

dotenv.config();

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const rs = await client.execute({
    sql: "SELECT scene_number, status, provider_task_id, provider_receipt_json FROM agnes_scene_generations WHERE series_id = 16 AND episode_number = 1 ORDER BY scene_number ASC",
    args: [],
  });

  console.log(`Checking ${rs.rows.length} scene generation records in Turso...`);

  const accounts: Record<string, string> = {
    "account-1": process.env.AGNES_API_KEY_1 || process.env.AGNES_API_KEY!,
    "account-2": process.env.AGNES_API_KEY_2!,
    "account-3": process.env.AGNES_API_KEY_3!,
    "account-4": process.env.AGNES_API_KEY_4!,
    "account-5": process.env.AGNES_API_KEY_5!,
  };

  let completedCount = 0;
  let inProgressCount = 0;
  let pendingCount = 0;

  for (const row of rs.rows) {
    const sceneNumber = row.scene_number as number;
    const taskId = row.provider_task_id as string | null;

    if (!taskId) {
      console.log(`Scene ${sceneNumber}: No taskId yet (status=${row.status})`);
      pendingCount++;
      continue;
    }

    let receipt: any = {};
    try {
      receipt = JSON.parse(row.provider_receipt_json as string);
    } catch {}

    const attempts = receipt.attempts ?? [];
    const lastAttempt = attempts[attempts.length - 1];
    const accountId = lastAttempt?.accountId || "account-1";
    const apiKey = accounts[accountId] || accounts["account-1"];

    try {
      const res = await fetch(`https://apihub.agnes-ai.com/v1/videos/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!res.ok) {
        console.log(`Scene ${sceneNumber}: Agnes GET status ${res.status} (${accountId}, taskId=${taskId})`);
        continue;
      }

      const data: any = await res.json();
      console.log(
        `Scene ${sceneNumber}: remoteStatus=${data.status}, progress=${data.progress}%, hasUrl=${Boolean(data.metadata?.url || data.url)} (accountId=${accountId})`
      );

      const videoUrl = data.metadata?.url || data.url;
      if (data.status === "completed" && videoUrl) {
        completedCount++;
        // Update Turso DB if not already marked completed
        if (row.status !== "completed") {
          const keyLabel = lastAttempt.keyLabel || "key-1";
          const keyFingerprint = lastAttempt.keyFingerprint || "0".repeat(64);
          lastAttempt.state = "accepted";
          lastAttempt.task = {
            id: taskId,
            task_id: taskId,
            video_id: taskId,
            model: "agnes-video-2.5-flash",
            status: "completed",
            progress: 100,
            keyLabel,
            keyFingerprint,
            metadata: { url: videoUrl },
            url: videoUrl,
          };
          await client.execute({
            sql: "UPDATE agnes_scene_generations SET status = 'completed', provider_video_url = ?, provider_receipt_json = ?, error = NULL, completed_at = CURRENT_TIMESTAMP WHERE series_id = 16 AND episode_number = 1 AND scene_number = ?",
            args: [videoUrl, JSON.stringify(receipt), sceneNumber],
          });
          console.log(`  -> Updated Scene ${sceneNumber} to status='completed' in Turso DB!`);
        }
      } else {
        inProgressCount++;
      }
    } catch (err: any) {
      console.error(`Scene ${sceneNumber} error:`, err.message);
    }
  }

  console.log("\n=================================");
  console.log(`Summary:`);
  console.log(`  Completed on Agnes: ${completedCount}`);
  console.log(`  Queued/In-Progress: ${inProgressCount}`);
  console.log(`  Pending Submission: ${pendingCount}`);
  console.log("=================================");
}

main().catch(console.error);
