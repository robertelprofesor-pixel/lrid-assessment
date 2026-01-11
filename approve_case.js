const fs = require("fs");
const path = require("path");
const { DATA_DIR, APPROVALS_DIR, ensureDir } = require("./storage");

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const res = { draftPath: null, auto: false };

  for (const a of args) {
    if (a === "--auto") res.auto = true;
    else if (!res.draftPath) res.draftPath = a;
  }
  return res;
}

function caseIdFromDraft(draft) {
  return draft.case_id || draft.caseId || draft.id || "UNKNOWN_CASE";
}

function main() {
  ensureDir(DATA_DIR);
  ensureDir(APPROVALS_DIR);

  const { draftPath, auto } = parseArgs();

  if (!draftPath) {
    console.error("Usage: node approve_case.js <draft_file_path> [--auto]");
    process.exit(1);
  }

  const absDraftPath = path.isAbsolute(draftPath)
    ? draftPath
    : path.join(process.cwd(), draftPath);

  if (!fs.existsSync(absDraftPath)) {
    console.error("Draft not found:", absDraftPath);
    process.exit(1);
  }

  const draft = readJSON(absDraftPath);
  const caseId = caseIdFromDraft(draft);

  // 1) Build approval object
  const approval = {
    case_id: caseId,
    decision: auto ? "APPROVE" : "APPROVE",
    operator_notes: "",
    executive_summary_override: "",
    risk_notes_override: "",
    recommendations_override: "",
    created_at: new Date().toISOString(),
  };

  // 2) Save approval json
  const approvalFile = `approval_${caseId}.json`;
  const approvalPath = path.join(APPROVALS_DIR, approvalFile);
  writeJSON(approvalPath, approval);

  // 3) Build payload.json (the crucial file!)
  // Minimal payload structure; extend as needed by your report generator
  const payload = {
    case_id: caseId,
    draft,
    approval,
    generated_at: new Date().toISOString(),
  };

  const payloadPath = path.join(DATA_DIR, "payload.json");
  writeJSON(payloadPath, payload);

  console.log("APPROVAL saved:", approvalPath);
  console.log("PAYLOAD saved:", payloadPath);
}

main();
