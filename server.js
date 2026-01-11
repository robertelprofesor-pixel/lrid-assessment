const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// Railway requirement: bind 0.0.0.0 and listen on process.env.PORT
const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

const STORAGE_ROOT =
  process.env.STORAGE_ROOT ||
  process.env.RAILWAY_VOLUME_MOUNT_PATH ||
  (fs.existsSync("/data") ? "/data" : __dirname);

const DATA_DIR = process.env.DATA_DIR || path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = process.env.APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals");
const OUT_DIR = process.env.OUT_DIR || path.join(STORAGE_ROOT, "out");

const WEB_DIR = path.join(__dirname, "web");
const CONFIG_DIR = path.join(__dirname, "config");

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
function safeExec(cmd) {
  try {
    return execSync(cmd, {
      cwd: __dirname,
      stdio: "pipe",
      env: { ...process.env, STORAGE_ROOT, DATA_DIR, APPROVALS_DIR, OUT_DIR }
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
function caseIdFromDraftFilename(draftFile) {
  if (!draftFile.startsWith("draft_") || !draftFile.endsWith(".json")) return null;
  return draftFile.replace(/^draft_/, "").replace(/\.json$/, "");
}

ensureDir(DATA_DIR);
ensureDir(APPROVALS_DIR);
ensureDir(OUT_DIR);

app.use(express.static(WEB_DIR));
app.use("/config", express.static(CONFIG_DIR));
app.use("/out", express.static(OUT_DIR));

app.get("/_ping", (req, res) => res.status(200).send("ok"));

app.get("/api/health", (req, res) => {
  res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    envPort: process.env.PORT || null,
    listenPort: PORT,
    paths: { STORAGE_ROOT, DATA_DIR, APPROVALS_DIR, OUT_DIR }
  });
});

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
        hasPayload: fs.existsSync(path.join(DATA_DIR, "payload.json"))
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

    return res.json({ ok: true, savedTo: outPath });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/draft/read", (req, res) => {
  try {
    const file = req.query.file;
    if (!file || !isSafeFilename(file)) {
      return res.status(400).json({ ok: false, error: "Invalid file" });
    }
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: "Draft not found" });
    res.json({ ok: true, draft: readJSON(p) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/approval/template", (req, res) => {
  try {
    const { draft_file } = req.body;
    if (!draft_file || !isSafeFilename(draft_file)) {
      return res.status(400).json({ ok: false, error: "Invalid draft_file" });
    }
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

app.post("/api/approval/finalize", (req, res) => {
  try {
    const { draft_file } = req.body;
    if (!draft_file || !isSafeFilename(draft_file)) {
      return res.status(400).json({ ok: false, error: "Invalid draft_file" });
    }
    const draftPath = path.join(DATA_DIR, draft_file);
    if (!fs.existsSync(draftPath)) return res.status(404).json({ ok: false, error: "Draft not found" });

    const approvalOutput = safeExec(`node approve_case.js "${draftPath}"`);
    const payloadPath = path.join(DATA_DIR, "payload.json");
    if (!fs.existsSync(payloadPath)) {
      throw new Error(`payload.json not found at ${payloadPath}`);
    }

    const pdfOutput = safeExec("node index.js");
    const outFolders = listFoldersSorted(OUT_DIR, "case_");
    const latestOut = outFolders[0] || null;

    res.json({
      ok: true,
      approvalOutput,
      pdfOutput,
      latestOut,
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

app.get("/", (req, res) => res.sendFile(path.join(WEB_DIR, "index.html")));
app.get("/review", (req, res) => res.sendFile(path.join(WEB_DIR, "review.html")));

app.listen(PORT, HOST, () => {
  console.log("✔ LRID™ Server running");
  console.log(`- Host:         ${HOST}`);
  console.log(`- Port:         ${PORT}`);
  console.log(`- ENV PORT:     ${process.env.PORT || "(not set)"}`);
  console.log(`- Intake:       /`);
  console.log(`- Review Panel: /review`);
  console.log(`- Health:       /api/health`);
  console.log(`- Ping:         /_ping`);
  console.log(`- STORAGE_ROOT: ${STORAGE_ROOT}`);
  console.log(`- DATA_DIR:     ${DATA_DIR}`);
  console.log(`- APPROVALS_DIR:${APPROVALS_DIR}`);
  console.log(`- OUT_DIR:      ${OUT_DIR}`);
});
