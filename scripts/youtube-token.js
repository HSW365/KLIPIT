// One-time: mint the YouTube refresh token for the HSW365MEDIA channel.
//   YT_CLIENT_ID=... YT_CLIENT_SECRET=... node scripts/youtube-token.js
// Opens a Google sign-in URL; sign in as the channel owner, approve, and the token prints here.
// In Google Cloud: create an OAuth client of type "Desktop app", enable "YouTube Data API v3".
import http from "node:http";

const id = process.env.YT_CLIENT_ID, secret = process.env.YT_CLIENT_SECRET;
if (!id || !secret) { console.error("Set YT_CLIENT_ID and YT_CLIENT_SECRET first."); process.exit(1); }
const redirect = "http://127.0.0.1:8765/cb";
const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: id, redirect_uri: redirect, response_type: "code", access_type: "offline", prompt: "consent",
  scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
});
console.log("\nOpen this in your browser and sign in as the channel owner:\n\n" + url + "\n");
http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get("code");
  if (!code) { res.end("waiting"); return; }
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }) });
  const j = await r.json();
  res.end(j.refresh_token ? "Done. Close this tab and check the terminal." : "Failed: " + JSON.stringify(j));
  console.log(j.refresh_token ? "\nYT_REFRESH_TOKEN=" + j.refresh_token + "\n" : j);
  process.exit(0);
}).listen(8765);
