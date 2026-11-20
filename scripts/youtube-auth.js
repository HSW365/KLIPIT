// One-time: get the refresh token for the HSW365MEDIA channel.
// 1) Google Cloud Console -> new project -> enable "YouTube Data API v3"
// 2) OAuth consent screen (External, add yourself as test user) -> Credentials -> OAuth client ID -> "Desktop app"
// 3) YT_CLIENT_ID=... YT_CLIENT_SECRET=... npm run yt:auth   (sign in as the account that owns the channel)
// 4) Put YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN in Render env vars.
import http from "node:http";

const id = process.env.YT_CLIENT_ID, secret = process.env.YT_CLIENT_SECRET;
if (!id || !secret) { console.error("Set YT_CLIENT_ID and YT_CLIENT_SECRET first."); process.exit(1); }
const redirect = "http://localhost:53682";
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent",
  scope: "https://www.googleapis.com/auth/youtube.upload",
});
console.log("\nOpen this URL and sign in as the channel owner:\n\n" + url + "\n");
http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get("code");
  if (!code) { res.end("waiting"); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const j = await r.json();
  res.end(j.refresh_token ? "Done. Check your terminal." : "Failed. Check your terminal.");
  console.log(j.refresh_token ? "\nYT_REFRESH_TOKEN=" + j.refresh_token + "\n" : "\nNo refresh token:", j);
  process.exit(0);
}).listen(53682);
