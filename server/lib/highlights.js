import Anthropic from "@anthropic-ai/sdk";

// Lazy singleton — don't throw at import when ANTHROPIC_API_KEY is unset.
let _anthropic = null;
function anthropic() {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Claude not configured: set ANTHROPIC_API_KEY");
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

// transcript: [{ start: seconds, end: seconds, text }]
// Returns up to `count` highlight ranges: [{ start, end, title, caption }]
export async function pickHighlights(transcript, count, maxSeconds) {
  const scoped = transcript.filter((c) => c.start <= maxSeconds);
  if (scoped.length === 0) return [];

  // Compact the transcript so the model sees timestamped lines it can cite.
  const lines = scoped
    .map((c) => `[${fmt(c.start)}-${fmt(c.end)}] ${c.text.replace(/\s+/g, " ").trim()}`)
    .join("\n")
    .slice(0, 90000);

  const sys =
    "You are a short-form video editor for a GTA 6 clipping tool. " +
    "From a stream transcript you select the most viral, self-contained 15-45 second moments " +
    "for TikTok / Reels / Shorts. Prioritize: funny fails, clutch plays, rage, shock reactions, " +
    "unexpected chaos, and quotable lines. Each clip must stand alone without setup. " +
    "Return ONLY JSON, no prose.";

  const user =
    `Pick the ${count} best clip moments from this timestamped transcript.\n` +
    `Return a JSON array of exactly up to ${count} objects with keys: ` +
    `start (seconds int), end (seconds int, 15-45s after start), title (<=60 chars, punchy, no emojis), ` +
    `caption (<=90 chars hook line, no emojis). Order by virality, best first.\n\n` +
    `TRANSCRIPT:\n${lines}`;

  const resp = await anthropic().messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: sys,
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const json = text.replace(/```json|```/g, "").trim();
  let picks;
  try {
    picks = JSON.parse(json);
  } catch {
    const m = json.match(/\[[\s\S]*\]/);
    picks = m ? JSON.parse(m[0]) : [];
  }

  return (Array.isArray(picks) ? picks : [])
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start)
    .map((p) => ({
      start: Math.max(0, Math.floor(p.start)),
      end: Math.min(Math.floor(p.start) + 45, Math.max(Math.floor(p.end), Math.floor(p.start) + 15)),
      title: String(p.title || "GTA6 Clip").slice(0, 60),
      caption: String(p.caption || "").slice(0, 90),
    }))
    .slice(0, count);
}

function fmt(s) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

// cands: [{ start, end, peak, loud, text }] from the audio pass. Returns up to `count` picks.
export async function rankCandidates(cands, count) {
  const fallback = () =>
    [...cands].sort((a, b) => b.loud - a.loud).slice(0, count).map((c) => ({
      start: c.start, end: c.end, title: `Moment at ${clock(c.peak)}`, caption: "",
    }));
  if (!cands.length) return [];
  try {
    const list = cands
      .map((c, i) => `#${i} [${clock(c.start)}-${clock(c.end)}] loudness_spike=${c.loud}dB speech: ${c.text ? JSON.stringify(c.text.slice(0, 600)) : "(no clear speech)"}`)
      .join("\n");
    const resp = await anthropic().messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system:
        "You are a short-form editor for a GTA 6 stream clipping tool. Each candidate is a 35 second window around a spike " +
        "in the streamer's audio (yelling, laughing, rage, chat-worthy reactions) with what was said. Pick the windows most " +
        "likely to get shared on TikTok, Reels and Shorts. Prefer clear reactions and quotable lines. Return ONLY JSON.",
      messages: [{
        role: "user",
        content: `Pick the best ${count} (or fewer if some are weak). Return a JSON array of {i (candidate number), title (<=60 chars, punchy, ` +
          `no emojis, never invent events the speech does not support), caption (<=80 chars hook, no emojis)}. Best first.\n\n${list}`,
      }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").replace(/```json|```/g, "");
    const m = text.match(/\[[\s\S]*\]/);
    const picks = (m ? JSON.parse(m[0]) : []).filter((p) => cands[p.i]);
    if (!picks.length) return fallback();
    const seen = new Set();
    return picks.filter((p) => !seen.has(p.i) && seen.add(p.i)).slice(0, count).map((p) => ({
      start: cands[p.i].start, end: cands[p.i].end,
      title: String(p.title || `Moment at ${clock(cands[p.i].peak)}`).slice(0, 60),
      caption: String(p.caption || "").slice(0, 80),
    }));
  } catch (e) {
    console.error("[highlights] rank failed:", e.message);
    return fallback();
  }
}

function clock(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`;
}
