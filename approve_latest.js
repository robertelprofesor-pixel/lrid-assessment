const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DATA_DIR = path.join(__dirname, "data");

function fail(msg) {
  console.error("✖ " + msg);
  process.exit(1);
}

function findLatestDraft() {
  if (!fs.existsSync(DATA_DIR)) {
    fail("data/ directory not found");
  }

  const drafts = fs
    .readdirSync(DATA_DIR)
    .filter(f => f.startsWith("draft_") && f.endsWith(".json"))
    .map(f => ({
      file: f,
      time: fs.statSync(path.join(DATA_DIR, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time);

  if (drafts.length === 0) {
    fail("No draft_*.json files found in data/");
  }

  return drafts[0].file;
}

try {
  console.log("LRID™ Auto-Detect Approval");

  const latestDraft = findLatestDraft();
  const fullPath = `data/${latestDraft}`;

  console.log("✔ Latest draft detected:");
  console.log("  →", fullPath);

  const cmd = `node approve_case.js ${fullPath} --auto`;
  console.log("▶ Running:", cmd);

  const output = execSync(cmd, { stdio: "inherit" });

  console.log("✔ Approval template ready.");
} catch (e) {
  fail(e.message);
}
