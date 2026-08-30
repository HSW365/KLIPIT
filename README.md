# GTA6 Hub — Daily YouTube Upload Bot

Fully automated daily uploads for **@Hoodstar365**. Every morning at **8:00 AM ET**, GitHub Actions:

1. Pulls the latest **GTA 6 news** (SerpAPI)
2. Writes a 60–90s hype **script + title + description** (Claude)
3. Generates a **voiceover** (ElevenLabs)
4. Generates **4 cinematic backgrounds** (fal.ai Flux)
5. Assembles a **Ken Burns slideshow + voiceover** into `final.mp4` (ffmpeg)
6. **Uploads to YouTube** (Data API v3)

Runs on the free GitHub Actions tier. No server needed.

---

## One-time setup (~20 min)

### 1. Create the repo
Push this folder to **`HSW365/gta6-hub`** (private is fine).

### 2. Get 6 API keys

| Secret | Where |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `SERPAPI_KEY` | serpapi.com |
| `ELEVENLABS_API_KEY` | elevenlabs.io |
| `ELEVENLABS_VOICE_ID` | ElevenLabs → your voice → ID |
| `FAL_KEY` | fal.ai |
| `YT_CLIENT_ID` + `YT_CLIENT_SECRET` | Google Cloud Console → OAuth client (Desktop app), YouTube Data API v3 enabled |

### 3. Mint the YouTube refresh token (local, once)
On your Windows PC:
```bash
npm install
set YT_CLIENT_ID=your_id
set YT_CLIENT_SECRET=your_secret
node scripts/get-refresh-token.js
```
A browser opens → approve → the terminal prints `YT_REFRESH_TOKEN`.

### 4. Add all secrets to GitHub
Repo → **Settings → Secrets and variables → Actions → New repository secret**. Add all 8:
`ANTHROPIC_API_KEY`, `SERPAPI_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `FAL_KEY`, `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`.

### 5. Done
It fires daily on its own. To test now: **Actions tab → GTA6 Hub Daily Upload → Run workflow**.

---

## Preview locally before going live
Builds today's video **without uploading** so you can watch `output/final.mp4`:
```bash
npm install
# set the stage 01–03 env vars, then:
bash scripts/run-local.sh
```

---

## Notes
- **DST is handled.** Two crons (12:00 & 13:00 UTC) fire, and a guard step skips whichever one isn't real 08 ET — so exactly one post per day, year-round.
- **Model** defaults to `claude-sonnet-5`. Override with the `ANTHROPIC_MODEL` env var if needed.
- **IP-safe.** This is a **news & commentary** channel: original narration over real headlines with original AI-generated visuals. It uses **no Rockstar footage, art, or trademarks** — image prompts are generic (neon city, palm trees, sports cars), not branded place-names. Not affiliated with or endorsed by Rockstar Games / Take-Two.
