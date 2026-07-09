import React, { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./lib/supabase.js";
import { askClaude, askClaudeJSON } from "./lib/ai.js";

/* ── LifeQuest — a personal RPG for real life ─────────────────────────
   v5 — research-backed edition:
   · Passion flag (♥): skills/quests/dailies you love earn XP but no
     gold, protecting intrinsic motivation (overjustification effect)
   · Surprise gold drops: unexpected variable rewards are the safe kind
   · Streak freezes: gentle loss-aversion, earned every 14-day streak
   · Cue fields on dailies: implementation intentions ("After X, I Y")
   · Milestone challenges: self-authored stretch goals at skill levels
     3/5/8/12/16/20 — the difficulty ratchet that sustains mastery
   · Long-horizon skill view: total sessions + 8-week training chart
   · AI (via /api/claude proxy): weekly reflection, quest drafting,
     milestone suggestions                                            */

/* Candlelit scriptorium — warm ink, vellum, candle gold, oxblood, verdigris */
const C = {
  bg: "#1A1310",
  surface: "#241A13",
  surface2: "#2E2218",
  parchment: "#EFE0C5",
  dim: "#A08D72",
  gold: "#D9A45B",
  arcane: "#6FA79A",
  ember: "#B04A3A",
  moss: "#8A9A5B",
  line: "#3A2C21",
};

const ABILITIES = [
  { id: "int", abbr: "INT", name: "Intelligence" },
  { id: "wis", abbr: "WIS", name: "Wisdom" },
  { id: "str", abbr: "STR", name: "Strength" },
  { id: "con", abbr: "CON", name: "Constitution" },
  { id: "dex", abbr: "DEX", name: "Dexterity" },
  { id: "cha", abbr: "CHA", name: "Charisma" },
];
const PRIMARY_SHARE = 0.5;
const SECONDARY_SHARE = 0.25;
const STREAK_MULT_AT = 7;
const STREAK_MULT = 1.25;
const REQ_REP_XP = 10;
const SURPRISE_CHANCE = 0.15;              // unexpected drops sidestep overjustification
const MILESTONE_LEVELS = [3, 5, 8, 12, 16, 20, 25, 30];
const FREEZE_EVERY = 14;                   // earn a streak freeze each 14-day streak
const MAX_FREEZES = 2;

const TIERS = {
  side: { label: "Side Quest", color: C.moss, bonus: 50 },
  main: { label: "Main Quest", color: C.gold, bonus: 150 },
  epic: { label: "Epic Quest", color: C.arcane, bonus: 400 },
};

const PRACTICE = [
  { label: "Trained", xp: 10 },
  { label: "Deep practice", xp: 25 },
  { label: "Breakthrough", xp: 50 },
];

const TITLES = [
  "Fledgling", "Wanderer", "Adventurer", "Journeyman", "Veteran",
  "Champion", "Hero", "Mythmaker", "Legend", "Ascendant",
];

/* level curves (cumulative XP to reach level L) */
const playerLevel = (xp) => { let l = 1; while (50 * l * (l + 1) <= xp) l++; return l; };
const playerFloor = (l) => 50 * (l - 1) * l;
const playerCeil = (l) => 50 * l * (l + 1);

const skillLevel = (xp) => { let l = 1; while (30 * l * (l + 1) <= xp) l++; return l; };
const skillFloor = (l) => 30 * (l - 1) * l;
const skillCeil = (l) => 30 * l * (l + 1);

const abilityLevel = (xp) => { let l = 1; while (40 * l * (l + 1) <= xp) l++; return l; };
const abilityFloor = (l) => 40 * (l - 1) * l;
const abilityCeil = (l) => 40 * l * (l + 1);

const milestoneReward = (level) => 30 + 10 * level;
const nextMilestoneLevel = (sk) =>
  MILESTONE_LEVELS.find((l) => l > (sk.lastMilestoneLevel || 0) && skillLevel(sk.xp) >= l) || null;

const uid = () => Math.random().toString(36).slice(2, 10);
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgoStr = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const weekId = () => {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
};
const prevWeekId = () => {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day - 7);
  return d.toISOString().slice(0, 10);
};
const fmtDate = (iso) => {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

/* coping plan ("If [obstacle], then [response]") display line.
   Strips a leading "if" the user may have typed, so we don't render "If If…" */
const copingLine = (o) => {
  const cIf = (o.copingIf || "").replace(/^if\s+/i, "");
  const cThen = (o.copingThen || "").replace(/^then\s+/i, "");
  return cIf && cThen ? `If ${cIf} → then ${cThen}`
    : cIf ? `If ${cIf}…`
    : cThen ? `If stuck → then ${cThen}`
    : null;
};

/* campaign progress rolls up: subtask → task → milestone → campaign */
const taskDone = (t) => (t.subtasks && t.subtasks.length ? t.subtasks.every((s) => s.done) : !!t.done);
const milestoneFrac = (m) =>
  m.claimedAt ? 1 : m.tasks.length ? m.tasks.filter(taskDone).length / m.tasks.length : 0;
const campaignFrac = (c) =>
  c.milestones.length ? c.milestones.reduce((a, m) => a + milestoneFrac(m), 0) / c.milestones.length : 0;

/* goal review is due monthly once the board has quests old enough to drift */
const REVIEW_EVERY_DAYS = 30;
const REVIEW_XP = 30;
const reviewDue = (s) =>
  s.quests.length > 0 &&
  (s.lastGoalReview
    ? s.lastGoalReview <= daysAgoStr(REVIEW_EVERY_DAYS)
    : s.quests.some((q) => q.createdAt && q.createdAt <= daysAgoStr(REVIEW_EVERY_DAYS)));

/* ── Achievements ── */
const countType = (s, type) => s.chronicle.filter((e) => e.type === type).length;
const ACHIEVEMENTS = [
  { id: "first-steps", icon: "☄", name: "First Steps", desc: "Earn your first XP", check: (s) => s.player.xp > 0 },
  { id: "quest-1", icon: "⚑", name: "Quest Rookie", desc: "Complete a quest", check: (s) => countType(s, "quest") >= 1 },
  { id: "quest-5", icon: "⚔", name: "Seasoned Adventurer", desc: "Complete 5 quests", check: (s) => countType(s, "quest") >= 5 },
  { id: "quest-15", icon: "♛", name: "Guildmaster", desc: "Complete 15 quests", check: (s) => countType(s, "quest") >= 15 },
  { id: "streak-3", icon: "🕯", name: "Kindled", desc: "3-day streak", check: (s) => s.player.streak >= 3 },
  { id: "streak-7", icon: "🔥", name: "Week of Fire", desc: "7-day streak", check: (s) => s.player.streak >= 7 },
  { id: "streak-30", icon: "☀", name: "Eternal Flame", desc: "30-day streak", check: (s) => s.player.streak >= 30 },
  { id: "level-5", icon: "✧", name: "Rising Star", desc: "Reach Level 5", check: (s) => playerLevel(s.player.xp) >= 5 },
  { id: "level-10", icon: "✦", name: "Heroic", desc: "Reach Level 10", check: (s) => playerLevel(s.player.xp) >= 10 },
  { id: "skill-5", icon: "❖", name: "Adept", desc: "Any skill to Level 5", check: (s) => s.skills.some((k) => skillLevel(k.xp) >= 5) },
  { id: "skill-10", icon: "◆", name: "Master", desc: "Any skill to Level 10", check: (s) => s.skills.some((k) => skillLevel(k.xp) >= 10) },
  { id: "milestone-1", icon: "▲", name: "Summit", desc: "Conquer a milestone", check: (s) => countType(s, "milestone") >= 1 },
  { id: "milestone-5", icon: "⛰", name: "Peak Chaser", desc: "Conquer 5 milestones", check: (s) => countType(s, "milestone") >= 5 },
  { id: "ability-para", icon: "⬢", name: "Paragon", desc: "Any attribute to Level 5", check: (s) => ABILITIES.some((a) => abilityLevel(s.abilities[a.id] || 0) >= 5) },
  { id: "ability-round", icon: "⬡", name: "Well-Rounded", desc: "All attributes Level 2+", check: (s) => ABILITIES.every((a) => abilityLevel(s.abilities[a.id] || 0) >= 2) },
  { id: "boss-1", icon: "☠", name: "Boss Slayer", desc: "Defeat a weekly boss", check: (s) => countType(s, "boss") >= 1 },
  { id: "boss-5", icon: "🜏", name: "Raid Leader", desc: "Defeat 5 weekly bosses", check: (s) => countType(s, "boss") >= 5 },
  { id: "xp-1000", icon: "❂", name: "Thousand Deeds", desc: "Earn 1,000 total XP", check: (s) => s.player.xp >= 1000 },
  { id: "vitals-10", icon: "♥", name: "Know Thyself", desc: "Log 10 tracker entries", check: (s) => s.trackers.reduce((n, t) => n + t.entries.length, 0) >= 10 },
  { id: "review-1", icon: "⚖", name: "Strategist", desc: "Complete a goal review", check: (s) => countType(s, "review") >= 1 },
  { id: "weekly-4", icon: "✶", name: "Steadfast", desc: "Hold a 4-week quota streak", check: (s) => (s.weeklies || []).some((w) => w.streak >= 4) },
  { id: "shop-1", icon: "⚜", name: "Treat Yourself", desc: "Redeem a reward", check: (s) => countType(s, "purchase") >= 1 },
  { id: "gold-500", icon: "♚", name: "Dragon's Hoard", desc: "Hold 500 gold at once", check: (s) => (s.player.gold || 0) >= 500 },
];

const zeroAbilities = () => ({ int: 0, wis: 0, str: 0, con: 0, dex: 0, cha: 0 });

const seedState = () => ({
  player: { name: "Adventurer", xp: 0, gold: 0, streak: 0, lastActive: null, freezes: 0 },
  abilities: zeroAbilities(),
  quests: [
    {
      id: uid(),
      title: "Learn Guitar",
      tier: "main",
      skillIds: [],
      passion: true,
      subtasks: [
        { id: uid(), text: "Learn basic open chords", xp: 30, type: "check", done: false },
        { id: uid(), text: "Practice 5 days in one week", xp: 40, type: "check", done: false },
        { id: uid(), text: "Play a full song start to finish", xp: 60, type: "check", done: false },
        { id: uid(), text: "Master a song from memory", xp: 100, type: "check", done: false },
      ],
      createdAt: todayStr(),
    },
    {
      id: uid(),
      title: "Land the Next Role",
      tier: "epic",
      skillIds: [],
      passion: false,
      subtasks: [
        { id: uid(), text: "Application submitted", xp: 10, type: "tally", count: 0 },
        { id: uid(), text: "Interview completed", xp: 40, type: "tally", count: 0 },
      ],
      createdAt: todayStr(),
    },
  ],
  dailies: [{ id: uid(), name: "Practice guitar", xp: 15, lastDone: null, cue: "After dinner, 15 minutes", copingIf: "I'm too tired after dinner", copingThen: "play one song, badly", passion: true, skillIds: [] }],
  weeklies: [],
  campaigns: [],
  boss: null,
  achievements: [],
  skills: [{ id: uid(), name: "Guitar", xp: 0, kind: "discipline", abilities: ["dex"], logs: [], passion: true, totalSessions: 0, milestone: null, lastMilestoneLevel: 0 }],
  trackers: [{ id: uid(), name: "Weight", unit: "lbs", entries: [], metricType: "simple", target: null }],
  rewards: [
    { id: uid(), name: "Fancy coffee", cost: 50 },
    { id: uid(), name: "New game or gear", cost: 800 },
  ],
  reflections: [],
  chronicle: [],
  lastGoalReview: null,
});

const migrate = (s) => ({
  ...seedState(),
  ...s,
  player: { gold: 0, freezes: 0, ...(s.player || {}) },
  abilities: { ...zeroAbilities(), ...(s.abilities || {}) },
  quests: (s.quests || []).map((q) => ({
    passion: false,
    copingIf: "",
    copingThen: "",
    ...q,
    skillIds: q.skillIds || (q.skillId ? [q.skillId] : []),
    subtasks: (q.subtasks || []).map((st) => ({ type: "check", count: 0, ...st })),
  })),
  dailies: (s.dailies || []).map((d) => ({ cue: "", passion: false, copingIf: "", copingThen: "", skillIds: [], ...d })),
  weeklies: (s.weeklies || []).map((w) => ({ skillIds: [], copingIf: "", copingThen: "", campaignId: null, ...w })),
  campaigns: (s.campaigns || []).map((c) => ({
    sequential: false,
    ...c,
    milestones: (c.milestones || []).map((m) => ({
      xp: 100,
      claimedAt: null,
      ...m,
      tasks: (m.tasks || []).map((t) => ({
        done: false,
        ...t,
        subtasks: (t.subtasks || []).map((st) => ({ done: false, ...st })),
      })),
    })),
  })),
  boss: s.boss ? { req: null, ...s.boss } : null,
  achievements: s.achievements || [],
  skills: (s.skills || []).map((k) => ({
    passion: false,
    milestone: null,
    lastMilestoneLevel: 0,
    kind: "discipline",
    ...k,
    abilities: k.abilities || [],
    totalSessions: k.totalSessions ?? (k.logs || []).length,
  })),
  /* trackers: legacy object targets ({value, reachedAt, …}) fold into metricType "target" + plain number */
  trackers: (s.trackers || []).map((t) => {
    const legacy = t.target && typeof t.target === "object";
    return {
      metricType: legacy ? "target" : "simple",
      ...t,
      target: legacy ? t.target.value : (typeof t.target === "number" ? t.target : null),
      entries: t.entries || [],
    };
  }),
  rewards: s.rewards || [],
  reflections: s.reflections || [],
  chronicle: s.chronicle || [],
  lastGoalReview: s.lastGoalReview || null,
});

/* apply XP to a skill and cascade shares into its linked abilities */
function applySkillGain(s, skillId, xp, label, countSession = true) {
  const sk = s.skills.find((k) => k.id === skillId);
  if (!sk) return s;
  const abilities = { ...s.abilities };
  const chron = [...s.chronicle];
  (sk.abilities || []).forEach((aid, i) => {
    const share = i === 0 ? PRIMARY_SHARE : SECONDARY_SHARE;
    const gain = Math.round(xp * share);
    const before = abilityLevel(abilities[aid] || 0);
    abilities[aid] = (abilities[aid] || 0) + gain;
    const after = abilityLevel(abilities[aid]);
    if (after > before) {
      const ab = ABILITIES.find((a) => a.id === aid);
      chron.unshift({ id: uid(), date: todayStr(), text: `${ab.name} rose to Level ${after}`, xp: 0, type: "levelup" });
    }
  });
  return {
    ...s,
    abilities,
    chronicle: chron,
    skills: s.skills.map((k) => k.id !== skillId ? k : {
      ...k,
      xp: k.xp + xp,
      totalSessions: (k.totalSessions || 0) + (countSession ? 1 : 0),
      logs: [{ date: todayStr(), xp, label }, ...k.logs].slice(0, 120),
    }),
  };
}

/* shared daily/weekly completion — used by the Quests tab and campaign Commitments */
function completeDaily(setState, grantXp, d) {
  const today = todayStr();
  if (d.lastDone === today) return;
  setState((s) => {
    let next = { ...s, dailies: s.dailies.map((x) => (x.id === d.id ? { ...x, lastDone: today } : x)) };
    (d.skillIds || []).forEach((sid) => { next = applySkillGain(next, sid, d.xp, "Daily", true); });
    return next;
  });
  grantXp(d.xp, `Daily: ${d.name}`, { noGold: d.passion });
}

function weeklyRep(setState, grantXp, w) {
  const newCount = w.count + 1;
  const reached = newCount === w.target;
  setState((s) => {
    let next = {
      ...s,
      weeklies: s.weeklies.map((x) => (x.id !== w.id ? x : { ...x, count: newCount, streak: reached ? x.streak + 1 : x.streak })),
    };
    (w.skillIds || []).forEach((sid) => { next = applySkillGain(next, sid, w.xp, "Weekly", false); });
    return next;
  });
  grantXp(
    reached ? w.xp * 3 : w.xp,
    reached ? `Weekly target met: ${w.name} (${newCount}/${w.target}) — ${w.streak + 1} wk streak` : `Weekly: ${w.name} (${newCount}/${w.target})`,
    { noGold: w.passion }
  );
}

/* ── persistence: Supabase + local cache ── */
const cacheKey = (userId) => `lifequest-cache-${userId}`;

const readCache = (userId) => {
  try {
    const v = localStorage.getItem(cacheKey(userId));
    return v ? migrate(JSON.parse(v)) : null;
  } catch { return null; }
};

const writeCache = (userId, state) => {
  try { localStorage.setItem(cacheKey(userId), JSON.stringify(state)); } catch { /* ignore */ }
};

async function loadCloud(userId) {
  const { data, error } = await supabase
    .from("saves")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ? migrate(data.data) : null;
}

async function saveCloud(userId, state) {
  const { error } = await supabase
    .from("saves")
    .upsert({ user_id: userId, data: state, updated_at: new Date().toISOString() });
  if (error) throw error;
}

/* ── root: auth gate ── */
export default function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!supabase) {
    return (
      <Shell center>
        <div style={{ maxWidth: 420, textAlign: "center", padding: 24 }}>
          <div className="display" style={{ fontSize: 20, color: C.gold, fontWeight: 700 }}>Setup needed</div>
          <p style={{ color: C.dim, fontSize: 14, lineHeight: 1.6 }}>
            Add your Supabase URL and anon key to a <code>.env</code> file (see <code>.env.example</code>), then restart the dev server.
          </p>
        </div>
      </Shell>
    );
  }

  if (session === undefined) {
    return <Shell center><div style={{ color: C.dim }}>Opening the tome…</div></Shell>;
  }

  if (!session) return <AuthScreen />;

  return <LifeQuest userId={session.user.id} onSignOut={() => supabase.auth.signOut()} />;
}

const Shell = ({ children, center }) => (
  <div style={{ minHeight: "100vh", background: C.bg, color: C.parchment, fontFamily: "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif", ...(center ? { display: "flex", alignItems: "center", justifyContent: "center" } : {}) }}>
    <GlobalStyle />
    {children}
  </div>
);

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=IM+Fell+English:ital@0;1&display=swap');
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    body { margin: 0; background: ${C.bg}; }
    body::after {
      content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 1; opacity: .09;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
    }
    body::before {
      content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 1;
      background: radial-gradient(ellipse 120% 90% at 50% 28%, transparent 42%, rgba(8,5,3,.42) 100%);
    }
    input, button, textarea { font-family: inherit; }
    input:focus, button:focus-visible, textarea:focus { outline: 2px solid ${C.gold}; outline-offset: 1px; }
    button { cursor: pointer; }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes glowpulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
    .display { font-family: 'IM Fell English', 'Palatino Linotype', Palatino, serif; letter-spacing: .02em; }
    ::placeholder { color: ${C.dim}; opacity: .7; }
  `}</style>
);

/* ── auth screen ── */
function AuthScreen() {
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (!email.trim() || !password) return;
    setBusy(true); setMsg(null);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (data.user && !data.session) setMsg("Check your email to confirm your account, then sign in.");
      }
    } catch (e) {
      setMsg(e.message || "Something went wrong. Try again.");
    }
    setBusy(false);
  };

  const inp = { width: "100%", background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "12px 14px", fontSize: 15, marginBottom: 10 };

  return (
    <Shell center>
      <div style={{ width: "100%", maxWidth: 380, padding: 24, animation: "rise .4s ease" }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div className="display" style={{ fontSize: 30, fontWeight: 700, color: C.gold }}>LifeQuest</div>
          <div style={{ color: C.dim, fontSize: 13, marginTop: 6 }}>Your character syncs across every device.</div>
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 20 }}>
          <input style={inp} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <input style={inp} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            onKeyDown={(e) => e.key === "Enter" && go()} />
          <button onClick={go} disabled={busy}
            style={{ width: "100%", background: C.gold, color: C.bg, border: "none", borderRadius: 8, padding: "12px 0", fontWeight: 700, fontSize: 15, opacity: busy ? 0.6 : 1 }}>
            {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>
          {msg && <div style={{ color: C.ember, fontSize: 13, marginTop: 10, lineHeight: 1.5 }}>{msg}</div>}
        </div>
        <button onClick={() => { setMode((m) => (m === "signin" ? "signup" : "signin")); setMsg(null); }}
          style={{ background: "none", border: "none", color: C.dim, fontSize: 13, marginTop: 14, width: "100%", textDecoration: "underline" }}>
          {mode === "signin" ? "New here? Create an account" : "Already have an account? Sign in"}
        </button>
      </div>
    </Shell>
  );
}

/* ── the game ── */
function LifeQuest({ userId, onSignOut }) {
  const [state, setState] = useState(null);
  const [tab, setTab] = useState("character");
  const [toast, setToast] = useState(null);
  const [sync, setSync] = useState("synced");
  const toastTimer = useRef(null);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cached = readCache(userId);
      try {
        const cloud = await loadCloud(userId);
        if (cancelled) return;
        setState(cloud || cached || seedState());
        setSync("synced");
      } catch {
        if (cancelled) return;
        setState(cached || seedState());
        setSync("offline");
      }
      loaded.current = true;
    })();
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (!state || !loaded.current) return;
    writeCache(userId, state);
    setSync("saving");
    const t = setTimeout(async () => {
      try {
        await saveCloud(userId, state);
        setSync("synced");
      } catch {
        setSync("offline");
      }
    }, 600);
    return () => clearTimeout(t);
  }, [state, userId]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /* boss expiry */
  useEffect(() => {
    if (!state || !state.boss) return;
    if (state.boss.weekId !== weekId()) {
      const escaped = !state.boss.defeated;
      const name = state.boss.name;
      setState((s) => ({
        ...s,
        boss: null,
        chronicle: escaped
          ? [{ id: uid(), date: todayStr(), text: `The boss escaped — ${name}`, xp: 0, type: "note" }, ...s.chronicle]
          : s.chronicle,
      }));
    }
  }, [state]);

  /* weekly quest rollover — new week: reset counts, keep streak only if the
     just-ended week hit its target and no week was skipped in between */
  useEffect(() => {
    if (!state || !(state.weeklies || []).length) return;
    const cur = weekId();
    if (state.weeklies.every((w) => w.weekId === cur)) return;
    const prev = prevWeekId();
    setState((s) => ({
      ...s,
      weeklies: s.weeklies.map((w) => w.weekId === cur ? w : {
        ...w,
        streak: w.count >= w.target && w.weekId === prev ? w.streak : 0,
        count: 0,
        weekId: cur,
      }),
    }));
  }, [state]);

  /* achievements */
  useEffect(() => {
    if (!state) return;
    const owned = state.achievements;
    const newly = ACHIEVEMENTS.filter((a) => !owned.includes(a.id) && a.check(state));
    if (newly.length) {
      setState((s) => ({
        ...s,
        achievements: [...s.achievements, ...newly.map((a) => a.id)],
        chronicle: [
          ...newly.map((a) => ({ id: uid(), date: todayStr(), text: `Achievement unlocked — ${a.name}`, xp: 0, type: "achievement" })),
          ...s.chronicle,
        ],
      }));
      showToast(`⭑ Achievement: ${newly[0].name}`);
    }
  }, [state, showToast]);

  /* Streak math shared by preview + commit.
     Freezes cover a single missed day; earned every 14-day streak. */
  const computeStreak = (player) => {
    const today = todayStr();
    let { streak, freezes = 0 } = player;
    let usedFreeze = false;
    if (player.lastActive !== today) {
      if (player.lastActive === daysAgoStr(1)) {
        streak += 1;
      } else if (player.lastActive === daysAgoStr(2) && freezes > 0) {
        freezes -= 1; streak += 1; usedFreeze = true;
      } else {
        streak = 1;
      }
      if (streak > 0 && streak % FREEZE_EVERY === 0 && freezes < MAX_FREEZES) freezes += 1;
    }
    return { streak, freezes, usedFreeze };
  };

  /* XP + gold + streak. `noGold` = passion protection (still gets XP).
     Surprise drops land regardless — unexpected rewards are the safe kind. */
  const grantXp = (amount, text, { noGold = false } = {}) => {
    const today = todayStr();
    const surprise = Math.random() < SURPRISE_CHANCE ? 5 + Math.floor(Math.random() * 21) : 0;

    // preview for toast (authoritative recompute happens inside setState)
    const pv = computeStreak(state.player);
    const pvMult = pv.streak >= STREAK_MULT_AT ? STREAK_MULT : 1;
    const pvAmt = Math.round(amount * pvMult);
    const pvGold = (noGold ? 0 : Math.max(1, Math.round(pvAmt / 10))) + surprise;

    setState((s) => {
      const { streak, freezes, usedFreeze } = computeStreak(s.player);
      const mult = streak >= STREAK_MULT_AT ? STREAK_MULT : 1;
      const amt = Math.round(amount * mult);
      const gold = (noGold ? 0 : Math.max(1, Math.round(amt / 10))) + surprise;
      const before = playerLevel(s.player.xp);
      const xp = s.player.xp + amt;
      const after = playerLevel(xp);
      const chron = [{ id: uid(), date: today, text, xp: amt, gold, type: "xp" }, ...s.chronicle].slice(0, 300);
      if (usedFreeze)
        chron.unshift({ id: uid(), date: today, text: "❄ A streak freeze melted to preserve your flame", xp: 0, type: "note" });
      if (after > before)
        chron.unshift({ id: uid(), date: today, text: `Reached Level ${after} — ${TITLES[Math.min(after - 1, TITLES.length - 1)]}`, xp: 0, type: "levelup" });
      return { ...s, player: { ...s.player, xp, gold: (s.player.gold || 0) + gold, streak, freezes, lastActive: today }, chronicle: chron };
    });

    let msg = `+${pvAmt} XP`;
    if (pvGold - surprise > 0) msg += ` · +${pvGold - surprise}g`;
    if (pvMult > 1) msg += " · ×1.25";
    if (surprise > 0) msg += ` · ✨ surprise +${surprise}g!`;
    showToast(`${msg} — ${text}`);
  };

  if (!state) return <Shell center><div style={{ color: C.dim }}>Opening the tome…</div></Shell>;

  const lvl = playerLevel(state.player.xp);
  const title = TITLES[Math.min(lvl - 1, TITLES.length - 1)];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.parchment, fontFamily: "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif", paddingBottom: 84 }}>
      <GlobalStyle />

      <div style={{ position: "fixed", top: 8, left: 12, zIndex: 45, display: "flex", alignItems: "center", gap: 5, color: C.gold, fontSize: 13 }}>
        <span style={{ width: 10, height: 10, borderRadius: 999, background: C.gold, display: "inline-block", boxShadow: `0 0 6px ${C.gold}88` }} />
        <span className="display" style={{ fontWeight: 700 }}>{state.player.gold || 0}g</span>
      </div>
      <div style={{ position: "fixed", top: 8, right: 12, fontSize: 10, color: sync === "offline" ? C.ember : C.dim, letterSpacing: ".08em", textTransform: "uppercase", zIndex: 45 }}>
        {sync === "saving" ? "saving…" : sync === "offline" ? "offline — will sync" : "synced"}
      </div>

      {tab === "character" && <CharacterView state={state} setState={setState} lvl={lvl} title={title} onSignOut={onSignOut} />}
      {tab === "quests" && <QuestsView state={state} setState={setState} grantXp={grantXp} />}
      {tab === "campaigns" && <CampaignsView state={state} setState={setState} grantXp={grantXp} />}
      {tab === "skills" && <SkillsView state={state} setState={setState} grantXp={grantXp} />}
      {tab === "trackers" && <TrackersView state={state} setState={setState} showToast={showToast} />}
      {tab === "shop" && <ShopView state={state} setState={setState} showToast={showToast} />}
      {tab === "chronicle" && <ChronicleView state={state} />}

      {toast && (
        <div style={{ position: "fixed", bottom: 96, left: "50%", transform: "translateX(-50%)", background: C.surface2, border: `1px solid ${C.gold}`, color: C.gold, padding: "10px 18px", borderRadius: 999, fontSize: 13, whiteSpace: "nowrap", animation: "rise .25s ease", zIndex: 50, boxShadow: "0 4px 24px rgba(0,0,0,.5)", maxWidth: "92vw", overflow: "hidden", textOverflow: "ellipsis" }}>
          {toast}
        </div>
      )}

      <TabBar tab={tab} setTab={setTab} />
    </div>
  );
}

/* ── shared bits ── */
const bracket = (pos) => ({
  position: "absolute", width: 10, height: 10, pointerEvents: "none",
  ...(pos.includes("t") ? { top: 4, borderTop: `1px solid ${C.gold}55` } : { bottom: 4, borderBottom: `1px solid ${C.gold}55` }),
  ...(pos.includes("l") ? { left: 4, borderLeft: `1px solid ${C.gold}55` } : { right: 4, borderRight: `1px solid ${C.gold}55` }),
});

const Card = ({ children, style }) => (
  <div style={{ position: "relative", background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, padding: 16, ...style }}>
    <span aria-hidden="true" style={bracket("tl")} />
    <span aria-hidden="true" style={bracket("tr")} />
    <span aria-hidden="true" style={bracket("bl")} />
    <span aria-hidden="true" style={bracket("br")} />
    {children}
  </div>
);

const SectionTitle = ({ children, right, color = C.gold }) => (
  <div style={{ margin: "22px 2px 10px" }}>
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
      <div className="display" style={{ fontSize: 13, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: ".18em" }}>{children}</div>
      {right}
    </div>
    <div aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
      <span style={{ flex: 1, height: 1, background: C.line }} />
      <span style={{ color: `${color}88`, fontSize: 12, lineHeight: 1 }}>❧</span>
      <span style={{ flex: 1, height: 1, background: C.line }} />
    </div>
  </div>
);

const Bar = ({ frac, color, height = 8 }) => (
  <div style={{ height, background: C.bg, borderRadius: 999, overflow: "hidden", border: `1px solid ${C.line}` }}>
    <div style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%`, height: "100%", background: `linear-gradient(90deg, ${color}, ${color}cc)`, borderRadius: 999, transition: "width .4s ease" }} />
  </div>
);

const GhostBtn = ({ onClick, children, color = C.gold, style, disabled }) => (
  <button onClick={onClick} disabled={disabled}
    style={{ background: "transparent", border: `1px solid ${color}66`, color, borderRadius: 8, padding: "8px 14px", fontSize: 13, opacity: disabled ? 0.4 : 1, ...style }}>
    {children}
  </button>
);

const Empty = ({ children }) => (
  <div style={{ color: C.dim, fontSize: 14, fontStyle: "italic", padding: "14px 4px" }}>{children}</div>
);

const Modal = ({ children, onClose }) => (
  <div onClick={onClose}
    style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
    <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 420, animation: "rise .25s ease" }}>
      {children}
    </div>
  </div>
);

const Stat = ({ label, value, color, sub }) => (
  <Card style={{ textAlign: "center", padding: "14px 8px" }}>
    <div className="display" style={{ fontSize: 26, fontWeight: 700, color }}>{value}</div>
    <div style={{ fontSize: 11, color: C.dim, marginTop: 2, letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</div>
    {sub && <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{sub}</div>}
  </Card>
);

/* passion toggle: XP yes, gold no — protects intrinsic motivation */
const PassionToggle = ({ on, onToggle, compact }) => (
  <button onClick={onToggle}
    title="Passion — earns XP but no gold. Protects things you love from being 'paid work'."
    style={{ background: on ? `${C.ember}22` : "transparent", border: `1px solid ${on ? C.ember : C.line}`, color: on ? C.ember : C.dim, borderRadius: 999, padding: compact ? "4px 9px" : "6px 12px", fontSize: 12, whiteSpace: "nowrap" }}>
    ♥ {compact ? "" : "Passion"}
  </button>
);

function AbilityPicker({ selected, onChange }) {
  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else if (selected.length < 2) onChange([...selected, id]);
  };
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {ABILITIES.map((a) => {
          const idx = selected.indexOf(a.id);
          const on = idx >= 0;
          return (
            <button key={a.id} onClick={() => toggle(a.id)}
              style={{ padding: "6px 10px", borderRadius: 999, fontSize: 12, border: `1px solid ${on ? C.gold : C.line}`, background: on ? `${C.gold}22` : "transparent", color: on ? C.gold : C.dim }}>
              {a.abbr}{on ? (idx === 0 ? " · P" : " · S") : ""}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>
        Tap up to two. Primary earns 50% of skill XP, secondary 25%.
      </div>
    </div>
  );
}

/* multi-select skill chips — quests/dailies/weeklies can feed up to 3 skills */
function SkillPicker({ skills, selected, onChange, label = "Feeds skills (optional) — all its XP also trains them" }) {
  if (!skills.length) return null;
  const toggle = (id) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else if (selected.length < 3) onChange([...selected, id]);
  };
  return (
    <div style={{ margin: "10px 0 4px" }}>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {skills.map((k) => {
          const on = selected.includes(k.id);
          return (
            <button key={k.id} onClick={() => toggle(k.id)}
              style={{ padding: "6px 10px", borderRadius: 999, fontSize: 12, border: `1px solid ${on ? C.arcane : C.line}`, background: on ? `${C.arcane}22` : "transparent", color: on ? C.arcane : C.dim }}>
              {k.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* single-select campaign chip — tags a daily/weekly as a campaign commitment */
function CampaignPicker({ campaigns, selected, onChange }) {
  if (!campaigns || !campaigns.length) return null;
  return (
    <div style={{ margin: "8px 0 0" }}>
      <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>Part of a campaign (optional)</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {campaigns.map((c) => {
          const on = selected === c.id;
          return (
            <button key={c.id} onClick={() => onChange(on ? null : c.id)}
              style={{ padding: "6px 10px", borderRadius: 999, fontSize: 12, border: `1px solid ${on ? C.gold : C.line}`, background: on ? `${C.gold}22` : "transparent", color: on ? C.gold : C.dim }}>
              ⚐ {c.title}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Character ── */
function CharacterView({ state, setState, lvl, title, onSignOut }) {
  const floor = playerFloor(lvl), ceil = playerCeil(lvl);
  const frac = (state.player.xp - floor) / (ceil - floor);
  const doneQuests = state.chronicle.filter((c) => c.type === "quest").length;
  const R = 74, circ = 2 * Math.PI * R;
  const multActive = state.player.streak >= STREAK_MULT_AT;
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "28px 16px" }}>
      <div style={{ textAlign: "center", animation: "rise .4s ease" }}>
        <div style={{ position: "relative", width: 190, height: 190, margin: "0 auto" }}>
          <svg width="190" height="190" style={{ transform: "rotate(-90deg)" }}>
            <circle cx="95" cy="95" r={R} fill="none" stroke={C.line} strokeWidth="7" />
            <circle cx="95" cy="95" r={R} fill="none" stroke={C.gold} strokeWidth="7" strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={circ * (1 - frac)} style={{ transition: "stroke-dashoffset .6s ease" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontSize: 11, color: C.dim, letterSpacing: ".2em", textTransform: "uppercase" }}>Level</div>
            <div className="display" style={{ fontSize: 52, fontWeight: 700, lineHeight: 1 }}>{lvl}</div>
          </div>
        </div>
        <div className="display" style={{ fontSize: 22, fontWeight: 700, marginTop: 10, color: C.gold }}>{title}</div>
        <div style={{ color: C.dim, fontSize: 13, marginTop: 4 }}>
          {state.player.xp - floor} / {ceil - floor} XP to Level {lvl + 1}
        </div>
        {multActive && (
          <div style={{ color: C.ember, fontSize: 12, marginTop: 6, fontWeight: 700 }}>
            🔥 Streak bonus active — all XP ×1.25
          </div>
        )}
      </div>

      <SectionTitle>Attributes</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {ABILITIES.map((a) => {
          const xp = state.abilities[a.id] || 0;
          const l = abilityLevel(xp);
          const f = (xp - abilityFloor(l)) / (abilityCeil(l) - abilityFloor(l));
          return (
            <Card key={a.id} style={{ padding: "12px 10px", textAlign: "center" }}>
              <div className="display" style={{ fontSize: 11, fontWeight: 700, color: C.gold, letterSpacing: ".14em" }}>{a.abbr}</div>
              <div className="display" style={{ fontSize: 30, fontWeight: 700, margin: "2px 0 6px" }}>{l}</div>
              <Bar frac={f} color={C.gold} height={5} />
              <div style={{ fontSize: 9, color: C.dim, marginTop: 5, textTransform: "uppercase", letterSpacing: ".06em" }}>{a.name}</div>
            </Card>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: C.dim, margin: "6px 4px 0" }}>
        Attributes rise only through linked skills — they are earned, never tapped.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 18 }}>
        <Stat label="Day streak" value={state.player.streak} color={C.ember}
          sub={state.player.freezes > 0 ? `❄ ${state.player.freezes} freeze${state.player.freezes > 1 ? "s" : ""}` : null} />
        <Stat label="Active quests" value={state.quests.length} color={C.moss} />
        <Stat label="Quests done" value={doneQuests} color={C.arcane} />
      </div>
      <div style={{ fontSize: 11, color: C.dim, margin: "6px 4px 0" }}>
        ❄ Freezes are earned every {FREEZE_EVERY}-day streak and quietly cover one missed day.
      </div>

      <SageSection state={state} setState={setState} />

      <SectionTitle>Achievements · {state.achievements.length}/{ACHIEVEMENTS.length}</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8 }}>
        {ACHIEVEMENTS.map((a) => {
          const owned = state.achievements.includes(a.id);
          return (
            <div key={a.id} title={a.desc} style={{ background: owned ? C.surface2 : C.surface, border: `1px solid ${owned ? C.gold : C.line}`, borderRadius: 10, padding: "10px 6px", textAlign: "center", opacity: owned ? 1 : 0.45 }}>
              <div style={{ fontSize: 20, lineHeight: 1 }}>{a.icon}</div>
              <div className="display" style={{ fontSize: 10, fontWeight: 700, marginTop: 5, color: owned ? C.gold : C.dim }}>{a.name}</div>
              <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>{a.desc}</div>
            </div>
          );
        })}
      </div>

      <SectionTitle>Recent deeds</SectionTitle>
      {state.chronicle.slice(0, 5).map((e) => <ChronicleRow key={e.id} e={e} />)}
      {state.chronicle.length === 0 && <Empty>Your story is unwritten. Complete a quest step to begin it.</Empty>}

      <div style={{ textAlign: "center", marginTop: 30, display: "flex", flexDirection: "column", gap: 12 }}>
        <button onClick={onSignOut} style={{ background: "none", border: "none", color: C.dim, fontSize: 12, textDecoration: "underline" }}>
          Sign out
        </button>
        <button onClick={() => setConfirmReset(true)} style={{ background: "none", border: "none", color: C.ember, fontSize: 12, textDecoration: "underline" }}>
          Reset character
        </button>
      </div>

      {confirmReset && (
        <Modal onClose={() => setConfirmReset(false)}>
          <Card style={{ borderLeft: `3px solid ${C.ember}`, background: C.surface2 }}>
            <div className="display" style={{ fontSize: 15, fontWeight: 700, color: C.ember, marginBottom: 8 }}>Reset your character?</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: C.parchment, marginBottom: 14 }}>
              This permanently erases everything — your level, XP, gold, streak, skills,
              quests, vitals, achievements, and chronicle — and starts a brand-new character
              from scratch. It cannot be undone, and there is no backup.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setState(seedState()); setConfirmReset(false); }}
                style={{ flex: 1, background: C.ember, color: C.bg, border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 13 }}>
                Erase everything
              </button>
              <GhostBtn color={C.dim} onClick={() => setConfirmReset(false)}>Cancel</GhostBtn>
            </div>
          </Card>
        </Modal>
      )}
    </div>
  );
}

/* ── The Sage: AI weekly reflection ── */
function SageSection({ state, setState }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const latest = state.reflections[0];

  const consult = async () => {
    setBusy(true); setErr(null);
    try {
      const week = state.chronicle.filter((e) => e.date >= daysAgoStr(7)).slice(0, 50);
      const summary = {
        streak: state.player.streak,
        level: playerLevel(state.player.xp),
        deedsThisWeek: week.map((e) => `${e.date}: ${e.text}${e.xp ? ` (+${e.xp} XP)` : ""}`),
        skills: state.skills.map((k) => `${k.name} — Level ${skillLevel(k.xp)}, ${k.totalSessions || 0} total sessions, passion: ${!!k.passion}`),
        activeQuests: state.quests.map((q) => q.title),
        weeklies: (state.weeklies || []).map((w) => `${w.name}: ${w.count}/${w.target} this week, ${w.streak} week streak`),
        campaigns: (state.campaigns || []).map((c) => `${c.title} — ${Math.round(campaignFrac(c) * 100)}% (${c.milestones.filter((m) => m.claimedAt).length}/${c.milestones.length} milestones claimed)`),
        vitals: state.trackers.map((t) => `${t.name}: ${t.entries[0] ? t.entries[0].value + " " + t.unit : "no entries"}`),
      };
      const text = await askClaude({
        system: "You are the Sage in a personal life-RPG app. The player is an adult working on self-betterment. Write a weekly reflection in 120-170 words: name one specific pattern you notice in their week's log, one thing that is clearly working, one gentle honest nudge (not preachy), and one suggested focus for next week. Be specific to their actual data, warm but not sycophantic, and never invent activities that are not in the log. Write in second person. Light fantasy flavor is welcome but keep substance first. No headers or bullet lists — flowing prose.",
        prompt: JSON.stringify(summary),
        maxTokens: 400,
      });
      setState((s) => ({ ...s, reflections: [{ id: uid(), date: todayStr(), text }, ...s.reflections].slice(0, 8) }));
    } catch (e) {
      setErr(e.message);
    }
    setBusy(false);
  };

  return (
    <>
      <SectionTitle color={C.arcane} right={
        <GhostBtn color={C.arcane} onClick={consult} disabled={busy}>
          {busy ? "The sage ponders…" : latest ? "Reflect again" : "Consult the Sage"}
        </GhostBtn>
      }>
        Sage's Counsel
      </SectionTitle>
      {err && <div style={{ color: C.ember, fontSize: 12, margin: "0 2px 8px", lineHeight: 1.5 }}>{err}</div>}
      {latest ? (
        <Card style={{ borderLeft: `3px solid ${C.arcane}` }}>
          <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>{fmtDate(latest.date)}</div>
          <div style={{ fontSize: 14, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
            <span className="display" style={{ float: "left", fontSize: 40, lineHeight: 0.85, color: C.gold, padding: "3px 8px 0 2px" }}>
              {latest.text.charAt(0)}
            </span>
            {latest.text.slice(1)}
          </div>
        </Card>
      ) : (
        !err && <Empty>Once a week, the Sage will read your chronicle and offer counsel. Best consulted on Sundays.</Empty>
      )}
    </>
  );
}

/* ── Quests (dailies + boss + quest log) ── */
function QuestsView({ state, setState, grantXp }) {
  const [adding, setAdding] = useState(false);
  const [confirmEditId, setConfirmEditId] = useState(null);
  const [editId, setEditId] = useState(null);

  const withSkillFeed = (base, q, xp) =>
    (q.skillIds || []).reduce((acc, sid) => applySkillGain(acc, sid, xp, "Quest", false), base);

  const toggleSub = (qid, sid) => {
    const q = state.quests.find((x) => x.id === qid);
    const st = q.subtasks.find((x) => x.id === sid);
    if (st.done) return;
    setState((s) => {
      const next = {
        ...s,
        quests: s.quests.map((qq) => qq.id !== qid ? qq : { ...qq, subtasks: qq.subtasks.map((ss) => ss.id === sid ? { ...ss, done: true } : ss) }),
      };
      return withSkillFeed(next, q, st.xp);
    });
    grantXp(st.xp, `${q.title}: ${st.text}`, { noGold: q.passion });
  };

  const tallyInc = (qid, sid) => {
    const q = state.quests.find((x) => x.id === qid);
    const st = q.subtasks.find((x) => x.id === sid);
    setState((s) => {
      const next = {
        ...s,
        quests: s.quests.map((qq) => qq.id !== qid ? qq : { ...qq, subtasks: qq.subtasks.map((ss) => ss.id === sid ? { ...ss, count: (ss.count || 0) + 1 } : ss) }),
      };
      return withSkillFeed(next, q, st.xp);
    });
    grantXp(st.xp, `${q.title}: ${st.text} #${(st.count || 0) + 1}`, { noGold: q.passion });
  };

  const claimQuest = (qid) => {
    const q = state.quests.find((x) => x.id === qid);
    const bonus = TIERS[q.tier].bonus;
    setState((s) => {
      const next = {
        ...s,
        quests: s.quests.filter((x) => x.id !== qid),
        chronicle: [{ id: uid(), date: todayStr(), text: `Quest complete — ${q.title}`, xp: bonus, type: "quest" }, ...s.chronicle],
      };
      return withSkillFeed(next, q, bonus);
    });
    grantXp(bonus, `Quest complete: ${q.title}`, { noGold: q.passion });
  };

  const abandon = (qid) => setState((s) => ({ ...s, quests: s.quests.filter((x) => x.id !== qid) }));

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      <GoalReviewSection state={state} setState={setState} grantXp={grantXp} />
      <DailiesSection state={state} setState={setState} grantXp={grantXp} />
      <WeekliesSection state={state} setState={setState} grantXp={grantXp} />
      <BossSection state={state} setState={setState} grantXp={grantXp} />

      <SectionTitle right={<GhostBtn onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "+ New quest"}</GhostBtn>}>
        Quest Log
      </SectionTitle>

      {adding && <QuestForm skills={state.skills} onCreate={(q) => { setState((s) => ({ ...s, quests: [q, ...s.quests] })); setAdding(false); }} />}
      {state.quests.length === 0 && !adding && <Empty>The board is bare. Post a new quest.</Empty>}

      {confirmEditId && (
        <Modal onClose={() => setConfirmEditId(null)}>
          <Card style={{ borderLeft: `3px solid ${C.gold}`, background: C.surface2 }}>
            <div className="display" style={{ fontSize: 15, fontWeight: 700, color: C.gold, marginBottom: 8 }}>Editing a committed quest</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: C.parchment, marginBottom: 14 }}>
              Are you changing it because the goal genuinely evolved, or because it got hard? Only proceed if it's the former.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setEditId(confirmEditId); setConfirmEditId(null); }}
                style={{ flex: 1, background: C.gold, color: C.bg, border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 13 }}>
                Yes, the goal changed
              </button>
              <GhostBtn color={C.dim} onClick={() => setConfirmEditId(null)}>Cancel</GhostBtn>
            </div>
          </Card>
        </Modal>
      )}

      {["epic", "main", "side"].map((tierKey) => {
        const group = state.quests.filter((q) => q.tier === tierKey);
        if (group.length === 0) return null;
        return (
          <div key={tierKey}>
            <SectionTitle color={TIERS[tierKey].color}>{TIERS[tierKey].label}s</SectionTitle>
            {group.map((q) => {
        if (q.id === editId) {
          return (
            <QuestEditor key={q.id} q={q}
              onCancel={() => setEditId(null)}
              onSave={(patch) => {
                setState((s) => ({ ...s, quests: s.quests.map((x) => x.id === q.id ? { ...x, ...patch } : x) }));
                setEditId(null);
              }}
            />
          );
        }
        const tier = TIERS[q.tier];
        const checks = q.subtasks.filter((s) => s.type !== "tally");
        const done = checks.filter((s) => s.done).length;
        const claimable = checks.length === 0 || done === checks.length;
        const linkedSkills = (q.skillIds || []).map((id) => state.skills.find((k) => k.id === id)).filter(Boolean);
        return (
          <Card key={q.id} style={{ marginBottom: 14, borderLeft: `3px solid ${tier.color}`, animation: "rise .3s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <div className="display" style={{ fontSize: 17, fontWeight: 700 }}>{q.title}</div>
              <div style={{ fontSize: 11, color: tier.color, letterSpacing: ".12em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{tier.label}</div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
              {linkedSkills.length > 0 && <span style={{ fontSize: 11, color: C.arcane }}>Feeds: {linkedSkills.map((k) => k.name).join(", ")}</span>}
              {q.passion && <span style={{ fontSize: 11, color: C.ember }}>♥ passion — XP only</span>}
              {copingLine(q) && <span style={{ fontSize: 11, color: C.dim, fontStyle: "italic" }}>⛨ {copingLine(q)}</span>}
            </div>
            {checks.length > 0 && (
              <div style={{ margin: "10px 0 12px" }}>
                <Bar frac={done / checks.length} color={tier.color} />
                <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>{done} of {checks.length} objectives · +{tier.bonus} XP on completion</div>
              </div>
            )}
            {checks.length === 0 && (
              <div style={{ fontSize: 12, color: C.dim, margin: "8px 0 10px" }}>
                Open-ended quest — complete it whenever life does. +{tier.bonus} XP on completion.
              </div>
            )}
            {q.subtasks.map((st) => st.type === "tally" ? (
              <div key={st.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 2px" }}>
                <span className="display" style={{ minWidth: 34, textAlign: "center", fontSize: 15, fontWeight: 700, color: tier.color, border: `1px solid ${tier.color}55`, borderRadius: 8, padding: "3px 6px" }}>
                  {st.count || 0}
                </span>
                <span style={{ flex: 1, fontSize: 14 }}>{st.text}</span>
                <span style={{ fontSize: 12, color: C.gold, whiteSpace: "nowrap" }}>+{st.xp} each</span>
                <GhostBtn color={tier.color} onClick={() => tallyInc(q.id, st.id)} style={{ padding: "5px 12px", fontSize: 13 }}>+1</GhostBtn>
              </div>
            ) : (
              <button key={st.id} onClick={() => toggleSub(q.id, st.id)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "8px 2px", color: st.done ? C.dim : C.parchment }}>
                <span style={{ width: 18, height: 18, borderRadius: 5, flexShrink: 0, border: `1.5px solid ${st.done ? C.moss : C.dim}`, background: st.done ? C.moss : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: C.bg }}>
                  {st.done ? "✓" : ""}
                </span>
                <span style={{ flex: 1, fontSize: 14, textDecoration: st.done ? "line-through" : "none" }}>{st.text}</span>
                <span style={{ fontSize: 12, color: st.done ? C.dim : C.gold, whiteSpace: "nowrap" }}>+{st.xp}</span>
              </button>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              {claimable && (
                <button onClick={() => claimQuest(q.id)}
                  style={{ flex: 1, background: tier.color, color: C.bg, border: "none", borderRadius: 8, padding: "10px 0", fontSize: 14, fontWeight: 700, animation: checks.length > 0 ? "glowpulse 1.6s infinite" : "none" }}>
                  {checks.length > 0 ? `Claim reward · +${tier.bonus} XP` : `Mark complete · +${tier.bonus} XP`}
                </button>
              )}
              {!claimable && <GhostBtn color={C.dim} onClick={() => setConfirmEditId(q.id)} style={{ marginLeft: "auto", fontSize: 12 }}>Edit</GhostBtn>}
              {claimable && <GhostBtn color={C.dim} onClick={() => setConfirmEditId(q.id)} style={{ fontSize: 12 }}>Edit</GhostBtn>}
              {!claimable && <GhostBtn color={C.dim} onClick={() => abandon(q.id)} style={{ fontSize: 12 }}>Abandon</GhostBtn>}
              {claimable && checks.length === 0 && <GhostBtn color={C.dim} onClick={() => abandon(q.id)} style={{ fontSize: 12 }}>Abandon</GhostBtn>}
            </div>
          </Card>
        );
            })}
          </div>
        );
      })}
    </div>
  );
}

/* ── Goal review: the control-theory loop — set goals, get feedback,
   revisit the goals themselves. Due monthly; keep / revise / retire. ── */
function GoalReviewSection({ state, setState, grantXp }) {
  const [dismissed, setDismissed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [idx, setIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [tier, setTier] = useState("side");

  if (!reviewDue(state) || dismissed) return null;

  const quests = state.quests;
  const q = quests[idx];

  const finish = () => {
    setState((s) => ({
      ...s,
      lastGoalReview: todayStr(),
      chronicle: [{ id: uid(), date: todayStr(), text: "Goal review complete — the board is current", xp: 0, type: "review" }, ...s.chronicle],
    }));
    grantXp(REVIEW_XP, "Goal review complete");
    setReviewing(false); setIdx(0); setEditing(false);
  };

  const advance = () => {
    setEditing(false);
    if (idx + 1 >= quests.length) finish();
    else setIdx(idx + 1);
  };

  const retire = () => {
    setEditing(false);
    const wasLast = idx >= quests.length - 1;
    setState((s) => ({
      ...s,
      quests: s.quests.filter((x) => x.id !== q.id),
      chronicle: [{ id: uid(), date: todayStr(), text: `Retired at review — ${q.title}`, xp: 0, type: "note" }, ...s.chronicle],
    }));
    if (wasLast) finish();
    // otherwise idx already points at the next quest after removal
  };

  const startRevise = () => { setTitle(q.title); setTier(q.tier); setEditing(true); };
  const saveRevision = () => {
    const t = title.trim();
    const chosen = tier;
    setState((s) => ({ ...s, quests: s.quests.map((x) => x.id !== q.id ? x : { ...x, title: t || x.title, tier: chosen }) }));
    advance();
  };

  if (!reviewing || !q) {
    return (
      <Card style={{ marginBottom: 18, borderLeft: `3px solid ${C.arcane}`, background: `linear-gradient(180deg, ${C.surface2}, ${C.surface})` }}>
        <div className="display" style={{ fontSize: 15, fontWeight: 700, color: C.arcane }}>⚖ The council convenes</div>
        <div style={{ fontSize: 13, color: C.dim, margin: "6px 0 12px", lineHeight: 1.55 }}>
          It's been a month. Walk the quest board — keep what still matters, revise what's drifted, retire what's done serving you. Retiring is a victory of judgment, not a defeat.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setReviewing(true); setIdx(0); }}
            style={{ flex: 1, background: C.arcane, color: C.bg, border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 14 }}>
            Begin review · +{REVIEW_XP} XP
          </button>
          <GhostBtn color={C.dim} onClick={() => setDismissed(true)} style={{ fontSize: 12 }}>Later</GhostBtn>
        </div>
      </Card>
    );
  }

  const tierInfo = TIERS[q.tier];
  const checks = q.subtasks.filter((s) => s.type !== "tally");
  const done = checks.filter((s) => s.done).length;
  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14, width: "100%" };

  return (
    <Card style={{ marginBottom: 18, borderLeft: `3px solid ${C.arcane}`, animation: "rise .3s ease" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 11, color: C.arcane, letterSpacing: ".14em", textTransform: "uppercase" }}>⚖ Goal review · {idx + 1} of {quests.length}</div>
        <button onClick={() => { setReviewing(false); setEditing(false); }} style={{ background: "none", border: "none", color: C.dim, fontSize: 11, textDecoration: "underline" }}>pause</button>
      </div>
      <div className="display" style={{ fontSize: 17, fontWeight: 700, marginTop: 8 }}>{q.title}</div>
      <div style={{ fontSize: 12, color: C.dim, marginTop: 3 }}>
        <span style={{ color: tierInfo.color }}>{tierInfo.label}</span>
        {q.createdAt && <> · posted {fmtDate(q.createdAt)}</>}
        {checks.length > 0 && <> · {done} of {checks.length} objectives done</>}
      </div>
      {checks.length > 0 && <div style={{ marginTop: 8 }}><Bar frac={done / checks.length} color={tierInfo.color} height={6} /></div>}

      {editing ? (
        <div style={{ marginTop: 12 }}>
          <input style={inp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quest name" />
          <div style={{ display: "flex", gap: 6, margin: "8px 0 10px" }}>
            {Object.entries(TIERS).filter(([k]) => k !== "epic" || q.tier === "epic").map(([k, t]) => (
              <button key={k} onClick={() => setTier(k)}
                style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, border: `1px solid ${tier === k ? t.color : C.line}`, background: tier === k ? `${t.color}22` : "transparent", color: tier === k ? t.color : C.dim }}>
                {t.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveRevision} style={{ flex: 1, background: C.arcane, color: C.bg, border: "none", borderRadius: 8, padding: "9px 0", fontWeight: 700, fontSize: 13 }}>
              Save & continue
            </button>
            <GhostBtn color={C.dim} onClick={() => setEditing(false)} style={{ fontSize: 12 }}>Cancel</GhostBtn>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={advance} style={{ flex: 1, background: C.moss, color: C.bg, border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 13 }}>Keep</button>
          <GhostBtn color={C.gold} onClick={startRevise} style={{ flex: 1 }}>Revise</GhostBtn>
          <GhostBtn color={C.ember} onClick={retire} style={{ flex: 1 }}>Retire</GhostBtn>
        </div>
      )}
    </Card>
  );
}

/* ── Dailies (with implementation-intention cues) ── */
function DailiesSection({ state, setState, grantXp }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [cue, setCue] = useState("");
  const [copingIf, setCopingIf] = useState("");
  const [copingThen, setCopingThen] = useState("");
  const [xp, setXp] = useState(15);
  const [passion, setPassion] = useState(false);
  const [skillIds, setSkillIds] = useState([]);
  const [campaignId, setCampaignId] = useState(null);
  const today = todayStr();
  const doneCount = state.dailies.filter((d) => d.lastDone === today).length;

  const complete = (d) => completeDaily(setState, grantXp, d);

  const add = () => {
    if (!name.trim()) return;
    setState((s) => ({ ...s, dailies: [...s.dailies, { id: uid(), name: name.trim(), cue: cue.trim(), copingIf: copingIf.trim(), copingThen: copingThen.trim(), xp: Math.max(5, Number(xp) || 15), lastDone: null, passion, skillIds, campaignId }] }));
    setName(""); setCue(""); setCopingIf(""); setCopingThen(""); setXp(15); setPassion(false); setSkillIds([]); setCampaignId(null); setAdding(false);
  };

  const remove = (id) => setState((s) => ({ ...s, dailies: s.dailies.filter((x) => x.id !== id) }));

  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 };

  return (
    <>
      <SectionTitle color={C.moss} right={<GhostBtn color={C.moss} onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "+ Daily"}</GhostBtn>}>
        Daily Quests · {doneCount}/{state.dailies.length}
      </SectionTitle>
      {adding && (
        <Card style={{ marginBottom: 10, background: C.surface2 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input style={{ ...inp, flex: 1 }} placeholder="Daily task — e.g. Meditate 10 min" value={name} onChange={(e) => setName(e.target.value)} />
            <input style={{ ...inp, width: 64 }} type="number" min="5" value={xp} onChange={(e) => setXp(e.target.value)} aria-label="XP" />
          </div>
          <input style={{ ...inp, width: "100%", marginBottom: 6 }} placeholder="When/where cue (optional) — e.g. After morning coffee" value={cue} onChange={(e) => setCue(e.target.value)} />
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input style={{ ...inp, flex: 1 }} placeholder="If I get stuck… (optional) — e.g. too tired after work" value={copingIf} onChange={(e) => setCopingIf(e.target.value)} />
            <input style={{ ...inp, flex: 1 }} placeholder="…then I'll — e.g. do just 5 minutes" value={copingThen} onChange={(e) => setCopingThen(e.target.value)} />
          </div>
          <SkillPicker skills={state.skills} selected={skillIds} onChange={setSkillIds} label="Feeds skills (optional) — each check-off trains them" />
          <CampaignPicker campaigns={state.campaigns} selected={campaignId} onChange={setCampaignId} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <PassionToggle on={passion} onToggle={() => setPassion((p) => !p)} />
            <GhostBtn color={C.moss} onClick={add} style={{ flex: 1 }}>Add daily</GhostBtn>
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>
            A when/where cue ("After X, I'll Y") roughly doubles follow-through — the best-supported trick in habit research.
            Naming your likely obstacle and a countermove ("If I get stuck…") is its sibling, a coping plan — the classic relapse preventer.
          </div>
        </Card>
      )}
      {state.dailies.length === 0 && !adding && <Empty>No daily quests. Add habits that reset each morning.</Empty>}
      {state.dailies.length > 0 && (
        <Card style={{ marginBottom: 6, borderLeft: `3px solid ${C.moss}`, padding: "8px 14px" }}>
          {state.dailies.map((d) => {
            const done = d.lastDone === today;
            return (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
                <button onClick={() => complete(d)} aria-label={`Complete ${d.name}`}
                  style={{ width: 20, height: 20, borderRadius: 999, flexShrink: 0, border: `1.5px solid ${done ? C.moss : C.dim}`, background: done ? C.moss : "transparent", color: C.bg, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {done ? "✓" : ""}
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, color: done ? C.dim : C.parchment, textDecoration: done ? "line-through" : "none" }}>
                    {d.name}{d.passion ? <span style={{ color: C.ember }}> ♥</span> : null}
                  </span>
                  {d.cue && <div style={{ fontSize: 11, color: C.dim, fontStyle: "italic" }}>{d.cue}</div>}
                  {copingLine(d) && <div style={{ fontSize: 11, color: C.dim, fontStyle: "italic" }}>⛨ {copingLine(d)}</div>}
                  {(d.skillIds || []).length > 0 && (
                    <div style={{ fontSize: 11, color: C.arcane }}>
                      → feeds {(d.skillIds || []).map((id) => (state.skills.find((k) => k.id === id) || {}).name).filter(Boolean).join(", ")}
                    </div>
                  )}
                  {d.campaignId && ((state.campaigns || []).find((c) => c.id === d.campaignId) || null) && (
                    <div style={{ fontSize: 11, color: C.gold }}>⚐ {(state.campaigns || []).find((c) => c.id === d.campaignId).title}</div>
                  )}
                </div>
                <span style={{ fontSize: 12, color: done ? C.dim : C.moss }}>+{d.xp}</span>
                <button onClick={() => remove(d.id)} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, padding: "0 2px" }} aria-label={`Remove ${d.name}`}>×</button>
              </div>
            );
          })}
        </Card>
      )}
      <div style={{ fontSize: 11, color: C.dim, margin: "2px 4px 0" }}>Dailies reset at midnight. ♥ = passion, earns XP only.</div>
    </>
  );
}

/* ── Weekly quests: "do this N times per week" — days flex, count matters ── */
function WeekliesSection({ state, setState, grantXp }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [xp, setXp] = useState(15);
  const [target, setTarget] = useState(3);
  const [passion, setPassion] = useState(false);
  const [copingIf, setCopingIf] = useState("");
  const [copingThen, setCopingThen] = useState("");
  const [skillIds, setSkillIds] = useState([]);

  const [campaignId, setCampaignId] = useState(null);
  const weeklies = state.weeklies || [];
  const hitCount = weeklies.filter((w) => w.count >= w.target).length;

  const rep = (w) => weeklyRep(setState, grantXp, w);

  const add = () => {
    if (!name.trim()) return;
    setState((s) => ({
      ...s,
      weeklies: [...(s.weeklies || []), {
        id: uid(), name: name.trim(), xp: Math.max(5, Number(xp) || 15), target: Math.max(1, Number(target) || 3),
        count: 0, weekId: weekId(), streak: 0, passion,
        copingIf: copingIf.trim(), copingThen: copingThen.trim(), skillIds, campaignId,
      }],
    }));
    setName(""); setXp(15); setTarget(3); setPassion(false); setCopingIf(""); setCopingThen(""); setSkillIds([]); setCampaignId(null); setAdding(false);
  };

  const remove = (id) => setState((s) => ({ ...s, weeklies: s.weeklies.filter((x) => x.id !== id) }));

  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 };

  return (
    <>
      <SectionTitle right={<GhostBtn onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "+ Weekly"}</GhostBtn>}>
        Weekly Quests{weeklies.length > 0 ? ` · ${hitCount}/${weeklies.length}` : ""}
      </SectionTitle>
      {adding && (
        <Card style={{ marginBottom: 10, background: C.surface2 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input style={{ ...inp, flex: 1 }} placeholder="Weekly quest — e.g. Gym session" value={name} onChange={(e) => setName(e.target.value)} />
            <input style={{ ...inp, width: 58 }} type="number" min="1" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Times per week" title="Times per week" />
            <input style={{ ...inp, width: 64 }} type="number" min="5" value={xp} onChange={(e) => setXp(e.target.value)} aria-label="XP per rep" title="XP per rep" />
          </div>
          <div style={{ fontSize: 11, color: C.dim, margin: "0 0 8px" }}>name · times per week · XP per rep</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input style={{ ...inp, flex: 1 }} placeholder="If I get stuck… (optional)" value={copingIf} onChange={(e) => setCopingIf(e.target.value)} />
            <input style={{ ...inp, flex: 1 }} placeholder="…then I'll" value={copingThen} onChange={(e) => setCopingThen(e.target.value)} />
          </div>
          <SkillPicker skills={state.skills} selected={skillIds} onChange={setSkillIds} label="Feeds skills (optional) — each rep trains them" />
          <CampaignPicker campaigns={state.campaigns} selected={campaignId} onChange={setCampaignId} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <PassionToggle on={passion} onToggle={() => setPassion((p) => !p)} />
            <GhostBtn onClick={add} style={{ flex: 1 }}>Add weekly</GhostBtn>
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>
            Only the weekly count matters — the days flex. The rep that hits the target pays triple, and hitting it week after week builds a streak.
          </div>
        </Card>
      )}
      {weeklies.length === 0 && !adding && <Empty>No weekly quests. Add the "N times a week" habits — gym, German, deep work.</Empty>}
      {weeklies.length > 0 && (
        <Card style={{ marginBottom: 6, borderLeft: `3px solid ${C.gold}`, padding: "8px 14px" }}>
          {weeklies.map((w) => {
            const hit = w.count >= w.target;
            return (
              <div key={w.id} style={{ padding: "8px 0", borderBottom: `1px solid ${C.line}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 14, color: hit ? C.dim : C.parchment }}>
                      {w.name}{w.passion ? <span style={{ color: C.ember }}> ♥</span> : null}
                      {w.streak > 0 && <span style={{ fontSize: 11, color: C.gold, marginLeft: 8 }}>✶ {w.streak} wk streak</span>}
                    </span>
                    {copingLine(w) && <div style={{ fontSize: 11, color: C.dim, fontStyle: "italic" }}>⛨ {copingLine(w)}</div>}
                    {(w.skillIds || []).length > 0 && (
                      <div style={{ fontSize: 11, color: C.arcane }}>
                        → feeds {(w.skillIds || []).map((id) => (state.skills.find((k) => k.id === id) || {}).name).filter(Boolean).join(", ")}
                      </div>
                    )}
                    {w.campaignId && ((state.campaigns || []).find((c) => c.id === w.campaignId) || null) && (
                      <div style={{ fontSize: 11, color: C.gold }}>⚐ {(state.campaigns || []).find((c) => c.id === w.campaignId).title}</div>
                    )}
                  </div>
                  <span style={{ fontSize: 12, color: hit ? C.moss : C.dim, whiteSpace: "nowrap" }}>{w.count}/{w.target}{hit ? " ✓" : ""}</span>
                  <GhostBtn color={C.gold} onClick={() => rep(w)} style={{ padding: "5px 12px", fontSize: 13 }}>+1</GhostBtn>
                  <button onClick={() => remove(w.id)} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, padding: "0 2px" }} aria-label={`Remove ${w.name}`}>×</button>
                </div>
                <div style={{ marginTop: 6 }}><Bar frac={w.count / w.target} color={hit ? C.moss : C.gold} height={5} /></div>
              </div>
            );
          })}
        </Card>
      )}
      {weeklies.length > 0 && (
        <div style={{ fontSize: 11, color: C.dim, margin: "2px 4px 0" }}>Counts reset each Monday. Hit the target to keep the ✶ streak alive.</div>
      )}
    </>
  );
}

/* ── Weekly boss (with optional hard prerequisite) ── */
function BossSection({ state, setState, grantXp }) {
  const [name, setName] = useState("");
  const [xp, setXp] = useState(250);
  const [reqName, setReqName] = useState("");
  const [reqTarget, setReqTarget] = useState(3);
  const boss = state.boss;

  const summon = () => {
    if (!name.trim()) return;
    const req = reqName.trim()
      ? { name: reqName.trim(), target: Math.max(1, Number(reqTarget) || 3), count: 0 }
      : null;
    setState((s) => ({ ...s, boss: { id: uid(), name: name.trim(), xp: Math.max(50, Number(xp) || 250), weekId: weekId(), defeated: false, req } }));
    setName(""); setXp(250); setReqName(""); setReqTarget(3);
  };

  const repInc = () => {
    setState((s) => ({ ...s, boss: { ...s.boss, req: { ...s.boss.req, count: s.boss.req.count + 1 } } }));
    grantXp(REQ_REP_XP, `${boss.req.name} (${boss.req.count + 1}/${boss.req.target})`);
  };

  const defeat = () => {
    const purse = Math.round(boss.xp / 5);
    setState((s) => ({
      ...s,
      boss: { ...s.boss, defeated: true },
      player: { ...s.player, gold: (s.player.gold || 0) + purse },
      chronicle: [{ id: uid(), date: todayStr(), text: `Boss defeated — ${s.boss.name} (+${purse}g purse)`, xp: s.boss.xp, type: "boss" }, ...s.chronicle],
    }));
    grantXp(boss.xp, `Boss defeated: ${boss.name}`);
  };

  const flee = () => setState((s) => ({ ...s, boss: null }));

  const locked = boss && boss.req && boss.req.count < boss.req.target;
  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 };

  return (
    <>
      <SectionTitle color={C.ember}>Weekly Boss</SectionTitle>
      {!boss && (
        <Card style={{ marginBottom: 6, borderLeft: `3px solid ${C.ember}` }}>
          <div style={{ fontSize: 13, color: C.dim, marginBottom: 10 }}>
            Name one hard thing to slay this week. Big XP plus a gold purse. Optionally lock it behind a rite — reps you must complete before you can strike.
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input style={{ ...inp, flex: 1 }} placeholder="Boss — e.g. Finish the cover letter" value={name} onChange={(e) => setName(e.target.value)} />
            <input style={{ ...inp, width: 72 }} type="number" min="50" value={xp} onChange={(e) => setXp(e.target.value)} aria-label="XP reward" />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input style={{ ...inp, flex: 1 }} placeholder="Rite (optional) — e.g. Submit application" value={reqName} onChange={(e) => setReqName(e.target.value)} />
            <input style={{ ...inp, width: 72 }} type="number" min="1" value={reqTarget} onChange={(e) => setReqTarget(e.target.value)} aria-label="Reps required" />
          </div>
          <button onClick={summon} style={{ width: "100%", marginTop: 10, background: C.ember, color: C.bg, border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 14 }}>
            Summon boss
          </button>
        </Card>
      )}
      {boss && !boss.defeated && (
        <Card style={{ marginBottom: 6, borderLeft: `3px solid ${C.ember}`, background: `linear-gradient(180deg, ${C.surface2}, ${C.surface})` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div className="display" style={{ fontSize: 17, fontWeight: 700, color: C.ember }}>☠ {boss.name}</div>
            <div style={{ fontSize: 12, color: C.gold, whiteSpace: "nowrap" }}>+{boss.xp} XP · +{Math.round(boss.xp / 5)}g</div>
          </div>
          {boss.req && (
            <div style={{ margin: "10px 0 4px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: locked ? C.parchment : C.moss, marginBottom: 5 }}>
                <span>Rite: {boss.req.name} · +{REQ_REP_XP} XP each</span>
                <span>{boss.req.count}/{boss.req.target}{!locked && " ✓"}</span>
              </div>
              <Bar frac={boss.req.count / boss.req.target} color={locked ? C.ember : C.moss} height={6} />
              {locked && (
                <GhostBtn color={C.ember} onClick={repInc} style={{ width: "100%", marginTop: 8 }}>
                  +1 {boss.req.name}
                </GhostBtn>
              )}
            </div>
          )}
          <div style={{ fontSize: 12, color: C.dim, margin: "8px 0 12px" }}>
            {locked ? "The boss is shielded. Complete the rite to break its ward." : "This week's raid. Fell it before Sunday ends."}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={defeat} disabled={locked}
              style={{ flex: 1, background: locked ? C.surface : C.ember, color: locked ? C.dim : C.bg, border: locked ? `1px solid ${C.line}` : "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 14, cursor: locked ? "not-allowed" : "pointer" }}>
              {locked ? "⛨ Warded" : "Strike the killing blow"}
            </button>
            <GhostBtn color={C.dim} onClick={flee} style={{ fontSize: 12 }}>Flee</GhostBtn>
          </div>
        </Card>
      )}
      {boss && boss.defeated && (
        <Card style={{ marginBottom: 6, borderLeft: `3px solid ${C.moss}`, textAlign: "center" }}>
          <div className="display" style={{ fontSize: 15, fontWeight: 700, color: C.moss }}>☠ {boss.name} — defeated</div>
          <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>A new boss can be summoned Monday.</div>
        </Card>
      )}
    </>
  );
}

/* ── Quest form (with AI drafting) ── */
function QuestForm({ skills, onCreate }) {
  const [title, setTitle] = useState("");
  const [tier, setTier] = useState("side");
  const [skillIds, setSkillIds] = useState([]);
  const [passion, setPassion] = useState(false);
  const [notes, setNotes] = useState("");
  const [copingIf, setCopingIf] = useState("");
  const [copingThen, setCopingThen] = useState("");
  const [subs, setSubs] = useState([{ id: uid(), text: "", xp: 20, type: "check" }]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState(null);

  const setSub = (id, patch) => setSubs((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const draftWithAI = async () => {
    if (!title.trim()) { setAiErr("Type the quest goal in the name field first, then draft."); return; }
    setAiBusy(true); setAiErr(null);
    try {
      const out = await askClaudeJSON({
        system: 'You design quests for a personal life-RPG. Given a real-life goal, return ONLY valid JSON, no markdown fences, no preamble: {"tier":"side|main","subtasks":[{"text":"...","xp":number,"type":"check|tally"}]}. Rules: 3-6 subtasks; "check" for one-time steps, "tally" for repeatable countable actions (e.g. "Application submitted"); xp between 10-100 scaled to effort; tier reflects overall scope (side=days, main=weeks or a few months at most). Subtask text under 60 characters, concrete and verifiable. If the user provides additional context (their current level, constraints, or what done looks like), use it to calibrate the difficulty and specificity of the subtasks to their situation.',
        prompt: notes.trim()
          ? `Goal: ${title.trim()}\nAdditional context from the user: ${notes.trim()}`
          : `Goal: ${title.trim()}`,
        maxTokens: 500,
      });
      if (out.tier && TIERS[out.tier] && out.tier !== "epic") setTier(out.tier);
      if (Array.isArray(out.subtasks) && out.subtasks.length) {
        setSubs(out.subtasks.slice(0, 6).map((s) => ({
          id: uid(),
          text: String(s.text || "").slice(0, 80),
          xp: Math.min(100, Math.max(5, Number(s.xp) || 20)),
          type: s.type === "tally" ? "tally" : "check",
        })));
      }
    } catch (e) {
      setAiErr(e.message);
    }
    setAiBusy(false);
  };

  const create = () => {
    const cleaned = subs.filter((s) => s.text.trim());
    if (!title.trim() || cleaned.length === 0) return;
    onCreate({
      id: uid(), title: title.trim(), tier, skillIds, passion, createdAt: todayStr(),
      copingIf: copingIf.trim(), copingThen: copingThen.trim(),
      subtasks: cleaned.map((s) => ({
        id: s.id, text: s.text.trim(), xp: Math.max(5, Number(s.xp) || 20),
        type: s.type, done: false, count: 0,
      })),
    });
  };

  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14, width: "100%" };

  return (
    <Card style={{ marginBottom: 16, background: C.surface2 }}>
      <input style={inp} placeholder="Quest name — e.g. Learn SQL for BA roles" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea
        style={{ ...inp, marginTop: 8, minHeight: 68, resize: "vertical", lineHeight: 1.5 }}
        placeholder="Context for the AI (optional) — your current level, constraints, what done looks like"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
        <GhostBtn color={C.arcane} onClick={draftWithAI} disabled={aiBusy} style={{ flex: 1 }}>
          {aiBusy ? "Drafting…" : "✨ Draft objectives with AI"}
        </GhostBtn>
      </div>
      {aiErr && <div style={{ color: C.ember, fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>{aiErr}</div>}

      <div style={{ display: "flex", gap: 6, margin: "2px 0 10px" }}>
        {Object.entries(TIERS).filter(([k]) => k !== "epic").map(([k, t]) => (
          <button key={k} onClick={() => setTier(k)}
            style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, border: `1px solid ${tier === k ? t.color : C.line}`, background: tier === k ? `${t.color}22` : "transparent", color: tier === k ? t.color : C.dim }}>
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.dim, margin: "-4px 0 10px" }}>
        Goals measured in months belong in a ⚐ Campaign now — epics have retired.
      </div>

      <div style={{ display: "flex", gap: 6, margin: "0 0 10px" }}>
        <input style={{ ...inp, flex: 1 }} placeholder="If I get stuck… (optional)" value={copingIf} onChange={(e) => setCopingIf(e.target.value)} />
        <input style={{ ...inp, flex: 1 }} placeholder="…then I'll" value={copingThen} onChange={(e) => setCopingThen(e.target.value)} />
      </div>
      <div style={{ fontSize: 11, color: C.dim, margin: "-4px 0 10px" }}>
        Coping plan — name the likely obstacle and your countermove now, before it happens.
      </div>

      <div style={{ fontSize: 12, color: C.dim, margin: "4px 0 8px" }}>
        Objectives — tap the left button to switch between ✓ one-time step and № running tally
      </div>
      {subs.map((s) => (
        <div key={s.id} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <button onClick={() => setSub(s.id, { type: s.type === "check" ? "tally" : "check" })}
            title={s.type === "check" ? "One-time step" : "Running tally"}
            style={{ width: 40, borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, color: s.type === "tally" ? C.gold : C.moss, fontSize: 14 }}>
            {s.type === "tally" ? "№" : "✓"}
          </button>
          <input style={{ ...inp, flex: 1 }} placeholder={s.type === "tally" ? "Tally — e.g. Application submitted" : "Objective"} value={s.text} onChange={(e) => setSub(s.id, { text: e.target.value })} />
          <input style={{ ...inp, width: 62 }} type="number" min="5" value={s.xp} onChange={(e) => setSub(s.id, { xp: e.target.value })} aria-label="XP value" />
          {subs.length > 1 && (
            <button onClick={() => setSubs((ss) => ss.filter((x) => x.id !== s.id))} aria-label="Remove objective"
              style={{ background: "none", border: "none", color: C.dim, fontSize: 16, padding: "0 2px" }}>×</button>
          )}
        </div>
      ))}

      <SkillPicker skills={skills} selected={skillIds} onChange={setSkillIds} />

      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
        <GhostBtn color={C.dim} onClick={() => setSubs((ss) => [...ss, { id: uid(), text: "", xp: 20, type: "check" }])}>+ Objective</GhostBtn>
        <PassionToggle on={passion} onToggle={() => setPassion((p) => !p)} compact />
        <button onClick={create} style={{ flex: 1, background: C.gold, color: C.bg, border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, padding: "9px 0" }}>
          Post quest
        </button>
      </div>
    </Card>
  );
}

/* ── Quest editor (post-creation, behind the "goal changed" confirmation) ── */
function QuestEditor({ q, onSave, onCancel }) {
  const tier = TIERS[q.tier];
  const [title, setTitle] = useState(q.title);
  const [objs, setObjs] = useState(q.subtasks.map((st) => ({ ...st })));

  const patch = (id, p) => setObjs((oo) => oo.map((o) => (o.id === id ? { ...o, ...p } : o)));
  const del = (id) => setObjs((oo) => (oo.length > 1 ? oo.filter((o) => o.id !== id) : oo));
  const add = () => setObjs((oo) => [...oo, { id: uid(), text: "", xp: 20, type: "check", done: false, count: 0, isNew: true }]);

  const save = () => {
    const cleaned = objs
      .filter((o) => o.text.trim())
      .map(({ isNew, ...o }) => ({ ...o, text: o.text.trim(), xp: Math.max(5, Number(o.xp) || 20) }));
    if (!title.trim() || cleaned.length === 0) return;
    onSave({ title: title.trim(), subtasks: cleaned });
  };

  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 };

  return (
    <Card style={{ marginBottom: 14, borderLeft: `3px solid ${tier.color}`, background: C.surface2 }}>
      <div style={{ fontSize: 11, color: tier.color, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 8 }}>Editing · {tier.label}</div>
      <input style={{ ...inp, width: "100%", marginBottom: 8 }} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Quest name" />
      {objs.map((o) => (
        <div key={o.id} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
          {o.isNew ? (
            <button onClick={() => patch(o.id, { type: o.type === "check" ? "tally" : "check" })}
              title={o.type === "check" ? "One-time step" : "Running tally"}
              style={{ width: 40, alignSelf: "stretch", borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, color: o.type === "tally" ? C.gold : C.moss, fontSize: 14 }}>
              {o.type === "tally" ? "№" : "✓"}
            </button>
          ) : (
            <span title={o.type === "tally" ? `Running tally · ${o.count || 0} so far` : o.done ? "Already done" : "One-time step"}
              style={{ width: 40, alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, border: `1px solid ${C.line}`, color: o.done ? C.moss : C.dim, fontSize: 14 }}>
              {o.type === "tally" ? `№${o.count || 0}` : o.done ? "✓" : "○"}
            </span>
          )}
          <input style={{ ...inp, flex: 1, textDecoration: o.done ? "line-through" : "none" }} value={o.text} onChange={(e) => patch(o.id, { text: e.target.value })} placeholder="Objective" />
          <input style={{ ...inp, width: 62 }} type="number" min="5" value={o.xp} onChange={(e) => patch(o.id, { xp: e.target.value })} aria-label="XP value" />
          <button onClick={() => del(o.id)} disabled={objs.length <= 1} aria-label="Remove objective"
            style={{ background: "none", border: "none", color: C.dim, fontSize: 16, padding: "0 2px", opacity: objs.length <= 1 ? 0.3 : 1, cursor: objs.length <= 1 ? "not-allowed" : "pointer" }}>×</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
        <GhostBtn color={C.dim} onClick={add}>+ Objective</GhostBtn>
        <button onClick={save} style={{ flex: 1, background: tier.color, color: C.bg, border: "none", borderRadius: 8, fontWeight: 700, fontSize: 14, padding: "9px 0" }}>
          Save changes
        </button>
        <GhostBtn color={C.dim} onClick={onCancel}>Cancel</GhostBtn>
      </div>
    </Card>
  );
}

/* ── Campaigns: months-long goals — milestones mark the road ── */
function CampaignsView({ state, setState, grantXp }) {
  const [title, setTitle] = useState("");
  const [sequential, setSequential] = useState(true);
  const [confirmAbandon, setConfirmAbandon] = useState(null);
  const campaigns = state.campaigns || [];

  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 };

  const found = () => {
    if (!title.trim()) return;
    setState((s) => ({
      ...s,
      campaigns: [...(s.campaigns || []), { id: uid(), title: title.trim(), createdAt: todayStr(), sequential, milestones: [] }],
    }));
    setTitle(""); setSequential(true);
  };

  const patchCampaign = (cid, fn) =>
    setState((s) => ({ ...s, campaigns: s.campaigns.map((c) => (c.id === cid ? fn(c) : c)) }));

  const claim = (c, m) => {
    setState((s) => ({
      ...s,
      campaigns: s.campaigns.map((cc) => cc.id !== c.id ? cc : {
        ...cc,
        milestones: cc.milestones.map((mm) => (mm.id === m.id ? { ...mm, claimedAt: todayStr() } : mm)),
      }),
      chronicle: [{ id: uid(), date: todayStr(), text: `Milestone claimed — ${c.title}: ${m.title}`, xp: m.xp, type: "milestone" }, ...s.chronicle],
    }));
    grantXp(m.xp, `Milestone: ${m.title}`);
  };

  const abandon = (cid) => {
    const c = campaigns.find((x) => x.id === cid);
    setState((s) => ({
      ...s,
      campaigns: s.campaigns.filter((x) => x.id !== cid),
      chronicle: [{ id: uid(), date: todayStr(), text: `Campaign closed — ${c.title}`, xp: 0, type: "note" }, ...s.chronicle],
    }));
    setConfirmAbandon(null);
  };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      <SectionTitle>Campaigns</SectionTitle>
      <div style={{ fontSize: 12, color: C.dim, margin: "0 2px 10px", lineHeight: 1.5 }}>
        A campaign is one big goal measured in months. Milestones mark the road; the commitments you tag to it keep the pace.
      </div>
      <Card style={{ marginBottom: 16, background: C.surface2 }}>
        <input style={{ ...inp, width: "100%", marginBottom: 8 }} placeholder="Campaign — e.g. Germany Prep" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={() => setSequential((x) => !x)}
            style={{ background: sequential ? `${C.arcane}22` : "transparent", border: `1px solid ${sequential ? C.arcane : C.line}`, color: sequential ? C.arcane : C.dim, borderRadius: 999, padding: "6px 12px", fontSize: 12 }}>
            {sequential ? "⛓ Milestones unlock in order" : "Milestones all open"}
          </button>
          <GhostBtn onClick={found} style={{ flex: 1 }}>Found campaign</GhostBtn>
        </div>
      </Card>

      {campaigns.length === 0 && <Empty>No campaigns yet — found one for a goal measured in months, not weeks.</Empty>}
      {campaigns.map((c) => (
        <CampaignCard key={c.id} c={c}
          dailies={state.dailies.filter((d) => d.campaignId === c.id)}
          weeklies={(state.weeklies || []).filter((w) => w.campaignId === c.id)}
          onCompleteDaily={(d) => completeDaily(setState, grantXp, d)}
          onWeeklyRep={(w) => weeklyRep(setState, grantXp, w)}
          onPatch={(fn) => patchCampaign(c.id, fn)}
          onClaim={(m) => claim(c, m)}
          onAbandon={() => setConfirmAbandon(c.id)}
        />
      ))}

      {confirmAbandon && (
        <Modal onClose={() => setConfirmAbandon(null)}>
          <Card style={{ borderLeft: `3px solid ${C.ember}`, background: C.surface2 }}>
            <div className="display" style={{ fontSize: 15, fontWeight: 700, color: C.ember, marginBottom: 8 }}>Close this campaign?</div>
            <div style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>
              Its milestones, tasks, and progress will be removed. Claimed rewards and chronicle entries stay yours. Commitments tagged to it survive as ordinary quests.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => abandon(confirmAbandon)}
                style={{ flex: 1, background: C.ember, color: C.bg, border: "none", borderRadius: 8, padding: "10px 0", fontWeight: 700, fontSize: 13 }}>
                Close campaign
              </button>
              <GhostBtn color={C.dim} onClick={() => setConfirmAbandon(null)}>Cancel</GhostBtn>
            </div>
          </Card>
        </Modal>
      )}
    </div>
  );
}

function CampaignCard({ c, dailies, weeklies, onCompleteDaily, onWeeklyRep, onPatch, onClaim, onAbandon }) {
  const [mTitle, setMTitle] = useState("");
  const [mXp, setMXp] = useState(100);
  const frac = campaignFrac(c);
  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "9px 11px", fontSize: 13 };

  const addMilestone = () => {
    if (!mTitle.trim()) return;
    onPatch((cc) => ({
      ...cc,
      milestones: [...cc.milestones, { id: uid(), title: mTitle.trim(), xp: Math.max(10, Number(mXp) || 100), claimedAt: null, tasks: [] }],
    }));
    setMTitle(""); setMXp(100);
  };

  return (
    <Card style={{ marginBottom: 16, borderLeft: `3px solid ${C.gold}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div className="display" style={{ fontSize: 18, fontWeight: 700 }}>⚐ {c.title}</div>
        <span className="display" style={{ fontSize: 15, fontWeight: 700, color: C.gold, whiteSpace: "nowrap" }}>{Math.round(frac * 100)}%</span>
      </div>
      <div style={{ margin: "10px 0 4px" }}><Bar frac={frac} color={C.gold} /></div>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 6 }}>
        {c.sequential ? "⛓ milestones unlock in order" : "all milestones open"} · founded {fmtDate(c.createdAt)}
      </div>

      {c.milestones.map((m, i) => (
        <MilestoneBlock key={m.id} m={m}
          locked={c.sequential && c.milestones.slice(0, i).some((x) => !x.claimedAt)}
          onPatch={(fn) => onPatch((cc) => ({ ...cc, milestones: cc.milestones.map((mm) => (mm.id === m.id ? fn(mm) : mm)) }))}
          onRemove={() => onPatch((cc) => ({ ...cc, milestones: cc.milestones.filter((mm) => mm.id !== m.id) }))}
          onClaim={() => onClaim(m)}
        />
      ))}

      <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
        <input style={{ ...inp, flex: 1 }} placeholder="New milestone — e.g. Python foundations" value={mTitle} onChange={(e) => setMTitle(e.target.value)} />
        <input style={{ ...inp, width: 64 }} type="number" min="10" value={mXp} onChange={(e) => setMXp(e.target.value)} aria-label="Milestone XP reward" title="XP reward" />
        <GhostBtn onClick={addMilestone}>+ Milestone</GhostBtn>
      </div>

      {(dailies.length > 0 || weeklies.length > 0) && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: C.moss, letterSpacing: ".14em", textTransform: "uppercase", marginBottom: 4 }}>Commitments</div>
          {dailies.map((d) => {
            const done = d.lastDone === todayStr();
            return (
              <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
                <button onClick={() => onCompleteDaily(d)} aria-label={`Complete ${d.name}`}
                  style={{ width: 18, height: 18, borderRadius: 999, flexShrink: 0, border: `1.5px solid ${done ? C.moss : C.dim}`, background: done ? C.moss : "transparent", color: C.bg, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {done ? "✓" : ""}
                </button>
                <span style={{ flex: 1, fontSize: 13, color: done ? C.dim : C.parchment, textDecoration: done ? "line-through" : "none" }}>
                  {d.name}{d.passion ? <span style={{ color: C.ember }}> ♥</span> : null}
                </span>
                <span style={{ fontSize: 11, color: C.dim }}>daily · +{d.xp}</span>
              </div>
            );
          })}
          {weeklies.map((w) => {
            const hit = w.count >= w.target;
            return (
              <div key={w.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
                <span style={{ flex: 1, fontSize: 13, color: hit ? C.dim : C.parchment }}>
                  {w.name}{w.passion ? <span style={{ color: C.ember }}> ♥</span> : null}
                  {w.streak > 0 && <span style={{ fontSize: 11, color: C.gold, marginLeft: 7 }}>✶ {w.streak} wk</span>}
                </span>
                <span style={{ fontSize: 11, color: hit ? C.moss : C.dim, whiteSpace: "nowrap" }}>{w.count}/{w.target}{hit ? " ✓" : ""}</span>
                <GhostBtn color={C.gold} onClick={() => onWeeklyRep(w)} style={{ padding: "3px 10px", fontSize: 12 }}>+1</GhostBtn>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ textAlign: "right", marginTop: 8 }}>
        <button onClick={onAbandon} style={{ background: "none", border: "none", color: C.dim, fontSize: 11, textDecoration: "underline" }}>close campaign</button>
      </div>
    </Card>
  );
}

function MilestoneBlock({ m, locked, onPatch, onRemove, onClaim }) {
  const [taskText, setTaskText] = useState("");
  const [subFor, setSubFor] = useState(null);
  const [subText, setSubText] = useState("");
  const frac = milestoneFrac(m);
  const claimable = !locked && !m.claimedAt && (m.tasks.length === 0 || m.tasks.every(taskDone));
  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "8px 10px", fontSize: 13 };

  const toggleTask = (tid) => onPatch((mm) => ({ ...mm, tasks: mm.tasks.map((t) => (t.id === tid ? { ...t, done: !t.done } : t)) }));
  const toggleSub = (tid, sid) => onPatch((mm) => ({
    ...mm,
    tasks: mm.tasks.map((t) => t.id !== tid ? t : { ...t, subtasks: t.subtasks.map((st) => (st.id === sid ? { ...st, done: !st.done } : st)) }),
  }));
  const addTask = () => {
    if (!taskText.trim()) return;
    onPatch((mm) => ({ ...mm, tasks: [...mm.tasks, { id: uid(), text: taskText.trim(), done: false, subtasks: [] }] }));
    setTaskText("");
  };
  const addSub = (tid) => {
    if (!subText.trim()) return;
    onPatch((mm) => ({
      ...mm,
      tasks: mm.tasks.map((t) => (t.id !== tid ? t : { ...t, subtasks: [...t.subtasks, { id: uid(), text: subText.trim(), done: false }] })),
    }));
    setSubText(""); setSubFor(null);
  };
  const removeTask = (tid) => onPatch((mm) => ({ ...mm, tasks: mm.tasks.filter((t) => t.id !== tid) }));
  const removeSub = (tid, sid) => onPatch((mm) => ({
    ...mm,
    tasks: mm.tasks.map((t) => (t.id !== tid ? t : { ...t, subtasks: t.subtasks.filter((st) => st.id !== sid) })),
  }));

  if (m.claimedAt) {
    return (
      <div style={{ border: `1px solid ${C.moss}55`, borderRadius: 10, padding: "9px 12px", marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 13, color: C.moss }}>✓ {m.title}</span>
        <span style={{ fontSize: 11, color: C.dim }}>claimed {fmtDate(m.claimedAt)} · +{m.xp} XP</span>
      </div>
    );
  }

  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 12, marginTop: 10, opacity: locked ? 0.5 : 1 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div className="display" style={{ flex: 1, fontSize: 14, fontWeight: 700 }}>{m.title}</div>
        <span style={{ fontSize: 11, color: C.gold, whiteSpace: "nowrap" }}>+{m.xp} XP</span>
        {!locked && <button onClick={onRemove} style={{ background: "none", border: "none", color: C.dim, fontSize: 14, padding: "0 2px" }} aria-label={`Remove milestone ${m.title}`}>×</button>}
      </div>
      <div style={{ margin: "8px 0 2px" }}><Bar frac={frac} color={C.arcane} height={5} /></div>

      {locked ? (
        <div style={{ fontSize: 12, color: C.dim, fontStyle: "italic", marginTop: 6 }}>⛓ Sealed until the previous milestone closes.</div>
      ) : (
        <>
          {m.tasks.map((t) => {
            const hasSubs = t.subtasks.length > 0;
            const done = taskDone(t);
            return (
              <div key={t.id} style={{ marginTop: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {hasSubs ? (
                    <span title="Completes when all its steps are done"
                      style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, border: `1.5px solid ${done ? C.moss : C.line}`, background: done ? C.moss : "transparent", color: C.bg, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {done ? "✓" : ""}
                    </span>
                  ) : (
                    <button onClick={() => toggleTask(t.id)} aria-label={`Toggle ${t.text}`}
                      style={{ width: 17, height: 17, borderRadius: 5, flexShrink: 0, border: `1.5px solid ${done ? C.moss : C.dim}`, background: done ? C.moss : "transparent", color: C.bg, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {done ? "✓" : ""}
                    </button>
                  )}
                  <span style={{ flex: 1, fontSize: 13, color: done ? C.dim : C.parchment, textDecoration: done ? "line-through" : "none" }}>{t.text}</span>
                  <button onClick={() => { setSubFor(subFor === t.id ? null : t.id); setSubText(""); }}
                    style={{ background: "none", border: "none", color: C.dim, fontSize: 11, textDecoration: "underline" }}>+ sub</button>
                  <button onClick={() => removeTask(t.id)} style={{ background: "none", border: "none", color: C.dim, fontSize: 13, padding: "0 2px" }} aria-label={`Remove ${t.text}`}>×</button>
                </div>
                {t.subtasks.map((st) => (
                  <div key={st.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, paddingLeft: 25 }}>
                    <button onClick={() => toggleSub(t.id, st.id)} aria-label={`Toggle ${st.text}`}
                      style={{ width: 14, height: 14, borderRadius: 4, flexShrink: 0, border: `1.5px solid ${st.done ? C.moss : C.dim}`, background: st.done ? C.moss : "transparent", color: C.bg, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {st.done ? "✓" : ""}
                    </button>
                    <span style={{ flex: 1, fontSize: 12, color: st.done ? C.dim : C.parchment, textDecoration: st.done ? "line-through" : "none" }}>{st.text}</span>
                    <button onClick={() => removeSub(t.id, st.id)} style={{ background: "none", border: "none", color: C.dim, fontSize: 12, padding: "0 2px" }} aria-label={`Remove ${st.text}`}>×</button>
                  </div>
                ))}
                {subFor === t.id && (
                  <div style={{ display: "flex", gap: 6, marginTop: 5, paddingLeft: 25 }}>
                    <input style={{ ...inp, flex: 1 }} autoFocus placeholder="Step — e.g. finish chapter 3" value={subText}
                      onChange={(e) => setSubText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addSub(t.id)} />
                    <GhostBtn color={C.dim} onClick={() => addSub(t.id)} style={{ padding: "5px 10px", fontSize: 12 }}>Add</GhostBtn>
                  </div>
                )}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input style={{ ...inp, flex: 1 }} placeholder="New task" value={taskText} onChange={(e) => setTaskText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} />
            <GhostBtn color={C.dim} onClick={addTask} style={{ padding: "5px 12px", fontSize: 12 }}>+ Task</GhostBtn>
          </div>
          {claimable && (
            <button onClick={onClaim}
              style={{ width: "100%", marginTop: 10, background: C.gold, color: C.bg, border: "none", borderRadius: 8, padding: "9px 0", fontWeight: 700, fontSize: 13, animation: m.tasks.length > 0 ? "glowpulse 1.6s infinite" : "none" }}>
              Claim milestone · +{m.xp} XP
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* ── Skills (milestones, passion, long-horizon view) ── */

/* 8-week training histogram from logs */
function weeklyCounts(logs) {
  const counts = new Array(8).fill(0);
  const now = new Date();
  for (const g of logs || []) {
    const diff = Math.floor((now - new Date(g.date + "T12:00:00")) / (7 * 24 * 3600 * 1000));
    if (diff >= 0 && diff < 8) counts[7 - diff] += 1;
  }
  return counts;
}

function SkillsView({ state, setState, grantXp }) {
  const [name, setName] = useState("");
  const [newKind, setNewKind] = useState("discipline");
  const [newAbilities, setNewAbilities] = useState([]);
  const [newPassion, setNewPassion] = useState(false);
  const [editing, setEditing] = useState(null);

  const addSkill = () => {
    if (!name.trim()) return;
    setState((s) => ({
      ...s,
      skills: [...s.skills, { id: uid(), name: name.trim(), xp: 0, kind: newKind, abilities: newAbilities, logs: [], passion: newPassion, totalSessions: 0, milestone: null, lastMilestoneLevel: 0 }],
    }));
    setName(""); setNewKind("discipline"); setNewAbilities([]); setNewPassion(false);
  };

  const patchSkill = (skillId, patch) =>
    setState((s) => ({ ...s, skills: s.skills.map((x) => x.id === skillId ? { ...x, ...patch } : x) }));

  const practice = (skillId, p) => {
    const sk = state.skills.find((x) => x.id === skillId);
    setState((s) => applySkillGain(s, skillId, p.xp, p.label));
    grantXp(p.xp, `${sk.name} · ${p.label}`, { noGold: sk.passion });
  };

  const completeMilestone = (skillId) => {
    const sk = state.skills.find((x) => x.id === skillId);
    const m = sk.milestone;
    if (!m) return;
    const reward = milestoneReward(m.level);
    setState((s) => {
      let next = applySkillGain(s, skillId, reward, "Milestone");
      next = {
        ...next,
        skills: next.skills.map((x) => x.id !== skillId ? x : { ...x, milestone: null, lastMilestoneLevel: m.level }),
        chronicle: [{ id: uid(), date: todayStr(), text: `Milestone conquered — ${sk.name}: ${m.text}`, xp: reward, type: "milestone" }, ...next.chronicle],
      };
      return next;
    });
    grantXp(reward, `Milestone: ${m.text}`, { noGold: sk.passion });
  };

  const remove = (id) => setState((s) => ({ ...s, skills: s.skills.filter((x) => x.id !== id) }));

  const renderCard = (sk) => (
    <SkillCard key={sk.id} sk={sk}
      fedBy={[
        ...state.quests.filter((q) => (q.skillIds || []).includes(sk.id)).map((q) => q.title),
        ...state.dailies.filter((d) => (d.skillIds || []).includes(sk.id)).map((d) => d.name),
        ...(state.weeklies || []).filter((w) => (w.skillIds || []).includes(sk.id)).map((w) => w.name),
      ]}
      editing={editing === sk.id}
      onEditToggle={() => setEditing(editing === sk.id ? null : sk.id)}
      onPatch={(p) => patchSkill(sk.id, p)}
      onPractice={(p) => practice(sk.id, p)}
      onMilestoneDone={() => completeMilestone(sk.id)}
      onRemove={() => remove(sk.id)}
    />
  );

  const disciplines = state.skills.filter((k) => k.kind !== "domain");
  const domains = state.skills.filter((k) => k.kind === "domain");

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      <SectionTitle>Skill Tree</SectionTitle>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={newKind === "domain" ? "New domain — e.g. Entrepreneurship" : "New skill — e.g. SQL, Disc Golf"}
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 }} />
          <PassionToggle on={newPassion} onToggle={() => setNewPassion((p) => !p)} compact />
          <GhostBtn onClick={addSkill}>Forge</GhostBtn>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {[["discipline", "Discipline"], ["domain", "Domain"]].map(([k, label]) => (
            <button key={k} onClick={() => setNewKind(k)}
              style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, border: `1px solid ${newKind === k ? C.arcane : C.line}`, background: newKind === k ? `${C.arcane}22` : "transparent", color: newKind === k ? C.arcane : C.dim }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.dim, marginBottom: 8 }}>
          {newKind === "domain"
            ? "Domains are higher-level fields that grow only when quests feed them — no direct practice."
            : "Disciplines are practiced directly, and quests can feed them too."}
        </div>
        <AbilityPicker selected={newAbilities} onChange={setNewAbilities} />
        <div style={{ fontSize: 11, color: C.dim, marginTop: 8 }}>
          ♥ Passion skills earn XP and levels but never gold — the things you love shouldn't become paid work.
        </div>
      </Card>

      <SectionTitle>Disciplines</SectionTitle>
      {disciplines.length === 0 && <Empty>No disciplines yet — forge a skill you practice directly.</Empty>}
      {disciplines.map(renderCard)}

      <SectionTitle color={C.arcane}>Domains</SectionTitle>
      {domains.length === 0 && <Empty>No domains yet — forge one for a broad field that quests will feed.</Empty>}
      {domains.map(renderCard)}
    </div>
  );
}

function SkillCard({ sk, fedBy, editing, onEditToggle, onPatch, onPractice, onMilestoneDone, onRemove }) {
  const isDomain = sk.kind === "domain";
  const l = skillLevel(sk.xp);
  const frac = (sk.xp - skillFloor(l)) / (skillCeil(l) - skillFloor(l));
  const trainedToday = (sk.logs || []).some((g) => g.date === todayStr());
  const links = sk.abilities || [];
  const dueLevel = !sk.milestone ? nextMilestoneLevel(sk) : null;
  const counts = weeklyCounts(sk.logs);
  const maxCount = Math.max(1, ...counts);
  const firstLog = sk.logs && sk.logs.length ? sk.logs[sk.logs.length - 1].date : null;

  const [mText, setMText] = useState("");
  const [suggestions, setSuggestions] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState(null);

  const suggest = async () => {
    setAiBusy(true); setAiErr(null);
    try {
      const out = await askClaudeJSON({
        system: 'You suggest milestone stretch challenges for a personal life-RPG skill. Return ONLY a valid JSON array of exactly 3 strings, no markdown fences. Each is a concrete, verifiable challenge that genuinely stretches someone at the given level — harder than routine practice, completable within a few weeks, under 70 characters.',
        prompt: `Skill: ${sk.name}. Current level: ${l} (milestone at level ${dueLevel}). Total sessions logged: ${sk.totalSessions || 0}. Recent practice quality labels: ${(sk.logs || []).slice(0, 10).map((g) => g.label).join(", ") || "none yet"}.`,
        maxTokens: 300,
      });
      if (Array.isArray(out)) setSuggestions(out.slice(0, 3).map(String));
    } catch (e) {
      setAiErr(e.message);
    }
    setAiBusy(false);
  };

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div className="display" style={{ width: 44, height: 44, borderRadius: 10, border: `1.5px solid ${C.arcane}`, color: C.arcane, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 18 }}>
          {l}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div className="display" style={{ fontSize: 16, fontWeight: 700 }}>
              {sk.name}{sk.passion ? <span style={{ color: C.ember, fontSize: 13 }}> ♥</span> : null}
            </div>
            {trainedToday && <span style={{ fontSize: 11, color: C.moss }}>{isDomain ? "fed today ✓" : "trained today ✓"}</span>}
          </div>
          <div style={{ marginTop: 6 }}><Bar frac={frac} color={C.arcane} /></div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>{sk.xp - skillFloor(l)} / {skillCeil(l) - skillFloor(l)} to Level {l + 1}</div>
        </div>
      </div>

      {/* long-horizon progress */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 26 }}>
          {counts.map((c, i) => (
            <div key={i} title={`${c} sessions`} style={{ width: 9, height: Math.max(3, (c / maxCount) * 26), background: c > 0 ? C.arcane : C.line, borderRadius: 2, opacity: c > 0 ? 0.9 : 0.6 }} />
          ))}
        </div>
        <div style={{ fontSize: 11, color: C.dim, lineHeight: 1.4 }}>
          {isDomain
            ? `${(sk.logs || []).length} quest feeds${firstLog ? ` · growing since ${fmtDate(firstLog)}` : ""} · last 8 weeks`
            : `${sk.totalSessions || 0} sessions total${firstLog ? ` · training since ${fmtDate(firstLog)}` : ""} · last 8 weeks`}
        </div>
      </div>

      {/* milestone: the difficulty ratchet */}
      {sk.milestone && (
        <div style={{ marginTop: 12, border: `1px solid ${C.gold}66`, borderRadius: 10, padding: 12, background: `${C.gold}0d` }}>
          <div style={{ fontSize: 11, color: C.gold, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 4 }}>▲ Active milestone · Level {sk.milestone.level}</div>
          <div style={{ fontSize: 14, marginBottom: 10 }}>{sk.milestone.text}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onMilestoneDone}
              style={{ flex: 1, background: C.gold, color: C.bg, border: "none", borderRadius: 8, padding: "9px 0", fontWeight: 700, fontSize: 13 }}>
              Conquered · +{milestoneReward(sk.milestone.level)} XP
            </button>
            <GhostBtn color={C.dim} onClick={() => onPatch({ milestone: null })} style={{ fontSize: 12 }}>Discard</GhostBtn>
          </div>
        </div>
      )}
      {dueLevel && (
        <div style={{ marginTop: 12, border: `1px dashed ${C.gold}88`, borderRadius: 10, padding: 12 }}>
          <div style={{ fontSize: 12, color: C.gold, marginBottom: 8 }}>
            ▲ Level {dueLevel} milestone unlocked — set a challenge that genuinely stretches you. Routine practice no longer counts as growth.
          </div>
          <input value={mText} onChange={(e) => setMText(e.target.value)} placeholder={`e.g. ${sk.name}: something a level-${dueLevel} you would find hard`}
            style={{ width: "100%", background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "9px 11px", fontSize: 13, marginBottom: 8 }} />
          {suggestions && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
              {suggestions.map((s, i) => (
                <button key={i} onClick={() => setMText(s)}
                  style={{ textAlign: "left", background: `${C.arcane}14`, border: `1px solid ${C.arcane}44`, color: C.parchment, borderRadius: 8, padding: "8px 10px", fontSize: 13 }}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {aiErr && <div style={{ color: C.ember, fontSize: 12, marginBottom: 8, lineHeight: 1.5 }}>{aiErr}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <GhostBtn color={C.arcane} onClick={suggest} disabled={aiBusy}>{aiBusy ? "…" : "✨ Suggest"}</GhostBtn>
            <button onClick={() => mText.trim() && onPatch({ milestone: { level: dueLevel, text: mText.trim() } })}
              style={{ flex: 1, background: C.gold, color: C.bg, border: "none", borderRadius: 8, padding: "9px 0", fontWeight: 700, fontSize: 13 }}>
              Set milestone
            </button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {links.length > 0 ? (
          links.map((aid, i) => {
            const ab = ABILITIES.find((a) => a.id === aid);
            return (
              <span key={aid} style={{ fontSize: 11, color: C.gold, border: `1px solid ${C.gold}55`, borderRadius: 999, padding: "3px 9px" }}>
                {ab.abbr} {i === 0 ? "50%" : "25%"}
              </span>
            );
          })
        ) : (
          <span style={{ fontSize: 11, color: C.dim, fontStyle: "italic" }}>No attributes linked — this skill feeds none.</span>
        )}
        <button onClick={onEditToggle}
          style={{ background: "none", border: "none", color: C.dim, fontSize: 11, textDecoration: "underline" }}>
          {editing ? "done" : "edit"}
        </button>
      </div>
      {editing && (
        <div style={{ marginTop: 10 }}>
          <AbilityPicker selected={links} onChange={(a) => onPatch({ abilities: a })} />
          <div style={{ marginTop: 8 }}>
            <PassionToggle on={!!sk.passion} onToggle={() => onPatch({ passion: !sk.passion })} />
          </div>
        </div>
      )}

      {isDomain ? (
        <div style={{ marginTop: 12, fontSize: 12, color: C.dim }}>
          {fedBy && fedBy.length > 0
            ? <>Fed by: <span style={{ color: C.arcane }}>{fedBy.join(", ")}</span></>
            : <span style={{ fontStyle: "italic" }}>Not yet fed — link a quest or daily to it.</span>}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
          {PRACTICE.map((p) => (
            <button key={p.label} onClick={() => onPractice(p)}
              style={{ flex: 1, background: `${C.arcane}18`, border: `1px solid ${C.arcane}55`, color: C.parchment, borderRadius: 8, padding: "8px 4px", fontSize: 12 }}>
              <div>{p.label}</div>
              <div style={{ color: C.arcane, marginTop: 2 }}>+{p.xp}</div>
            </button>
          ))}
        </div>
      )}
      <div style={{ textAlign: "right", marginTop: 8 }}>
        <button onClick={onRemove} style={{ background: "none", border: "none", color: C.dim, fontSize: 11 }}>{isDomain ? "retire domain" : "retire skill"}</button>
      </div>
    </Card>
  );
}

/* ── Trackers ── */
const METRIC_TYPES = [
  { id: "simple", label: "Simple", hint: "Just observe — a value and its trend, nothing more." },
  { id: "target", label: "Target value", hint: "A value you're moving toward and want to hold. Shown as a calm reference line — no scoring." },
  { id: "nightly", label: "Nightly target", hint: "A per-entry target where the rolling average matters more than any single log." },
];

function TrackersView({ state, setState, showToast }) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [metricType, setMetricType] = useState("simple");
  const [target, setTarget] = useState("");

  const addTracker = () => {
    if (!name.trim()) return;
    const tv = parseFloat(target);
    setState((s) => ({
      ...s,
      trackers: [...s.trackers, {
        id: uid(), name: name.trim(), unit: unit.trim(), entries: [],
        metricType, target: metricType !== "simple" && !isNaN(tv) ? tv : null,
      }],
    }));
    setName(""); setUnit(""); setMetricType("simple"); setTarget("");
  };

  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      <SectionTitle>Vitals</SectionTitle>
      <div style={{ fontSize: 12, color: C.dim, margin: "0 2px 10px" }}>
        Your body's readouts — weight, sleep, mood, whatever you want to measure over time.
      </div>
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input style={{ ...inp, flex: 2 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tracker — e.g. Sleep" />
          <input style={{ ...inp, flex: 1 }} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="unit" />
          <GhostBtn onClick={addTracker}>Add</GhostBtn>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {METRIC_TYPES.map((m) => (
            <button key={m.id} onClick={() => setMetricType(m.id)}
              style={{ flex: 1, padding: "8px 0", borderRadius: 8, fontSize: 12, border: `1px solid ${metricType === m.id ? C.ember : C.line}`, background: metricType === m.id ? `${C.ember}22` : "transparent", color: metricType === m.id ? C.ember : C.dim }}>
              {m.label}
            </button>
          ))}
        </div>
        {metricType !== "simple" && (
          <input style={{ ...inp, width: "100%", marginBottom: 8 }} type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)}
            placeholder={metricType === "nightly" ? "Per-entry target — e.g. 8" : "Target value — e.g. 220"} aria-label="Target value" />
        )}
        <div style={{ fontSize: 11, color: C.dim }}>
          {METRIC_TYPES.find((m) => m.id === metricType).hint}
        </div>
      </Card>

      {state.trackers.map((t) => (
        <TrackerCard key={t.id} t={t} setState={setState} showToast={showToast} />
      ))}
    </div>
  );
}

function TrackerCard({ t, setState, showToast }) {
  const [val, setVal] = useState("");
  const [editingTarget, setEditingTarget] = useState(false);
  const [tgtVal, setTgtVal] = useState("");
  const latest = t.entries[0];
  const first = t.entries[t.entries.length - 1];
  const delta = latest && first && t.entries.length > 1 ? latest.value - first.value : null;
  const type = t.metricType || "simple";
  const target = type !== "simple" && typeof t.target === "number" ? t.target : null;

  const log = () => {
    const v = parseFloat(val);
    if (isNaN(v)) return;
    setState((s) => ({
      ...s,
      trackers: s.trackers.map((x) => x.id !== t.id ? x : { ...x, entries: [{ date: todayStr(), value: v }, ...x.entries].slice(0, 120) }),
    }));
    setVal("");
    showToast(`${t.name} logged: ${v} ${t.unit}`);
  };

  const saveTarget = () => {
    const v = parseFloat(tgtVal);
    if (isNaN(v)) return;
    setState((s) => ({ ...s, trackers: s.trackers.map((x) => x.id !== t.id ? x : { ...x, target: v }) }));
    setTgtVal(""); setEditingTarget(false);
  };

  const remove = () => setState((s) => ({ ...s, trackers: s.trackers.filter((x) => x.id !== t.id) }));

  const round1 = (n) => Math.round(n * 10) / 10;
  /* rolling average over entries logged in the last N days (nightly type) */
  const avgSince = (days) => {
    const cutoff = daysAgoStr(days - 1);
    const win = t.entries.filter((e) => e.date >= cutoff);
    return win.length ? round1(win.reduce((a, e) => a + e.value, 0) / win.length) : null;
  };
  const avg7 = type === "nightly" ? avgSince(7) : null;
  const avg30 = type === "nightly" ? avgSince(30) : null;

  const pts = [...t.entries].reverse().slice(-20);
  let spark = null;
  if (pts.length >= 2) {
    const vals = pts.map((p) => p.value);
    const min = Math.min(...vals, ...(target != null ? [target] : []));
    const max = Math.max(...vals, ...(target != null ? [target] : []));
    const span = max - min || 1;
    const W = 260, H = 44;
    const y = (v) => H - ((v - min) / span) * (H - 6) - 3;
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${(i / (pts.length - 1)) * W},${y(p.value)}`).join(" ");
    spark = (
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ marginTop: 10 }}>
        {target != null && <line x1="0" x2={W} y1={y(target)} y2={y(target)} stroke={C.moss} strokeWidth="1" strokeDasharray="4 3" opacity="0.75" />}
        <path d={path} fill="none" stroke={C.ember} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  /* headline: nightly leads with the rolling average; others lead with the latest value */
  const headline = type === "nightly"
    ? (avg7 != null && (
        <div style={{ textAlign: "right" }}>
          <span className="display" style={{ fontSize: 22, fontWeight: 700, color: C.ember }}>{avg7}</span>
          <span style={{ fontSize: 12, color: C.dim, marginLeft: 4 }}>{t.unit} · 7-day avg</span>
        </div>
      ))
    : (latest && (
        <div style={{ textAlign: "right" }}>
          <span className="display" style={{ fontSize: 22, fontWeight: 700, color: C.ember }}>{latest.value}</span>
          <span style={{ fontSize: 12, color: C.dim, marginLeft: 4 }}>{t.unit}</span>
        </div>
      ));

  /* per-type info line — informational only, no judgment */
  let info = null;
  if (type === "target" && target != null) {
    info = (
      <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>
        Target {target} {t.unit}{latest ? <> · currently {round1(Math.abs(latest.value - target))} {t.unit} away</> : null}
      </div>
    );
  } else if (type === "nightly") {
    info = (
      <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>
        30-day avg {avg30 != null ? `${avg30} ${t.unit}` : "—"}{target != null ? <> · target {target} {t.unit}</> : null}{latest ? <> · last {latest.value}</> : null}
      </div>
    );
  } else if (delta !== null) {
    info = (
      <div style={{ fontSize: 12, color: C.dim, marginTop: 2 }}>
        {delta > 0 ? "+" : ""}{round1(delta)} {t.unit} since first entry · {t.entries.length} logs
      </div>
    );
  }

  return (
    <Card style={{ marginBottom: 14, borderLeft: `3px solid ${C.ember}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div className="display" style={{ fontSize: 16, fontWeight: 700 }}>{t.name}</div>
        {headline}
      </div>
      {info}
      {spark}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input type="number" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} placeholder={`Today's ${t.name.toLowerCase()}`}
          style={{ flex: 1, background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 }} />
        <GhostBtn color={C.ember} onClick={log}>Log</GhostBtn>
      </div>
      {editingTarget && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input type="number" inputMode="decimal" value={tgtVal} onChange={(e) => setTgtVal(e.target.value)} placeholder={`Target ${t.name.toLowerCase()}${t.unit ? ` (${t.unit})` : ""}`}
            onKeyDown={(e) => e.key === "Enter" && saveTarget()}
            style={{ flex: 1, background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 }} />
          <GhostBtn color={C.moss} onClick={saveTarget}>Set</GhostBtn>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 14, marginTop: 8 }}>
        {type !== "simple" && (
          <button onClick={() => setEditingTarget((x) => !x)} style={{ background: "none", border: "none", color: C.dim, fontSize: 11 }}>
            {editingTarget ? "cancel" : target != null ? "change target" : "set target"}
          </button>
        )}
        <button onClick={remove} style={{ background: "none", border: "none", color: C.dim, fontSize: 11 }}>remove tracker</button>
      </div>
    </Card>
  );
}

/* ── Reward Shop ── */
function ShopView({ state, setState, showToast }) {
  const [name, setName] = useState("");
  const [cost, setCost] = useState(100);
  const gold = state.player.gold || 0;

  const add = () => {
    if (!name.trim()) return;
    setState((s) => ({ ...s, rewards: [...s.rewards, { id: uid(), name: name.trim(), cost: Math.max(1, Number(cost) || 100) }] }));
    setName(""); setCost(100);
  };

  const redeem = (r) => {
    if (gold < r.cost) return;
    setState((s) => ({
      ...s,
      player: { ...s.player, gold: (s.player.gold || 0) - r.cost },
      chronicle: [{ id: uid(), date: todayStr(), text: `Reward claimed — ${r.name}`, xp: 0, gold: -r.cost, type: "purchase" }, ...s.chronicle],
    }));
    showToast(`⚜ Redeemed: ${r.name} — now go enjoy it for real`);
  };

  const remove = (id) => setState((s) => ({ ...s, rewards: s.rewards.filter((x) => x.id !== id) }));

  const inp = { background: C.bg, border: `1px solid ${C.line}`, color: C.parchment, borderRadius: 8, padding: "10px 12px", fontSize: 14 };

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      <SectionTitle>Reward Shop</SectionTitle>
      <Card style={{ marginBottom: 14, textAlign: "center", borderColor: `${C.gold}55` }}>
        <div style={{ fontSize: 11, color: C.dim, letterSpacing: ".16em", textTransform: "uppercase" }}>Your purse</div>
        <div className="display" style={{ fontSize: 40, fontWeight: 700, color: C.gold, margin: "4px 0 2px" }}>{gold}g</div>
        <div style={{ fontSize: 12, color: C.dim }}>Earned from effortful tasks (♥ passion items stay gold-free), plus boss purses and surprise drops.</div>
      </Card>

      <div style={{ fontSize: 12, color: C.dim, margin: "0 2px 10px", lineHeight: 1.5 }}>
        Stock this shop with real-life treats, priced by how much they should cost you in effort. The one rule: when you redeem something here, you actually do it out there.
      </div>

      <Card style={{ marginBottom: 16, display: "flex", gap: 6, background: C.surface2 }}>
        <input style={{ ...inp, flex: 1 }} placeholder="Reward — e.g. Weekend hike trip" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ ...inp, width: 76 }} type="number" min="1" value={cost} onChange={(e) => setCost(e.target.value)} aria-label="Gold cost" />
        <GhostBtn onClick={add}>Stock</GhostBtn>
      </Card>

      {state.rewards.length === 0 && <Empty>The shelves are empty. Stock a treat worth working for.</Empty>}
      {state.rewards.map((r) => {
        const affordable = gold >= r.cost;
        return (
          <Card key={r.id} style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 12, borderLeft: `3px solid ${affordable ? C.gold : C.line}` }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15 }}>{r.name}</div>
              {!affordable && (
                <div style={{ fontSize: 11, color: C.dim, marginTop: 3 }}>{r.cost - gold}g to go</div>
              )}
            </div>
            <div className="display" style={{ fontWeight: 700, color: affordable ? C.gold : C.dim, whiteSpace: "nowrap" }}>{r.cost}g</div>
            <button onClick={() => redeem(r)} disabled={!affordable}
              style={{ background: affordable ? C.gold : "transparent", color: affordable ? C.bg : C.dim, border: affordable ? "none" : `1px solid ${C.line}`, borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: affordable ? "pointer" : "not-allowed" }}>
              Redeem
            </button>
            <button onClick={() => remove(r.id)} style={{ background: "none", border: "none", color: C.dim, fontSize: 14 }} aria-label={`Remove ${r.name}`}>×</button>
          </Card>
        );
      })}
    </div>
  );
}

/* ── Chronicle ── */
function ChronicleView({ state }) {
  const quests = state.chronicle.filter((e) => e.type === "quest");
  const bosses = state.chronicle.filter((e) => e.type === "boss");
  const milestones = state.chronicle.filter((e) => e.type === "milestone");
  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "24px 16px" }}>
      <SectionTitle color={C.ember}>Bosses Slain</SectionTitle>
      {bosses.length === 0 && <Empty>No bosses defeated yet.</Empty>}
      {bosses.map((e) => (
        <Card key={e.id} style={{ marginBottom: 8, borderLeft: `3px solid ${C.ember}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14 }}>☠ {e.text.replace("Boss defeated — ", "")}</div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{fmtDate(e.date)}</div>
          </div>
          <div className="display" style={{ color: C.ember, fontWeight: 700 }}>+{e.xp}</div>
        </Card>
      ))}

      <SectionTitle>Milestones Conquered</SectionTitle>
      {milestones.length === 0 && <Empty>No milestones yet — they unlock as your skills level up.</Empty>}
      {milestones.map((e) => (
        <Card key={e.id} style={{ marginBottom: 8, borderLeft: `3px solid ${C.gold}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14 }}>▲ {e.text.replace("Milestone conquered — ", "")}</div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{fmtDate(e.date)}</div>
          </div>
          <div className="display" style={{ color: C.gold, fontWeight: 700 }}>+{e.xp}</div>
        </Card>
      ))}

      <SectionTitle>Completed Quests</SectionTitle>
      {quests.length === 0 && <Empty>No quests completed yet. Glory awaits.</Empty>}
      {quests.map((e) => (
        <Card key={e.id} style={{ marginBottom: 8, borderLeft: `3px solid ${C.gold}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14 }}>{e.text.replace("Quest complete — ", "")}</div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{fmtDate(e.date)}</div>
          </div>
          <div className="display" style={{ color: C.gold, fontWeight: 700 }}>+{e.xp}</div>
        </Card>
      ))}

      <SectionTitle>Full Chronicle</SectionTitle>
      {state.chronicle.length === 0 && <Empty>Every deed you do will be recorded here.</Empty>}
      {state.chronicle.map((e) => <ChronicleRow key={e.id} e={e} />)}
    </div>
  );
}

const ChronicleRow = ({ e }) => {
  const special = ["levelup", "achievement", "boss", "purchase", "milestone", "review", "target"].includes(e.type);
  const color = e.type === "boss" ? C.ember : e.type === "purchase" ? C.moss : e.type === "target" ? C.moss : e.type === "review" ? C.arcane : special ? C.gold : C.parchment;
  const icon = e.type === "levelup" ? "⭑ " : e.type === "achievement" ? "❖ " : e.type === "boss" ? "☠ " : e.type === "purchase" ? "⚜ " : e.type === "milestone" ? "▲ " : e.type === "review" ? "⚖ " : e.type === "target" ? "◎ " : "";
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "9px 2px", borderBottom: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 11, color: C.dim, width: 52, flexShrink: 0 }}>{fmtDate(e.date)}</span>
      <span style={{ flex: 1, fontSize: 13, color, fontWeight: special ? 700 : 400 }}>
        {icon}
        {special ? e.text : (
          <>
            <span className="display" style={{ color: C.ember, fontSize: 15 }}>{e.text.charAt(0)}</span>
            {e.text.slice(1)}
          </>
        )}
      </span>
      {e.xp > 0 && <span style={{ fontSize: 12, color: C.gold, whiteSpace: "nowrap" }}>+{e.xp}</span>}
      {e.gold < 0 && <span style={{ fontSize: 12, color: C.ember, whiteSpace: "nowrap" }}>{e.gold}g</span>}
    </div>
  );
};

/* ── Tab bar ── */
function TabBar({ tab, setTab }) {
  const tabs = [
    { id: "character", label: "Character", icon: "◈" },
    { id: "quests", label: "Quests", icon: "⚔" },
    { id: "campaigns", label: "Campaigns", icon: "⚐" },
    { id: "skills", label: "Skills", icon: "✦" },
    { id: "trackers", label: "Vitals", icon: "♥" },
    { id: "shop", label: "Shop", icon: "⚜" },
    { id: "chronicle", label: "Chronicle", icon: "❦" },
  ];
  return (
    <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: `${C.surface}f2`, backdropFilter: "blur(10px)", borderTop: `1px solid ${C.line}`, display: "flex", justifyContent: "space-around", padding: "8px 2px calc(8px + env(safe-area-inset-bottom))", zIndex: 40 }}>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => setTab(t.id)} aria-label={t.label}
          style={{ background: "transparent", border: "none", color: tab === t.id ? C.gold : C.dim, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, fontSize: 10, minWidth: 48, padding: "4px 0" }}>
          <span style={{ fontSize: 17, lineHeight: 1 }}>{t.icon}</span>
          <span className={tab === t.id ? "display" : ""} style={{ letterSpacing: ".03em" }}>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
