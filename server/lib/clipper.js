import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickHighlights, rankCandidates } from "./highlights.js";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const HAS_FONT = existsSync(FONT);
const WORK_ROOT = existsSync("/data") ? "/data/work" : os.tmpdir();
const YTDLP = ["--no-playlist", "--no-warnings", "--socket-timeout", "30", "--retries", "5",
  ...(existsSync("/opt/bgutil/server/build") ? ["--extractor-args", "youtubepot-bgutilscript:server_home=/opt/bgutil/server"] : [])];
// Optional: YouTube cookies (Netscape format) in YT_COOKIES lets YouTube links work from the server.
const COOKIES = path.join(os.tmpdir(), "yt-cookies.txt");
if (process.env.YT_COOKIES) {
  (await import("node:fs")).writeFileSync(COOKIES, process.env.YT_COOKIES.replace(/\\n/g, "\n"));
  YTDLP.push("--cookies", COOKIES);
}

export class ClipError extends Error {}

// tier: { clipsPerStream, maxMinutes, resolution, watermark, captions }
export async function clipStream(sourceUrl, tier, onProgress = () => {}, onClip = async () => {}) {
  await fs.mkdir(WORK_ROOT, { recursive: true });
  const work = await fs.mkdtemp(path.join(WORK_ROOT, "klipit-"));
  try {
    onProgress("Reading the stream");
    sourceUrl = await resolveChannel(sourceUrl, onProgress);
    const info = await probe(sourceUrl);
    if (info.isLive) throw new ClipError("That stream is still live. Paste the link again once it ends and the VOD is up.");
    const window = Math.min(tier.maxMinutes * 60, info.duration || tier.maxMinutes * 60);

    let picks = [];
    onProgress("Checking for captions");
    const transcript = await fetchTranscript(sourceUrl, work);
    if (transcript.length > 20) {
      onProgress("Finding the best moments");
      picks = await pickHighlights(transcript, tier.clipsPerStream, window).catch((e) => {
        console.error("[highlights] caption pick failed:", e.message);
        return [];
      });
    }
    if (!picks.length) {
      picks = await audioHighlights(sourceUrl, window, tier.clipsPerStream, work, onProgress);
    }
    if (!picks.length) throw new ClipError("Klipit could not find clear highlight moments in that stream. Try a longer stream or a different VOD.");

    picks.sort((a, b) => a.start - b.start);
    onProgress("Opening the video");
    const media = await mediaUrls(sourceUrl, tier.resolution);
    const clips = [];
    for (let i = 0; i < picks.length; i++) {
      onProgress(`Cutting clip ${i + 1} of ${picks.length}`);
      try {
        const clip = { ...picks[i], file: await renderClip(media, picks[i], tier, work, i) };
        clips.push(clip);
        await onClip(clip, i);
      } catch (e) {
        console.error(`[clipper] clip ${i} failed:`, lastLine(e.stderr || e.message));
      }
    }
    if (!clips.length) throw new ClipError("The clips could not be downloaded from that link. The VOD may be private, deleted or region locked.");
    return { work, clips, title: info.title };
  } catch (e) {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// A Twitch channel link (twitch.tv/name) means "their most recent broadcast".
async function resolveChannel(url, onProgress) {
  const m = url.match(/^https?:\/\/(?:www\.|m\.)?twitch\.tv\/([a-z0-9_]{3,25})\/?(?:\?.*)?$/i);
  if (!m || ["videos", "directory", "search", "settings"].includes(m[1].toLowerCase())) return url;
  onProgress(`Finding ${m[1]}'s latest broadcast`);
  try {
    const r = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query{user(login:${JSON.stringify(m[1].toLowerCase())}){videos(first:3,type:ARCHIVE,sort:TIME){edges{node{id status}}}}}` }),
    });
    const j = await r.json();
    const id = j?.data?.user?.videos?.edges?.map((e) => e.node).find((n) => n.status !== "RECORDING")?.id;
    if (id) return `https://www.twitch.tv/videos/${id}`;
    if (j?.data && !j.data.user) throw new ClipError(`There is no Twitch channel called ${m[1]}.`);
  } catch (e) {
    if (e instanceof ClipError) throw e;
    console.error("[resolve]", m[1], e.message);
  }
  throw new ClipError(`${m[1]} has no past broadcasts saved on Twitch. Paste a VOD link instead.`);
}

async function probe(url) {
  try {
    const { stdout } = await run("yt-dlp", [...YTDLP, "--skip-download", "--print", "%(title)s\t%(duration)s\t%(is_live)s", url], { maxBuffer: 1 << 20, timeout: 90e3 });
    const [title, dur, live] = stdout.trim().split("\n").pop().split("\t");
    return { title: title || "Stream", duration: Number(dur) || 0, isLive: live === "True" };
  } catch (e) {
    const msg = String(e.stderr || e.message).split("\n").filter((l) => /ERROR/.test(l)).pop() || firstLine(e.stderr || e.message);
    console.error("[probe]", url, msg);
    if (/sign in|bot/i.test(msg)) throw new ClipError("YouTube blocked the request for this video. Try the Twitch or Kick VOD of the same stream.");
    if (/unsupported url/i.test(msg)) throw new ClipError("That link is not a YouTube, Twitch or Kick video.");
    throw new ClipError(`Could not open that link. ${msg.replace(/^ERROR:\s*/, "")}`);
  }
}

async function fetchTranscript(url, work) {
  try {
    await run("yt-dlp", [...YTDLP, "--skip-download", "--write-auto-subs", "--write-subs", "--sub-langs", "en.*,en", "--sub-format", "vtt",
      "-o", path.join(work, "src.%(ext)s"), url], { timeout: 120e3 });
  } catch {
    return [];
  }
  const vtt = (await fs.readdir(work)).find((f) => f.endsWith(".vtt"));
  return vtt ? parseVtt(await fs.readFile(path.join(work, vtt), "utf8")) : [];
}

// No captions (most Twitch/Kick VODs): find the loudest reactions in the audio, transcribe just those
// windows locally, then let Claude pick and title the best ones.
async function audioHighlights(url, windowSec, count, work, onProgress) {
  onProgress("Listening to the stream");
  const { stdout: audioUrl } = await run("yt-dlp", [...YTDLP, "-f", "bestaudio/worst", "-g", url], { timeout: 90e3 });
  const src = audioUrl.trim().split("\n")[0];
  const local = path.join(work, "audio.ogg");
  const rms = await loudnessPerSecond(src, windowSec, local, (s) => onProgress(`Listening to the stream (${Math.min(99, Math.round((s / windowSec) * 100))}%)`));
  if (rms.length < 30) return [];

  // smooth over 3s, score against a rolling 2-minute baseline so loud games don't drown everything
  const sm = rms.map((_, i) => avg(rms.slice(Math.max(0, i - 1), i + 2)));
  const score = sm.map((v, i) => v - avg(sm.slice(Math.max(0, i - 60), i + 60)));
  const order = score.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const peaks = [];
  const want = count + Math.min(count, 8);
  for (const [, i] of order) {
    if (peaks.length >= want) break;
    if (peaks.every((p) => Math.abs(p - i) > 45)) peaks.push(i);
  }
  const cands = peaks.map((p) => ({ start: Math.max(0, p - 22), end: Math.min(rms.length, p + 13), peak: p, loud: +score[p].toFixed(1), text: "" }));

  // transcribe the strongest spikes only, so long streams stay fast
  const audio = existsSync(local) ? local : src;
  const toHear = new Set([...cands.keys()].sort((a, b) => cands[b].loud - cands[a].loud).slice(0, Math.min(cands.length, 20)));
  onProgress("Transcribing the loudest moments");
  const wavs = [];
  for (let i = 0; i < cands.length; i++) {
    if (!toHear.has(i)) { wavs.push(null); continue; }
    const f = path.join(work, `cand_${i}.wav`);
    try {
      await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(cands[i].start), "-t", String(cands[i].end - cands[i].start), "-i", audio,
        "-ac", "1", "-ar", "16000", f], { timeout: 120e3 });
      wavs.push(f);
    } catch {
      wavs.push(null);
    }
  }
  try {
    const ok = wavs.filter(Boolean);
    const { stdout } = await run("python3", [path.join(HERE, "transcribe.py"), ...ok], { timeout: 15 * 60e3, maxBuffer: 8 << 20 });
    const texts = JSON.parse(stdout.trim().split("\n").pop());
    let k = 0;
    wavs.forEach((w, i) => { if (w) cands[i].text = texts[k++] || ""; });
  } catch (e) {
    console.error("[clipper] transcribe failed:", firstLine(e.stderr || e.message));
  }

  onProgress("Picking the best moments");
  return rankCandidates(cands, count);
}

function loudnessPerSecond(src, windowSec, saveTo, onSec) {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-nostats", "-t", String(windowSec), "-i", src, "-vn", "-ac", "1",
      "-af", "aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
      "-f", "null", "-",
      "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-y", saveTo];
    const p = spawn("ffmpeg", args);
    const vals = []; let buf = ""; let last = 0;
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/RMS_level=(-?[\d.]+|-inf)/);
        if (m) {
          vals.push(m[1] === "-inf" ? -90 : Math.max(-90, Number(m[1])));
          if (vals.length - last >= 300) { last = vals.length; onSec(vals.length); }
        }
      }
    });
    p.stderr.on("data", () => {});
    p.on("error", reject);
    p.on("close", () => resolve(vals));
  });
}

function parseVtt(raw) {
  const out = [];
  for (const b of raw.replace(/\r/g, "").split("\n\n")) {
    const m = b.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!m) continue;
    const text = b.split("\n").filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim()) && l.trim() !== "WEBVTT")
      .join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) out.push({ start: toSec(m[1]), end: toSec(m[2]), text });
  }
  return out.filter((c, i) => i === 0 || c.text !== out[i - 1].text);
}

// Direct stream URLs (video, plus audio when separate), resolved once per job.
async function mediaUrls(url, res) {
  const { stdout } = await run("yt-dlp", [...YTDLP, "-f", `bv*[height<=${res}]+ba/b[height<=${res}]/b`, "-g", url], { timeout: 120e3 });
  const urls = stdout.trim().split("\n").filter((l) => /^https?:/.test(l));
  if (!urls.length) throw new ClipError("Could not open the video for that link.");
  return { urls: urls.slice(0, 2), page: url, format: `bv*[height<=${res}]+ba/b[height<=${res}]/b` };
}

async function renderClip(media, pick, tier, work, i) {
  const out = path.join(work, `clip_${i}.mp4`);
  const dur = pick.end - pick.start;
  // A: fetch only the stream pieces that cover the moment (HLS), or read it directly (progressive video)
  try {
    const hls = media.urls[0].includes(".m3u8") || media.urls[0].includes("m3u8");
    let inputs;
    if (hls && media.urls.length === 1) {
      const { file, offset } = await hlsCut(media.urls[0], pick.start, dur, path.join(work, `hls_${i}.ts`));
      inputs = ["-ss", String(offset), "-t", String(dur), "-i", file];
    } else {
      inputs = media.urls.flatMap((u) => ["-ss", String(pick.start), "-t", String(dur), "-i", u]);
    }
    await encode(inputs, media.urls.length > 1 ? "1:a?" : "0:a?", pick, tier, out);
    await fs.rm(path.join(work, `hls_${i}.ts`), { force: true }).catch(() => {});
    if ((await seconds(out)) > dur * 0.6) return out;
    console.error(`[clipper] clip ${i}: direct read came back short, retrying with a section download`);
  } catch (e) {
    console.error(`[clipper] clip ${i} direct read failed:`, lastLine(e.stderr || e.message));
  }
  // B: download the section, then encode from disk
  const raw = path.join(work, `seg_${i}.mp4`);
  const pad = 3;
  await run("yt-dlp", [...YTDLP, "-f", media.format, "--download-sections", `*${Math.max(0, pick.start - pad)}-${pick.end + pad}`,
    "--merge-output-format", "mp4", "-o", raw, media.page], { timeout: 10 * 60e3 });
  const seg = existsSync(raw) ? raw : path.join(work, (await fs.readdir(work)).find((f) => f.startsWith(`seg_${i}.`)) || "missing");
  const lead = pick.start - Math.max(0, pick.start - pad);
  await encode(["-ss", String(lead), "-t", String(dur), "-i", seg], "0:a?", pick, tier, out);
  await fs.rm(seg, { force: true }).catch(() => {});
  if ((await seconds(out)) < dur * 0.6) throw new Error("clip came back empty");
  return out;
}

// Download just the HLS segments that cover [start, start+dur]. Returns the local file and where the moment starts in it.
async function hlsCut(playlistUrl, start, dur, outFile) {
  let url = playlistUrl;
  let text = await (await fetch(url)).text();
  if (text.includes("#EXT-X-STREAM-INF")) {
    const v = text.split("\n").find((l) => l.trim() && !l.startsWith("#"));
    url = new URL(v.trim(), url).href;
    text = await (await fetch(url)).text();
  }
  const lines = text.split("\n").map((l) => l.trim());
  const segs = []; let t = 0, d = 0, init = null;
  for (const l of lines) {
    if (l.startsWith("#EXT-X-MAP")) { const m = l.match(/URI="([^"]+)"/); if (m) init = new URL(m[1], url).href; }
    else if (l.startsWith("#EXTINF:")) d = parseFloat(l.slice(8));
    else if (l && !l.startsWith("#")) { segs.push({ uri: new URL(l, url).href, t0: t, t1: t + d }); t += d; d = 0; }
  }
  const need = segs.filter((g) => g.t1 > start && g.t0 < start + dur);
  if (!need.length) throw new Error("moment is outside the stream");
  const fh = await fs.open(outFile, "w");
  try {
    const get = async (u) => {
      let r = await fetch(u);
      if (!r.ok && /-unmuted\.ts/.test(u)) r = await fetch(u.replace("-unmuted.ts", "-muted.ts"));
      if (!r.ok) throw new Error(`segment ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    };
    if (init) await fh.write(await get(init));
    for (const g of need) await fh.write(await get(g.uri));
  } finally {
    await fh.close();
  }
  return { file: outFile, offset: Math.max(0, start - need[0].t0) };
}

async function encode(inputs, audioMap, pick, tier, out) {
  const W = tier.resolution === 1080 ? 1080 : 720;
  const H = Math.round((W * 16) / 9);
  // Feed-ready vertical: the full gameplay frame over a blurred fill, so nothing important gets cropped off.
  // Blur is done at quarter size then scaled up: same look, a fraction of the CPU.
  let fc = `[0:v]fps=30,split[a][b];[a]scale=${W / 4}:${H / 4}:force_original_aspect_ratio=increase,crop=${W / 4}:${H / 4},boxblur=6:2,eq=brightness=-0.12,scale=${W}:${H}[bg];` +
    `[b]scale=${W}:-2:flags=fast_bilinear[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  if (tier.captions && pick.caption && HAS_FONT) fc += "," + drawtext(pick.caption, "y=h*0.16", Math.round(W / 17), 1, true);
  if (tier.watermark && HAS_FONT) fc += "," + drawtext("KLIPIT", "y=h*0.86", Math.round(W / 26), 0.7, false);
  fc += ",format=yuv420p[v]";
  await run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", fc, "-map", "[v]", "-map", audioMap,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "0", "-c:a", "aac", "-b:a", "160k",
    "-movflags", "+faststart", out], { timeout: 10 * 60e3, maxBuffer: 16 << 20 });
}

async function seconds(file) {
  try {
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration:format=duration",
      "-of", "default=nw=1:nk=1", file]);
    return Math.max(0, ...stdout.split("\n").map(Number).filter(Number.isFinite));
  } catch {
    return 0;
  }
}

function drawtext(text, y, size, alpha, box) {
  const lines = wrapText(text.toUpperCase(), 22);
  return lines.map((l, k) => {
    const safe = l.replace(/[\\':,]/g, (c) => "\\" + c).replace(/%/g, "\\%");
    return `drawtext=fontfile=${FONT}:text='${safe}':fontcolor=white@${alpha}:fontsize=${size}:` +
      (box ? `box=1:boxcolor=black@0.55:boxborderw=${Math.round(size / 3)}:` : `borderw=2:bordercolor=black@0.6:`) +
      `x=(w-text_w)/2:${y}+${k * Math.round(size * 1.45)}`;
  }).join(",");
}

function wrapText(s, n) {
  const out = []; let cur = "";
  for (const w of s.split(/\s+/)) {
    if ((cur + " " + w).trim().length > n && cur) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, 3);
}

const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function toSec(t) { const [h, m, s] = t.split(":"); return Math.round(+h * 3600 + +m * 60 + parseFloat(s)); }
function lastLine(s) { return String(s).trim().split("\n").filter((l) => !/Skip \(/.test(l)).pop() || String(s); }
function firstLine(s) { return String(s).split("\n").find((l) => l.trim()) || String(s); }
