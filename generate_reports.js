/**
 * LRID One-command runner:
 * responses -> draft -> (approval gate) -> payload -> pdf
 *
 * Usage:
 *  node generate_reports.js data/responses_LRID-20251220-0001.json
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function run(cmd, cwd) {
  console.log(">", cmd);
  execSync(cmd, { stdio: "inherit", cwd });
}

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Usage: node generate_reports.js data/responses_<case_id>.json");
    process.exit(1);
  }

  const projectRoot = __dirname;
  const responsesPath = path.isAbsolute(inputArg) ? inputArg : path.join(projectRoot, inputArg);
  if (!fs.existsSync(responsesPath)) {
    console.error("Responses file not found:", responsesPath);
    process.exit(1);
  }

  // 1) Draft
  run(`node build_draft.js ${JSON.stringify(path.relative(projectRoot, responsesPath))}`, projectRoot);

  // Find produced draft by reading case_id from responses
  const responses = JSON.parse(fs.readFileSync(responsesPath, "utf8"));
  const caseId = responses?.meta?.case_id;
  if (!caseId) {
    console.error("responses.meta.case_id missing.");
    process.exit(1);
  }

  const draftFile = path.join(projectRoot, "data", `draft_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  if (!fs.existsSync(draftFile)) {
    console.error("Draft file not found:", draftFile);
    process.exit(1);
  }

  // 2) Approval + payload
  // If approval does not exist, approve_case.js will create it and exit
  run(`node approve_case.js ${JSON.stringify(path.relative(projectRoot, draftFile))}`, projectRoot);

  // 3) PDF (only if payload.json exists)
  const payloadPath = path.join(projectRoot, "data", "payload.json");
  if (!fs.existsSync(payloadPath)) {
    console.log("No payload.json yet (likely waiting for approval).");
    console.log("➡ Edit approvals/approval_<case_id>.json and set decision.status to APPROVE or ADJUST, then rerun.");
    process.exit(0);
  }

  run("node index.js", projectRoot);
}

main();
