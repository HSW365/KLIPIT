# KLIPIT — by HSW365

Paste a GTA6 stream link → Klipit finds the viral moments and cuts ready-to-post vertical clips. Clip count and quality scale with the subscriber's plan.

**Stack (stripped to the essentials):** Claude API + Stripe. Nothing else. No ElevenLabs, no fal.ai, no SerpAPI.

- **Frontend** — static landing + pricing + clipper (`/public`), served by the backend.
- **Backend** — Node/Express (`/server`): Stripe checkout + webhook, clip job API.
- **Engine** — `yt-dlp` reads the stream captions, **Claude** picks the best 15–45s moments, `yt-dlp` pulls only those segments, `ffmpeg` renders them vertical (9:16) with captions/watermark by tier.
- **Data** — Supabase (subscribers, jobs, clip storage).

## How the clipping actually works
1. `yt-dlp` grabs the stream's captions only (no full download) — fast.
2. Claude reads the timestamped transcript and returns the top N moments (N = plan).
3. `yt-dlp --download-sections` pulls **only those seconds**, not the whole stream.
4. `ffmpeg` crops to vertical, burns captions/watermark per tier, exports MP4.
5. Clips upload to Supabase storage; the subscriber downloads them.

> Because it works off captions + segment downloads, it never has to download a 6-hour VOD. Streams **without captions** are rejected with a clear message (whisper transcription can be added later as an Elite feature).

## Plans (edit in `server/lib/tiers.js` — prices are placeholders, confirm before going live)
| Plan | Price | Clips/stream | Scan window | Quality |
|------|-------|--------------|-------------|---------|
| Starter | $9/mo | 3 | 30 min | 720p, watermark |
| Pro | $29/mo | 15 | 120 min | 1080p, captions |
| Elite | $79/mo | 40 | 480 min | 1080p, captions |

## Setup
```bash
npm install
cp .env.example .env      # fill in keys
```

1. **Supabase** — run `supabase/schema.sql`, then create a **public** storage bucket named `klipit-clips`.
2. **Stripe** — put your `STRIPE_SECRET_KEY` in `.env`, confirm prices in `tiers.js`, then:
   ```bash
   npm run stripe:setup      # creates products/prices, prints the STRIPE_PRICE_* lines
   ```
   Paste those into `.env`.
3. **Stripe webhook** — point a webhook at `https://<your-app>/api/webhook` for events
   `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
4. **Run**
   ```bash
   npm start                 # http://localhost:3000
   ```

## Deploy (Render, Docker)
The `Dockerfile` installs ffmpeg + yt-dlp + fonts. Push to GitHub, create a Render **Web Service** from the repo (`render.yaml` is included), set the env vars, deploy. Set `APP_URL` to the Render URL.

> Video processing needs real RAM/CPU — the Render **Starter** plan, not free. Free tier will time out and spin down mid-job.

## Contact
HSW365 · hsw365media@gmail.com

Not affiliated with or endorsed by Rockstar Games / Take-Two. Users are responsible for the rights to any stream they submit.
