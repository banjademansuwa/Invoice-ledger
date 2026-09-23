#!/usr/bin/env node
// ReceiptLedger — turn a photo of a receipt into a structured expense row,
// entirely on-device via @qvac/sdk. No cloud calls, no API keys.
import { resolve } from "node:path";
import { extractText } from "./lib/ocr.js";
import { structureReceipt } from "./lib/structure.js";
import { appendRecord, countDataRows } from "./lib/ledger.js";

const CSV_PATH = resolve(process.cwd(), "expenses.csv");

async function main() {
  const imageArg = process.argv[2];
  if (!imageArg) {
    console.error("Usage: node app.js <path-to-receipt-image>");
    process.exit(1);
  }
  const imagePath = resolve(process.cwd(), imageArg);

  try {
    console.log("Loading OCR model on-device...");
    const rawText = await extractText(imagePath);
    if (!rawText.trim()) {
      console.error("OCR returned no text. Is the receipt sharp and well-lit?");
      process.exit(2);
    }
    console.log("OCR complete.");

    console.log("Loading LLM to structure the receipt...");
    const record = await structureReceipt(rawText);

    const added = await appendRecord(CSV_PATH, record);
    const total = await countDataRows(CSV_PATH);

    const merchant = record.merchant ?? "(unknown merchant)";
    const date = record.date ?? "(no date)";
    console.log("");
    console.log(`\u2705 ${merchant} \u2014 ${date} \u2014 total: ${record.total ?? "?"}`);
    for (const item of record.items) {
      console.log(`   + ${item.name}: ${item.price}`);
    }
    console.log(`Appended to expenses.csv (${total} rows total, +${added})`);
  } catch (err) {
    console.error("");
    console.error(`\u274c ${err.message}`);
    process.exit(1);
  }
}

main();
