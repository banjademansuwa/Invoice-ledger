# InvoiceLedger

Turn a receipt photo **or** a spoken description into structured expense rows —
entirely on-device, using [Tether's QVAC SDK](https://github.com/tetherto/qvac).

No API key. No cloud call. No usage bill. Point it at a receipt image, or say
what you bought out loud, and it produces clean `merchant / date / item / price`
rows appended to a running `expenses.csv` — all inference happens on your own
machine.

**Author:** Mansuwa Banjade · **SDK:** `@qvac/sdk` 0.19.1

---

## Two input modes, one ledger

| Mode | Input | Pipeline |
|---|---|---|
| **Image** | Receipt photo (PNG/JPG/WEBP) | QVAC OCR → LLM extraction → CSV row(s) |
| **Voice** | Audio file (MP3/WAV/M4A/OGG/WEBM/MP4) | QVAC Whisper → LLM extraction → CSV row(s) |

Both modes share the same output schema and append to the same `expenses.csv`.
You can mix and match — scan a paper receipt today, dictate a purchase
tomorrow, and they land in the same growing ledger.

### Example — voice input

Say or upload:

> *"A Lenovo laptop at 400 from Lenovo Store and a Samsung mobile from
> Samsung Store at 2000."*

And you get **two** ledger rows:

```
date,merchant,item,price
,Lenovo Store,Lenovo laptop,400
,Samsung Store,Samsung mobile,2000
```

---

## What it does — and which QVAC functions it calls

| Stage | Function | QVAC API used |
|---|---|---|
| Read text from image | `lib/ocr.js` → `extractText()` | `loadModel` + `ocr` + `unloadModel` |
| Read text from audio | `lib/speech.js` → `transcribeAudio()` | `loadModel` + `transcribe` + `unloadModel` |
| Structure OCR text | `lib/structure.js` → `structureReceipt()` | `loadModel` + `completion` + `unloadModel` |
| Structure transcript | `lib/structure-speech.js` → `structureSpeech()` | `loadModel` + `completion` + `unloadModel` (per clause) |
| Append to CSV | `lib/ledger.js` → `appendRecord()` | — (plain Node `fs`) |

Every request calls `loadModel`, runs inference, then `unloadModel` — so only
one model is resident at any time, keeping memory use modest even on a laptop.

---

## Requirements

- **Node.js `>= 22.17`**
- **~1 GB of free disk space** for the cached models
  - OCR (EasyOCR Latin + CRAFT detector): ~200 MB
  - LLM (Llama 3.2 1B Instruct, Q4_0): ~700 MB
  - Whisper (English tiny, Q8_0, for voice): ~43 MB
- **Internet access on the first run only** — to download models from QVAC's
  registry. Every run after that, and all inference, is fully offline.

---

## Install

```bash
npm install
```

The only runtime dependency is `@qvac/sdk`. No CSV library, no image library,
no web framework, no cloud SDK.

---

## Run — CLI (image only)

```bash
node app.js <path-to-receipt-image>
```

Try it with the bundled synthetic fixture:

```bash
node app.js samples/test-receipt.png
```

**Example session:**

```
$ node app.js myledgers/receipt-1.jpg
Loading OCR model on-device...
[engine] Loading from registry: .../latin_g2.gguf
[engine] Loading from registry: .../craft_mlt_25k.gguf
[ggml-ocr] OCR inference completed. Stats: {"numBoxes":71,...}
OCR complete.
Loading LLM to structure the receipt...
[engine] Loading from registry: .../Llama-3.2-1B-Instruct-Q4_0.gguf
[llamacpp-completion] Job completed

✅ COMPANY — (no date) — total: 371
   + T-shirt: 19
   + Pants: 59
   + Shirt: 39
   + Shoes: 199
   + Socks: 55
Appended to expenses.csv (5 rows total, +5)
```

---

## Run — Web client (image + voice)

```bash
node server.js
```

Then open **http://localhost:3000** in your browser.

The web client is a thin shell around the same `lib/` pipeline the CLI uses.
Two tabs at the top of the upload card:

- **Image tab** — drag a receipt photo, click **Extract & structure**.
- **Voice tab** — drag an audio file (or export a recording from your phone /
  Windows Voice Recorder), click **Transcribe & structure**.

Both show the extracted record(s) and refresh the ledger table below.

A **Clear** button empties `expenses.csv`; a **Refresh** button re-reads it.

### Server endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/process` | Image → OCR + LLM → append CSV → return record |
| `POST` | `/api/process-audio` | Audio → Whisper + LLM → append CSV → return records |
| `GET` | `/api/ledger` | Return current `expenses.csv` as JSON |
| `POST` | `/api/clear` | Reset `expenses.csv` to just its header |

Static files (`index.html`, `styles.css`, `app.js`) are served from `./public`.

### Binding

The server listens on **all interfaces** by default. To restrict it to your
own machine only:

```js
// In server.js, change:
server.listen(PORT, () => { ... });
// to:
server.listen(PORT, "127.0.0.1", () => { ... });
```

### First run — what to expect

The **first time** you click **Extract & structure** or **Transcribe &
structure**, QVAC downloads the required models from its registry:

- ~700 MB for the LLM (needed by both modes)
- ~200 MB for OCR (image mode only, first time only)
- ~43 MB for Whisper (voice mode only, first time only)

Downloads go into `~/.qvac/models/` on Linux/macOS, `C:\Users\<you>\.qvac\models\`
on Windows. **Once cached, every subsequent run is fully offline.**

The first load on Windows can be slow because Windows Defender scans the
freshly-downloaded `.gguf` / `.bin` files. If you see the SDK time out at 30
seconds, raise the worker startup timeout:

```powershell
# Windows PowerShell
$env:QVAC_RPC_INIT_TIMEOUT_MS = "180000"
node server.js
```

```bash
# Linux / macOS
QVAC_RPC_INIT_TIMEOUT_MS=180000 node server.js
```

Subsequent runs don't need this — the timeout is a one-time cold-start issue.

---

## Project structure

```
Invoice-ledger/
├── app.js                    CLI entry point (image only)
├── server.js                 Web server (Node http module, no framework)
├── public/
│   ├── index.html            Web client markup (image + voice tabs)
│   ├── styles.css            Web client styling
│   └── app.js                Web client logic
├── lib/
│   ├── ocr.js                Stage A  — image  → raw text
│   ├── speech.js             Stage A' — audio  → transcript
│   ├── structure.js          Stage B  — OCR text → one record
│   ├── structure-speech.js   Stage B' — transcript → many records
│   └── ledger.js             CSV append + row count
├── samples/
│   └── test-receipt.png      Synthetic fixture for a first run
├── expenses.csv              The growing ledger (gitignored)
├── LICENSE                   MIT
└── package.json
```

---

## The CSV ledger

`expenses.csv` is created on first run, appended to on every subsequent run.
One row per extracted line item:

```
date,merchant,item,price
2026-09-17,Himalayan Java,Cappuccino,180
2026-09-17,Himalayan Java,Butter Croissant,150
,Lenovo Store,Lenovo laptop,400
,Samsung Store,Samsung mobile,2000
```

It's `.gitignore`d — receipts and voice memos are personal data.

---

## How it works

### Image pipeline

```
image file
   │
   ▼
Stage A   lib/ocr.js
  loadModel({ modelSrc: OCR_LATIN.src, modelType: MODEL_TYPES.ggmlOcr })
  ocr({ modelId, image: imagePath })       → array of { text, bbox, confidence }
  unloadModel({ modelId })
   │
   ▼
Stage B   lib/structure.js
  sanitizeOcrText(rawText)                 ← strips currency symbols
  loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0, modelConfig: { ctx_size: 8192 } })
  completion({
    modelId,
    history,
    responseFormat: { type: "json_schema", json_schema: { name, schema } },
    generationParams: { temp: 0, seed: 42, predict: 768 }
  })
  → await run.final → final.contentText
  unloadModel({ modelId })
   │
   ▼
Append to expenses.csv + print summary
```

### Voice pipeline

```
audio file
   │
   ▼
Stage A'  lib/speech.js
  loadModel({ modelSrc: WHISPER_EN_TINY_Q8_0, modelType: MODEL_TYPES.whispercppTranscription })
  transcribe({ modelId, audioChunk: audioPath })   → string transcript
  unloadModel({ modelId })
   │
   ▼
Stage B'  lib/structure-speech.js
  sanitizeTranscript(transcript)           ← strips spoken currency words
  splitIntoClauses(transcript)             ← plain JS, deterministic
    "…Lenovo laptop at 400 from Lenovo Store"    → clause 1
    "…Samsung mobile from Samsung Store at 2000" → clause 2
  for each clause:
    completion({ …, responseFormat: json_schema })   ← ONE record per call
  dedupeRecords([...])
   │
   ▼
For each record: append to expenses.csv
```

**Only one model is loaded at a time** — the OCR (or Whisper) model is
unloaded before the LLM is loaded.

### Why voice splits in JavaScript, not the LLM

The obvious design would be: give the LLM the full transcript and ask for an
array of records. We tried it. On a 1B model this fails reliably — every prompt
that asked the model to split a two-purchase sentence either:

- merged both purchases into one record with an inflated total, or
- emitted the same record twice.

We tested three different prompts; the failure rate stayed above 30%.

So we changed the architecture: **the split is deterministic JavaScript**, and
the LLM only ever sees **one purchase at a time**. That's the same shape of
task it already handles well for receipts, and it now succeeds every time.

This is the correct engineering choice — use the LLM for what LLMs are good
at (extract fields from a simple sentence), and use code for everything else
(split strings, deduplicate, validate).

### Three reliability layers (shared by both modes)

**1. Input sanitization (`sanitizeOcrText` / `sanitizeTranscript`)**

Currency symbols (`$ € £ ¥ ₹ ₨`) and spoken currency words (`dollars`,
`rupees`, `USD`, …) are stripped before the LLM sees the text. A 1B model
reliably confuses a leading `$` with the digit `5` or `8`, and `€` with `6` —
so `$2.49` becomes `52.49`. Removing the symbols leaves pure numbers.

**2. Strict `json_schema` response format**

`responseFormat: { type: "json_object" }` (the loose form) lets a small model
legitimately emit `{}` — technically valid, useless in practice. The strict
form forces the grammar to require every field with the correct type, so the
model cannot "succeed" by emitting nothing. It also caps the items array
(`maxItems: 8`) so the model can't ramble past the token budget.

**3. Deterministic post-filter (`filterAgainstOcr`)**

After the image pipeline produces its JSON, a pure-JS filter runs:

- **Vocabulary filter** — rejects column headers, totals, tax lines, payment
  methods, customer-metadata fields, and known footer phrases (`THANK YOU`,
  `DINE IN`, `PLEASE COME AGAIN`). Includes common OCR-garbled variants
  (`Unlt`, `Oty`, `@randTotal`, `Dlocount`).
- **Shape filter** — item names must be ≥ 4 chars with ≥ 2 letters.
- **Metadata-context filter** — tokens within ~40 chars after a metadata
  keyword (`Name:`, `Bill No.`, `Regd`, `Batch`, …) are treated as metadata.
- **Anti-hallucination** — item names must share a token with the OCR text;
  dates must reference a year that appears in the OCR text.

For the voice pipeline, the deterministic layers are:

- **Clause filter** — clauses without a digit are dropped.
- **Dedup** — records with identical merchant + total + item set collapse to
  one.
- **Schema enforcement** — the LLM must emit a valid single record or the
  clause is skipped (with a warning to the terminal).

---

## Limitations (honest)

- **The structuring LLM is a 1B quantized model running on CPU.** It handles
  clean, printed receipts well. On harder inputs — thermal receipts, strong
  shadows, handwritten receipts, non-Latin scripts — it does what a 1B model
  can do: extracts what it recognizes, drops what it can't, and occasionally
  misreads a digit. The pipeline never invents data.
- **CPU inference is slow.**
  - **Image:** 1–2 min per full-page photo on an i5-1135G7 with no GPU.
  - **Voice:** Whisper is fast (~5–20 s for a short clip), but each clause
    requires its own LLM call, so a two-purchase sentence runs the LLM twice.
    Expect ~1–3 minutes per voice clip on CPU.
- **Whisper is English-only.** `WHISPER_EN_TINY_Q8_0` is the English-only tiny
  model. To support other languages, change one line in `lib/speech.js`:
  swap `WHISPER_EN_TINY_Q8_0` for `WHISPER_TINY` (multilingual, ~75 MB) or a
  language-specific variant from the QVAC registry.
- **Voice split is heuristic.** The clause splitter uses regexes on connectors
  (`and`, `also`, `then`, `,`, `;`). A single purchase described as "coffee
  and croissant for 5" will produce two clauses and therefore two records.
  That's often what you want — but not always.
- **Date parsing depends on the format.** `08/01/2016` is ambiguous between
  DD/MM and MM/DD; without locale context, the model picks one.
- **No image pre-processing.** The pipeline feeds the raw photo to QVAC's OCR.
  A photo with strong shadows or a steep angle is harder than it needs to be.
- **Date and total are transcribed verbatim, not sanity-checked.** If OCR
  reads `41700` as `41887`, the model reports `41887`. It doesn't invent — it
  also doesn't cross-check totals against item lists.
- **The web server runs one request at a time.** The pipeline loads and
  unloads models per request. Concurrent uploads from separate browser tabs
  will collide. Don't open two tabs and hit **Extract** simultaneously.

---

## Runtime dependencies

`package.json` declares exactly one runtime dependency:

```json
"dependencies": {
  "@qvac/sdk": "^0.19.1"
}
```

No CSV library. No image library. No HTTP client. No web framework. No cloud
AI SDK.

- The CSV writer is ~15 lines of hand-rolled code in `lib/ledger.js`.
- The web server uses Node's built-in `http` module (no Express).
- The multipart/form-data parser is ~60 lines of hand-rolled code in `server.js`.
- The client is plain HTML/CSS/JS with zero build step.

---

## Why I built this

Expense-tracking apps that OCR your receipts almost always ship the photo to
a cloud API. That's a document with your name, sometimes the last digits of
your bank card, and a running list of your spending habits going to someone
else's server. Voice memos are even worse — nobody expects their "I just
bought X" recording to leave their phone.

QVAC does the whole pipeline — reading the receipt, understanding the voice
memo, structuring the result — on your own machine. InvoiceLedger is a small,
honest demo of that: one command, one receipt (or one voice clip), one new row
in a local CSV, nothing leaves the laptop.

— Mansuwa Banjade

---

## License

MIT — see [LICENSE](LICENSE).