import { createClient } from "@supabase/supabase-js";

// Lazy singleton — never throw at import so the app still boots (and serves the
// landing page) when env vars aren't set yet. Only DB-backed calls error.
let _supa = null;
export function supaClient() {
  if (_supa) return _supa;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  _supa = createClient(url, serviceKey, { auth: { persistSession: false } });
  return _supa;
}

// --- users / subscriptions ---

export async function upsertSubscriber({ email, stripeCustomerId, tier, status, currentPeriodEnd }) {
  const { data, error } = await supaClient()
    .from("klipit_subscribers")
    .upsert(
      {
        email: email?.toLowerCase(),
        stripe_customer_id: stripeCustomerId,
        tier,
        status,
        current_period_end: currentPeriodEnd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "stripe_customer_id" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getSubscriberByEmail(email) {
  const { data, error } = await supaClient()
    .from("klipit_subscribers")
    .select("*")
    .eq("email", email?.toLowerCase())
    .eq("status", "active")
    .maybeSingle();
  if (error) throw error;
  return data;
}

// --- clip jobs ---

export async function createJob({ email, tier, sourceUrl }) {
  const { data, error } = await supaClient()
    .from("klipit_jobs")
    .insert({ email: email?.toLowerCase(), tier, source_url: sourceUrl, status: "queued" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateJob(id, patch) {
  const { data, error } = await supaClient()
    .from("klipit_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getJob(id) {
  const { data, error } = await supaClient().from("klipit_jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

// --- storage ---

export async function uploadClip(localPath, destName) {
  const fs = await import("node:fs/promises");
  const bytes = await fs.readFile(localPath);
  const { error } = await supaClient().storage
    .from("klipit-clips")
    .upload(destName, bytes, { contentType: "video/mp4", upsert: true });
  if (error) throw error;
  const { data } = supaClient().storage.from("klipit-clips").getPublicUrl(destName);
  return data.publicUrl;
}
