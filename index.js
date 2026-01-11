const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
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

function writePdf(filePath, title, payload) {
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(filePath));

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const stream = fs.createWriteStream(filePath);

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);

    doc.pipe(stream);

    doc.fontSize(20).text(title);
    doc.moveDown(0.5);

    doc.fontSize(11).text(`Case ID: ${payload.case_id || "UNKNOWN_CASE"}`);
    doc.text(`Generated: ${new Date().toISOString()}`);
    doc.moveDown(1);

    const meta = payload.meta || {};
    doc.fontSize(12).text("Subject", { underline: true });
    doc.fontSize(10).text(`Name: ${meta.subject_name || "Unknown"}`);
    doc.fontSize(10).text(`Email: ${meta.subject_email || "-"}`);
    doc.fontSize(10).text(`Organization: ${meta.organization || "-"}`);
    doc.moveDown(1);

    doc.fontSize(12).text("Decision", { underline: true });
    doc.fontSize(10).text(`Status: ${payload.decision_status || "-"}`);
    doc.moveDown(1);

    // Show a short snapshot of answers if present
    const draft = payload.draft || {};
    const responses = draft.responses || draft; // compatible with different draft shapes
    const answers = Array.isArray(responses.answers) ? responses.answers : Array.isArray(draft.answers) ? draft.answers : [];

    doc.fontSize(12).text("Captured answers (first 10)", { underline: true });
    doc.moveDown(0.3);

    answers.slice(0, 10).forEach((a, i) => {
      const q = a.question || a.q || `Q${i + 1}`;
      const v = a.value ?? a.answer ?? a.choice ?? "-";
      doc.fontSize(9).text(`${i + 1}. ${String(q)}`);
      doc.fontSize(9).text(`   → ${String(v)}`);
      doc.moveDown(0.2);
    });

    doc.moveDown(1);
    doc.fontSize(9).text(
      "This report is generated via a stable PDF engine (PDFKit) to ensure production reliability on Railway volumes.",
      { align: "left" }
    );

    doc.end();
  });
}

async function main() {
  console.log("LRID PDF Generator – start");

  const payloadPath = path.join(DATA_DIR, "payload.json");
  if (!exists(payloadPath)) {
    throw new Error(`payload.json not found in DATA_DIR: ${payloadPath}`);
  }

  const payload = readJSON(payloadPath);

  const folder = `case_${payload.case_id || "UNKNOWN_CASE"}_${nowStamp()}`;
  const outFolder = path.join(OUT_DIR, folder);
  ensureDir(outFolder);

  const executivePath = path.join(outFolder, "executive.pdf");
  const hrPath = path.join(outFolder, "hr.pdf");
  const academicPath = path.join(outFolder, "academic.pdf");

  await writePdf(executivePath, "LRID™ Executive Report", payload);
  await writePdf(hrPath, "LRID™ HR Report", payload);
  await writePdf(academicPath, "LRID™ Academic Report", payload);

  console.log("LRID PDF Generator – done");
  console.log("OUT_FOLDER:", outFolder);
}

main().catch((e) => {
  console.error("\nERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
