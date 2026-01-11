/**
 * LRID™ server.js (Railway-ready)
 * - Uses persistent volume at /data (STORAGE_ROOT) when available
 * - Stores: /data/data (responses, drafts, payload.json), /data/approvals, /data/out
 * - Serves: /out/* PDFs and /review panel
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
app.use(express.json({ limit: "2mb" }));

// =======================
// Env + Paths
// =======================
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HOST = process.env.HOST || "0.0.0.0";

// Prefer Railway volume mount path if present; fallback to /data; fallback to repo local
const DEFAULT_STORAGE =
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  process.env.VOLUME_MOUNT_PATH ||
  "/data";

const STORAGE_ROOT =
  process.env.STORAGE_ROOT ||
  (fs.existsSync(DEFAULT_STORAGE) ? DEFAULT_STORAGE : path.join(__dirname));

const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = process.env.APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals");
const OUT_DIR = process.env.OUT_DIR || path.join(STORAGE_ROOT, "out");

// Repo (read-only) paths
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, "web");
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, "config");
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || path.join(__dirname, "templates");

// =======================
// Helpers
// =======================
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function writeJSON(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}

function listFilesSorted(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
}

function listFoldersSorted(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix))
    .map((f) => {
      const full = path.join(dir, f);
      if (!fs.existsSync(full)) return null;
      if (!fs.statSync(full).isDirectory()) return null;
      return { folder: f, mtime: fs.statSync(full).mtime.getTime() };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.folder);
}

// IMPORTANT: pass storage env to child scripts so they write/read /data/*
function safeExec(cmd) {
  const env = {
    ...process.env,
    STORAGE_ROOT,
    DATA_DIR,
    APPROVALS_DIR,
    OUT_DIR,
    WEB_DIR,
    CONFIG_DIR,
    TEMPLATES_DIR,
    NODE_ENV: process.env.NODE_ENV || "production",
  };

  return execSync(cmd, {
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nowStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function rand4() {
  return Math.floor(1000 + Math.random() * 9000);
}

function ensureCaseId(payload) {
  // If client sends caseId, keep it; else generate LRID-YYYYMMDD-####.
  if (payload && payload.caseId && String(payload.caseId).trim()) {
    return String(payload.caseId).trim();
  }
  return `LRID-${nowStamp()}-${rand4()}`;
}

function caseIdFromDraftFilename(draftFile) {
  // draft_LRID-20260111-6859.json -> LRID-20260111-6859
  const m = /^draft_(.+)\.json$/i.exec(draftFile || "");
  return m ? m[1] : null;
}

// =======================
// Boot: ensure dirs exist
// =======================
ensureDir(DATA_DIR);
ensureDir(APPROVALS_DIR);
ensureDir(OUT_DIR);

// =======================
// Static
// =======================
app.use("/out", express.static(OUT_DIR));
app.use("/data", express.static(DATA_DIR));
app.use("/approvals", express.static(APPROVALS_DIR));
app.use("/web", express.static(WEB_DIR));

// =======================
// Health + Debug
// =======================
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "lrid-assessment",
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || "production",
    paths: {
      STORAGE_ROOT,
      DATA_DIR,
      APPROVALS_DIR,
      OUT_DIR,
    },
  });
});

app.get("/api/debug/paths", (req, res) => {
  res.json({
    ok: true,
    __dirname,
    WEB_DIR,
    CONFIG_DIR,
    TEMPLATES_DIR,
    STORAGE_ROOT,
    DATA_DIR,
    APPROVALS_DIR,
    OUT_DIR,
    exists: {
      web: fs.existsSync(WEB_DIR),
      config: fs.existsSync(CONFIG_DIR),
      templates: fs.existsSync(TEMPLATES_DIR),
      data: fs.existsSync(DATA_DIR),
      approvals: fs.existsSync(APPROVALS_DIR),
      out: fs.existsSync(OUT_DIR),
    },
  });
});

// =======================
// Intake submit -> DATA_DIR/responses_<caseId>.json
// =======================
app.post("/api/intake/submit", (req, res) => {
  try {
    const submission = req.body || {};
    const caseId = ensureCaseId(submission);

    const outFile = `responses_${caseId}.json`;
    const outPath = path.join(DATA_DIR, outFile);

    const payload = {
      ...submission,
      caseId,
      submittedAt: new Date().toISOString(),
    };

    writeJSON(outPath, payload);

    return res.json({ ok: true, caseId, file: `data/${outFile}`, savedTo: outPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// List files for panel
// =======================
app.get("/api/list", (req, res) => {
  try {
    const responses = listFilesSorted(DATA_DIR, "responses_");
    const drafts = listFilesSorted(DATA_DIR, "draft_");
    const approvals = listFilesSorted(APPROVALS_DIR, "approval_");
    const outFolders = listFoldersSorted(OUT_DIR, "case_");

    res.json({
      ok: true,
      data: {
        responses,
        drafts,
        approvals,
        outFolders,
        hasPayload: fs.existsSync(path.join(DATA_DIR, "payload.json")),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Create approval template from draft
// Expects { draft_file: "draft_....json" }
// =======================
app.post("/api/approval/template", (req, res) => {
  try {
    const { draft_file } = req.body || {};
    if (!draft_file) return res.status(400).json({ ok: false, error: "draft_file required" });

    const draftPath = path.join(DATA_DIR, draft_file);
    if (!fs.existsSync(draftPath)) return res.status(404).json({ ok: false, error: "Draft not found" });

    const output = safeExec(`node approve_case.js "${draftPath}" --auto`);

    const caseId = caseIdFromDraftFilename(draft_file);
    const approvalFile = caseId ? `approval_${caseId}.json` : "approval_UNKNOWN_CASE.json";

    res.json({ ok: true, output, approvalFile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Save approval JSON (from panel)
// Expects { file: "approval_....json", approval: {...} }
// =======================
app.post("/api/approval/save", (req, res) => {
  try {
    const { file, approval } = req.body || {};
    if (!file || !approval) {
      return res.status(400).json({ ok: false, error: "file + approval required" });
    }
    if (!file.startsWith("approval_") || !file.endsWith(".json")) {
      return res.status(400).json({ ok: false, error: "Invalid approval filename" });
    }

    const p = path.join(APPROVALS_DIR, file);
    writeJSON(p, approval);

    res.json({ ok: true, savedTo: p });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Finalize: apply approval + generate payload + generate PDFs
// Expects { draft_file: "draft_....json" }
// =======================
app.post("/api/approval/finalize", (req, res) => {
  try {
    const { draft_file } = req.body || {};
    if (!draft_file) return res.status(400).json({ ok: false, error: "draft_file required" });

    const draftPath = path.join(DATA_DIR, draft_file);
    if (!fs.existsSync(draftPath)) return res.status(404).json({ ok: false, error: "Draft not found" });

    // 1) Apply approval to draft (this should also create/update payload.json in DATA_DIR)
    const approvalOutput = safeExec(`node approve_case.js "${draftPath}"`);

    // 2) Ensure payload exists
    const payloadPath = path.join(DATA_DIR, "payload.json");
    if (!fs.existsSync(payloadPath)) {
      throw new Error(
        `payload.json not found at ${payloadPath}. ` +
          `Your approve_case.js must generate it (or call your builder before PDFs).`
      );
    }

    // 3) Generate PDFs (index.js MUST read DATA_DIR/OUT_DIR from env)
    const pdfOutput = safeExec(`node index.js`);

    // 4) Find latest out folder
    const outFolders = listFoldersSorted(OUT_DIR, "case_");
    const latestOut = outFolders[0] || null;

    res.json({
      ok: true,
      approvalOutput,
      pdfOutput,
      latestOut,
      pdfs: latestOut
        ? {
            executive: `/out/${latestOut}/executive.pdf`,
            hr: `/out/${latestOut}/hr.pdf`,
            academic: `/out/${latestOut}/academic.pdf`,
          }
        : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Root routes
// =======================
app.get("/", (req, res) => {
  res.sendFile(path.join(WEB_DIR, "index.html"));
});

app.get("/review", (req, res) => {
  res.sendFile(path.join(WEB_DIR, "review.html"));
});

// =======================
// Start
// =======================
app.listen(PORT, HOST, () => {
  console.log(`✔ LRID™ Server running`);
  console.log(`- Host:         ${HOST}`);
  console.log(`- Port:         ${PORT}`);
  console.log(`- Intake:       /`);
  console.log(`- Review Panel: /review`);
  console.log(`- Health:       /api/health`);
  console.log(`- STORAGE_ROOT: ${STORAGE_ROOT}`);
  console.log(`- DATA_DIR:     ${DATA_DIR}`);
  console.log(`- APPROVALS_DIR:${APPROVALS_DIR}`);
  console.log(`- OUT_DIR:      ${OUT_DIR}`);
});
