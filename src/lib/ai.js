// Client helper for the AI proxy at /api/claude.
// Works when deployed to Vercel, or locally via `npx vercel dev`.
// Plain `npm run dev` has no /api route, so AI features will show a friendly error.

export async function askClaude({ system, prompt, maxTokens = 800 }) {
  let res;
  try {
    res = await fetch("/api/claude", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      }),
    });
  } catch {
    throw new Error("Couldn't reach the AI endpoint. Are you online?");
  }

  if (res.status === 404) {
    throw new Error("AI features need the API route: deploy to Vercel, or run `npx vercel dev` locally (see README, AI setup).");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `AI request failed (${res.status})`);
  }

  const data = await res.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export async function askClaudeJSON(opts) {
  const text = await askClaude(opts);
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}
