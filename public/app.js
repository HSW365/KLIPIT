/* Klipit web app: paste any link, plans + checkout, sign in, clip library, billing. */
import { normalizeSource } from "/links.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const KEY = "klipit.token", PEND = "klipit.pending";
const lsGet = (k, st = localStorage) => { try { return st.getItem(k); } catch { return null; } };
const lsSet = (k, v, st = localStorage) => { try { st.setItem(k, v); } catch {} };
const lsDel = (k, st = localStorage) => { try { st.removeItem(k); } catch {} };
let token = lsGet(KEY);
let me = null;
let pollTimer = null;

async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("No connection. Check your internet and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) signOut(true);
  if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");
  return data;
}

const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
const clock = (s) => {
  s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(r).padStart(2, "0");
};
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return new Date(iso).toLocaleDateString();
};
function toast(m) {
  const t = $("#toast"); t.textContent = m; t.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2800);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.l = btn.textContent; btn.textContent = label || "Working"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.l || btn.textContent; btn.disabled = false; }
}
const msg = (el, text) => { el.textContent = text || ""; };
const openDialog = (d) => { if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); };
const closeDialog = (d) => { if (d.close) d.close(); else d.removeAttribute("open"); };

// ---------- dialogs ----------
$$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) closeDialog(d); }));
$$("[data-open=auth]").forEach((b) => b.addEventListener("click", () => openAuth()));
function openAuth(note) {
  $("#auth-note").textContent = note || "Use the email on your plan and the last 4 digits of the card it bills.";
  msg($("#si-msg"), "");
  openDialog($("#auth"));
  setTimeout(() => $("#si-email").focus(), 60);
}
// "Sign in" links open the dialog when signed out; "My clips" just scrolls.
$$("[data-acct]").forEach((a) => a.closest("a")?.addEventListener("click", (e) => {
  if (!(token && me)) { e.preventDefault(); openAuth(); }
}));

// ---------- paste box ----------
const url = $("#url"), say = $("#say"), SAY_DEFAULT = say.textContent;
function setSay(text, kind) { say.textContent = text; say.className = "say" + (kind ? " " + kind : ""); }
function detect() {
  const v = url.value.trim();
  const r = v ? normalizeSource(v) : null;
  $$(".chip").forEach((c) => c.classList.toggle("on", !!(r?.ok && c.dataset.p === r.platform)));
  if (!v) setSay(SAY_DEFAULT);
  else if (r.ok) setSay(`Looks good. ${{ youtube: "YouTube", twitch: "Twitch", kick: "Kick" }[r.platform]} link ready.`, "ok");
  else setSay(r.error, v.length > 12 ? "err" : "");
  return r;
}
url.addEventListener("input", detect);
url.addEventListener("paste", () => setTimeout(detect, 0));
$("#pastebtn").addEventListener("click", async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t.trim()) return toast("Nothing copied yet. Copy a stream link first.");
    url.value = t.trim(); detect(); url.focus();
  } catch { url.focus(); toast("Long-press or press Ctrl+V to paste into the box."); }
});

$("#paste").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = detect();
  if (!url.value.trim()) { url.focus(); return setSay("Paste a stream link first.", "err"); }
  if (!r.ok) return setSay(r.error, "err");
  if (!(token && me)) {
    lsSet(PEND, r.url, sessionStorage);
    setSay("Sign in or pick a plan and Klipit starts on this link.", "ok");
    return openAuth("Sign in and Klipit starts clipping your link right away.");
  }
  if (!me.plan) { lsSet(PEND, r.url, sessionStorage); toast("Pick a plan to start clipping. Your link is saved."); return $("#pricing").scrollIntoView(); }
  await startClip(r.url);
});

async function startClip(sourceUrl) {
  const go = $("#go");
  busy(go, true, "Starting");
  try {
    await api("/api/clip", { method: "POST", body: { sourceUrl } });
    url.value = ""; $$(".chip").forEach((c) => c.classList.remove("on"));
    setSay("Got it. Klipit is on it. Watch your clips below, or leave and come back.", "ok");
    await loadMe();
    $("#library").scrollIntoView();
  } catch (err) {
    setSay(err.message, "err");
  } finally { busy(go, false); }
}

// ---------- plans + checkout ----------
let tiers = [], buyTier = null;
(async function loadTiers() {
  const el = $("#tiers");
  try {
    tiers = await api("/api/tiers");
    el.innerHTML = tiers.map((t, i) => `
      <div class="tier ${i === 1 ? "feature" : ""}">
        ${i === 1 ? '<div class="pop">Most popular</div>' : ""}
        <h3>${esc(t.name)}</h3>
        <div class="price">$${t.priceUsd}<small>/month</small></div>
        <ul>
          <li>${t.clipsPerStream} clips per stream</li>
          <li>Scans up to ${t.maxMinutes >= 60 ? `${t.maxMinutes / 60} hour${t.maxMinutes > 60 ? "s" : ""}` : `${t.maxMinutes} minutes`} of stream</li>
          <li>${t.resolution}p vertical clips</li>
          <li>${t.captions ? "Hook caption burned in" : "Clean cuts, no caption"}</li>
          <li>${t.watermark ? "Klipit watermark" : "No watermark"}</li>
        </ul>
        <button class="btn ${i === 1 ? "btn-sun" : "btn-ghost"}" type="button" data-tier="${t.key}">Choose ${esc(t.name)}</button>
      </div>`).join("");
    $$("button[data-tier]", el).forEach((b) => b.addEventListener("click", () => openBuy(b.dataset.tier)));
    // QR / ad links land straight on sign up: ?signup or ?signup=starter|pro|elite
    const want = new URLSearchParams(location.search).get("signup") ?? (/^#(signup|join)$/.test(location.hash) ? "" : null);
    if (want !== null) {
      history.replaceState(null, "", location.pathname + "#pricing");
      openBuy(tiers.some((x) => x.key === want) ? want : "pro");
    }
  } catch {
    el.innerHTML = '<p class="lede">Plans did not load. Refresh the page, or email hsw365media@gmail.com.</p>';
  }
})();

function paintBuy() {
  const t = tiers.find((x) => x.key === buyTier);
  $("#buy-plan").textContent = `${t.name} · $${t.priceUsd} a month`;
  $("#buy-pick").innerHTML = tiers.map((x) => `<button type="button" role="radio" aria-checked="${x.key === buyTier}" data-pick="${x.key}"><b>$${x.priceUsd}</b><span>${esc(x.name)} · ${x.clipsPerStream} clips</span></button>`).join("");
  $$("button[data-pick]", $("#buy-pick")).forEach((b) => b.addEventListener("click", () => { buyTier = b.dataset.pick; paintBuy(); }));
}
function openBuy(key) {
  buyTier = key; paintBuy(); msg($("#buy-msg"), "");
  if (me?.email) $("#buy-email").value = me.email;
  openDialog($("#buy"));
  setTimeout(() => $("#buy-email").focus(), 60);
}
$("#buy-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#buy-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return msg($("#buy-msg"), "Enter a valid email.");
  const btn = $("button[type=submit]", e.target);
  busy(btn, true, "Opening checkout");
  try {
    const { url: to } = await api("/api/checkout", { method: "POST", body: { tier: buyTier, email } });
    location.href = to;
  } catch (err) { busy(btn, false); msg($("#buy-msg"), err.message); }
});

// ---------- auth ----------
$("#signin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#si-email").value.trim(), proof = $("#si-proof").value.trim();
  if (!email || !proof) return msg($("#si-msg"), "Enter your email and the last 4 digits of your card.");
  const btn = $("button[type=submit]", e.target);
  busy(btn, true, "Signing in");
  try {
    const r = await api("/api/auth/signin", { method: "POST", body: { email, proof } });
    token = r.token; lsSet(KEY, token); $("#si-proof").value = "";
    closeDialog($("#auth"));
    await loadMe(); toast("Signed in");
    resumePending();
  } catch (err) { msg($("#si-msg"), err.message); }
  finally { busy(btn, false); }
});

function signOut(expired) {
  token = null; me = null; lsDel(KEY); clearTimeout(pollTimer);
  if (!expired) lsDel("hsw_owner");
  render();
  if (expired) openAuth("Your session ended. Sign in again.");
}
$("#signout").addEventListener("click", () => { signOut(); toast("Signed out"); });
$("#billing").addEventListener("click", async (e) => {
  busy(e.currentTarget, true, "Opening");
  try { location.href = (await api("/api/portal", { method: "POST" })).url; }
  catch (err) { toast(err.message); busy(e.currentTarget, false); }
});

// A link pasted before sign-in is saved, then started once the person is in.
function resumePending() {
  const p = lsGet(PEND, sessionStorage);
  if (!p || !(token && me)) return;
  lsDel(PEND, sessionStorage);
  url.value = p; detect();
  if (me.plan) startClip(p); else { toast("Pick a plan to start. Your link is saved."); $("#pricing").scrollIntoView(); lsSet(PEND, p, sessionStorage); }
}

// ---------- account + library ----------
async function loadMe() {
  if (!token) return render();
  try { me = await api("/api/me"); } catch (err) { if (token) toast(err.message); }
  render();
}

function render() {
  const signed = !!(token && me);
  $("#gate").hidden = signed; $("#app").hidden = !signed;
  $$("[data-acct]").forEach((a) => (a.textContent = signed ? "My clips" : "Sign in"));
  if (!signed) return;
  const p = me.plan;
  $("#me-email").textContent = me.email;
  $("#plan-pill").textContent = p ? `${p.name}${p.owner ? " · Owner" : ""}` : "No active plan";
  $("#me-renew").textContent = p?.owner ? "Free full access" : p?.renews ? `Renews ${new Date(p.renews).toLocaleDateString()}` : "";
  $("#billing").hidden = !p || p.owner;
  $("#plan-note").textContent = p
    ? `Your plan: ${p.clipsPerStream} clips per stream, scans up to ${p.maxMinutes >= 60 ? p.maxMinutes / 60 + " hours" : p.maxMinutes + " minutes"}, ${p.resolution}p.`
    : "Your plan is not active. Pick a plan to keep clipping.";
  renderJobs(me.jobs || []);
  if ((me.jobs || []).some((j) => j.status === "queued" || j.status === "processing")) schedulePoll();
}

function renderJobs(jobs) {
  const box = $("#jobs");
  if (!jobs.length) { box.innerHTML = '<div class="empty">Your clips show up here. Paste a stream link at the top to start.</div>'; return; }
  const existing = new Map($$(".job", box).map((n) => [n.dataset.id, n]));
  const frag = document.createDocumentFragment();
  jobs.forEach((j) => {
    const old = existing.get(j.id);
    if (old && old.dataset.sig === sig(j)) frag.appendChild(old);
    else { const t = document.createElement("template"); t.innerHTML = jobCard(j).trim(); frag.appendChild(t.content.firstChild); }
  });
  box.replaceChildren(frag);
}
const sig = (j) => [j.status, j.progress, j.error, j.position, (j.clips || []).length, j.source_title].join("|");

function jobCard(j) {
  const title = j.source_title || j.source_url.replace(/^https?:\/\/(www\.)?/, "");
  const live = j.status === "queued" || j.status === "processing";
  const label = { done: "Ready", failed: "Failed", processing: "Working", queued: "In line" }[j.status] || j.status;
  let body = "";
  if (live) {
    const where = j.status === "queued" && j.position > 1 ? `Number ${j.position} in line. ` : "";
    body = `<div class="bar"><i></i></div><p class="job-msg">${esc(where + (j.progress || "Waiting to start"))}</p>` + gallery(j);
  } else if (j.status === "failed") body = `<p class="job-msg err">${esc(j.error || "This one did not finish.")}</p>` + gallery(j);
  else body = gallery(j);
  return `<article class="job" data-id="${esc(j.id)}" data-sig="${esc(sig(j))}">
    <div class="job-head"><div><b>${esc(title)}</b><span>${ago(j.created_at)}${(j.clips || []).length ? ` · ${(j.clips || []).length} clips` : ""}</span></div>
    <span class="state ${esc(j.status)}">${label}</span></div>${body}</article>`;
}
function gallery(j) {
  if (!(j.clips || []).length) return "";
  return `<div class="gallery">${(j.clips || []).map((c, k) => `
      <div class="kc">
        <video src="${esc(c.url)}#t=0.5" preload="metadata" controls playsinline></video>
        <div class="kc-b"><b>${esc(c.title)}</b><span>${clock(c.start)} to ${clock(c.end)}</span>
          <div class="kc-a"><a class="btn btn-sun" href="${esc(c.url)}" download="${esc(fileName(c.title, k))}">Download</a>
          <button class="btn btn-ghost" type="button" data-copy="${esc(c.caption || c.title)}">Caption</button>
          ${c.yt === "posted" && c.yt_url ? `<a class="btn btn-ghost" href="${esc(c.yt_url)}" target="_blank" rel="noopener">On YouTube</a>` : c.yt && c.yt !== "failed" ? '<button class="btn btn-ghost" type="button" disabled>Posting to YouTube…</button>' : `<button class="btn btn-ghost" type="button" data-yt="${esc(j.id)}:${k}">Post to YouTube</button>`}</div>
        </div>
      </div>`).join("")}</div>`;
}
const fileName = (t, k) => `klipit-${String(k + 1).padStart(2, "0")}-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}.mp4`;

$("#jobs").addEventListener("click", async (e) => {
  const y = e.target.closest("[data-yt]");
  if (y) {
    if (!confirm("Post this clip to the HSW365MEDIA YouTube channel? It goes public with your clip, a link to Klipit and hsw365.net, and credit to the streamer. You confirm you have the right to share it.")) return;
    const [jobId, index] = y.dataset.yt.split(":");
    y.disabled = true;
    try { await api("/api/yt/submit", { method: "POST", body: { jobId, index: Number(index), consent: true } }); y.textContent = "Posting to YouTube…"; toast("Posting to the HSW365MEDIA channel. Check back in a few minutes."); }
    catch (err) { y.disabled = false; toast(err.message || "Could not submit"); }
    return;
  }
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copy); toast("Caption copied"); }
  catch { toast("Copy did not work on this browser"); }
});

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!token) return;
    try {
      me = await api("/api/me"); render();
      if (me.jobs?.[0]?.status === "done" && !document.hasFocus()) document.title = "Clips ready | Klipit";
    } catch { schedulePoll(); }
  }, 4000);
}

// ---------- nav highlight ----------
const links = $$(".nav-links a, .dock a");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    links.forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + e.target.id && !a.classList.contains("go")));
  }), { rootMargin: "-45% 0px -50% 0px" });
  ["top", "how", "library", "pricing", "faq"].forEach((id) => { const s = document.getElementById(id); if (s) io.observe(s); });
}

// ---------- owner PIN login (tab from owner-login.js) ----------
let ownerBusy = false;
async function ownerSignIn() {
  const ot = lsGet("hsw_owner");
  if (!ot || ownerBusy || (token && me?.plan?.owner)) return;
  ownerBusy = true;
  try {
    const r = await api("/api/auth/owner", { method: "POST", body: { token: ot } });
    token = r.token; lsSet(KEY, token);
    await loadMe(); toast("Owner signed in");
    resumePending();
  } catch (err) { toast(err.message); }
  finally { ownerBusy = false; }
}
window.addEventListener("hsw-owner", (e) => { if (e.detail?.owner) ownerSignIn(); });

// ---------- return from Stripe ----------
(async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get("checkout") === "success" && q.get("session_id")) {
    history.replaceState(null, "", location.pathname + "#library");
    try {
      const r = await api("/api/auth/checkout", { method: "POST", body: { sessionId: q.get("session_id") } });
      token = r.token; lsSet(KEY, token);
      toast("You're in. Paste a stream to start.");
    } catch (err) { openAuth(err.message); }
  } else if (q.get("checkout") === "cancel") {
    history.replaceState(null, "", location.pathname + "#pricing");
    toast("Checkout canceled. Nothing was charged.");
  }
  await loadMe();
  resumePending();
})();
