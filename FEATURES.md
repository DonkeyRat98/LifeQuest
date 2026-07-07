# LifeQuest — Feature Reference

LifeQuest is a personal RPG for real life: a single-user React app where real-world
effort earns XP, levels, gold, and titles. This document is the authoritative
description of every feature and game rule. It has two jobs:

1. **Feature tracking** — update this file whenever a feature is added, changed, or
   removed (see the changelog at the bottom).
2. **AI context** — paste this file to Claude (or another model) when brainstorming
   new quests, skills, vitals, rewards, or mechanics, so suggestions fit the app's
   actual systems and design philosophy.

Tech shape: one React file (`src/App.jsx`), Supabase for auth + a single JSONB save
per user, localStorage cache for offline, AI calls proxied through `api/claude.js`.
All numbers below are the live tuning values.

---

## Design philosophy

Every mechanic is chosen from behavior-change research, and the tone is deliberately
gentle — the app rewards showing up, never punishes falling short:

- **Behavior over outcome.** XP is earned by doing things (practice, quest steps,
  dailies). Outcome goals exist only as calm, informational Vitals targets with no
  XP, scoring, or success/fail language attached.
- **Intrinsic motivation is protected.** Anything flagged as a Passion (♥) earns XP
  but never gold, so loved activities don't turn into paid work (overjustification
  effect). Surprise gold drops are random and unannounced — unexpected rewards are
  the safe kind.
- **Implementation intentions & coping plans.** Dailies carry a when/where cue
  ("After X, I'll Y") and both dailies and quests carry an optional coping plan
  ("If [obstacle], then I'll [response]") — the two best-supported habit techniques.
- **The control-theory loop.** Set goals → get feedback → *revisit the goals
  themselves*: a monthly Goal Review resurfaces every active quest for
  keep/revise/retire.
- **Gentle loss aversion.** Streaks build a multiplier; streak freezes (earned, not
  bought) quietly absorb a single missed day. Nothing shames a broken streak.
- **A difficulty ratchet.** Skill milestones at set levels demand a self-authored
  stretch challenge — routine practice stops counting as growth.
- **Friction where it helps.** Editing a committed quest first asks whether the goal
  genuinely evolved or just got hard.

---

## Core progression

### Player
- **XP → Level:** level L is reached at cumulative XP = 50·L·(L+1). (Level 2 at
  100 XP, level 3 at 300, level 5 at 1,500…)
- **Titles by level:** Fledgling, Wanderer, Adventurer, Journeyman, Veteran,
  Champion, Hero, Mythmaker, Legend, Ascendant (level 10+ holds Ascendant).
- **Gold:** every non-passion XP grant pays `max(1, round(XP/10))` gold. Spent in
  the Reward Shop. Shown as a purse in the top-left corner.
- **Surprise drops:** every XP grant has a 15% chance of +5–25 bonus gold,
  regardless of passion status.
- **Streak:** any XP-earning action counts as activity for the day. Consecutive
  active days build the streak; at 7+ days all XP is multiplied ×1.25.
- **Streak freezes:** earned automatically every 14 streak days (max 2 held). If a
  single day is missed, a freeze melts silently and the streak survives. Two missed
  days resets to 1.

### Attributes (internally `abilities`)
Six D&D-style attributes: INT, WIS, STR, CON, DEX, CHA.
- Level curve: 40·L·(L+1) cumulative XP.
- Attributes can never be trained directly — they rise only through linked skills:
  a skill's **primary** attribute receives 50% of all skill XP, the **secondary**
  25%. Each skill links up to two attributes.
- Displayed as a 6-card grid on the Character tab with level and progress bar.

### Skills
Two kinds, shown in separate sections on the Skills tab:
- **Disciplines** — practiced directly. Three practice buttons per card:
  Trained +10 XP, Deep practice +25, Breakthrough +50. Quests can also feed them.
- **Domains** — higher-level fields (e.g. Entrepreneurship, Naturalist). No
  practice buttons; they level **only** when a quest feeds them. The card shows
  "Fed by: [active quest titles]" or "Not yet fed by any quest."

Shared skill mechanics:
- Level curve: 30·L·(L+1) cumulative XP.
- Kind is chosen at forge time (Discipline/Domain toggle). Existing saves migrate
  to Discipline.
- Passion flag (♥): XP but no gold from this skill's activity.
- Long-horizon view: total session count (Disciplines) or quest-feed count
  (Domains), an 8-week activity histogram, and "training/growing since" date.
  Last 120 log entries retained.
- **Milestones:** at skill levels 3, 5, 8, 12, 16, 20, 25, 30 a milestone unlocks —
  the user writes (or asks AI to suggest) a concrete stretch challenge, completable
  in a few weeks. Conquering it awards 30 + 10·level XP into the skill. Applies to
  both kinds.

---

## Quests tab

### Daily Quests
Habits that reset at midnight. Each daily has:
- Name, XP value (default 15, min 5), passion flag.
- **Cue** (optional): when/where implementation intention, shown in italics.
- **Coping plan** (optional): "If I get stuck… / then I'll…" pair, shown as
  "⛨ If [obstacle] → [response]".
- One completion per day (checkbox); progress count in the section header.

### Weekly Boss
One hard thing to slay per week (Monday-to-Sunday week).
- Custom XP reward (default 250, min 50) plus a gold purse of XP/5 on defeat.
- Optional **Rite**: a prerequisite rep counter (e.g. "Submit application ×3",
  +10 XP per rep) that wards the boss — the killing blow is locked until the rite
  is complete.
- An undefeated boss escapes when the week rolls over (chronicle note, no penalty).
  A new boss can be summoned each Monday.

### Quest Log
Project-scale goals, grouped under tier headings (empty tiers hidden):
- **Epic Quests** (violet) — months of scope, +400 XP completion bonus.
- **Main Quests** (gold) — weeks, +150 XP.
- **Side Quests** (moss) — days, +50 XP.

Each quest has:
- Title, tier, passion flag, optional coping plan, creation date.
- **Objectives (subtasks):** either ✓ one-time checks (with individual XP) or
  № running tallies (repeatable, +XP each). A quest with zero check-objectives is
  "open-ended" and can be completed any time.
- **Feeds a skill** (optional): all XP from this quest (objectives and completion
  bonus) is also applied to one chosen skill — Discipline or Domain — cascading
  into its linked attributes. This is the only way Domains grow.
- **Claim:** when all checks are done (or none exist) the completion bonus can be
  claimed; the quest moves to the Chronicle.
- **Edit:** posted quests can be edited (title, objective text/XP, add/delete
  objectives — always at least one) behind a confirmation modal: *"Are you changing
  it because the goal genuinely evolved, or because it got hard? Only proceed if
  it's the former."* Existing objectives keep their done/tally state; only newly
  added rows can pick their type.
- **Abandon:** removes the quest without penalty.
- **New-quest form:** tier picker, objective rows (deletable down to one), coping
  plan fields, skill picker, passion toggle, and **AI drafting** — type a goal (and
  optional context notes) and the AI proposes a tier plus 3–6 concrete objectives
  with XP values.

### Goal Review (monthly)
When 30+ days have passed since the last review (or since the oldest quest was
posted, if never reviewed), a banner appears: *"⚖ The council convenes."*
- Steps through each active quest one at a time showing tier, age, and progress,
  with three choices: **Keep** (move on), **Revise** (inline title/tier edit), or
  **Retire** (remove; chronicle note — framed as "a victory of judgment, not a
  defeat").
- Finishing grants +30 XP and logs a chronicle entry. Can be paused mid-review or
  dismissed for the session ("Later").

---

## Vitals tab (trackers)

Numeric self-measurements, each with a name, unit, and **metric type** chosen at
creation:

- **Simple** — observe only: latest value, change since first entry, sparkline of
  the last 20 entries.
- **Target value** (e.g. Weight) — a goal value to reach and hold. Shows latest
  value, "Target X · currently Y away", and a dashed reference line at the target
  on the chart. Purely informational: no progress bar, no scoring, no success/fail
  language, no XP.
- **Nightly target** (e.g. Sleep) — a per-entry target where the average matters
  more than any single log. The **7-day rolling average is the headline number**,
  with a 30-day average, the target, and the last entry beneath, plus the dashed
  reference line.

Mechanics: one value logged at a time (multiple per day allowed), last 120 entries
kept, target editable via a "change target" link on target/nightly cards.
Logging Vitals earns no XP or gold by design.

---

## Reward Shop

- User stocks the shop with real-life treats, each priced in gold ("priced by how
  much they should cost you in effort").
- Redeeming deducts gold, logs a chronicle entry, and the rule is: actually do the
  treat in real life.
- Gold sources: non-passion XP grants (XP/10), boss purses (XP/5), surprise drops.

---

## Achievements (22)

Unlocked automatically, shown as a badge grid on the Character tab.

| Badge | Requirement |
|---|---|
| First Steps | Earn your first XP |
| Quest Rookie / Seasoned Adventurer / Guildmaster | Complete 1 / 5 / 15 quests |
| Kindled / Week of Fire / Eternal Flame | 3 / 7 / 30-day streak |
| Rising Star / Heroic | Player level 5 / 10 |
| Adept / Master | Any skill level 5 / 10 |
| Summit / Peak Chaser | Conquer 1 / 5 milestones |
| Paragon | Any attribute to level 5 |
| Well-Rounded | All attributes level 2+ |
| Boss Slayer / Raid Leader | Defeat 1 / 5 weekly bosses |
| Thousand Deeds | 1,000 total XP |
| Know Thyself | 10 tracker entries logged |
| Strategist | Complete a goal review |
| Treat Yourself | Redeem a reward |
| Dragon's Hoard | Hold 500 gold at once |

---

## Chronicle tab

The permanent record (last 300 entries). Sections: Bosses Slain, Milestones
Conquered, Completed Quests, then the full feed. Entry types: `xp` (any grant),
`quest`, `boss`, `milestone`, `levelup`, `achievement`, `purchase`, `review`,
`note` (freezes, escapes, retirements). Each shows date, text, and XP/gold deltas.

---

## The Sage & AI features

All AI calls go through the `/api/claude` proxy (`src/lib/ai.js`).

- **Sage's Counsel** (Character tab): on demand — intended weekly — the Sage reads
  the last 7 days of chronicle plus skill/quest/vitals summaries and writes a
  120–170-word second-person reflection: one observed pattern, one thing working,
  one gentle nudge, one suggested focus. Last 8 reflections kept.
- **Quest drafting** (new-quest form): goal + optional context notes → suggested
  tier and 3–6 verifiable objectives with XP, calibrated to the user's situation.
- **Milestone suggestions** (skill card): proposes 3 concrete stretch challenges
  scaled to the skill's level and recent practice quality.

---

## Persistence & data model

- Supabase table `saves`: one row per user (`user_id`, JSONB `data`,
  `updated_at`), row-level security. Email/password auth.
- Saves are debounced (600 ms) to the cloud and mirrored to a localStorage cache;
  the app works offline and shows a sync indicator (synced / saving / offline).
- A `migrate()` function backfills defaults for every new field, so old saves
  never break. **Any new feature must add its defaults there.**
- **Reset character:** a link on the Character tab (below Sign out) opens a
  confirmation modal warning that everything is permanently erased with no backup;
  confirming overwrites the save with a fresh `seedState()`, which the normal
  autosave then persists to both cloud and cache. This is the sanctioned way to
  start over (the client has no delete permission by design).

State shape (top level):

```
player      { name, xp, gold, streak, lastActive, freezes }
abilities   { int, wis, str, con, dex, cha }           // XP totals ("Attributes" in UI)
quests      [{ id, title, tier, skillId, passion, copingIf, copingThen, createdAt,
               subtasks: [{ id, text, xp, type: "check"|"tally", done, count }] }]
dailies     [{ id, name, xp, lastDone, cue, copingIf, copingThen, passion }]
boss        null | { id, name, xp, weekId, defeated, req: null|{ name, target, count } }
skills      [{ id, name, xp, kind: "discipline"|"domain", abilities: [primary, secondary?],
               logs: [{ date, xp, label }], passion, totalSessions,
               milestone: null|{ level, text }, lastMilestoneLevel }]
trackers    [{ id, name, unit, metricType: "simple"|"target"|"nightly",
               target: number|null, entries: [{ date, value }] }]
rewards     [{ id, name, cost }]
reflections [{ id, date, text }]
chronicle   [{ id, date, text, xp, gold?, type }]
achievements [ids]
lastGoalReview  "YYYY-MM-DD" | null
```

---

## Prompting Claude with this document

When using this file to generate content ideas, useful framings:

- **Quests:** propose title, tier (side/main/epic by scope), 3–6 concrete
  verifiable objectives (check vs tally) with XP 10–100 by effort, an optional
  coping plan, and which skill it should feed. Passion flag if it's a love-not-duty.
- **Skills:** decide Discipline (practiceable) vs Domain (quest-fed field), which
  one or two attributes it feeds, and whether it's a passion.
- **Vitals:** pick the metric type — simple (observe), target value (reach and
  hold), nightly target (average matters) — and a sensible unit and target.
- **Milestones:** concrete, verifiable, a genuine stretch at the given level,
  completable within a few weeks, under 70 characters.
- **Rewards:** real-life treats priced in gold relative to earning rates (~10–40g
  per active day is typical early on).
- Respect the tone: encouraging, never punitive; behavior-first; outcome goals
  stay informational.

---

## Feature changelog

Update this table with each feature commit.

| Date | Commit | Changes |
|---|---|---|
| 2026-07-07 | `HEAD` | Added "Reset character" button on the Character tab — confirmation modal warning of permanent erasure, then overwrites the save with a fresh `seedState()`. |
| 2026-07-07 | `0d14af8` | "Abilities" renamed to "Attributes" (display only). Skills split into Disciplines and Domains (quest-fed, "Fed by" line). Quest objectives deletable in form; posted quests editable behind a "did the goal genuinely change?" modal. Quest Log grouped by tier headings. Vitals metric types (simple / target value / nightly target) with dashed reference lines and 7/30-day rolling averages; replaced v1 outcome-target progress bar, reach detection, and Trueshot achievement with purely informational display. |
| 2026-07-06 | `cb068da` | Coping plans ("If I get stuck… / then I'll…") on dailies and quests. Monthly Goal Review (keep/revise/retire, +30 XP, Strategist achievement). Vitals outcome targets v1 (progress bar + reach detection — superseded next commit). |
| 2026-07-06 | `5ff1953` | Notes box on AI quest drafting for user context. |
| 2026-07-06 | `3054010` | Initial release: player XP/levels/titles/gold, streaks + freezes, attributes, skills with practice/milestones/passion, quests with tiers/objectives/AI drafting, dailies with cues, weekly boss with rites, vitals trackers, reward shop, achievements, chronicle, Sage reflections, Supabase sync. |
