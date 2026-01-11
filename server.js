const fs = require("fs");
const path = require("path");
const express = require("express");
const { execFileSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * Railway (i inne hostingi) często mają read-only filesystem dla repo.
 * Dlatego dane MUSZĄ iść do volume.
 *
 * Na Railway ustawisz zmienną:
 *   LRID_STORAGE=/data
 *
 * Wtedy:
 *   /data/data        -> responses_*, draft_*, payload_*
 *   /data/approvals   -> approval_*
 *   /data/out         -> pdfy
 */
const STORAGE_ROOT = process.env.LRID_STORAGE || path.join(__dirname, ".runtime");
const DATA_DIR = process.env.LRID_DATA_DIR || path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = process.env.LRID_APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals");
const OUT_DIR = process.env.LRID_OUT_DIR || path.join(STORAGE_ROOT, "out");

// =======================
// Middleware
// =======================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Disable caching (prevents stale JS/HTML)
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// =======================
// Helpers
// =======================
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}
function isSafeFilename(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}
function listFilesSorted(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => (prefix ? f.startsWith(prefix) : true))
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.file);
}
function caseIdFromDraftFilename(draftFile) {
  if (!draftFile.startsWith("draft_") || !draftFile.endsWith(".json")) return null;
  return draftFile.replace(/^draft_/, "").replace(/\.json$/, "");
}

/**
 * Bezpieczne uruchomienie node-skryptu z ustawionymi katalogami runtime.
 * Dzięki temu build_draft.js / approve_case.js / index.js zapisują w volume.
 */
function runNodeScript(scriptFile, args = []) {
  const env = {
    ...process.env,
    LRID_STORAGE: STORAGE_ROOT,
    LRID_DATA_DIR: DATA_DIR,
    LRID_APPROVALS_DIR: APPROVALS_DIR,
    LRID_OUT_DIR: OUT_DIR
  };

  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, scriptFile), ...args], {
      cwd: __dirname,
      env,
      stdio: "pipe"
    });
    return out.toString("utf8");
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString("utf8") : "";
    const stderr = e.stderr ? e.stderr.toString("utf8") : "";
    const msg = (stdout + "\n" + stderr).trim() || e.message;
    throw new Error(msg);
  }
}

// =======================
// Init runtime dirs
// =======================
ensureDir(STORAGE_ROOT);
ensureDir(DATA_DIR);
ensureDir(APPROVALS_DIR);
ensureDir(OUT_DIR);

// =======================
// Static hosting
// =======================
app.use(express.static(path.join(__dirname, "web"))); // index.html, intake.js, review.html, review.js
app.use("/config", express.static(path.join(__dirname, "config"))); // questions JSON
app.use("/out", express.static(OUT_DIR)); // PDFs from volume

// =======================
// Health
// =======================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    storage: { STORAGE_ROOT, DATA_DIR, APPROVALS_DIR, OUT_DIR }
  });
});

// =======================
// Intake submit -> saves responses + auto-build draft
// =======================
app.post("/api/intake/submit", (req, res) => {
  try {
    const submission = req.body;

    if (!submission || typeof submission !== "object") {
      return res.status(400).json({ ok: false, error: "Missing submission body" });
    }
    if (!submission.case_id || typeof submission.case_id !== "string") {
      return res.status(400).json({ ok: false, error: "Missing case_id" });
    }

    const outFile = `responses_${submission.case_id}.json`;
    const outPath = path.join(DATA_DIR, outFile);

    writeJSON(outPath, submission);

    // AUTO: build draft immediately so Review Panel sees it
    // build_draft.js will read responses and write draft_<case_id>.json to DATA_DIR
    const draftOutput = runNodeScript("build_draft.js", [outPath]);

    return res.json({
      ok: true,
      file: `data/${outFile}`,
      draft: `draft_${submission.case_id}.json`,
      draftOutput
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Lists (for Review UI)
// =======================
app.get("/api/list", (req, res) => {
  try {
    const responses = listFilesSorted(DATA_DIR, "responses_");
    const drafts = listFilesSorted(DATA_DIR, "draft_");
    const approvals = listFilesSorted(APPROVALS_DIR, "approval_");

    const outFolders = fs.existsSync(OUT_DIR)
      ? fs
          .readdirSync(OUT_DIR)
          .filter((f) => fs.statSync(path.join(OUT_DIR, f)).isDirectory())
          .map((f) => ({ folder: f, mtime: fs.statSync(path.join(OUT_DIR, f)).mtime.getTime() }))
          .sort((a, b) => b.mtime - a.mtime)
          .map((x) => x.folder)
      : [];

    res.json({
      ok: true,
      data: {
        responses,
        drafts,
        approvals,
        outFolders,
        hasPayload: fs.existsSync(path.join(DATA_DIR, "payload.json"))
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Read draft JSON (for review panel)
// =======================
app.get("/api/draft/read", (req, res) => {
  try {
    const file = req.query.file;

    if (!file || !isSafeFilename(file)) {
      return res.status(400).json({ ok: false, error: "Invalid file" });
    }

    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) {
      return res.status(404).json({ ok: false, error: "Draft not found" });
    }

    res.json({ ok: true, draft: readJSON(p) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Approval: create template from a draft
// =======================
app.post("/api/approval/template", (req, res) => {
  try {
    const { draft_file } = req.body;

    if (!draft_file || !isSafeFilename(draft_file)) {
      return res.status(400).json({ ok: false, error: "Invalid draft_file" });
    }

    const draftPath = path.join(DATA_DIR, draft_file);
    if (!fs.existsSync(draftPath)) {
      return res.status(404).json({ ok: false, error: "Draft not found" });
    }

    // approve_case.js: if approval missing -> creates template and exits
    const output = runNodeScript("approve_case.js", [draftPath, "--auto"]).trim();

    const caseId = caseIdFromDraftFilename(draft_file);
    const approvalFile = caseId ? `approval_${caseId}.json` : null;

    res.json({ ok: true, output, approvalFile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Approval: get approval JSON
// =======================
app.get("/api/approval/get", (req, res) => {
  try {
    const file = req.query.file;

    if (!file || !isSafeFilename(file)) {
      return res.status(400).json({ ok: false, error: "Invalid file" });
    }

    const p = path.join(APPROVALS_DIR, file);
    if (!fs.existsSync(p)) {
      return res.status(404).json({ ok: false, error: "Approval not found" });
    }

    res.json({ ok: true, approval: readJSON(p) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Approval: save approval JSON (edited in UI)
// =======================
app.post("/api/approval/save", (req, res) => {
  try {
    const { file, approval } = req.body;

    if (!file || !isSafeFilename(file)) {
      return res.status(400).json({ ok: false, error: "Invalid file" });
    }
    if (!approval || typeof approval !== "object") {
      return res.status(400).json({ ok: false, error: "Invalid approval payload" });
    }

    writeJSON(path.join(APPROVALS_DIR, file), approval);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Finalize: apply approval + generate payload + generate PDFs
// =======================
app.post("/api/approval/finalize", (req, res) => {
  try {
    const { draft_file } = req.body;

    if (!draft_file || !isSafeFilename(draft_file)) {
      return res.status(400).json({ ok: false, error: "Invalid draft_file" });
    }

    const draftPath = path.join(DATA_DIR, draft_file);
    if (!fs.existsSync(draftPath)) {
      return res.status(404).json({ ok: false, error: "Draft not found" });
    }

    // 1) Apply approval to draft -> produces payload.json in DATA_DIR
    const approvalOutput = runNodeScript("approve_case.js", [draftPath]);

    // 2) Generate PDFs -> reads payload.json and writes to OUT_DIR
    const pdfOutput = runNodeScript("index.js", []);

    // 3) Latest out folder
    const latestOut =
      fs.existsSync(OUT_DIR)
        ? fs
            .readdirSync(OUT_DIR)
            .filter((f) => fs.statSync(path.join(OUT_DIR, f)).isDirectory())
            .map((f) => ({ folder: f, mtime: fs.statSync(path.join(OUT_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.mtime - a.mtime)[0]?.folder
        : null;

    res.json({
      ok: true,
      approvalOutput,
      pdfOutput,
      latestOutFolder: latestOut,
      links: latestOut
        ? {
            executive: `/out/${latestOut}/executive.pdf`,
            hr: `/out/${latestOut}/hr.pdf`,
            academic: `/out/${latestOut}/academic.pdf`
          }
        : null
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Root routes
// =======================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "web", "index.html"));
});
app.get("/review", (req, res) => {
  res.sendFile(path.join(__dirname, "web", "review.html"));
});

// =======================
// Start
// =======================
app.listen(PORT, () => {
  console.log(`✔ LRID™ Server running at http://localhost:${PORT}`);
  console.log(`- Intake:       http://localhost:${PORT}/`);
  console.log(`- Review Panel: http://localhost:${PORT}/review`);
  console.log(`- Health:       http://localhost:${PORT}/api/health`);
  console.log(`- Storage:      ${STORAGE_ROOT}`);
});
