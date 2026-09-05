import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.warn("[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — DB calls will fail.");
}

export const supa = createClient(url || "", serviceKey || "", {
  auth: { persistSession: false },
});

// --- users / subscriptions ---

export async function upsertSubscriber({ email, stripeCustomerId, tier, status, currentPeriodEnd }) {
  const { data, error } = await supa
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
  const { data, error } = await supa
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
  const { data, error } = await supa
    .from("klipit_jobs")
    .insert({ email: email?.toLowerCase(), tier, source_url: sourceUrl, status: "queued" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateJob(id, patch) {
  const { data, error } = await supa
    .from("klipit_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getJob(id) {
  const { data, error } = await supa.from("klipit_jobs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

// --- storage ---

export async function uploadClip(localPath, destName) {
  const fs = await import("node:fs/promises");
  const bytes = await fs.readFile(localPath);
  const { error } = await supa.storage
    .from("klipit-clips")
    .upload(destName, bytes, { contentType: "video/mp4", upsert: true });
  if (error) throw error;
  const { data } = supa.storage.from("klipit-clips").getPublicUrl(destName);
  return data.publicUrl;
}
