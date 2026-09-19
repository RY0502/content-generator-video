import "dotenv/config";

async function checkRequestyModels() {
  const key = process.env.REQUESTY_API_KEY;
  const res = await fetch("https://router.requesty.ai/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const json = await res.json();
  const models = json.data?.map((m: any) => m.id) || [];
  console.log("Claude models:", models.filter((id: string) => id.includes("claude")));
  console.log("GPT models:", models.filter((id: string) => id.includes("gpt-4") || id.includes("gpt-5")));
  console.log("Gemini models:", models.filter((id: string) => id.includes("gemini")));
}

checkRequestyModels().catch(console.error);
