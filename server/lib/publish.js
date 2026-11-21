// Klipit auto-publisher: takes a finished clip (public mp4 URL) and posts it to every
// platform that has credentials set. Free official APIs only. Each adapter returns
// { ok, url?, error? } and never throws, so one platform failing never blocks the rest.
import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";

const env = (k) => (process.env[k] || "").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FOOTER =
  "\n\nWebsite: hsw365.net\nInvestors / business: hsw365media@gmail.com\nSupport the channel: CashApp $hsw365" +
  "\nClipped with Klipit. Not affiliated with Rockstar Games or the streamer.";

// ---------- copy (title / description / hashtags) ----------

export async function makeCopy(clip, job) {
  const streamer = streamerFrom(job);
  let title = clip.title && !/^moment at/i.test(clip.title) ? clip.title : "";
  let hook = clip.caption || "";
  if ((!title || !hook) && env("ANTHROPIC_API_KEY")) {
    try {
      const a = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
      const r = await a.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: "You write viral titles for GTA 6 stream clips. Return ONLY JSON {\"title\":\"<=70 chars\",\"hook\":\"<=100 chars\"}. No claims you cannot know. One emoji max.",
        messages: [{ role: "user", content: `Streamer: ${streamer || "unknown"}\nStream title: ${job.source_title || ""}\nClip: ${clip.title || ""} | ${clip.caption || ""}\nWrite a punchy clip title and a hook line.` }],
      });
      const t = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const j = JSON.parse(t.match(/\{[\s\S]*\}/)[0]);
      title ||= String(j.title || "");
      hook ||= String(j.hook || "");
    } catch (e) { console.error("[copy]", e.message); }
  }
  title ||= `${streamer || "Streamer"} GTA 6 moment`;
  const tags = ["#GTA6", ...(streamer ? ["#" + streamer.replace(/[^a-z0-9]/gi, "")] : []), "#Shorts", "#Klipit"];
  const body = `${hook ? hook + "\n\n" : ""}${streamer ? `Credit: ${streamer} live stream.\n` : ""}${FOOTER}\n\n${tags.join(" ")}`;
  return { title: title.slice(0, 95), description: body, short: `${title}\n\n${tags.join(" ")}`.slice(0, 270), tags };
}

function streamerFrom(job) {
  const u = String(job?.source_url || "");
  const m = u.match(/(?:twitch\.tv|kick\.com)\/([a-z0-9_]+)(?:$|\/|\?)/i);
  if (m && !/^(videos|video)$/i.test(m[1])) return m[1];
  return "";
}

// ---------- YouTube (Data API v3, resumable upload) ----------
// Note: default API quota is 10,000 units/day and one upload costs 1,600 => about 6 uploads/day.

async function ytToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("YT_CLIENT_ID"), client_secret: env("YT_CLIENT_SECRET"), refresh_token: env("YT_REFRESH_TOKEN"), grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("YouTube token: " + (j.error_description || j.error || "failed"));
  return j.access_token;
}

const youtube = {
  id: "youtube",
  configured: () => Boolean(env("YT_CLIENT_ID") && env("YT_CLIENT_SECRET") && env("YT_REFRESH_TOKEN")),
  async post({ videoUrl, copy }) {
    const token = await ytToken();
    const src = await fetch(videoUrl);
    if (!src.ok) throw new Error("clip download " + src.status);
    const buf = Buffer.from(await src.arrayBuffer());
    const meta = { snippet: { title: copy.title.includes("#Shorts") ? copy.title : (copy.title + " #Shorts").slice(0, 100), description: copy.description, tags: copy.tags.map((t) => t.slice(1)), categoryId: "20" },
      status: { privacyStatus: env("YT_PRIVACY") || "public", selfDeclaredMadeForKids: false } };
    const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": String(buf.length) },
      body: JSON.stringify(meta),
    });
    if (!init.ok) throw new Error("YouTube init " + init.status + " " + (await init.text()).slice(0, 200));
    const up = await fetch(init.headers.get("location"), { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(buf.length) }, body: buf });
    const j = await up.json().catch(() => ({}));
    if (!j.id) throw new Error("YouTube upload " + up.status + " " + JSON.stringify(j).slice(0, 200));
    return { ok: true, url: `https://youtube.com/shorts/${j.id}` };
  },
};

// ---------- Facebook Page (Graph API, video by public URL) ----------

const facebook = {
  id: "facebook",
  configured: () => Boolean(env("FB_PAGE_ID") && env("FB_PAGE_TOKEN")),
  async post({ videoUrl, copy }) {
    const r = await fetch(`https://graph.facebook.com/v21.0/${env("FB_PAGE_ID")}/videos`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ file_url: videoUrl, title: copy.title, description: copy.description, access_token: env("FB_PAGE_TOKEN") }),
    });
    const j = await r.json();
    if (!j.id) throw new Error("Facebook " + JSON.stringify(j.error || j).slice(0, 200));
    return { ok: true, url: `https://facebook.com/${env("FB_PAGE_ID")}/videos/${j.id}` };
  },
};

// ---------- Instagram Reels ----------
// Uses the Instagram account already connected to iRun (irun_ig_connections, same Supabase project)
// so there is nothing new to set up. Env IG_USER_ID + IG_TOKEN override it (Graph API on Facebook login).

async function igConn() {
  if (env("IG_USER_ID") && env("IG_TOKEN")) return { id: env("IG_USER_ID"), token: env("IG_TOKEN"), host: "graph.facebook.com" };
  try {
    const { supaClient } = await import("./supabase.js");
    const { data } = await supaClient().from("irun_ig_connections").select("ig_user_id,username,token,expires_at").order("updated_at", { ascending: false }).limit(5);
    const want = (env("IG_USERNAME") || "hoodstar365").toLowerCase();
    const row = (data || []).find((r) => (r.username || "").toLowerCase() === want && r.token && (!r.expires_at || Date.parse(r.expires_at) > Date.now()));
    return row ? { id: row.ig_user_id, token: row.token, host: "graph.instagram.com" } : null;
  } catch { return null; }
}

const instagram = {
  id: "instagram",
  // Connected when env creds exist or iRun's connection is reachable (Supabase env present); the real check happens at post time.
  configured: () => Boolean((env("IG_USER_ID") && env("IG_TOKEN")) || (env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY") && env("IG_FROM_IRUN") !== "off")),
  async post({ videoUrl, copy }) {
    const c0 = await igConn();
    if (!c0) throw new Error("Instagram: no valid iRun connection (reconnect @hoodstar365 in iRun)");
    const base = `https://${c0.host}/v21.0/${c0.id}`;
    const form = (o) => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...o, access_token: c0.token }) });
    const c = await (await fetch(`${base}/media`, form({ media_type: "REELS", video_url: videoUrl, caption: `${copy.title}\n\n${copy.description}`.slice(0, 2200), share_to_feed: "true" }))).json();
    if (!c.id) throw new Error("Instagram container " + JSON.stringify(c.error || c).slice(0, 200));
    for (let i = 0; i < 40; i++) {
      await sleep(5000);
      const s = await (await fetch(`https://${c0.host}/v21.0/${c.id}?fields=status_code&access_token=${encodeURIComponent(c0.token)}`)).json();
      if (s.status_code === "FINISHED") break;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error("Instagram processing " + s.status_code);
    }
    const p = await (await fetch(`${base}/media_publish`, form({ creation_id: c.id }))).json();
    if (!p.id) throw new Error("Instagram publish " + JSON.stringify(p.error || p).slice(0, 200));
    const link = await (await fetch(`https://${c0.host}/v21.0/${p.id}?fields=permalink&access_token=${encodeURIComponent(c0.token)}`)).json().catch(() => ({}));
    return { ok: true, url: link.permalink || "https://instagram.com/hoodstar365" };
  },
};

// ---------- X (v2 media upload + post, OAuth 1.0a user context) ----------

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
function oauth1(method, url, params = {}) {
  const o = { oauth_consumer_key: env("X_API_KEY"), oauth_nonce: crypto.randomBytes(12).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: env("X_ACCESS_TOKEN"), oauth_version: "1.0" };
  const all = { ...params, ...o };
  const norm = Object.keys(all).sort().map((k) => `${pct(k)}=${pct(all[k])}`).join("&");
  const base = [method, pct(url), pct(norm)].join("&");
  o.oauth_signature = crypto.createHmac("sha1", `${pct(env("X_API_SECRET"))}&${pct(env("X_ACCESS_SECRET"))}`).update(base).digest("base64");
  return "OAuth " + Object.keys(o).sort().map((k) => `${pct(k)}="${pct(o[k])}"`).join(", ");
}

const x = {
  id: "x",
  configured: () => Boolean(env("X_API_KEY") && env("X_API_SECRET") && env("X_ACCESS_TOKEN") && env("X_ACCESS_SECRET")),
  async post({ videoUrl, copy }) {
    const buf = Buffer.from(await (await fetch(videoUrl)).arrayBuffer());
    const U = "https://upload.twitter.com/1.1/media/upload.json";
    const form = async (fields, file) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      if (file) fd.append("media", new Blob([file]));
      return fetch(U, { method: "POST", headers: { Authorization: oauth1("POST", U) }, body: fd });
    };
    const initR = await (await fetch(U, { method: "POST", headers: { Authorization: oauth1("POST", U, { command: "INIT", total_bytes: String(buf.length), media_type: "video/mp4", media_category: "tweet_video" }), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ command: "INIT", total_bytes: String(buf.length), media_type: "video/mp4", media_category: "tweet_video" }) })).json();
    if (!initR.media_id_string) throw new Error("X init " + JSON.stringify(initR).slice(0, 200));
    const id = initR.media_id_string, CH = 4 * 1024 * 1024;
    for (let i = 0, seg = 0; i < buf.length; i += CH, seg++) {
      const r = await form({ command: "APPEND", media_id: id, segment_index: String(seg) }, buf.subarray(i, i + CH));
      if (!r.ok) throw new Error("X append " + r.status);
    }
    let fin = await (await fetch(U, { method: "POST", headers: { Authorization: oauth1("POST", U, { command: "FINALIZE", media_id: id }), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ command: "FINALIZE", media_id: id }) })).json();
    for (let n = 0; fin.processing_info && n < 30; n++) {
      if (fin.processing_info.state === "failed") throw new Error("X processing failed");
      if (fin.processing_info.state === "succeeded") break;
      await sleep((fin.processing_info.check_after_secs || 5) * 1000);
      const q = { command: "STATUS", media_id: id };
      fin = await (await fetch(`${U}?${new URLSearchParams(q)}`, { headers: { Authorization: oauth1("GET", U, q) } })).json();
    }
    const T = "https://api.twitter.com/2/tweets";
    const t = await (await fetch(T, { method: "POST", headers: { Authorization: oauth1("POST", T), "Content-Type": "application/json" }, body: JSON.stringify({ text: copy.short, media: { media_ids: [id] } }) })).json();
    if (!t.data?.id) throw new Error("X post " + JSON.stringify(t).slice(0, 200));
    return { ok: true, url: `https://x.com/i/status/${t.data.id}` };
  },
};

// ---------- Reddit (script app, link post to the YouTube Short) ----------
// Reddit bans self-promo spam: only post to subs listed in REDDIT_SUBS that allow clips.

const reddit = {
  id: "reddit",
  configured: () => Boolean(env("REDDIT_CLIENT_ID") && env("REDDIT_CLIENT_SECRET") && env("REDDIT_USERNAME") && env("REDDIT_PASSWORD") && env("REDDIT_SUBS")),
  async post({ copy, urls }) {
    const link = urls.youtube;
    if (!link) throw new Error("Reddit needs the YouTube link first (YouTube must post before Reddit)");
    const ua = `klipit/1.0 by ${env("REDDIT_USERNAME")}`;
    const tk = await (await fetch("https://www.reddit.com/api/v1/access_token", { method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${env("REDDIT_CLIENT_ID")}:${env("REDDIT_CLIENT_SECRET")}`).toString("base64"), "User-Agent": ua, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: env("REDDIT_USERNAME"), password: env("REDDIT_PASSWORD") }) })).json();
    if (!tk.access_token) throw new Error("Reddit auth " + (tk.error || "failed"));
    const subs = env("REDDIT_SUBS").split(",").map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const sr of subs.slice(0, 2)) {
      const r = await (await fetch("https://oauth.reddit.com/api/submit", { method: "POST", headers: { Authorization: `Bearer ${tk.access_token}`, "User-Agent": ua, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ api_type: "json", kind: "link", sr, title: copy.title.slice(0, 290), url: link, resubmit: "true" }) })).json();
      const e = r.json?.errors?.[0];
      if (e) throw new Error(`Reddit r/${sr}: ${e.join(" ")}`);
      out.push(r.json?.data?.url);
    }
    return { ok: true, url: out[0] };
  },
};

// ---------- Snapchat ----------
// Snapchat has no public posting API for normal accounts (Public Profile API is invite-only
// and Creative Kit is share-sheet only), so this cannot post automatically. Reported, never faked.
const snapchat = {
  id: "snapchat",
  configured: () => false,
  async post() { return { ok: false, error: "Snapchat has no posting API for regular accounts" }; },
};

export const PLATFORMS = [youtube, facebook, instagram, x, reddit, snapchat];
export const platformStatus = () => Object.fromEntries(PLATFORMS.map((p) => [p.id, p.configured()]));

// Post one clip to every configured platform that has not posted it yet.
// `done` = { youtube: {status,url} , ...} already on the clip. Returns the updated map.
export async function publishClip(clip, job, done = {}) {
  const copy = await makeCopy(clip, job);
  const urls = Object.fromEntries(Object.entries(done).filter(([, v]) => v?.url).map(([k, v]) => [k, v.url]));
  const only = clip.only || (env("AUTOPOST_PLATFORMS") || "youtube,facebook,instagram,x,reddit").split(",").map((s) => s.trim());
  const next = { ...done };
  for (const p of PLATFORMS) {
    if (!only.includes(p.id) || !p.configured()) continue;
    if (next[p.id]?.status === "posted") continue;
    try {
      const r = await p.post({ videoUrl: clip.url, copy, urls, clip, job });
      next[p.id] = r.ok ? { status: "posted", url: r.url, at: new Date().toISOString() } : { status: "failed", error: r.error, at: new Date().toISOString() };
      if (r.ok && r.url) urls[p.id] = r.url;
    } catch (e) {
      console.error(`[publish:${p.id}]`, e.message);
      const tries = (next[p.id]?.tries || 0) + 1;
      next[p.id] = { status: tries >= 3 ? "failed" : "retry", error: e.message.slice(0, 300), tries, at: new Date().toISOString() };
    }
  }
  return next;
}
