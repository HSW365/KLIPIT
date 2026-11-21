import "dotenv/config";
import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { TIERS, getTier } from "./lib/tiers.js";
import { createCheckoutSession, handleWebhook, confirmCheckout, cardLast4, billingPortal } from "./lib/stripe.js";
import { getSubscriberByEmail, isComp, createJob, updateJob, getJob, listJobs, failStuckJobs, uploadClip, setClipYt, listYtQueue, queueJobForPublish, OWNER_EMAILS } from "./lib/supabase.js";
import { clipStream, ClipError } from "./lib/clipper.js";
import { issueToken, requireAuth, limited, safeEqual } from "./lib/auth.js";
import { normalizeSource } from "../public/links.js";
import { startAutopost, autopostState, tick as autopostTick } from "./lib/autopost.js";
import { platformStatus } from "./lib/publish.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    autopost: { platforms: platformStatus(), ...autopostState() },
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
    res.status(500).json({ error: "Checkout is unavailable right now. Email hsw365media@gmail.com or visit hsw365.net." });
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

// Owner PIN login: the PIN service (Supabase edge function owner-pin) verifies its own signed token.
const OWNER_PIN_API = `${(process.env.SUPABASE_URL || "https://lsxdlmrjrcivxwgfkpop.supabase.co").replace(/\/$/, "")}/functions/v1/owner-pin`;
app.post("/api/auth/owner", async (req, res) => {
  try {
    if (limited(`own:${req.ip}`, 30)) return res.status(429).json({ error: "Too many tries. Wait 15 minutes." });
    const t = String(req.body?.token || "");
    if (!t.includes(".")) return res.status(401).json({ error: "Owner session ended. Enter your PIN again." });
    const r = await fetch(OWNER_PIN_API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: "verify", token: t }) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return res.status(401).json({ error: "Owner session ended. Enter your PIN again." });
    const email = "hsw365media@gmail.com";
    res.json({ token: issueToken(email), email });
  } catch (e) {
    console.error("[owner]", e.message);
    res.status(500).json({ error: "Owner login is unavailable right now. Try again." });
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
    res.status(500).json({ error: "Billing page is unavailable right now. Email hsw365media@gmail.com or visit hsw365.net." });
  }
});

// ---- clipping ----

app.post("/api/clip", requireAuth, async (req, res) => {
  try {
    const link = normalizeSource(req.body?.sourceUrl);
    if (!link.ok) return res.status(400).json({ error: link.error });
    const sourceUrl = link.url;
    const sub = await getSubscriberByEmail(req.email);
    if (!sub) return res.status(402).json({ error: "Your plan is not active. Pick a plan to keep clipping." });
    const tier = getTier(sub.tier);
    if (queue.some((q) => q.email === req.email) || running?.email === req.email)
      return res.status(409).json({ error: "You already have a stream being clipped. It will show below when it is done." });
    const job = await createJob({ email: req.email, tier: sub.tier, sourceUrl });
    queue.push({ id: job.id, email: req.email, sourceUrl, tier });
    pump();
    res.json({ jobId: job.id, platform: link.platform, position: queuePos(job.id) });
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

// ---- YouTube channel: users opt in per clip; the HSW365 PC uploads the queue ----

app.post("/api/yt/submit", requireAuth, async (req, res) => {
  try {
    const { jobId, index, consent } = req.body || {};
    if (consent !== true) return res.status(400).json({ error: "Please agree to post this clip." });
    const job = await getJob(String(jobId || ""));
    if (!job || job.email !== req.email) return res.status(404).json({ error: "Not found." });
    const i = Number(index);
    if (!Number.isInteger(i) || !job.clips?.[i]) return res.status(404).json({ error: "Clip not found." });
    if (job.clips[i].yt) return res.json({ yt: job.clips[i].yt });
    await setClipYt(job.id, i, { yt: "queued", yt_at: new Date().toISOString(), pub: "queued", only: ["youtube"] });
    res.json({ yt: "queued" });
  } catch (e) {
    console.error("[yt submit]", e.message);
    res.status(500).json({ error: "Could not submit that clip. Try again." });
  }
});

const ytKey = (req, res, next) =>
  process.env.YT_QUEUE_KEY && safeEqual(String(req.headers["x-queue-key"] || ""), process.env.YT_QUEUE_KEY) ? next() : res.status(401).json({ error: "No." });

app.get("/api/yt/queue", ytKey, async (_req, res) => {
  try { res.json(await listYtQueue()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/yt/done", ytKey, async (req, res) => {
  try {
    const { jobId, index, videoUrl } = req.body || {};
    const r = await setClipYt(String(jobId), Number(index), { yt: "posted", yt_url: String(videoUrl || "").slice(0, 200) });
    res.json({ ok: Boolean(r) });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const results = [];
    const { work, title } = await clipStream(sourceUrl, tier,
      (msg) => updateJob(id, { progress: msg }).catch(() => {}),
      async (c, i) => {
        // each clip goes live in the library as soon as it is cut
        const url = await uploadClip(c.file, `${id}/${String(i + 1).padStart(2, "0")}-${slug(c.title)}.mp4`);
        results.push({ title: c.title, caption: c.caption, start: c.start, end: c.end, url });
        await fs.rm(c.file, { force: true }).catch(() => {});
        await updateJob(id, { clips: results }).catch(() => {});
      });
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    await updateJob(id, { status: "done", progress: `${results.length} clips ready`, clips: results, source_title: title?.slice(0, 200) });
    // HSW365 owner jobs post themselves to every connected platform (YouTube, FB, IG, X, Reddit).
    if (OWNER_EMAILS.includes(String(running.email).toLowerCase())) {
      const n = await queueJobForPublish(id).catch((e) => (console.error("[autopost queue]", e.message), 0));
      console.log("[autopost] queued", n, "clips from", id);
    }
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

app.use("/yt", (req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); next(); });
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"], maxAge: "1h" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.post("/api/autopost/run", ytKey, async (_req, res) => { await autopostTick(); res.json(autopostState()); });

app.listen(PORT, async () => {
  console.log(`Klipit live on :${PORT}`);
  startAutopost();
  await failStuckJobs().catch((e) => console.error("[boot]", e.message));
});
