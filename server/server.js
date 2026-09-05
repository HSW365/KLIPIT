import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { TIERS } from "./lib/tiers.js";
import { createCheckoutSession, handleWebhook } from "./lib/stripe.js";
import { getSubscriberByEmail, createJob, updateJob, getJob, uploadClip } from "./lib/supabase.js";
import { clipStream } from "./lib/clipper.js";
import { getTier } from "./lib/tiers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Stripe webhook needs the raw body — mount BEFORE express.json.
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const summary = await handleWebhook(req.body, req.headers["stripe-signature"]);
    console.log("[webhook]", summary);
    res.json({ received: true });
  } catch (e) {
    console.error("[webhook] error", e.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

app.use(express.json());

// Public tier list for the pricing UI.
app.get("/api/tiers", (_req, res) => {
  res.json(
    Object.values(TIERS).map((t) => ({
      key: t.key,
      name: t.name,
      priceUsd: t.priceUsd,
      clipsPerStream: t.clipsPerStream,
      maxMinutes: t.maxMinutes,
      resolution: t.resolution,
      watermark: t.watermark,
      captions: t.captions,
    }))
  );
});

// Start a subscription checkout.
app.post("/api/checkout", async (req, res) => {
  try {
    const { tier, email } = req.body || {};
    if (!TIERS[tier]) return res.status(400).json({ error: "invalid tier" });
    const session = await createCheckoutSession(tier, email);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit a stream link → gated clip job.
app.post("/api/clip", async (req, res) => {
  try {
    const { email, sourceUrl } = req.body || {};
    if (!email || !sourceUrl) return res.status(400).json({ error: "email and sourceUrl required" });
    if (!/^https?:\/\//i.test(sourceUrl)) return res.status(400).json({ error: "sourceUrl must be a link" });

    const sub = await getSubscriberByEmail(email);
    if (!sub) return res.status(402).json({ error: "no active subscription for this email" });

    const tier = getTier(sub.tier);
    if (!tier) return res.status(400).json({ error: "unknown tier on account" });

    const job = await createJob({ email, tier: sub.tier, sourceUrl });
    processJob(job.id, sourceUrl, tier).catch(async (e) => {
      console.error("[job] fatal", job.id, e.message);
      await updateJob(job.id, { status: "failed", error: e.message }).catch(() => {});
    });

    res.json({ jobId: job.id, tier: sub.tier, status: "queued" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll a job.
app.get("/api/job/:id", async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Background worker.
async function processJob(id, sourceUrl, tier) {
  await updateJob(id, { status: "processing", progress: "starting" });
  const { work, clips } = await clipStream(sourceUrl, tier, (msg) =>
    updateJob(id, { progress: msg }).catch(() => {})
  );
  const results = [];
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const dest = `${id}/${i}-${slug(c.title)}.mp4`;
    const url = await uploadClip(c.file, dest);
    results.push({ title: c.title, caption: c.caption, start: c.start, end: c.end, url });
  }
  await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  await updateJob(id, { status: "done", progress: `${results.length} clips`, clips: results });
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip";

// Static frontend (landing + clipper) from /public.
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(PORT, () => console.log(`Klipit live on :${PORT}`));
