import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supabase } from "./lib/supabase.js";
import { consumeRun, refundRun, quotaStatus } from "./lib/quota.js";
import { tierByKey, TIERS } from "./lib/tiers.js";
import { createCheckout, constructEvent, handleEvent, keyForSession } from "./lib/stripe.js";
import { startWorker } from "./jobs/worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

// --- Stripe webhook needs the RAW body, so mount it BEFORE express.json ---
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = constructEvent(req.body, req.headers["stripe-signature"]);
  } catch (e) {
    console.error("[stripe] bad signature:", e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  try {
    await handleEvent(event);
  } catch (e) {
    console.error("[stripe] handler error:", e.message);
  }
  res.json({ received: true });
});

app.use(express.json());

// static: clip downloads + frontend
app.use("/clips", express.static(path.join(DATA_DIR, "clips")));
app.use(express.static(path.join(__dirname, "public")));

// --- pricing / tiers (public) ---
app.get("/api/tiers", (_req, res) => {
  res.json(
    Object.values(TIERS).map((t) => ({
      key: t.key,
      name: t.name,
      price_usd: t.price_usd,
      runs_per_month: t.runs_per_month,
      max_vod_minutes: t.max_vod_minutes,
      max_clips_per_run: t.max_clips_per_run,
      vertical: t.vertical,
    }))
  );
});

// --- start checkout ---
app.post("/api/checkout", async (req, res) => {
  try {
    const { tier, email } = req.body || {};
    if (!tierByKey(tier)) return res.status(400).json({ error: "Invalid tier" });
    const url = await createCheckout(tier, email);
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- reveal api key after successful checkout ---
app.get("/api/session-key", async (req, res) => {
  try {
    const row = await keyForSession(req.query.session_id);
    if (!row) return res.status(404).json({ error: "Not ready yet. Give it a few seconds and refresh." });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- account / quota status ---
app.get("/api/account", async (req, res) => {
  try {
    const status = await quotaStatus(req.query.key);
    if (!status) return res.status(404).json({ error: "Unknown key" });
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- submit a generation run ---
app.post("/api/jobs", async (req, res) => {
  const { key, url, vertical } = req.body || {};
  if (!key) return res.status(401).json({ error: "Missing key" });
  if (!isValidUrl(url)) return res.status(400).json({ error: "Paste a valid stream/VOD link (http/https)." });

  let consumed;
  try {
    consumed = await consumeRun(key);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!consumed.ok) {
    const map = {
      invalid_key: [401, "Invalid key."],
      inactive_subscription: [403, "Your subscription isn't active."],
      no_tier: [403, "No active plan on this account."],
      out_of_quota: [429, "You're out of runs for this month."],
    };
    const [code, msg] = map[consumed.reason] || [403, "Not allowed."];
    return res.status(code).json({ error: msg });
  }

  const tier = consumed.tier;
  const wantVertical = !!vertical && tier.vertical;

  try {
    const { data, error } = await supabase
      .from("klipit_jobs")
      .insert({
        user_id: consumed.user.id,
        source_url: url,
        status: "queued",
        vertical: wantVertical,
        max_clips: tier.max_clips_per_run,
        stage_message: "Queued…",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    res.json({ jobId: data.id, remaining: consumed.remaining });
  } catch (e) {
    // creating the job failed after we consumed quota — refund it
    await refundRun(consumed.user.id).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// --- poll a job ---
app.get("/api/jobs/:id", async (req, res) => {
  try {
    const { data: job, error } = await supabase
      .from("klipit_jobs")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!job) return res.status(404).json({ error: "No such job" });

    // ownership check via key
    if (req.query.key) {
      const { data: u } = await supabase
        .from("klipit_users")
        .select("id")
        .eq("api_key", req.query.key)
        .maybeSingle();
      if (!u || u.id !== job.user_id) return res.status(403).json({ error: "Not your job" });
    }

    let clips = [];
    if (job.status === "done") {
      const r = await supabase
        .from("klipit_clips")
        .select("title,reason,start_sec,end_sec,file_wide,file_vertical,rank")
        .eq("job_id", job.id)
        .order("rank", { ascending: true });
      clips = r.data || [];
    }

    res.json({
      id: job.id,
      status: job.status,
      stage_message: job.stage_message,
      error: job.error,
      clips,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function isValidUrl(u) {
  if (!u || typeof u !== "string") return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

app.listen(PORT, () => {
  console.log(`KLIPIT server on :${PORT}`);
  if (process.env.WORKER_MODE !== "external") startWorker();
});
