import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { TIERS, getTier } from "./lib/tiers.js";
import { createCheckoutSession, handleWebhook, confirmCheckout, cardLast4, billingPortal } from "./lib/stripe.js";
import { getSubscriberByEmail, isComp, createJob, updateJob, getJob, listJobs, failStuckJobs, uploadClip } from "./lib/supabase.js";
import { clipStream, ClipError } from "./lib/clipper.js";
import { issueToken, requireAuth, limited, safeEqual } from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOURCE_RE = /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|twitch\.tv|kick\.com)\//i;

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "SAMEORIGIN" });
  next();
});

// Stripe webhook needs the raw body — mount BEFORE express.json.
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    console.log("[webhook]", await handleWebhook(req.body, req.headers["stripe-signature"]));
    res.json({ received: true });
  } catch (e) {
    console.error("[webhook] error", e.message);
    res.status(400).send(`Webhook Error: ${e.message}`);
  }
});

app.use(express.json({ limit: "20kb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    stripe: Boolean(process.env.STRIPE_SECRET_KEY),
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
    supabase: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
    queue: queue.length,
  });
});

app.get("/api/tiers", (_req, res) => {
  res.json(Object.values(TIERS).map(({ priceEnv, ...t }) => t));
});

app.post("/api/checkout", async (req, res) => {
  try {
    const { tier, email } = req.body || {};
    if (!TIERS[tier]) return res.status(400).json({ error: "Pick a plan." });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email." });
    const session = await createCheckoutSession(tier, email?.trim().toLowerCase());
    res.json({ url: session.url });
  } catch (e) {
    console.error("[checkout]", e.message);
    res.status(500).json({ error: "Checkout is unavailable right now. Email hsw365media@gmail.com." });
  }
});

// ---- account ----

// Right after Stripe checkout: the session id proves the purchase.
app.post("/api/auth/checkout", async (req, res) => {
  try {
    const id = String(req.body?.sessionId || "");
    if (!id.startsWith("cs_")) return res.status(400).json({ error: "Invalid checkout." });
    const email = await confirmCheckout(id);
    res.json({ token: issueToken(email), email });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// New device: email + last 4 digits of the card on the plan (or the owner key for HSW365 accounts).
app.post("/api/auth/signin", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const proof = String(req.body?.proof || "").trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter the email on your plan." });
    if (limited(`ip:${req.ip}`, 20) || limited(`em:${email}`)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes and try again." });
    const sub = await getSubscriberByEmail(email);
    const nope = () => res.status(401).json({ error: "That email and card do not match an active plan." });
    if (!sub) return nope();
    if (isComp(sub)) {
      if (!safeEqual(proof, process.env.OWNER_KEY)) return nope();
    } else {
      const last4 = await cardLast4(sub.stripe_customer_id);
      if (!/^\d{4}$/.test(proof) || !last4.includes(proof)) return nope();
    }
    res.json({ token: issueToken(email), email });
  } catch (e) {
    console.error("[signin]", e.message);
    res.status(500).json({ error: "Sign in is unavailable right now. Try again in a minute." });
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const sub = await getSubscriberByEmail(req.email);
    const jobs = await listJobs(req.email);
    const t = sub && getTier(sub.tier);
    res.json({
      email: req.email,
      plan: sub ? { ...(({ priceEnv, ...x }) => x)(t), status: sub.status, renews: sub.current_period_end, owner: isComp(sub) } : null,
      jobs: jobs.map((j) => ({ ...j, position: queuePos(j.id) })),
    });
  } catch (e) {
    console.error("[me]", e.message);
    res.status(500).json({ error: "Could not load your account." });
  }
});

app.post("/api/portal", requireAuth, async (req, res) => {
  try {
    const sub = await getSubscriberByEmail(req.email);
    if (!sub) return res.status(404).json({ error: "No active plan on this email." });
    if (isComp(sub)) return res.status(400).json({ error: "This is an HSW365 owner account. There is no billing on it." });
    res.json({ url: await billingPortal(sub.stripe_customer_id) });
  } catch (e) {
    console.error("[portal]", e.message);
    res.status(500).json({ error: "Billing page is unavailable right now. Email hsw365media@gmail.com." });
  }
});

// ---- clipping ----

app.post("/api/clip", requireAuth, async (req, res) => {
  try {
    const sourceUrl = String(req.body?.sourceUrl || "").trim();
    if (!SOURCE_RE.test(sourceUrl)) return res.status(400).json({ error: "Paste a YouTube, Twitch or Kick video link." });
    const sub = await getSubscriberByEmail(req.email);
    if (!sub) return res.status(402).json({ error: "Your plan is not active. Pick a plan to keep clipping." });
    const tier = getTier(sub.tier);
    if (queue.some((q) => q.email === req.email) || running?.email === req.email)
      return res.status(409).json({ error: "You already have a stream being clipped. It will show below when it is done." });
    const job = await createJob({ email: req.email, tier: sub.tier, sourceUrl });
    queue.push({ id: job.id, email: req.email, sourceUrl, tier });
    pump();
    res.json({ jobId: job.id, position: queuePos(job.id) });
  } catch (e) {
    console.error("[clip]", e.message);
    res.status(500).json({ error: "Could not start that job. Try again." });
  }
});

app.get("/api/job/:id", requireAuth, async (req, res) => {
  try {
    const job = await getJob(req.params.id);
    if (!job || job.email !== req.email) return res.status(404).json({ error: "Not found." });
    res.json({ ...job, position: queuePos(job.id) });
  } catch {
    res.status(404).json({ error: "Not found." });
  }
});

// One job at a time keeps the box stable; everyone else waits in line and sees their place.
const queue = [];
let running = null;
const queuePos = (id) => (running?.id === id ? 0 : queue.findIndex((q) => q.id === id) + 1 || null);

async function pump() {
  if (running || !queue.length) return;
  running = queue.shift();
  const { id, sourceUrl, tier } = running;
  try {
    await updateJob(id, { status: "processing", progress: "Starting" });
    const { work, clips, title } = await clipStream(sourceUrl, tier, (msg) => updateJob(id, { progress: msg }).catch(() => {}));
    const results = [];
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      await updateJob(id, { progress: `Saving clip ${i + 1} of ${clips.length}` }).catch(() => {});
      const url = await uploadClip(c.file, `${id}/${String(i + 1).padStart(2, "0")}-${slug(c.title)}.mp4`);
      results.push({ title: c.title, caption: c.caption, start: c.start, end: c.end, url });
    }
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    await updateJob(id, { status: "done", progress: `${results.length} clips ready`, clips: results, source_title: title?.slice(0, 200) });
  } catch (e) {
    console.error("[job]", id, e.message);
    const msg = e instanceof ClipError ? e.message : "Something went wrong while clipping. Paste the link again, and if it keeps failing email hsw365media@gmail.com.";
    await updateJob(id, { status: "failed", error: msg }).catch(() => {});
  } finally {
    running = null;
    setImmediate(pump);
  }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "clip";

app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"], maxAge: "1h" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(PORT, async () => {
  console.log(`Klipit live on :${PORT}`);
  await failStuckJobs().catch((e) => console.error("[boot]", e.message));
});
