/**
 * LRID™ server.js — Railway-proof
 * Key fixes:
 * - Always listen on process.env.PORT (Railway requirement)
 * - Bind to 0.0.0.0
 * - Volume-aware storage under /data
 * - Health + debug endpoints
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const app = express();

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
// Runtime (Railway)
// =======================
const HOST = "0.0.0.0";

// Railway sets PORT. Do NOT hardcode 8080.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// =======================
// Storage (Volume)
// =======================
// Railway volume mount path is /data in your setup.
// We detect it and use it as the root for persisted files.
const STORAGE_ROOT =
  process.env.STORAGE_ROOT ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  (fs.existsSync("/data") ? "/data" : __dirname);

const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = process.env.APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals");
const OUT_DIR = process.env.OUT_DIR || path.join(STORAGE_ROOT, "out");

// Repo (code) paths
const WEB_DIR = path.join(__dirname, "web");
const CONFIG_DIR = path.join(__dirname, "config");
const TEMPLATES_DIR = path.join(__dirname, "templates");

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

function listFoldersSorted(dir, prefix) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => {
      const full = path.join(dir, f);
      return fs.existsSync(full) && fs.statSync(full).isDirectory() && (prefix ? f.startsWith(prefix) : true);
    })
    .map((f) => ({ folder: f, mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.folder);
}

function safeExec(cmd) {
  try {
    return execSync(cmd, {
      cwd: __dirname,
      stdio: "pipe",
      env: {
        ...process.env,
        STORAGE_ROOT,
        DATA_DIR,
        APPROVALS_DIR,
        OUT_DIR,
      },
    }).toString("utf8");
  } catch (e) {
    const out =
      (e.stdout ? e.stdout.toString("utf8") : "") +
      (e.stderr ? e.stderr.toString("utf8") : "");
    throw new Error(out || e.message);
  }
}

function caseIdFromDraftFilename(draftFile) {
  // draft_<case_id>.json
  if (!draftFile.startsWith("draft_") || !draftFile.endsWith(".json")) return null;
  return draftFile.replace(/^draft_/, "").replace(/\.json$/, "");
}

// =======================
// Ensure persisted dirs exist
// =======================
ensureDir(DATA_DIR);
ensureDir(APPROVALS_DIR);
ensureDir(OUT_DIR);

// =======================
// Static hosting
// =======================
app.use(express.static(WEB_DIR));
app.use("/config", express.static(CONFIG_DIR));
app.use("/out", express.static(OUT_DIR)); // IMPORTANT: serve PDFs from volume

// =======================
// Root quick response (helps platform health checks)
// =======================
app.get("/_ping", (req, res) => res.status(200).send("ok"));

// =======================
// Health + Debug
// =======================
app.get("/api/health", (req, res) => {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    process: {
      pid: process.pid,
      node: process.version,
      envPort: process.env.PORT || null,
      listenPort: PORT,
    },
    paths: {
      STORAGE_ROOT,
      DATA_DIR,
      APPROVALS_DIR,
      OUT_DIR,
      WEB_DIR,
      CONFIG_DIR,
      TEMPLATES_DIR,
    },
  });
});

app.get("/api/debug/paths", (req, res) => {
  res.status(200).json({
    ok: true,
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

    return res.json({ ok: true, file: `data/${outFile}`, savedTo: outPath });
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
// Draft read
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
// Approval: template from draft
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
    const approvalFile = caseId ? `approval_${caseId}.json` : "approval_UNKNOWN_CASE.json";

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

    ensureDir(APPROVALS_DIR);
    const p = path.join(APPROVALS_DIR, file);
    writeJSON(p, approval);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Finalize: apply approval + generate payload + PDFs
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

    const payloadPath = path.join(DATA_DIR, "payload.json");
    if (!fs.existsSync(payloadPath)) {
      throw new Error(
        `payload.json not found at ${payloadPath}. ` +
          `approve_case.js must generate it (or call a builder before PDFs).`
      );
    }

    const pdfOutput = safeExec("node index.js");

    const outFolders = listFoldersSorted(OUT_DIR, "case_");
    const latestOut = outFolders[0] || null;

    res.json({
      ok: true,
      approvalOutput,
      pdfOutput,
      latestOutFolder: latestOut,
      links: latestOut
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
  // If index.html is missing for any reason, keep platform happy with a 200.
  const p = path.join(WEB_DIR, "index.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(200).send("LRID server is up. Missing web/index.html");
});

app.get("/review", (req, res) => {
  const p = path.join(WEB_DIR, "review.html");
  if (fs.existsSync(p)) return res.sendFile(p);
  return res.status(404).send("Missing web/review.html");
});

// =======================
// Start
// =======================
app.listen(PORT, HOST, () => {
  console.log(`✔ LRID™ Server running`);
  console.log(`- Host:         ${HOST}`);
  console.log(`- Port:         ${PORT}`);
  console.log(`- ENV PORT:     ${process.env.PORT || "(not set)"}`);
  console.log(`- Intake:       /`);
  console.log(`- Review Panel: /review`);
  console.log(`- Health:       /api/health`);
  console.log(`- Ping:         /_ping`);
  console.log(`STORAGE_ROOT: ${STORAGE_ROOT}`);
  console.log(`DATA_DIR: ${DATA_DIR}`);
  console.log(`APPROVALS_DIR: ${APPROVALS_DIR}`);
  console.log(`OUT_DIR: ${OUT_DIR}`);
});
