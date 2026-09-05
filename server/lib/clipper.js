import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickHighlights } from "./highlights.js";

const run = promisify(execFile);
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const HAS_FONT = existsSync(FONT);

// tier: object from tiers.js  { clipsPerStream, maxMinutes, resolution, watermark, captions }
// onProgress(msg) optional
export async function clipStream(sourceUrl, tier, onProgress = () => {}) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "klipit-"));
  try {
    onProgress("fetching stream transcript");
    const transcript = await fetchTranscript(sourceUrl, work);
    if (!transcript.length) {
      throw new Error(
        "No captions found on this stream. Klipit uses stream captions to find highlights — " +
          "pick a VOD that has captions, or upgrade the plan for whisper transcription."
      );
    }

    onProgress("finding highlights with Claude");
    const picks = await pickHighlights(transcript, tier.clipsPerStream, tier.maxMinutes * 60);
    if (!picks.length) throw new Error("Claude found no strong clip moments in the scanned window.");

    const clips = [];
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      onProgress(`rendering clip ${i + 1}/${picks.length}: ${p.title}`);
      try {
        const file = await renderClip(sourceUrl, p, tier, work, i);
        clips.push({ ...p, file });
      } catch (e) {
        // one bad segment shouldn't kill the whole batch
        console.error(`[clipper] clip ${i} failed:`, e.message);
      }
    }
    if (!clips.length) throw new Error("All clip renders failed — source may be geo-blocked or removed.");
    return { work, clips };
  } catch (e) {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

async function fetchTranscript(url, work) {
  await run("yt-dlp", [
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    "en.*",
    "--sub-format",
    "vtt",
    "--no-playlist",
    "-o",
    path.join(work, "src.%(ext)s"),
    url,
  ]).catch((e) => {
    throw new Error(`yt-dlp could not read that link: ${firstLine(e.stderr || e.message)}`);
  });

  const files = await fs.readdir(work);
  const vtt = files.find((f) => f.endsWith(".vtt"));
  if (!vtt) return [];
  return parseVtt(await fs.readFile(path.join(work, vtt), "utf8"));
}

function parseVtt(raw) {
  const out = [];
  const blocks = raw.replace(/\r/g, "").split("\n\n");
  for (const b of blocks) {
    const m = b.match(/(\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3})/);
    if (!m) continue;
    const text = b
      .split("\n")
      .filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim()) && l.trim() !== "WEBVTT")
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!text) continue;
    out.push({ start: toSec(m[1]), end: toSec(m[2]), text });
  }
  // de-dupe consecutive identical auto-caption lines
  return out.filter((c, i) => i === 0 || c.text !== out[i - 1].text);
}

async function renderClip(url, pick, tier, work, i) {
  const raw = path.join(work, `seg_${i}.mp4`);
  const out = path.join(work, `clip_${i}.mp4`);
  const section = `*${pick.start}-${pick.end}`;

  await run("yt-dlp", [
    "-f",
    `bv*[height<=${tier.resolution === 1080 ? 1920 : 1280}]+ba/b`,
    "--download-sections",
    section,
    "--force-keyframes-at-cuts",
    "--no-playlist",
    "--recode-video",
    "mp4",
    "-o",
    raw,
    url,
  ]);

  const W = tier.resolution;           // 720 or 1080 (vertical width)
  const H = Math.round((W * 16) / 9);  // 1280 or 1920

  const filters = [`scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`];
  if (tier.captions && pick.caption && HAS_FONT) {
    filters.push(drawtext(pick.caption, `y=h-(h/6)`, Math.round(W / 22)));
  }
  if (tier.watermark && HAS_FONT) {
    filters.push(drawtext("KLIPIT • HSW365", `y=h/14`, Math.round(W / 30), 0.85));
  }

  await run("ffmpeg", [
    "-y",
    "-i",
    raw,
    "-vf",
    filters.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    out,
  ]);
  return out;
}

function drawtext(text, y, size, alpha = 1) {
  const safe = text.replace(/[\\':]/g, (c) => "\\" + c).replace(/%/g, "\\%");
  return (
    `drawtext=fontfile=${FONT}:text='${safe}':fontcolor=white@${alpha}:fontsize=${size}:` +
    `box=1:boxcolor=black@0.5:boxborderw=12:x=(w-text_w)/2:${y}`
  );
}

function toSec(t) {
  const [h, m, s] = t.split(":");
  return Math.round(parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s));
}
function firstLine(s) {
  return String(s).split("\n").find((l) => l.trim()) || String(s);
}
