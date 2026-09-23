// Tiny HTTP server. No Express, no dependencies — just Node's built-in http
// module. Serves the static client from ./public and exposes one API:
//   POST /api/process  (multipart/form-data with an "image" field)
//     → runs your existing OCR + LLM pipeline
//     → appends to expenses.csv
//     → returns the structured record as JSON

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { extractText } from "./lib/ocr.js";
import { structureReceipt } from "./lib/structure.js";
import { appendRecord, countDataRows } from "./lib/ledger.js";

const PORT = 3000;
const ROOT = resolve(process.cwd());
const PUBLIC_DIR = join(ROOT, "public");
const CSV_PATH = join(ROOT, "expenses.csv");
const TMP_DIR = join(ROOT, ".tmp");
const MAX_UPLOAD = 25 * 1024 * 1024; // 25 MB

// ── MIME types for static files ──────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

// ── Server ──────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/process") {
      return await handleProcess(req, res);
    }
    if (req.method === "GET" && req.url === "/api/ledger") {
      return await handleLedger(req, res);
    }
    if (req.method === "POST" && req.url === "/api/clear") {
      return await handleClear(req, res);
    }
    if (req.method === "GET") {
      return await serveStatic(req, res);
    }
    send(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error("[server] error:", err);
    send(res, 500, { error: err.message || "Internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`\n  ReceiptLedger running at http://localhost:${PORT}\n`);
});

// ── Static file serving ─────────────────────────────────
async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = join(PUBLIC_DIR, urlPath);

  // Prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, { error: "Forbidden" });
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

// ── POST /api/process ───────────────────────────────────
async function handleProcess(req, res) {
  const started = Date.now();

  // 1. Read the full body (with size cap)
  const body = await readBody(req, MAX_UPLOAD);

  // 2. Parse multipart/form-data to extract the image
  const image = parseMultipartImage(body, req.headers["content-type"]);
  if (!image) {
    return send(res, 400, { error: "No image field in request." });
  }

  // 3. Write image to a temp file (your ocr.js expects a path)
  await mkdir(TMP_DIR, { recursive: true });
  const tmpPath = join(TMP_DIR, `receipt-${Date.now()}${image.ext}`);
  await writeFile(tmpPath, image.buffer);

  try {
    // 4. Run your existing pipeline — unchanged
    console.log(`[process] OCR start (${(image.buffer.length / 1024).toFixed(0)} KB)`);
    const rawText = await extractText(tmpPath);
    if (!rawText.trim()) {
      return send(res, 422, { error: "OCR returned no text. Is the image sharp and well-lit?" });
    }
    console.log(`[process] OCR done, ${rawText.length} chars`);

    console.log(`[process] LLM start`);
    const record = await structureReceipt(rawText);
    console.log(`[process] LLM done, ${record.items.length} items`);

    // 5. Append to CSV using your existing ledger helper
    const added = await appendRecord(CSV_PATH, record);
    const total = await countDataRows(CSV_PATH);

    // 6. Return everything to the client
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    send(res, 200, {
      ok: true,
      record,
      added,
      total,
      elapsed,
      rawTextPreview: rawText.slice(0, 500),
    });
  } finally {
    // Clean up temp file
    try { await (await import("node:fs/promises")).unlink(tmpPath); } catch {}
  }
}

// ── GET /api/ledger ─────────────────────────────────────
async function handleLedger(req, res) {
  if (!existsSync(CSV_PATH)) {
    return send(res, 200, { rows: [] });
  }
  const csv = await readFile(CSV_PATH, "utf8");
  const rows = parseCsv(csv);
  send(res, 200, { rows });
}

// ── POST /api/clear ─────────────────────────────────────
async function handleClear(req, res) {
  if (existsSync(CSV_PATH)) {
    await writeFile(CSV_PATH, "date,merchant,item,price\n", "utf8");
  }
  send(res, 200, { ok: true });
}

// ── Body reader with size cap ───────────────────────────
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`Upload too large (max ${maxBytes / 1024 / 1024} MB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ── Minimal multipart/form-data parser ──────────────────
// Extracts the first file field from the body. Good enough for one image.
function parseMultipartImage(body, contentType) {
  if (!contentType || !contentType.includes("multipart/form-data")) return null;

  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  const boundaryBuf = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(body, boundaryBuf);

  for (const part of parts) {
    // Skip empty parts and the closing "--"
    if (part.length < 4) continue;

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headers = part.slice(0, headerEnd).toString("utf8");
    if (!/content-disposition:.*filename=/i.test(headers)) continue;

    // Extract content-type extension
    const ctMatch = headers.match(/content-type:\s*([^\r\n]+)/i);
    const ct = ctMatch ? ctMatch[1].trim() : "image/jpeg";
    const ext = ct.includes("png") ? ".png"
              : ct.includes("webp") ? ".webp"
              : ".jpg";

    // Body is everything after the header block, minus trailing \r\n
    let data = part.slice(headerEnd + 4);
    if (data.length >= 2 && data[data.length - 2] === 0x0d && data[data.length - 1] === 0x0a) {
      data = data.slice(0, -2);
    }

    return { buffer: data, ext, contentType: ct };
  }
  return null;
}

function splitBuffer(buf, delimiter) {
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buf.indexOf(delimiter, start);
    if (idx === -1) break;
    if (start > 0) parts.push(buf.slice(start, idx));
    start = idx + delimiter.length;
  }
  return parts;
}

// ── Minimal CSV parser (for the ledger endpoint) ────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ── Helpers ─────────────────────────────────────────────
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}