// Plain browser JS. Talks to the local server. No framework, no build step.

const $ = (id) => document.getElementById(id);

const dropzone   = $("dropzone");
const fileInput  = $("fileInput");
const preview    = $("preview");
const previewImg = $("previewImg");
const clearBtn   = $("clearBtn");
const runBtn     = $("runBtn");
const logEl      = $("log");

const resultCard = $("resultCard");
const rMerchant  = $("rMerchant");
const rDate      = $("rDate");
const rTotal     = $("rTotal");
const itemsBody  = $("itemsBody");

const ledgerBody = $("ledgerBody");
const rowCount   = $("rowCount");
const refreshBtn = $("refreshBtn");
const clearLedgerBtn = $("clearLedgerBtn");

let selectedFile = null;
let busy = false;

// ── Logging ──────────────────────────────────────────────
function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  const t = new Date().toLocaleTimeString();
  line.textContent = `[${t}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
const ok   = (m) => log("✓ " + m, "ok");
const err  = (m) => log("✗ " + m, "err");
const warn = (m) => log("! " + m, "warn");
function reset() { logEl.textContent = ""; }

// ── File selection ───────────────────────────────────────
function pick(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { err("Not an image."); return; }
  selectedFile = file;
  previewImg.src = URL.createObjectURL(file);
  preview.hidden = false;
  runBtn.disabled = false;
  ok(`Selected ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
}

function clearFile() {
  selectedFile = null;
  previewImg.src = "";
  preview.hidden = true;
  fileInput.value = "";
  runBtn.disabled = true;
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => pick(e.target.files?.[0]));
clearBtn.addEventListener("click", clearFile);

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); })
);
dropzone.addEventListener("drop", (e) => pick(e.dataTransfer?.files?.[0]));

// ── Run ──────────────────────────────────────────────────
runBtn.addEventListener("click", run);

async function run() {
  if (busy || !selectedFile) return;
  busy = true;
  runBtn.disabled = true;
  runBtn.textContent = "Working…";
  reset();
  log("Uploading image…");

  const t0 = performance.now();

  try {
    const form = new FormData();
    form.append("image", selectedFile);

    log("Server is running OCR + LLM. This can take 1–3 minutes on CPU…");
    const res = await fetch("/api/process", { method: "POST", body: form });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    ok(`Done in ${secs}s (server: ${data.elapsed}s)`);
    ok(`Added ${data.added} row(s) — ledger now has ${data.total}`);

    renderResult(data.record);
    await loadLedger();
  } catch (e) {
    err(e.message || String(e));
  } finally {
    busy = false;
    runBtn.disabled = false;
    runBtn.textContent = "Extract & structure";
  }
}

// ── Render result ────────────────────────────────────────
function renderResult(rec) {
  rMerchant.textContent = rec.merchant || "(unknown merchant)";
  rDate.textContent     = rec.date || "(no date)";
  rTotal.textContent    = rec.total != null ? fmt(rec.total) : "—";

  itemsBody.innerHTML = "";
  if (!rec.items.length) {
    itemsBody.innerHTML = `<tr class="empty"><td colspan="2">No items extracted.</td></tr>`;
  } else {
    for (const it of rec.items) {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const tdPrice = document.createElement("td");
      tdName.textContent = it.name;
      tdPrice.className = "num";
      tdPrice.textContent = fmt(it.price);
      tr.append(tdName, tdPrice);
      itemsBody.appendChild(tr);
    }
  }
  resultCard.hidden = false;
}

// ── Load ledger ──────────────────────────────────────────
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
    // Reverse for newest-first display
    for (const r of [...rows].reverse()) {
      const tr = document.createElement("tr");
      for (const [key, val] of [
        ["date", r.date], ["merchant", r.merchant],
        ["item", r.item], ["price", r.price === "" ? "" : fmt(r.price)],
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

// ── Refresh / Clear ──────────────────────────────────────
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
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ── Boot ─────────────────────────────────────────────────
loadLedger();