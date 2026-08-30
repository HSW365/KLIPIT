# KLIPIT

Paste a stream link → KLIPIT finds the best moments, cuts them into clips (16:9 + 9:16), and the user downloads and posts them anywhere. Subscription tiers set how many links a user can run each month.

An HSW365 product · hsw365media@gmail.com

---

## What it does (and nothing else)

1. User pastes a public stream/VOD link (YouTube, Twitch VOD, Kick, etc.).
2. KLIPIT downloads it with `yt-dlp`.
3. It scans the audio for the loudest, most-hype moments (`ffmpeg` energy detection).
4. Claude ranks and titles the best moments.
5. `ffmpeg` cuts each into a clip — wide (16:9) and vertical (9:16).
6. The user downloads them and posts wherever they want.

**Paid APIs: Claude + Stripe only.** Everything else (`yt-dlp`, `ffmpeg`, Supabase free tier) costs nothing per clip.

---

## Stack

- **Node.js / Express** — API + serves the frontend + runs the job worker in-process
- **yt-dlp + ffmpeg** — download, highlight detection, cutting (free, no API)
- **Claude API** — picks + titles the final clips
- **Supabase (Postgres)** — subscribers, jobs, clips, monthly quota
- **Stripe** — subscriptions ($20 / $45 / $99), webhook-driven activation

---

## This cannot run on GitHub Pages

GitHub Pages is static hosting — it can't download video, run ffmpeg, or hold state. Use `hsw365.github.io/KLIPIT/` as the **marketing page** and run this app on a real container. See **Deploy**.

---

## Setup

### 1. Supabase
Create a Supabase project, then run `supabase/schema.sql` in its SQL editor. Grab:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (Project settings → API → service_role — **server only, never ship to the browser**)

### 2. Stripe
- Create 3 recurring **Products/Prices**: $20, $45, $99 monthly → copy the `price_...` IDs into `STRIPE_PRICE_STARTER/PRO/ELITE`.
- Get `STRIPE_SECRET_KEY`.
- Add a webhook endpoint → `https://YOUR-APP/api/stripe/webhook`, subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted` → copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 3. Claude
- `ANTHROPIC_API_KEY` from console.anthropic.com.

### 4. Env
Copy `.env.example` → `.env` and fill everything in.

---

## Run locally

```bash
npm install
# ffmpeg + yt-dlp must be installed on your machine:
#   ffmpeg: https://ffmpeg.org/download.html
#   yt-dlp: pip install yt-dlp
cp .env.example .env    # then fill it in
npm start               # http://localhost:3000
```

For Stripe webhooks locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`.

---

## Deploy (Render, Docker)

The included `Dockerfile` installs ffmpeg + yt-dlp. `render.yaml` is a ready blueprint.

1. Push this repo to GitHub.
2. Render → New → Blueprint → point at the repo.
3. Set every `sync: false` env var in the Render dashboard (Supabase, Stripe, Anthropic, `APP_URL`).
4. Deploy. Use at least the **Standard** plan — video processing needs real CPU/RAM, and the attached 20 GB disk holds clips.

Any host that runs Docker with ffmpeg + a persistent disk works (Fly.io, Railway, a VPS).

---

## How tiers / quota work

`lib/tiers.js` defines the plans. A "run" = one link processed. Quota is consumed atomically in Postgres (`klipit_consume_quota`) and **refunded automatically if a job fails**. The monthly window rolls 30 days after first use.

| Plan | Price | Runs/mo | Max VOD | Clips/run |
|------|-------|---------|---------|-----------|
| Clipper | $20 | 25 | 90 min | 6 |
| Pro | $45 | 75 | 180 min | 12 |
| Elite | $99 | 250 | 600 min | 24 |

**These run/limit numbers are a proposal — adjust in `lib/tiers.js` before launch. Prices are fixed at 20/45/99.**

---

## Notes / hardening

- **Auth** is a per-subscriber `klip_` API key minted on checkout (shown on the success screen). Simple and real; swap in Supabase Auth magic links later if you want accounts.
- **Better highlights (optional):** wire local Whisper (`whisper.cpp`, free) into `lib/highlights.js` to give Claude a transcript — titles get much sharper. Off by default so there's no heavy model download.
- **Storage:** clips are written to the persistent disk and served from `/clips/...`. For multi-instance scale, move them to Supabase Storage / S3.
