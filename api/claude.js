// Vercel serverless function: proxies requests to the Anthropic API so the
// API key stays server-side and is never shipped to the browser.
// Set ANTHROPIC_API_KEY in Vercel (Project Settings -> Environment Variables)
// or in your local .env when running `npx vercel dev`.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "POST only" } });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: { message: "ANTHROPIC_API_KEY is not set on the server. See README, AI setup section." } });
  }

  const { system, messages, max_tokens = 800 } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: "messages array required" } });
  }

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: Math.min(Number(max_tokens) || 800, 1500),
        system,
        messages,
      }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: { message: "Upstream request failed: " + e.message } });
  }
}
