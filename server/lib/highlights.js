import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || "" });

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

  const resp = await anthropic.messages.create({
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
      end: Math.min(Math.floor(p.start) + 45, Math.floor(p.end)),
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
