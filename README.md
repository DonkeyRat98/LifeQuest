# LifeQuest v5 — cloud sync + AI edition

A personal RPG for real life: quests (with tally counters), skills that
feed six D&D-style abilities, milestone challenges, weekly bosses with
optional prerequisites, daily quests with habit cues, streak freezes,
a gold economy with a self-stocked reward shop, achievements, vitals
tracking — plus three AI features powered by the Anthropic API:

- **Sage's Counsel** — a weekly AI reflection on your chronicle (Character tab)
- **Draft objectives with AI** — turn a goal into a ready-made quest (Quest form)
- **Milestone suggestions** — AI-proposed stretch challenges when a skill levels up

Data syncs across devices via Supabase, with a local cache for instant
offline loads.

---

## Part 1 — Supabase (database + accounts, free, ~15 min)

1. Go to https://supabase.com → sign up → **New project**
   (any name, strong database password, closest region)
2. Left sidebar → **SQL Editor** → **New query** → paste the entire
   contents of `supabase-schema.sql` → **Run**
3. Recommended for personal use: **Authentication → Sign In / Up →
   Email** → turn OFF "Confirm email" (lets you sign in instantly)
4. **Project Settings → API** → copy the **Project URL** and the
   **anon public** key
5. In this folder, copy `.env.example` to `.env` and paste both values

## Part 2 — Run it locally

```
npm install
npm run dev
```
Open the printed localhost URL, create an account, play.
(Note: AI features won't work under `npm run dev` — see Part 4.)

## Part 3 — Deploy to Vercel (free)

1. Push this folder to a GitHub repo (github.com → New repository →
   follow the "push an existing folder" commands it shows you)
2. At https://vercel.com → sign up with GitHub → **Add New… → Project**
   → import your repo → Deploy
3. In the Vercel project → **Settings → Environment Variables**, add:
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
   - `ANTHROPIC_API_KEY` = your Anthropic key (see Part 4)
4. **Deployments → Redeploy** so the variables take effect
5. iPhone: open your live URL in Safari → Share → **Add to Home Screen**

Every future `git push` redeploys automatically.

## Part 4 — Anthropic API (the AI features, ~10 min)

Never used an LLM API before? It works like this: you create an
account, add a small amount of prepaid credit, and generate a secret
key. Your app's server (the file `api/claude.js`) sends requests to
Anthropic with that key attached, and gets Claude's replies back.
The key must stay server-side — that's why this project routes AI
calls through a Vercel serverless function instead of the browser.

1. Go to https://console.anthropic.com and sign up
2. Add billing credit (Settings → Billing) — $5 is plenty to start;
   this app's usage is literally pennies per month for one person
3. Go to **API Keys** → **Create Key** → copy it
   (it starts with `sk-ant-` — treat it like a password)
4. In Vercel: **Settings → Environment Variables** →
   add `ANTHROPIC_API_KEY` with your key → Redeploy
5. Done — the Sage, quest drafting, and milestone suggestions now work
   on your deployed site

**To test AI locally:** add `ANTHROPIC_API_KEY=sk-ant-...` as a line in
your `.env`, then run `npx vercel dev` instead of `npm run dev`
(first run will ask you to log in and link the project — accept the
defaults). `vercel dev` serves both the app and the `/api` route.

⚠️ Never prefix the Anthropic key with `VITE_` — VITE_-prefixed
variables are bundled into the public browser code.

**Official docs if you want to go deeper:**
- Get started with the API: https://docs.anthropic.com/en/api/messages
- Full platform docs: https://platform.claude.com/docs

## Costs at a glance

| Thing | Cost |
|---|---|
| Supabase (free tier) | $0 |
| Vercel (hobby tier) | $0 |
| Anthropic API | pay-per-use; weekly reflections + occasional drafting ≈ well under $1/month |
| Custom domain (optional) | ~$10–15/year |

## Notes

- The Supabase anon key is safe in the browser; row-level security
  keeps each account's save private. The Anthropic key is NOT safe in
  the browser, which is why it lives only in `api/claude.js`'s env.
- One JSON save blob per user in the `saves` table; sign in anywhere
  to pull the same character.
- The AI model is set in `api/claude.js` (`claude-sonnet-4-6`); swap in
  a Haiku model string for even cheaper calls.
