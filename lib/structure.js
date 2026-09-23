// Stage B — turn raw OCR text into a structured expense record with a
// small on-device LLM.
//
// SDK 0.19.1 notes:
//   - `responseFormat` accepts `json_object` (loose) or `json_schema`
//     (strict; validated as GBNF natively by llama.cpp). We use
//     json_schema so the grammar forces populated output.
//   - `generationParams.predict` hard-caps output length.
//   - `run.tokenStream` is deprecated; use `run.final` →
//     `final.contentText`.
//
// OCR sanitization: we strip currency symbols ($ € £ ¥ ₹ ₨ and the
// three-letter codes USD, EUR, ...) before the LLM sees the text.
// A 1B model regularly confuses a leading `$` with the digits 5 or 8,
// and `€` with the digit 6 — turning `$2.49` into `52.49`. Removing
// the symbols leaves pure numbers that the model parses correctly.
import {
  loadModel,
  completion,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

const RECORD_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string" },
    date: { type: "string" },
    items: {
      type: "array",
      maxItems: 8,
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

const PROMPT =
  "You extract structured expense data from raw receipt OCR text.\n" +
  "\n" +
  "Extract these fields from the OCR text below:\n" +
  "- merchant: the shop or school name, usually the first line of the\n" +
  "  receipt. If the OCR splits it across multiple lines, join them with\n" +
  "  a space. If the top of the OCR text is a header like 'DATE' or a\n" +
  "  day-of-week abbreviation (MON, TUE, WED, THU, FRI, SAT, SUN) with\n" +
  "  no shop name visible, use an empty string.\n" +
  "- date: the date printed on the receipt, in YYYY-MM-DD if possible.\n" +
  "  Use an empty string if no date is visible.\n" +
  "- items: one entry per priced product or service line. Skip column\n" +
  "  headers (Item, Qty, Rate, Amount, Particulars, ...), totals\n" +
  "  (Total, Subtotal, Grand Total, ...), tax/tip/discount lines, and\n" +
  "  customer fields (Name, Bill No, Roll No, Batch, ...). Also skip\n" +
  "  footer phrases like 'THANK YOU' or 'RECEIPT', and payment-method\n" +
  "  lines like 'Visa', 'Mastercard', 'Cash', 'Change Due'. Fix\n" +
  "  obvious OCR-garbled item names if you can, otherwise use the\n" +
  "  text as-is.\n" +
  "- total: the number printed next to TOTAL or Grand Total. Do NOT\n" +
  "  compute it yourself. Use 0 if no total is visible.\n" +
  "\n" +
  "Rules:\n" +
  "- Use ONLY text that literally appears in the OCR text below.\n" +
  "- Do NOT invent, guess, or compute values.\n" +
  "- Prices and totals are JSON numbers, not strings.\n" +
  "- If a price is written as `19,00` or `4,50` (European comma),\n" +
  "  interpret it as the decimal `19.00` / `4.50`, NOT as thousands.\n" +
  "\n" +
  "OCR TEXT:\n";

const NON_ITEM_NAMES =
  /^(total|tota|totat|sub-?total|oub-?total|grand-?total|grandtotal|@?rand-?total|@?randtotal|net-?amount|gross-?amount|balance|amount|amount\s*\(rs\.?\)|amount\s*due|amount\s*in\s*word[s]?|received(\s*amount)?|received\s*amt|note|tax|vat|gst|tip|gratuity|change|change\s*due|cash|card|paid|payment|payment\s*mode|paymentmodename|discount|dlocount|qty|oty|quantity|unlt|unit|rate|rato|particulars|description|desc|item|items|sn|no|s\.?\s*no\.?|name|date|miti|table|tablename|tablonamo|bill|billno|reference|customer|regd?t?|roll|batch|user|accountant|duel?adv:?|phone|tel|only|thank|thanks|receipt|invoice|welcome|please|visit|again|visa|mastercard|amex|discover|debit|credit|refund|refund\s*reason|order|order\s*#?\s*\d*|cashier|subtotal|hst\d?|hst|gst|pst)[\s:.,;!]*$/i;

const MULTIWORD_META =
  /^(total|gross|net|sub|grand)\s+(amount|fees?|total|balance|due|paid)\b|^(thank\s*you|dine\s*in|dine\s*out|please\s+come\s+again|have\s+a\s+nice|eat\s+well|come\s+again|change\s+due|refund\s+reason)\b/i;

const META_KEYWORDS =
  /\b(name|bill|billno|regd?t?|batch|roll|user|accountant|signature|date|miti|table|tablename|reference|customer|subject|sem|student)\b/gi;

const MIN_NAME_LEN = 4;
const MIN_LETTER_COUNT = 2;

export async function structureReceipt(rawOcrText) {
  if (!rawOcrText || !rawOcrText.trim()) {
    throw new Error("No OCR text to structure.");
  }

  const cleanOcr = sanitizeOcrText(rawOcrText);

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { ctx_size: 8192 },
  });

  try {
    const run = completion({
      modelId,
      history: [{ role: "user", content: PROMPT + cleanOcr }],
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "receipt_record",
          schema: RECORD_SCHEMA,
        },
      },
      generationParams: { temp: 0, seed: 42, predict: 768 },
    });

    const final = await run.final;
    const content = final?.contentText;

    if (typeof content !== "string" || !content.trim()) {
      throw new Error(
        "LLM returned empty content. " +
          `final keys: ${Object.keys(final || {}).join(", ")}`
      );
    }

    const parsed = tryParseJson(content);
    if (parsed === null) {
      throw new Error(
        `LLM returned non-JSON output. First 300 chars:\n${content.slice(0, 300)}`
      );
    }

    return filterAgainstOcr(normalize(parsed), rawOcrText);
  } finally {
    await unloadModel({ modelId }).catch(() => {});
  }
}

// Strip currency symbols and codes from OCR text before the LLM sees it.
// A 1B model reliably misreads `$2.49` as `52.49` (symbol confused with
// the digit 5 or 8) and `€7.50` as `67.50` (symbol confused with 6).
// Removing the symbols leaves clean numbers the model can parse.
function sanitizeOcrText(text) {
  return text
    // Currency symbols: $ € £ ¥ ₹ ₨ (broad coverage)
    .replace(/[$€£¥₹₨]/g, "")
    // Three-letter currency codes and the South-Asian "Rs." abbreviation
    .replace(
      /\b(?:USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|NPR|PHP|MYR|Rs)\b\.?/gi,
      ""
    )
    // Collapse runs of spaces/tabs so stripping doesn't leave gaps
    .replace(/[ \t]+/g, " ")
    .trim();
}

// Robust JSON parse with staged recovery.
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

  const itemsMatch = s.match(/"items"\s*:\s*\[/);
  if (itemsMatch) {
    const itemsStart = itemsMatch.index + itemsMatch[0].length;
    const prefix = s.slice(0, itemsStart);
    const itemsPart = s.slice(itemsStart);
    const itemMatches = [...itemsPart.matchAll(/\{[^{}]*\}/g)];
    if (itemMatches.length > 0) {
      const last = itemMatches[itemMatches.length - 1];
      const lastEnd = last.index + last[0].length;
      const rebuilt = prefix + itemsPart.slice(0, lastEnd) + "]}";
      try {
        return JSON.parse(rebuilt);
      } catch {}
    }
    try {
      return JSON.parse(prefix + "]}");
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

function normalize(r) {
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

function buildMetadataContextTokens(rawOcrText) {
  const tokens = new Set();
  META_KEYWORDS.lastIndex = 0;
  let m;
  while ((m = META_KEYWORDS.exec(rawOcrText)) !== null) {
    const after = rawOcrText.slice(
      m.index + m[0].length,
      m.index + m[0].length + 40
    );
    for (const tok of normalizeText(after).split(" ")) {
      if (tok.length >= 3) tokens.add(tok);
    }
  }
  return tokens;
}

function filterAgainstOcr(record, rawOcrText) {
  const ocrNorm = normalizeText(rawOcrText);
  const ocrLower = rawOcrText.toLowerCase();
  const metaTokens = buildMetadataContextTokens(rawOcrText);

  const items = record.items.filter((it) => {
    const name = it.name.trim();
    // Strip trailing parentheticals before matching (e.g. "Tax (103)"
    // → "Tax") so a numeric suffix doesn't defeat the blocklist.
    const matchName = name.replace(/\s*\(.*?\)\s*$/, "").trim();

    if (NON_ITEM_NAMES.test(matchName)) return false;
    if (MULTIWORD_META.test(name)) return false;
    if (name.length < MIN_NAME_LEN) return false;
    const letters = name.replace(/[^A-Za-z]/g, "");
    if (letters.length < MIN_LETTER_COUNT) return false;
    if (/^[^A-Za-z]*\d/.test(name) && !/[A-Za-z]{2,}/.test(name)) return false;

    const nameTokens = normalizeText(name)
      .split(" ")
      .filter((t) => t.length >= 3);
    if (nameTokens.length === 0) return false;

    if (nameTokens.every((t) => metaTokens.has(t))) return false;
    if (!nameTokens.some((t) => ocrNorm.includes(t))) return false;

    return true;
  });

  let merchant = record.merchant;
  if (merchant && NON_ITEM_NAMES.test(merchant.trim())) merchant = null;
  if (merchant && /^(mon|tue|wed|thu|fri|sat|sun|date)$/i.test(merchant.trim())) {
    merchant = null;
  }

  let date = record.date;
  if (date) {
    const yearMatch = String(date).match(/\d{4}/);
    if (!yearMatch || !ocrLower.includes(yearMatch[0])) {
      date = null;
    }
  }

  return { ...record, merchant, items, date };
}

function normalizeText(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
