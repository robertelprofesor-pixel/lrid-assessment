const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const STORAGE_ROOT = process.env.LRID_STORAGE || path.join(__dirname, ".runtime");
const DATA_DIR = process.env.LRID_DATA_DIR || path.join(STORAGE_ROOT, "data");
const OUT_DIR = process.env.LRID_OUT_DIR || path.join(STORAGE_ROOT, "out");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getValueByPath(obj, dottedPath) {
  return dottedPath
    .split(".")
    .reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : ""), obj);
}

function renderTemplate(html, payload) {
  return html.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (match, key) => {
    const value = getValueByPath(payload, key.trim());
    return value !== undefined && value !== null ? String(value) : "";
  });
}

function slugify(input) {
  return String(input || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "Unknown";
}

async function htmlToPdf(html, outputPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });

  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" }
  });

  await browser.close();
}

async function main() {
  console.log("LRID PDF Generator – start");

  const payloadPath = path.join(DATA_DIR, "payload.json");
  if (!fs.existsSync(payloadPath)) {
    throw new Error(`payload.json not found in DATA_DIR: ${payloadPath}`);
  }

  const payload = readJson(payloadPath);

  const subjectName = getValueByPath(payload, "meta.subject_name") || "Unknown";
  const reportDate = getValueByPath(payload, "meta.report_date") || "NoDate";

  const folderName = `${slugify(subjectName)}_${slugify(reportDate)}`;
  const outDir = path.join(OUT_DIR, folderName);
  ensureDir(outDir);

  const reports = [
    { template: "templates/executive.html", file: "executive.pdf" },
    { template: "templates/hr.html", file: "hr.pdf" },
    { template: "templates/academic.html", file: "academic.pdf" }
  ];

  for (const r of reports) {
    const templatePath = path.join(__dirname, r.template);
    const htmlTemplate = readText(templatePath);

    const renderedHtml = renderTemplate(htmlTemplate, payload);
    const outputPath = path.join(outDir, r.file);

    await htmlToPdf(renderedHtml, outputPath);
    console.log("✔ Created:", path.join(folderName, r.file));
  }

  console.log("DONE. PDFs are in:", outDir);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
