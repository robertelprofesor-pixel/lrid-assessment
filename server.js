const fs = require("fs");
const path = require("path");
const express = require("express");
const { execSync } = require("child_process");

const app = express();

// IMPORTANT for Railway: listen on process.env.PORT and bind 0.0.0.0
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

// =======================
// Middleware
// =======================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Basic request log (helps debug Railway)
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Disable caching (prevents stale JS/HTML)
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// =======================
// Storage dirs (support Railway Volume)
// =======================
const STORAGE_ROOT = process.env.STORAGE_ROOT || "/data";

// You appear to be using these in Railway logs:
const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = process.env.APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals");
const OUT_DIR = process.env.OUT_DIR || path.join(STORAGE_ROOT, "out");

// Ensure dirs exist
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(APPROVALS_DIR);
ensureDir(OUT_DIR);

// =======================
// Static hosting
// =======================
// Serve UI from /web in the repo
app.use(express.static(path.join(__dirname, "web"))); // index.html, intake.js, review.html, review.js
app.use("/config", express.static(path.join(__dirname, "config"))); // questions JSON

// Serve generated PDFs from volume out dir
app.use("/out", express.static(OUT_DIR));

// =======================
// Helpers
// =======================
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function safeExec(cmd) {
  try {
    return execSync(cmd, { cwd: __dirname, stdio: "pipe" }).toString("utf8");
  } catch (e) {
    const out =
      (e.stdout ? e.stdout.toString("utf8") : "") +
      (e.stderr ? e.stderr.toString("utf8") : "");
    throw new Error(out || e.message);
  }
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
    .map((f) => ({
      file: f,
      mtime: fs.statSync(path.join(dir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.file);
}

function caseIdFromDraftFilename(draftFile) {
  // draft_<case_id>.json
  if (!draftFile.startsWith("draft_") || !draftFile.endsWith(".json")) return null;
  return draftFile.replace(/^draft_/, "").replace(/\.json$/, "");
}

// =======================
// Health
// =======================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    env: {
      PORT,
      STORAGE_ROOT,
      DATA_DIR,
      APPROVALS_DIR,
      OUT_DIR
    }
  });
});

// =======================
// Intake submit -> DATA_DIR/responses_<case_id>.json
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

    return res.json({ ok: true, file: `data/${outFile}` });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Lists (for UI)
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
          .map((f) => ({
            folder: f,
            mtime: fs.statSync(path.join(OUT_DIR, f)).mtime.getTime()
          }))
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
// Approval: create template (auto) from a draft
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

    const output = safeExec(`node approve_case.js "${draftPath}" --auto`);

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
// Finalize: apply approval + generate PDFs
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

    const approvalOutput = safeExec(`node approve_case.js "${draftPath}"`);
    const pdfOutput = safeExec(`node index.js`);

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
app.listen(PORT, HOST, () => {
  console.log(`✔ LRID™ Server running at http://${HOST}:${PORT}`);
  console.log(`- Intake:       /`);
  console.log(`- Review Panel: /review`);
  console.log(`- Health:       /api/health`);
  console.log(`STORAGE_ROOT: ${STORAGE_ROOT}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);
  console.log(`APPROVALS_DIR: ${APPROVALS_DIR}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});

// Crash visibility
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
  process.exit(1);
});
