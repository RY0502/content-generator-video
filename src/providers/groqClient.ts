import { CONFIG } from "../config.js";

/**
 * Lightweight Groq API client for text reasoning calls (voice selection, etc.).
 * Uses Groq's OpenAI-compatible chat completions endpoint with a fast text
 * model. This is used specifically for the voice assignment tool's LLM
 * reasoning call instead of routing through OpenRouter.
 */
export async function groqChatText(params: {
  systemPrompt: string;
  userText: string;
}): Promise<string> {
  const apiKey = CONFIG.groqApiKey;
  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY (required for voice selection reasoning via Groq).");
  }

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CONFIG.groqModel,
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userText },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}
