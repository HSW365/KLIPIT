/* Klipit web app: plans + checkout, sign in, clip a stream, clip library, billing. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const KEY = "klipit.token";
const store = {
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(KEY, v); } catch {} },
  clear: () => { try { localStorage.removeItem(KEY); } catch {} },
};
let token = store.get();
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
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("on");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("on"), 2600);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.l = btn.textContent; btn.textContent = label || "Working"; btn.disabled = true; }
  else { btn.textContent = btn.dataset.l || btn.textContent; btn.disabled = false; }
}
const msg = (el, text, ok) => { el.textContent = text || ""; el.classList.toggle("ok", !!ok); };

// ---------- plans + checkout ----------
let tiers = [];
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
        <button class="btn ${i === 1 ? "btn-primary" : "btn-ghost"}" type="button" data-tier="${t.key}">Choose ${esc(t.name)}</button>
      </div>`).join("");
    $$("button[data-tier]", el).forEach((b) => b.addEventListener("click", () => openBuy(b.dataset.tier)));
  } catch {
    el.innerHTML = '<div class="loading">Plans did not load. Refresh the page, or email hsw365media@gmail.com.</div>';
  }
})();

let buyTier = null;
function openBuy(key) {
  buyTier = key;
  const t = tiers.find((x) => x.key === key);
  $("#buy-plan").textContent = `${t.name} · $${t.priceUsd} a month`;
  msg($("#buy-msg"), "");
  if (me?.email) $("#buy-email").value = me.email;
  const d = $("#buy");
  if (d.showModal) d.showModal(); else d.setAttribute("open", "");
  setTimeout(() => $("#buy-email").focus(), 50);
}
$("#buy").addEventListener("click", (e) => { if (e.target.id === "buy") e.target.close(); });
$("#buy-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#buy-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return msg($("#buy-msg"), "Enter a valid email.");
  const btn = $("button[type=submit]", e.target);
  busy(btn, true, "Opening checkout");
  try {
    const { url } = await api("/api/checkout", { method: "POST", body: { tier: buyTier, email } });
    location.href = url;
  } catch (err) {
    busy(btn, false); msg($("#buy-msg"), err.message);
  }
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
    token = r.token; store.set(token); $("#si-proof").value = "";
    await loadMe(); toast("Signed in");
  } catch (err) {
    msg($("#si-msg"), err.message);
  } finally { busy(btn, false); }
});

function signOut(expired) {
  token = null; me = null; store.clear(); clearTimeout(pollTimer);
  render();
  if (expired) msg($("#si-msg"), "Your session ended. Sign in again.");
}
$("#signout").addEventListener("click", () => { signOut(); toast("Signed out"); });

$("#billing").addEventListener("click", async (e) => {
  busy(e.currentTarget, true, "Opening");
  try { location.href = (await api("/api/portal", { method: "POST" })).url; }
  catch (err) { toast(err.message); busy(e.currentTarget, false); }
});

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
    : "Your plan is not active. Pick a plan below to keep clipping.";
  $("#go").disabled = !p;
  renderJobs(me.jobs || []);
  if ((me.jobs || []).some((j) => j.status === "queued" || j.status === "processing")) schedulePoll();
}

function renderJobs(jobs) {
  const box = $("#jobs");
  if (!jobs.length) {
    box.innerHTML = '<div class="empty">Your clips show up here. Paste a stream link above to start.</div>';
    return;
  }
  // keep any playing video untouched: only re-render cards whose content changed
  const html = jobs.map(jobCard);
  const existing = new Map($$(".job", box).map((n) => [n.dataset.id, n]));
  const frag = document.createDocumentFragment();
  jobs.forEach((j, i) => {
    const old = existing.get(j.id);
    if (old && old.dataset.sig === sig(j)) frag.appendChild(old);
    else { const t = document.createElement("template"); t.innerHTML = html[i].trim(); frag.appendChild(t.content.firstChild); }
  });
  box.replaceChildren(frag);
}
const sig = (j) => [j.status, j.progress, j.error, j.position, (j.clips || []).length].join("|");

function jobCard(j) {
  const title = j.source_title || j.source_url.replace(/^https?:\/\/(www\.)?/, "");
  const live = j.status === "queued" || j.status === "processing";
  const label = { done: "Ready", failed: "Failed", processing: "Working", queued: "In line" }[j.status] || j.status;
  let body = "";
  if (live) {
    const where = j.status === "queued" && j.position > 1 ? `Number ${j.position} in line. ` : "";
    body = `<div class="bar"><i></i></div><p class="job-msg">${esc(where + (j.progress || "Waiting to start"))}</p>`;
  } else if (j.status === "failed") {
    body = `<p class="job-msg err">${esc(j.error || "This one did not finish.")}</p>`;
  } else {
    body = `<div class="gallery">${(j.clips || []).map((c, k) => `
      <div class="kc">
        <video src="${esc(c.url)}#t=0.5" preload="metadata" controls playsinline></video>
        <div class="kc-b"><b>${esc(c.title)}</b><span>${clock(c.start)} to ${clock(c.end)}</span>
          <div class="kc-a"><a class="btn btn-acc" href="${esc(c.url)}" download="${esc(fileName(c.title, k))}">Download</a>
          <button class="btn btn-line" type="button" data-copy="${esc(c.caption || c.title)}">Copy caption</button></div>
        </div>
      </div>`).join("")}</div>`;
  }
  return `<article class="job" data-id="${j.id}" data-sig="${esc(sig(j))}">
    <div class="job-head"><div><b>${esc(title)}</b><span>${ago(j.created_at)}${j.status === "done" ? ` · ${(j.clips || []).length} clips` : ""}</span></div>
    <span class="state ${j.status}">${label}</span></div>${body}</article>`;
}
const fileName = (t, k) => `klipit-${String(k + 1).padStart(2, "0")}-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}.mp4`;

$("#jobs").addEventListener("click", async (e) => {
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

$("#paste").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sourceUrl = $("#url").value.trim();
  const m = $("#paste-msg"); msg(m, "");
  if (!/^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be|twitch\.tv|kick\.com)\//i.test(sourceUrl))
    return msg(m, "Paste a full YouTube, Twitch or Kick video link.");
  busy($("#go"), true, "Starting");
  try {
    await api("/api/clip", { method: "POST", body: { sourceUrl } });
    $("#url").value = "";
    msg(m, "Got it. Klipit is working on it. You can leave this page and come back.", true);
    await loadMe();
  } catch (err) {
    msg(m, err.message);
  } finally { busy($("#go"), false); if (!me?.plan) $("#go").disabled = true; }
});

// ---------- return from Stripe ----------
(async function boot() {
  const q = new URLSearchParams(location.search);
  if (q.get("checkout") === "success" && q.get("session_id")) {
    history.replaceState(null, "", location.pathname + "#clip");
    try {
      const r = await api("/api/auth/checkout", { method: "POST", body: { sessionId: q.get("session_id") } });
      token = r.token; store.set(token);
      toast("You're in. Paste a stream to start.");
    } catch (err) { msg($("#si-msg"), err.message); }
    $("#clip").scrollIntoView();
  } else if (q.get("checkout") === "cancel") {
    history.replaceState(null, "", location.pathname + "#pricing");
    toast("Checkout canceled. Nothing was charged.");
  }
  await loadMe();
})();
