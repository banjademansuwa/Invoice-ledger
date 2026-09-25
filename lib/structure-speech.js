// Stage B' — turn a spoken expense description into one or more structured
// expense records with the same small on-device LLM used for receipts.
//
// IMPORTANT ARCHITECTURAL CHOICE
// ------------------------------
// A 1B model cannot reliably split "I bought X at A and Y at B" into two
// records with correct per-merchant attribution — we tested it. Every
// prompt that asked the model to do the split either merged the two
// purchases into one inflated total, or duplicated the same record twice.
//
// So we don't ask the model to split. We split the transcript into
// individual purchase clauses in plain JavaScript (deterministic), then
// run each clause through a single-record extraction prompt — the same
// shape of task the model already handles well for receipts.
//
// The output is an array of records, one per clause that contained a
// number (a price). Clauses without a number are dropped.
//
// Same reliability model as structure.js:
//   - sanitizeTranscript() strips spoken currency words before the LLM
//   - strict json_schema forces a populated single-record output
//   - the caller's ledger append is called once per record
import {
  loadModel,
  completion,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

// Schema for ONE record. Same shape as the receipt schema in structure.js —
// the model is already good at this.
const RECORD_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    date: { type: "string" },
    items: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "number" },
        },
        required: ["name", "price"],
        additionalProperties: false,
      },
    },
    total: { type: "number" },
  },
  required: ["merchant", "date", "items", "total"],
  additionalProperties: false,
};

// One-purchase prompt. Deliberately short and concrete: the model only
// needs to pull merchant, date, and item+price out of a simple sentence.
const PROMPT =
  "Extract structured expense data from a single spoken purchase\n" +
  "description. The speaker described exactly ONE purchase.\n" +
  "\n" +
  "Extract:\n" +
  "- merchant: the shop or brand name spoken. If the speaker named a\n" +
  "  store ('Lenovo Store', 'Apple Store', 'Sungold'), use it. If only a\n" +
  "  brand was mentioned ('Lenovo', 'Apple'), use the brand. If nothing\n" +
  "  was named, use an empty string.\n" +
  "- date: ISO YYYY-MM-DD if a date was spoken. Otherwise empty string.\n" +
  "  Resolve 'today'/'yesterday' against CURRENT DATE below.\n" +
  "- items: ONE item with its name and price, in JSON number form.\n" +
  "- total: the price of that item.\n" +
  "\n" +
  "Rules:\n" +
  "- Use ONLY information present in the transcript.\n" +
  "- Prices are JSON numbers, not strings.\n" +
  "- If a currency word was spoken, ignore it and record the number only.\n" +
  "\n";

// Split a spoken transcript into purchase clauses.
//
// The idea: each clause should describe exactly one purchase. We split on
// natural connectors ("and", "also", "then", ",", ";") and then keep only
// clauses that contain a digit (a price). Fragments without a number are
// almost certainly filler.
//
// This is deliberately conservative: it can produce false splits when a
// single purchase is described with an "and" ("a coffee and a croissant
// for 5") — in that case both fragments are kept and the LLM will produce
// two records. That's acceptable, and honestly reflects what the user
// said: two items.
function splitIntoClauses(transcript) {
  let t = String(transcript || "").trim();
  if (!t) return [];

  // Normalize the connectors we recognize into a single sentinel we can
  // split on. We keep the sentinel text-less so it doesn't leak into the
  // clause the model sees.
  t = t.replace(/\s*(?:,|;|\.\s+|!|\?)\s*/g, " § ");
  t = t.replace(/\s+(?:and\s+also|also|and\s+then|then)\s+/gi, " § ");
  t = t.replace(/\s+and\s+(?=[^,;.!?]*\d)/gi, " § ");

  const rawParts = t
    .split("§")
    .map((s) => s.trim())
    .filter(Boolean);

  // Keep only clauses with a digit — a purchase must have a price.
  const clauses = rawParts.filter((c) => /\d/.test(c));

  // If for some reason we end up with nothing (e.g. the transcript had no
  // digits at all), fall back to the whole transcript so at least the LLM
  // gets a chance to extract *something*.
  return clauses.length ? clauses : [String(transcript).trim()];
}

export async function structureSpeech(transcript) {
  if (!transcript || !transcript.trim()) {
    throw new Error("No transcript to structure.");
  }

  const today = new Date().toISOString().slice(0, 10);
  const clean = sanitizeTranscript(transcript);
  const clauses = splitIntoClauses(clean);

  console.log(
    `[speech] split transcript into ${clauses.length} clause(s): ` +
      clauses.map((c) => `"${c}"`).join(" | ")
  );

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { ctx_size: 8192 },
  });

  try {
    const records = [];

    for (const clause of clauses) {
      const fullPrompt =
        PROMPT + `CURRENT DATE: ${today}\n\nPURCHASE:\n${clause}`;

      const run = completion({
        modelId,
        history: [{ role: "user", content: fullPrompt }],
        responseFormat: {
          type: "json_schema",
          json_schema: { name: "speech_record", schema: RECORD_SCHEMA },
        },
        generationParams: { temp: 0, seed: 42, predict: 512 },
      });

      const final = await run.final;
      const content = final?.contentText;
      if (typeof content !== "string" || !content.trim()) {
        console.warn(`[speech] empty LLM output for clause: ${clause}`);
        continue;
      }

      const parsed = tryParseJson(content);
      if (parsed === null) {
        console.warn(`[speech] non-JSON LLM output for clause: ${clause}`);
        continue;
      }

      const rec = normalizeRecord(parsed);
      // Keep only records that actually carry information. We do NOT drop
      // records with null merchant — that just means the speaker didn't
      // name a store; the item and price are still useful.
      if (rec.items.length > 0 || rec.total != null) {
        records.push(rec);
      }
    }

    return dedupeRecords(records);
  } finally {
    await unloadModel({ modelId }).catch(() => {});
  }
}

// Strip spoken currency words so the LLM sees pure numbers.
function sanitizeTranscript(text) {
  return String(text)
    .replace(
      /\b(dollars?|bucks?|euros?|pounds?|rupees?|rs|inr|usd|eur|gbp|npr|yen|yuan|pesos?)\b/gi,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

// Robust JSON parse with unbalanced-brace recovery. Voice outputs are
// short, so this is simpler than the version in structure.js — but same
// staged approach for consistency.
function tryParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {}

  const balanced = balanceJson(s);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced);
    } catch {}
  }

  return null;
}

function balanceJson(s) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) return null;
  const cleaned = s.replace(/,\s*$/, "");
  return cleaned + stack.reverse().join("");
}

function normalizeRecord(r) {
  const rawItems = Array.isArray(r?.items) ? r.items : [];
  const items = rawItems
    .filter((i) => i && typeof i.name === "string" && i.name.trim())
    .map((i) => ({ name: i.name.trim(), price: toNumber(i.price) }))
    .filter((i) => i.price !== null);

  return {
    merchant: emptyToNull(r?.merchant),
    date: emptyToNull(r?.date),
    items,
    total: zeroToNull(toNumber(r?.total)),
  };
}

function emptyToNull(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function zeroToNull(n) {
  return n === 0 ? null : n;
}

function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  let s = v.trim().replace(/[^\d.,\-]/g, "");
  if (!s) return null;
  if (!s.includes(".")) {
    const m = s.match(/^(.*),(\d{1,2})$/);
    if (m) s = `${m[1]}.${m[2]}`;
    else s = s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Remove duplicate records that a small model sometimes emits. Two records
// are duplicates when their merchant, total, and sorted item names match.
function dedupeRecords(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const itemKey = r.items
      .map((i) => `${i.name.toLowerCase()}@${i.price}`)
      .sort()
      .join("|");
    const key = `${(r.merchant || "").toLowerCase()}::${r.total ?? ""}::${itemKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}