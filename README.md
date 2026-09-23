# Invoice manager & Ledger

Turn a photo of a printed Invoice into a structured expense-log row — entirely
on-device, using [Tether's QVAC SDK](https://github.com/tetherto/qvac).

No API key. No cloud call. No usage bill. Point it at a receipt/invoice photo and it
OCRs the text, structures it into merchant/date/items/total with a local LLM,
and appends it to a running `expenses.csv` — all inference happens on your own
machine.

**Author:** Mansuwa Banjade

---

## What it does

Calls `loadModel` + `ocr` to read text off the invoice photo on-device, then
`loadModel` + `completion` (with a strict `json_schema` response format) to
turn that raw text into a clean structured record, and `unloadModel` between
stages so only one model is resident at a time. The structured record is
appended to `expenses.csv`.

Every run calls all four of `loadModel`, `ocr`, `completion`, and `unloadModel`.

---

## Two ways to use it

| Interface | Command | Best for |
|---|---|---|
| **CLI** | `node app.js invoice.jpg` | Quick one-off runs, scripting |
| **Web client** | `node server.js` → open `http://localhost:3000` | Drag-and-drop, browsing your ledger |

Both share the exact same pipeline in `lib/`. Both append to the same
`expenses.csv`. Use whichever you prefer — they're interchangeable.

---

## SDK version

Built and tested with **`@qvac/sdk` 0.19.1** on Node.js 22, Windows 11,
CPU-only (11th Gen Intel i5-1135G7, no discrete GPU).

---

## Requirements

- Node.js `>= 22.17`
- ~1 GB of free disk space for the cached models (OCR detector + recognizer +
  Llama 3.2 1B)
- Internet access **on the first run only** — to download the models from
  QVAC's registry. Every run after that, and all inference, is fully offline.

---

## Install

    npm install

---

## Run — CLI

    node app.js <path-to-invoice-image>

Try it immediately with the bundled synthetic fixture:

    node app.js samples/test-invoice.png

**Example session:**

    $ node app.js myledgers/invoice-1.jpg
    Loading OCR model on-device...
    [sdk:client] Initializing SDK config
    [engine] Loading from registry: .../latin_g2.gguf
    [engine] Loading from registry: .../craft_mlt_25k.gguf
    [ggml-ocr] OCR inference completed. Stats: {"numBoxes":71,...}
    OCR complete.
    Loading LLM to structure the invoice...
    [engine] Loading from registry: .../Llama-3.2-1B-Instruct-Q4_0.gguf
    [llamacpp-completion] Job completed

    ✅ COMPANY — (no date) — total: 371
       + T-shirt: 19
       + Pants: 59
       + Shirt: 39
       + Shoes: 199
       + Socks: 55
    Appended to expenses.csv (5 rows total, +5)

Run it on a different invoice and it appends another row — the CSV becomes a
real, growing ledger, not a one-shot demo.

---

## Run — Web client

    node server.js

Then open **http://localhost:3000** in your browser.

The web client is a thin shell around the same `lib/` pipeline the CLI uses.
Drag a invoice image onto the dropzone, click **Extract & structure**, and the
server runs OCR + LLM exactly as the CLI does. When it finishes, the extracted
record is displayed and the running ledger table refreshes. A **Clear** button
empties `expenses.csv` and a **Refresh** button re-reads it.

The server uses only Node's built-in `http` module — no Express, no Multer, no
extra dependencies. It exposes three endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/process` | Upload an image → run OCR + LLM → append to CSV → return the record |
| `GET`  | `/api/ledger`  | Return the current contents of `expenses.csv` as JSON |
| `POST` | `/api/clear`   | Reset `expenses.csv` to just its header row |

Static files (`index.html`, `styles.css`, `app.js`) are served from `./public`.

**Binding:** the server listens on all interfaces by default. To restrict it
to your own machine, change the last line of `server.js` to:

    server.listen(PORT, "127.0.0.1");

---

## Project structure

    invoice-ledger/
    ├── app.js                  CLI entry point
    ├── server.js               Web server (Node http module only)
    ├── public/
    │   ├── index.html          Web client markup
    │   ├── styles.css          Web client styling
    │   └── app.js              Web client logic
    ├── lib/
    │   ├── ocr.js              Stage A — image → raw text
    │   ├── structure.js        Stage B — raw text → structured record
    │   └── ledger.js           CSV append + row count
    ├── samples/
    │   └── test-receipt.png    Synthetic fixture for a first run
    ├── expenses.csv            The growing ledger (gitignored)
    └── package.json

---

## The CSV ledger

`expenses.csv` is created on first run, appended to on every subsequent run.
One row per extracted line item:

    date,merchant,item,price
    2026-09-17,Himalayan Java,Cappuccino,180
    2026-09-17,Himalayan Java,Butter Croissant,150

The file is `.gitignore`d (invoices are personal data), and the ledger helper
creates it with headers on first run if it doesn't exist.

---

## How it works

Pipeline, in order, shared by the CLI and the web server:

    image file
       │
       ▼
    Stage A  lib/ocr.js
      loadModel({ modelSrc: OCR_LATIN.src, modelType: MODEL_TYPES.ggmlOcr })
      ocr({ modelId, image })         →  array of { text, bbox, confidence }
      unloadModel({ modelId })
       │
       ▼
    Stage B  lib/structure.js
      sanitizeOcrText(rawText)         ← strips currency symbols
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

Only one model is loaded at a time — the OCR model is unloaded before the LLM
is loaded. That keeps memory use modest even on a laptop.

### Three reliability layers

A 1B parameter model running on noisy OCR output has predictable failure
modes. The pipeline defends against them in three layers, all deterministic
and all running before anything reaches the CSV:

**1. Input sanitization (`sanitizeOcrText`)**

Currency symbols (`$ € £ ¥ ₹ ₨`) and currency codes (`USD`, `EUR`, `Rs.`, …)
are stripped from the OCR text before the LLM sees it. A 1B model reliably
confuses a leading `$` with the digit `5` or `8`, and `€` with `6` — so
`$2.49` becomes `52.49` and `€7.50` becomes `67.50`. Stripping the symbols
leaves pure numbers the model parses correctly.

**2. Strict `json_schema` response format**

`responseFormat: { type: "json_object" }` (the loose form) lets a small model
legitimately emit `{}` — technically a valid JSON object, useless in practice.
The strict form forces the grammar to require every field with the correct
type, so the model cannot "succeed" by emitting nothing. It also caps the
items array (`maxItems: 8`) so the model can't ramble past the token budget.

**3. Deterministic post-filter (`filterAgainstOcr`)**

After the model produces its JSON, a pure-JS filter runs:

- **Vocabulary filter** — rejects column headers, totals, tax lines, payment
  methods, customer-metadata fields, and known footer phrases
  (`THANK YOU`, `DINE IN`, `PLEASE COME AGAIN`). Includes common OCR-garbled
  variants (`Unlt`, `Oty`, `@randTotal`, `Dlocount`, `Brand Total`).
- **Shape filter** — item names must be ≥ 4 chars with ≥ 2 letters and must
  not start with a digit unless a word follows.
- **Metadata-context filter** — tokens appearing within ~40 chars after a
  metadata keyword (`Name:`, `Bill No.`, `Regd`, `Batch`, …) in the OCR text
  are treated as metadata; items composed entirely of such tokens are dropped.
- **Anti-hallucination** — item names must share a token with the OCR text;
  a date must reference a year that appears in the OCR text.

Anything the model invents is filtered here before it reaches the CSV.

### Handling flaky LLM output

LLM sampling is stochastic — the same input can produce a tight 3-item JSON
one run and a sprawling 15-item JSON the next. `tryParseJson` recovers from
truncated responses with four staged strategies: direct parse, balance-closing
unclosed braces, dropping an incomplete trailing item, and falling back to an
empty items array. Combined with a hard `predict: 768` token cap and a
`temperature: 0, seed: 42` deterministic sampler, output is stable across runs.

---

## Limitations (honest)

- **The structuring LLM is a 1B quantized model running on CPU.** It handles
  clean, printed invoices well (see the sample run above). On harder inputs —
  thermal invoices, currency symbols glued to digits, non-Latin scripts — it
  does what a 1B model can do: extracts what it recognizes, drops what it
  can't, and occasionally misreads a digit. The pipeline is honest about
  this — it never invents data, and the deterministic post-filter drops
  anything that isn't backed by the OCR text. On a GPU-equipped machine or
  with a larger model, output quality would improve; the pipeline is
  designed so the model is the only thing that needs to change.
- **CPU inference is slow.** OCR takes 1–2 minutes per full-page photo on an
  i5-1135G7 with no GPU. Per-invoices time end-to-end is around 1.5–3 minutes.
- **Date parsing depends on the invoice's format.** `08/01/2016` is
  ambiguous between DD/MM and MM/DD; the model picks one, and without locale
  context it can't always pick the right one.
- **No image pre-processing.** The pipeline feeds the raw photo to QVAC's
  OCR. A photo with strong shadows or a steep angle is harder than it needs
  to be. Adding a cheap downscale would help but would need an image library
  — out of scope for this build (see the dependency policy below).
- **The date and total are OCR'd verbatim, not sanity-checked.** If OCR reads
  `41700` as `41887`, the model will report `41887`. That's honest behavior
  for a 1B model — it does not invent, but it does not cross-check the total
  against the item list either.
- **The web client runs one request at a time.** The pipeline loads and
  unloads models on the server; two concurrent `/api/process` requests from
  separate tabs will collide. For a personal tool this is fine — don't open
  two tabs and hit **Extract** simultaneously.

---

## Runtime dependencies

`package.json` declares exactly one runtime dependency:

    "dependencies": { "@qvac/sdk": "^0.19.1" }

No CSV library, no image library, no HTTP client, no web framework, no cloud
AI SDK. The CSV writer is ~15 lines of hand-rolled code in `lib/ledger.js`;
the web server is built entirely on Node's `http` module; the client is plain
HTML/CSS/JS with zero build step.

---

## Why I built this

Expense-tracking apps that OCR your invoices almost always ship the photo to
a cloud API. That's a document with your name, sometimes the last digits of
your bank card, and a running list of your spending habits going to someone
else's server. QVAC does the whole pipeline — reading the invoice and
structuring it — on your own machine. invoicetLedger is a small, honest demo
of that: one command, one invoice, one new row in a local CSV, nothing
leaves the laptop.

— Mansuwa Banjade

---

## License

MIT — see [LICENSE](LICENSE).