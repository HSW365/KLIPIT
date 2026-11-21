// Background worker: posts queued clips to every connected platform, paced so the
// channels look human and API quotas hold. Runs inside the Klipit web service.
import { listPubQueue, listRecentJobsWithClips, setClipYt } from "./supabase.js";
import { publishClip, PLATFORMS } from "./publish.js";

const num = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
const PER_DAY = () => num("AUTOPOST_PER_DAY", 3);
const GAP_MIN = () => num("AUTOPOST_GAP_MIN", 90);
const TICK_MS = 2 * 60e3;
let busy = false;
let last = { at: null, note: "not run yet" };
export const autopostState = () => last;

async function postedSince(iso) {
  const jobs = await listRecentJobsWithClips(iso);
  const times = [];
  for (const j of jobs) for (const c of j.clips || []) if (c.pub_at && c.pub_at >= iso) times.push(c.pub_at);
  return times.sort();
}

export async function tick() {
  if (busy || process.env.AUTOPOST === "off") return;
  busy = true;
  try {
    const active = PLATFORMS.filter((p) => p.configured());
    if (!active.length) { last = { at: new Date().toISOString(), note: "no platform credentials set" }; return; }
    const day = await postedSince(new Date(Date.now() - 24 * 3600e3).toISOString());
    if (day.length >= PER_DAY()) { last = { at: new Date().toISOString(), note: `daily limit ${PER_DAY()} reached` }; return; }
    const lastAt = day.at(-1);
    if (lastAt && Date.now() - Date.parse(lastAt) < GAP_MIN() * 60e3) { last = { at: new Date().toISOString(), note: "waiting between posts" }; return; }

    const jobs = await listPubQueue();
    for (const job of jobs) {
      if (job.status !== "done" && !(job.clips || []).length) continue;
      const i = (job.clips || []).findIndex((c) => c.pub === "queued");
      if (i < 0) continue;
      const clip = job.clips[i];
      const posts = await publishClip(clip, job, clip.posts || {});
      const mine = active.filter((p) => !clip.only || clip.only.includes(p.id));
      const states = mine.map((p) => posts[p.id]?.status);
      const finished = states.every((s) => s === "posted" || s === "failed");
      const anyPosted = states.some((s) => s === "posted");
      const patch = { posts, pub: finished ? (anyPosted ? "posted" : "failed") : "queued" };
      if (anyPosted && !clip.pub_at) patch.pub_at = new Date().toISOString();
      if (posts.youtube?.status === "posted") { patch.yt = "posted"; patch.yt_url = posts.youtube.url; }
      await setClipYt(job.id, i, patch);
      last = { at: new Date().toISOString(), note: `clip ${job.id.slice(0, 8)}#${i + 1}: ` + mine.map((p) => `${p.id}=${posts[p.id]?.status}`).join(" ") };
      console.log("[autopost]", last.note);
      return; // one clip per tick
    }
    last = { at: new Date().toISOString(), note: "queue empty" };
  } catch (e) {
    console.error("[autopost]", e.message);
    last = { at: new Date().toISOString(), note: "error: " + e.message };
  } finally {
    busy = false;
  }
}

export function startAutopost() {
  setInterval(() => tick().catch(() => {}), TICK_MS).unref?.();
  setTimeout(() => tick().catch(() => {}), 20e3);
}
