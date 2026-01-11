const fs = require("fs");
const path = require("path");
const os = require("os");
const express = require("express");
const { execSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// Writable runtime storage (Railway-safe)
const STORAGE_ROOT =
  process.env.LRID_STORAGE_ROOT ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  path.join(os.tmpdir(), "lrid");

// Repo assets (read-only-ish)
const REPO_WEB_DIR = path.join(__dirname, "web");
const REPO_CONFIG_DIR = path.join(__dirname, "config");

// Runtime dirs (writable)
const RUNTIME_DATA_DIR = path.join(STORAGE_ROOT, "data");
const RUNTIME_APPROVALS_DIR = path.join(STORAGE_ROOT, "approvals");
const RUNTIME_OUT_DIR = path.join(STORAGE_ROOT, "out");

// =======================
// Middleware
// =======================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

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

function safeExec(cmd, extraEnv = {}) {
  try {
    return execSync(cmd, {
      cwd: __dirname,
      stdio: "pipe",
      env: { ...process.env, ...extraEnv }
    }).toString("utf8");
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
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.file);
}

function caseIdFromDraftFilename(draftFile) {
  if (!draftFile.startsWith("draft_") || !draftFile.endsWith(".json")) return null;
  return draftFile.replace(/^draft_/, "").replace(/\.json$/, "");
}

// Ensure runtime dirs exist
ensureDir(RUNTIME_DATA_DIR);
ensureDir(RUNTIME_APPROVALS_DIR);
ensureDir(RUNTIME_OUT_DIR);

// =======================
// Static hosting
// =======================
app.use(express.static(REPO_WEB_DIR));
app.use("/config", express.static(REPO_CONFIG_DIR));
app.use("/out", express.static(RUNTIME_OUT_DIR));

// =======================
// Health
// =======================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    port: PORT,
    storage_root: STORAGE_ROOT,
    runtime_data_dir: RUNTIME_DATA_DIR
  });
});

// =======================
// Intake submit -> create responses + auto-generate draft
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

    // 1) Save responses to runtime
    const outFile = `responses_${submission.case_id}.json`;
    const outPath = path.join(RUNTIME_DATA_DIR, outFile);
    writeJSON(outPath, submission);

    // 2) Auto-generate draft_<case_id>.json into the SAME runtime data directory
    const draftEnv = {
      LRID_DATA_DIR: RUNTIME_DATA_DIR
    };

    // Call build_draft.js with absolute path (no ambiguity)
    const draftOutput = safeExec(`node build_draft.js "${outPath}"`, draftEnv);

    return res.json({
      ok: true,
      file: `data/${outFile}`,
      saved_to: outPath,
      draft_output: draftOutput
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
});

// =======================
// Lists (for UI)
// =======================
app.get("/api/list", (req, res) => {
  try {
    const responses = listFilesSorted(RUNTIME_DATA_DIR, "responses_");
    const drafts = listFilesSorted(RUNTIME_DATA_DIR, "draft_");
    const approvals = listFilesSorted(RUNTIME_APPROVALS_DIR, "approval_");

    const outFolders = fs.existsSync(RUNTIME_OUT_DIR)
      ? fs
          .readdirSync(RUNTIME_OUT_DIR)
          .filter((f) => fs.statSync(path.join(RUNTIME_OUT_DIR, f)).isDirectory())
          .map((f) => ({ folder: f, mtime: fs.statSync(path.join(RUNTIME_OUT_DIR, f)).mtime.getTime() }))
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
        hasPayload: fs.existsSync(path.join(RUNTIME_DATA_DIR, "payload.json")),
        storage_root: STORAGE_ROOT
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

    const p = path.join(RUNTIME_DATA_DIR, file);
    if (!fs.existsSync(p)) {
      return res.status(404).json({ ok: false, error: "Draft not found" });
    }

    res.json({ ok: true, draft: readJSON(p) });
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

    const p = path.join(RUNTIME_APPROVALS_DIR, file);
    if (!fs.existsSync(p)) {
      return res.status(404).json({ ok: false, error: "Approval not found" });
    }

    res.json({ ok: true, approval: readJSON(p) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Approval: save approval JSON
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

    const p = path.join(RUNTIME_APPROVALS_DIR, file);
    writeJSON(p, approval);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Root routes
// =======================
app.get("/", (req, res) => {
  res.sendFile(path.join(REPO_WEB_DIR, "index.html"));
});

app.get("/review", (req, res) => {
  res.sendFile(path.join(REPO_WEB_DIR, "review.html"));
});

// =======================
// Start
// =======================
app.listen(PORT, () => {
  console.log(`✔ LRID™ Server running`);
  console.log(`- Port: ${PORT}`);
  console.log(`- Storage root: ${STORAGE_ROOT}`);
  console.log(`- Runtime data: ${RUNTIME_DATA_DIR}`);
  console.log(`- Intake:       /`);
  console.log(`- Review Panel: /review`);
  console.log(`- Health:       /api/health`);
});
