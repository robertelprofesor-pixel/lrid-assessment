/**
 * LRID PDF Generator – index.js (auto-folder per subject+date)
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

/* ================================
   Read files
================================ */

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

/* ================================
   Template renderer {{a.b.c}}
================================ */

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

/* ================================
   Safe folder / filename helper
================================ */

function slugify(input) {
  // make it filesystem-safe (mac/windows friendly)
  return String(input || "")
    .trim()
    .replace(/\s+/g, "_")           // spaces -> _
    .replace(/[^\w\-]/g, "")        // remove weird chars
    .replace(/_+/g, "_")            // collapse ___
    .replace(/^_+|_+$/g, "")        // trim _
    .slice(0, 80) || "Unknown";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/* ================================
   HTML → PDF (Chromium)
================================ */

async function htmlToPdf(html, outputPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: "networkidle" });

  await page.pdf({
    path: outputPath,
    format: "A4",
    printBackground: true,
    margin: {
      top: "12mm",
      bottom: "12mm",
      left: "12mm",
      right: "12mm"
    }
  });

  await browser.close();
}

/* ================================
   Main
================================ */

async function main() {
  console.log("LRID PDF Generator – start");

  // 1) Load payload
  const payloadPath = path.join(__dirname, "data", "payload.json");
  const payload = readJson(payloadPath);

  // 2) Build output folder name: out/<Subject>_<Date>
  const subjectName = getValueByPath(payload, "meta.subject_name") || "Unknown";
  const reportDate = getValueByPath(payload, "meta.report_date") || "NoDate";

  const folderName = `${slugify(subjectName)}_${slugify(reportDate)}`;
  const outDir = path.join(__dirname, "out", folderName);

  ensureDir(outDir);

  // 3) Reports to generate (saved inside that folder)
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
    console.log("✔ Created:", path.join("out", folderName, r.file));
  }

  console.log("DONE. PDFs are in:", path.join("out", folderName));
}

main().catch((error) => {
  console.error("ERROR:", error);
  process.exit(1);
});
