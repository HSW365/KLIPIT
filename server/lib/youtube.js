// Direct YouTube upload for the HSW365MEDIA channel (YouTube Data API v3, free tier).
// Needs YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN (get the token with `npm run yt:auth`).

export const ytConfigured = () =>
  Boolean(process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET && process.env.YT_REFRESH_TOKEN);

async function accessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.YT_CLIENT_ID,
      client_secret: process.env.YT_CLIENT_SECRET,
      refresh_token: process.env.YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`YouTube auth failed: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

export function buildMeta({ title, caption, sourceTitle, sourceUrl }) {
  const t = `${String(title || "Clip").slice(0, 85)} #Shorts`;
  const description = [
    caption || title || "",
    "",
    sourceTitle ? `Source stream: ${sourceTitle}` : "",
    sourceUrl ? `Watch the full stream: ${sourceUrl}` : "",
    "All credit to the streamer. Clipped with Klipit.",
    "",
    "Make your own clips: https://klipit.onrender.com",
    "More from HSW365: https://hsw365.net",
    "Donations: CashApp $hsw365",
    "",
    "#GTA6 #Clips #Streamer #Shorts",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n").slice(0, 4900);
  return { title: t.slice(0, 100), description, tags: ["GTA6", "clips", "streamer", "shorts", "Klipit"] };
}

// Returns the new video URL.
export async function uploadToYouTube({ url, title, description, tags }) {
  const token = await accessToken();
  const src = await fetch(url);
  if (!src.ok) throw new Error(`Could not read clip file (${src.status})`);
  const buf = Buffer.from(await src.arrayBuffer());

  const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(buf.length),
    },
    body: JSON.stringify({
      snippet: { title, description, tags, categoryId: "20" },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) throw new Error(`YouTube init failed (${init.status}): ${(await init.text()).slice(0, 300)}`);
  const loc = init.headers.get("location");
  if (!loc) throw new Error("YouTube gave no upload URL");

  const up = await fetch(loc, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(buf.length) }, body: buf });
  const j = await up.json().catch(() => ({}));
  if (!up.ok || !j.id) throw new Error(`YouTube upload failed (${up.status}): ${JSON.stringify(j).slice(0, 300)}`);
  return `https://www.youtube.com/watch?v=${j.id}`;
}
