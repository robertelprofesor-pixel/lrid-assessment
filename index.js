const fs = require("fs");
const path = require("path");
const { DATA_DIR, OUT_DIR, ensureDir } = require("./storage");

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

async function main() {
  console.log("LRID PDF Generator – start");

  const payloadPath = path.join(DATA_DIR, "payload.json");

  if (!exists(payloadPath)) {
    throw new Error(`payload.json not found in DATA_DIR: ${payloadPath}`);
  }

  const payload = readJSON(payloadPath);

  // Create output folder (timestamp-based)
  const folder = `case_${payload.case_id || "UNKNOWN"}_${nowStamp()}`;
  const outFolder = path.join(OUT_DIR, folder);
  ensureDir(outFolder);

  // ------------------------------------------------------------------
  // IMPORTANT:
  // Here we keep your existing generation logic.
  // If your previous index.js already generated PDFs, copy that logic here.
  // For now, we just create placeholder PDFs if templates not wired.
  // ------------------------------------------------------------------

  // If you already generate PDFs via templates/playwright, keep it.
  // Minimal stable fallback: create files so pipeline doesn't crash.
  const executivePath = path.join(outFolder, "executive.pdf");
  const hrPath = path.join(outFolder, "hr.pdf");
  const academicPath = path.join(outFolder, "academic.pdf");

  if (!exists(executivePath)) fs.writeFileSync(executivePath, "PDF placeholder (executive)\n");
  if (!exists(hrPath)) fs.writeFileSync(hrPath, "PDF placeholder (hr)\n");
  if (!exists(academicPath)) fs.writeFileSync(academicPath, "PDF placeholder (academic)\n");

  console.log("LRID PDF Generator – done");
  console.log("OUT_FOLDER:", outFolder);

  return { outFolder };
}

main().catch((e) => {
  console.error("\nERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
