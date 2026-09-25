// Plain browser JS. Talks to the local server. No framework, no build step.

const $ = (id) => document.getElementById(id);

// ── DOM refs ─────────────────────────────────────────────
const dropzone      = $("dropzone");
const fileInput     = $("fileInput");
const preview       = $("preview");
const previewImg    = $("previewImg");
const clearBtn      = $("clearBtn");
const runBtn        = $("runBtn");

const audioDropzone = $("audioDropzone");
const audioFileInput = $("audioFileInput");
const audioPreview  = $("audioPreview");
const audioPlayer   = $("audioPlayer");
const audioFileName = $("audioFileName");
const clearAudioBtn = $("clearAudioBtn");
const runAudioBtn   = $("runAudioBtn");

const logEl         = $("log");
const statusDot     = $("statusDot");
const resultCard    = $("resultCard");
const resultBody    = $("resultBody");

const ledgerBody    = $("ledgerBody");
const rowCount      = $("rowCount");
const refreshBtn    = $("refreshBtn");
const clearLedgerBtn = $("clearLedgerBtn");

// ── State ────────────────────────────────────────────────
let selectedImage = null;
let selectedAudio = null;
let busy = false;

// ── Logging ──────────────────────────────────────────────
function setStatus(state) {
  if (statusDot) statusDot.dataset.state = state;
}
function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
const ok   = (m) => { log("✓ " + m, "ok");   setStatus("ok");   };
const err  = (m) => { log("✗ " + m, "err");  setStatus("err");  };
const warn = (m) => { log("! " + m, "warn"); setStatus("idle"); };
function reset() { logEl.textContent = ""; setStatus("idle"); }

// ── Tabs ─────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.remove("active")
    );
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    document
      .querySelector(`[data-panel="${tab.dataset.tab}"]`)
      .classList.add("active");
  });
});

// ── Image selection ──────────────────────────────────────
function pickImage(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { err("Not an image."); return; }
  selectedImage = file;
  previewImg.src = URL.createObjectURL(file);
  preview.hidden = false;
  runBtn.disabled = false;
  ok(`Selected ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
}
function clearImage() {
  selectedImage = null;
  previewImg.src = "";
  preview.hidden = true;
  fileInput.value = "";
  runBtn.disabled = true;
  warn("Image removed.");
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => pickImage(e.target.files?.[0]));
clearBtn.addEventListener("click", (e) => { e.stopPropagation(); clearImage(); });
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); })
);
dropzone.addEventListener("drop", (e) => pickImage(e.dataTransfer?.files?.[0]));

// ── Audio selection ──────────────────────────────────────
function pickAudio(file) {
  if (!file) return;
  const isAudio = file.type.startsWith("audio/") ||
                  file.type === "video/mp4" ||
                  /\.(mp3|wav|m4a|ogg|webm|mp4)$/i.test(file.name);
  if (!isAudio) { err("Not an audio file."); return; }
  selectedAudio = file;
  audioPlayer.src = URL.createObjectURL(file);
  audioFileName.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  audioPreview.hidden = false;
  runAudioBtn.disabled = false;
  ok(`Selected audio: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
}
function clearAudio() {
  selectedAudio = null;
  audioPlayer.src = "";
  audioFileName.textContent = "";
  audioPreview.hidden = true;
  audioFileInput.value = "";
  runAudioBtn.disabled = true;
  warn("Audio removed.");
}

audioDropzone.addEventListener("click", () => audioFileInput.click());
audioDropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); audioFileInput.click(); }
});
audioFileInput.addEventListener("change", (e) => pickAudio(e.target.files?.[0]));
clearAudioBtn.addEventListener("click", (e) => { e.stopPropagation(); clearAudio(); });
["dragenter", "dragover"].forEach((ev) =>
  audioDropzone.addEventListener(ev, (e) => { e.preventDefault(); audioDropzone.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  audioDropzone.addEventListener(ev, (e) => { e.preventDefault(); audioDropzone.classList.remove("over"); })
);
audioDropzone.addEventListener("drop", (e) => pickAudio(e.dataTransfer?.files?.[0]));

// ── Run image pipeline ───────────────────────────────────
runBtn.addEventListener("click", runImage);

async function runImage() {
  if (busy || !selectedImage) return;
  setBusy(true, runBtn, "Working…");
  reset();
  log("Uploading image…");
  const t0 = performance.now();
  try {
    const form = new FormData();
    form.append("image", selectedImage);

    log("Server is running OCR + LLM. This can take 1–3 minutes on CPU…");
    const res = await fetch("/api/process", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    ok(`Done in ${secs}s (server: ${data.elapsed}s)`);
    ok(`Added ${data.added} row(s) — ledger now has ${data.total}`);

    renderSingleResult(data.record);
    await loadLedger();
  } catch (e) {
    err(e.message || String(e));
  } finally {
    setBusy(false, runBtn, "Extract & structure");
  }
}

// ── Run audio pipeline ───────────────────────────────────
runAudioBtn.addEventListener("click", runAudio);

async function runAudio() {
  if (busy || !selectedAudio) return;
  setBusy(true, runAudioBtn, "Working…");
  reset();
  log("Uploading audio…");
  const t0 = performance.now();
  try {
    const form = new FormData();
    form.append("audio", selectedAudio);

    log("Server is transcribing + structuring. This can take 30–120 s on CPU…");
    const res = await fetch("/api/process-audio", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    ok(`Done in ${secs}s (server: ${data.elapsed}s)`);
    ok(`Extracted ${data.records.length} purchase(s) — added ${data.added} row(s)`);
    ok(`Transcript: "${truncate(data.transcript, 140)}"`);

    renderMultiResults(data.records, data.transcript);
    await loadLedger();
  } catch (e) {
    err(e.message || String(e));
  } finally {
    setBusy(false, runAudioBtn, "Transcribe & structure");
  }
}

// ── Busy helper ──────────────────────────────────────────
function setBusy(isBusy, btn, labelText) {
  busy = isBusy;
  if (btn) {
    btn.disabled = isBusy;
    const label = btn.querySelector("span") || btn;
    label.textContent = labelText;
  }
  if (isBusy) setStatus("busy");
}

// ── Render single record (image) ─────────────────────────
function renderSingleResult(rec) {
  resultBody.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="result-head">
      <div class="result-meta">
        <div class="merchant"></div>
        <div class="date"></div>
      </div>
      <div class="total">
        <span class="total-label">Total</span>
        <span class="total-value"></span>
      </div>
    </div>
    <div class="table-scroll">
      <table class="items">
        <thead><tr><th>Item</th><th class="num">Price</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  `;
  wrap.querySelector(".merchant").textContent = rec.merchant || "(unknown merchant)";
  wrap.querySelector(".date").textContent     = rec.date || "(no date)";
  wrap.querySelector(".total-value").textContent = rec.total != null ? fmt(rec.total) : "—";

  const tbody = wrap.querySelector("tbody");
  if (!rec.items.length) {
    tbody.innerHTML = `<tr class="empty"><td colspan="2">No items extracted.</td></tr>`;
  } else {
    for (const it of rec.items) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const tdPrice = document.createElement("td");
      tdName.textContent = it.name;
      tdPrice.className = "num";
      tdPrice.textContent = fmt(it.price);
      tr.append(tdName, tdPrice);
      tbody.appendChild(tr);
    }
  }
  resultBody.appendChild(wrap);
  resultCard.hidden = false;
}

// ── Render multi record (voice) ──────────────────────────
function renderMultiResults(records, transcript) {
  resultBody.innerHTML = "";

  if (transcript) {
    const note = document.createElement("div");
    note.className = "transcript-note";
    note.textContent = `Heard: "${transcript}"`;
    resultBody.appendChild(note);
  }

  const wrap = document.createElement("div");
  wrap.className = "multi-records";

  for (const rec of records) {
    const block = document.createElement("div");
    block.className = "record-block";
    block.innerHTML = `
      <div class="result-head">
        <div class="result-meta">
          <div class="merchant"></div>
          <div class="date"></div>
        </div>
        <div class="total">
          <span class="total-label">Total</span>
          <span class="total-value"></span>
        </div>
      </div>
      <table class="items">
        <thead><tr><th>Item</th><th class="num">Price</th></tr></thead>
        <tbody></tbody>
      </table>
    `;
    block.querySelector(".merchant").textContent = rec.merchant || "(unknown merchant)";
    block.querySelector(".date").textContent     = rec.date || "(no date)";
    block.querySelector(".total-value").textContent =
      rec.total != null ? fmt(rec.total) : "—";

    const tbody = block.querySelector("tbody");
    if (!rec.items.length) {
      tbody.innerHTML = `<tr class="empty"><td colspan="2">No items.</td></tr>`;
    } else {
      for (const it of rec.items) {
        const tr = document.createElement("tr");
        const tdName = document.createElement("td");
        const tdPrice = document.createElement("td");
        tdName.textContent = it.name;
        tdPrice.className = "num";
        tdPrice.textContent = fmt(it.price);
        tr.append(tdName, tdPrice);
        tbody.appendChild(tr);
      }
    }
    wrap.appendChild(block);
  }
  resultBody.appendChild(wrap);
  resultCard.hidden = false;
}

// ── Ledger ───────────────────────────────────────────────
async function loadLedger() {
  try {
    const res = await fetch("/api/ledger");
    const data = await res.json();
    const rows = data.rows || [];

    rowCount.textContent = `${rows.length} row${rows.length === 1 ? "" : "s"}`;

    if (!rows.length) {
      ledgerBody.innerHTML = `<tr class="empty"><td colspan="4">No entries yet.</td></tr>`;
      return;
    }

    ledgerBody.innerHTML = "";
    for (const r of [...rows].reverse()) {
      const tr = document.createElement("tr");
      for (const [key, val] of [
        ["date", r.date],
        ["merchant", r.merchant],
        ["item", r.item],
        ["price", r.price === "" ? "" : fmt(r.price)],
      ]) {
        const td = document.createElement("td");
        if (key === "price") td.className = "num";
        td.textContent = val ?? "";
        tr.appendChild(td);
      }
      ledgerBody.appendChild(tr);
    }
  } catch (e) {
    err("Failed to load ledger: " + e.message);
  }
}

refreshBtn.addEventListener("click", loadLedger);
clearLedgerBtn.addEventListener("click", async () => {
  if (!confirm("Clear all ledger entries?")) return;
  try {
    await fetch("/api/clear", { method: "POST" });
    await loadLedger();
    warn("Ledger cleared.");
  } catch (e) { err(e.message); }
});

// ── Utils ────────────────────────────────────────────────
function fmt(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return String(n ?? "");
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}
function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ── Boot ─────────────────────────────────────────────────
loadLedger();