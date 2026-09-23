// Append structured receipt records to expenses.csv.
// Hand-rolled — no third-party CSV dependency, per the hackathon's
// "QVAC SDK only" runtime-dependency rule.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const HEADER = "date,merchant,item,price";

export async function appendRecord(csvPath, record) {
  const date = record.date ?? "";
  const merchant = record.merchant ?? "";

  const rows =
    record.items && record.items.length
      ? record.items.map((it) => [date, merchant, it.name, it.price])
      : [[date, merchant, "", record.total ?? ""]];

  const body = rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

  if (!existsSync(csvPath)) {
    await writeFile(csvPath, HEADER + "\n" + body, "utf8");
  } else {
    await appendFile(csvPath, body, "utf8");
  }

  return rows.length;
}

export async function countDataRows(csvPath) {
  if (!existsSync(csvPath)) return 0;
  const text = await readFile(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  return Math.max(0, lines.length - 1);
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
