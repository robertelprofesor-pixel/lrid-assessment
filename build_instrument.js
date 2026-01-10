/**
 * Build LRID instrument JSON from CSV question bank.
 *
 * Input:  schemas/questions.v1.csv
 * Output: schemas/instrument.v1.json
 *
 * Usage:
 *   node build_instrument.js
 */

const fs = require("fs");
const path = require("path");

function parseCsvSimple(csvText) {
  // Minimal CSV parser supporting quoted fields with commas.
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (ch === '"' && next === '"') {
      cur += '"';
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some(cell => cell.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }
    cur += ch;
  }
  row.push(cur);
  if (row.some(cell => cell.trim() !== "")) rows.push(row);

  const header = rows.shift().map(h => h.trim());
  return rows.map(r => {
    const obj = {};
    header.forEach((h, idx) => obj[h] = (r[idx] ?? "").trim());
    return obj;
  });
}

function toBool(s) {
  return String(s).toLowerCase() === "true";
}
function toIntOrNull(s) {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function safeJsonOrNull(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function main() {
  const root = __dirname;
  const csvPath = path.join(root, "schemas", "questions.v1.csv");
  const outPath = path.join(root, "schemas", "instrument.v1.json");

  if (!fs.existsSync(csvPath)) {
    console.error("Missing:", csvPath);
    process.exit(1);
  }

  const csvText = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsvSimple(csvText);

  const question_bank = rows.map(r => {
    const options = safeJsonOrNull(r.options_json);
    const q = {
      question_id: r.question_id,
      dimension: r.dimension,
      type: r.type,
      required: toBool(r.required),
      reverse_scored: toBool(r.reverse_scored),
      text: {
        en: r.text_en || "",
        pl: r.text_pl || ""
      }
    };
    const minChars = toIntOrNull(r.min_chars);
    if (minChars) q.min_chars = minChars;
    if (options) q.options = options;
    return q;
  });

  // Basic expected count = required + optional total
  const expected_questions = question_bank.length;

  const instrument = {
    instrument_id: "LRID",
    instrument_version: "1.0",
    expected_questions,
    min_expected_seconds: 900,
    bands: { risk_zone_max: 2.79, mixed_max: 3.30 },
    question_bank,
    // placeholders you will extend later:
    consistency_sets: [],
    red_flag_rules: []
  };

  fs.writeFileSync(outPath, JSON.stringify(instrument, null, 2), "utf8");
  console.log("✔ Built:", path.relative(root, outPath));
  console.log("Questions:", expected_questions);
}

main();
