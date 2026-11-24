// Shared link normalizer (browser + server). Accepts whatever a person copies from YouTube or Twitch:
// full links, links without https, mobile links, shorts, live, clips, channel links, or a whole pasted sentence.
const reserved = new Set(["videos", "directory", "search", "settings", "downloads", "turbo", "subscriptions", "categories", "browse", "following", "u", "popout", "embed", "moderator", "dashboard"]);
const bad = (error) => ({ ok: false, error });

export function normalizeSource(input) {
  let s = String(input ?? "").trim();
  if (!s) return bad("Paste a stream link first.");
  const found = s.match(/https?:\/\/[^\s"'<>]+/i) || s.match(/(?:^|[\s(])((?:[a-z0-9-]+\.)+(?:com|tv|be)\/[^\s"'<>]*)/i);
  s = (found ? (found[1] || found[0]) : s).replace(/[)\].,;]+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return bad("That does not look like a link. Copy it from the address bar or the Share button."); }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  const t = u.searchParams.get("t") || u.searchParams.get("start");

  if (/^(?:(?:www|m|music|gaming)\.)?youtube\.com$/.test(host) || host === "youtu.be" || host === "www.youtube-nocookie.com") {
    let id = null;
    if (host === "youtu.be") id = seg[0];
    else if (seg[0] === "watch") id = u.searchParams.get("v");
    else if (["shorts", "live", "embed", "v"].includes(seg[0])) id = seg[1];
    if (!id || !/^[\w-]{11}$/.test(id))
      return bad("That YouTube link is not a single video. Open the video or the live replay and copy its link.");
    const url = `https://www.youtube.com/watch?v=${id}` + (t && /^\d+s?$/.test(t) ? `&t=${parseInt(t, 10)}s` : "");
    return { ok: true, platform: "youtube", url };
  }

  if (host === "clips.twitch.tv" && seg[0]) return { ok: true, platform: "twitch", url: `https://clips.twitch.tv/${seg[0]}` };
  if (/^(?:(?:www|m)\.)?twitch\.tv$/.test(host)) {
    if (seg[0] === "videos" && /^\d+$/.test(seg[1] || ""))
      return { ok: true, platform: "twitch", url: `https://www.twitch.tv/videos/${seg[1]}` + (t ? `?t=${encodeURIComponent(t)}` : "") };
    if (seg[1] === "clip" && seg[2]) return { ok: true, platform: "twitch", url: `https://www.twitch.tv/${seg[0]}/clip/${seg[2]}` };
    if (seg[0] && !reserved.has(seg[0].toLowerCase()) && /^[a-z0-9_]{3,25}$/i.test(seg[0]) && (seg.length === 1 || ["videos", "schedule", "about"].includes(seg[1])))
      return { ok: true, platform: "twitch", url: `https://www.twitch.tv/${seg[0].toLowerCase()}` };
    return bad("That Twitch link is not a VOD or a channel. Copy the link of the past broadcast.");
  }

  if (/^(?:www\.)?kick\.com$/.test(host)) {
    const vid = u.pathname.match(/\/videos?\/([0-9a-f-]{36})/i)?.[1];
    if (vid) return { ok: true, platform: "kick", url: `https://kick.com/video/${vid}` };
    if (seg.length === 1 && /^[a-z0-9_-]{2,25}$/i.test(seg[0]) && !reserved.has(seg[0].toLowerCase()))
      return { ok: true, platform: "kick", url: `https://kick.com/${seg[0].toLowerCase()}` };
    return bad("That Kick link is not a VOD or a channel. Copy the link of the past broadcast.");
  }

  return bad("Klipit reads YouTube, Twitch and Kick links. Paste one of those.");
}

export const platformOf = (v) => { const r = normalizeSource(v); return r.ok ? r.platform : null; };
