const fs = require("fs");
const path = require("path");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// Railway Volume root (recommended: /data)
const STORAGE_ROOT = process.env.LRID_STORAGE || path.join(__dirname, ".localdata");

// Our app folders inside the storage root
const DATA_DIR = path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = path.join(STORAGE_ROOT, "approvals");
const OUT_DIR = path.join(STORAGE_ROOT, "out");
const SESSIONS_DIR = path.join(STORAGE_ROOT, "sessions");

// Ensure they exist
ensureDir(STORAGE_ROOT);
ensureDir(DATA_DIR);
ensureDir(APPROVALS_DIR);
ensureDir(OUT_DIR);
ensureDir(SESSIONS_DIR);

module.exports = {
  STORAGE_ROOT,
  DATA_DIR,
  APPROVALS_DIR,
  OUT_DIR,
  SESSIONS_DIR,
  ensureDir,
};
