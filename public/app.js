const $ = (s) => document.querySelector(s);
const api = (p, opts) => fetch(p, opts).then((r) => r.json());

// --- pricing ---
(async function loadTiers() {
  const el = $("#tiers");
  try {
    const tiers = await api("/api/tiers");
    el.innerHTML = tiers
      .map((t, i) => {
        const feature = i === 1 ? "feature" : "";
        const pop = i === 1 ? '<div class="pop">MOST POPULAR</div>' : "";
        return `
        <div class="tier ${feature}">
          ${pop}
          <h3>${t.name}</h3>
          <div class="price">$${t.priceUsd}<small>/mo</small></div>
          <ul>
            <li>${t.clipsPerStream} clips per stream</li>
            <li>Scans up to ${t.maxMinutes} min of stream</li>
            <li>${t.resolution}p vertical clips</li>
            <li>${t.captions ? "Auto captions burned in" : "Clean cuts"}</li>
            <li>${t.watermark ? "Klipit watermark" : "No watermark"}</li>
          </ul>
          <button class="btn ${feature ? "btn-primary" : "btn-ghost"}" data-tier="${t.key}">Subscribe</button>
        </div>`;
      })
      .join("");
    el.querySelectorAll("button[data-tier]").forEach((b) =>
      b.addEventListener("click", () => checkout(b.dataset.tier))
    );
  } catch {
    el.innerHTML = '<div class="loading">Plans unavailable — email hsw365media@gmail.com.</div>';
  }
})();

async function checkout(tier) {
  const email = prompt("Email for your subscription:");
  if (!email) return;
  try {
    const { url, error } = await api("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, email }),
    });
    if (url) location.href = url;
    else alert(error || "Checkout unavailable.");
  } catch {
    alert("Checkout failed. Try again.");
  }
}

// --- clipper ---
const status = $("#status");
const clipsBox = $("#clips");

$("#go").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  const sourceUrl = $("#url").value.trim();
  clipsBox.innerHTML = "";
  status.className = "status";
  if (!email || !sourceUrl) return setStatus("Enter your email and a stream link.", true);

  $("#go").disabled = true;
  setStatus("submitting…");
  try {
    const res = await api("/api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, sourceUrl }),
    });
    if (res.error) {
      $("#go").disabled = false;
      return setStatus(res.error, true);
    }
    poll(res.jobId);
  } catch {
    $("#go").disabled = false;
    setStatus("Submit failed. Try again.", true);
  }
});

async function poll(jobId) {
  try {
    const job = await api(`/api/job/${jobId}`);
    if (job.status === "done") {
      $("#go").disabled = false;
      setStatus(`Done — ${job.clips?.length || 0} clips ready.`);
      renderClips(job.clips || []);
    } else if (job.status === "failed") {
      $("#go").disabled = false;
      setStatus(job.error || "Job failed.", true);
    } else {
      setStatus(`${job.status}… ${job.progress || ""}`);
      setTimeout(() => poll(jobId), 3000);
    }
  } catch {
    setTimeout(() => poll(jobId), 4000);
  }
}

function renderClips(clips) {
  clipsBox.innerHTML = clips
    .map(
      (c) => `
    <div class="clip">
      <div class="meta"><strong>${escape(c.title)}</strong><span>${c.start}s – ${c.end}s</span></div>
      <a class="btn btn-ghost" href="${c.url}" download target="_blank" rel="noopener">Download</a>
    </div>`
    )
    .join("");
}

function setStatus(msg, err) {
  status.textContent = msg;
  status.className = "status" + (err ? " err" : "");
}
function escape(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

// handle post-checkout return
const params = new URLSearchParams(location.search);
if (params.get("checkout") === "success") {
  const email = params.get("email");
  if (email && email !== "{CHECKOUT_SESSION_CUSTOMER_EMAIL}") $("#email").value = email;
  location.hash = "#clip";
  setStatus("Subscription active. Paste a stream to start clipping.");
}
