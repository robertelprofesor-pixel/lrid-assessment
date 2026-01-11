const fs = require("fs");
const path = require("path");
const { DATA_DIR, APPROVALS_DIR, ensureDir } = require("./storage");

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function safeSlug(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function pickFirstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function extractCaseIdFromAny(draft, draftPath) {
  // Try best-known locations (because drafts evolved in your project)
  const fromMeta = draft?.meta?.case_id;
  const fromTop = draft?.case_id || draft?.caseId || draft?.id;

  const fromResponses =
    draft?.responses?.case_id ||
    draft?.responses?.meta?.case_id ||
    draft?.responses?.session_id ||
    draft?.responses?.meta?.session_id;

  // From filename draft_<id>.json
  let fromFilename = null;
  const base = path.basename(draftPath);
  const m = base.match(/^draft_(.+)\.json$/);
  if (m && m[1]) fromFilename = m[1];

  const cid = pickFirstString(fromMeta, fromTop, fromResponses, fromFilename);
  if (cid) return cid;

  // last resort
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `LRID-${stamp}-NOCASEID`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    draftPath: args.find((a) => a && !a.startsWith("--")),
    auto: args.includes("--auto"),
  };
}

function main() {
  ensureDir(DATA_DIR);
  ensureDir(APPROVALS_DIR);

  const { draftPath, auto } = parseArgs();
  if (!draftPath) {
    console.error("Usage: node approve_case.js <draft_file_path> [--auto]");
    process.exit(1);
  }

  const absDraftPath = path.isAbsolute(draftPath) ? draftPath : path.join(process.cwd(), draftPath);
  if (!fs.existsSync(absDraftPath)) {
    console.error("Draft not found:", absDraftPath);
    process.exit(1);
  }

  const draft = readJSON(absDraftPath);
  const caseId = safeSlug(extractCaseIdFromAny(draft, absDraftPath));

  const approvalFile = `approval_${caseId}.json`;
  const approvalPath = path.join(APPROVALS_DIR, approvalFile);

  // If template does not exist, create it (auto mode)
  if (!fs.existsSync(approvalPath)) {
    const template = {
      meta: {
        case_id: caseId,
        created_at: new Date().toISOString(),
        expert_name: "Prof. Robert Karaszewski",
      },
      decision: {
        status: "APPROVE",
        operator_notes: "",
      },
      overrides: {
        executive_summary: "",
        risk_notes: "",
        recommendations: "",
      },
      adjustments: {
        dimension_scores_override: { DI: null, RP: null, MA: null, AC: null, PR: null, ED: null },
      },
    };

    writeJSON(approvalPath, template);
    console.log("✔ Created approval template:", approvalPath);

    if (auto) process.exit(0);
  }

  const approval = readJSON(approvalPath);
  const status = approval?.decision?.status || "APPROVE";

  if (status === "DEBRIEF") {
    console.log("DEBRIEF selected. No payload generated.");
    process.exit(0);
  }

  // Always write payload.json to DATA_DIR (this is what index.js reads)
  const payload = {
    case_id: caseId,
    generated_at: new Date().toISOString(),
    decision_status: status,
    meta: {
      subject_name: draft?.meta?.respondent_name || draft?.responses?.respondent?.name || "Unknown",
      subject_email: draft?.meta?.respondent_email || draft?.responses?.respondent?.email || "",
      organization: draft?.meta?.respondent_org || draft?.responses?.respondent?.organization || "",
      expert_name: approval?.meta?.expert_name || "Prof. Robert Karaszewski",
    },
    draft,
    approval,
  };

  const payloadDefaultPath = path.join(DATA_DIR, "payload.json");
  const payloadCasePath = path.join(DATA_DIR, `payload_${caseId}.json`);

  writeJSON(payloadDefaultPath, payload);
  writeJSON(payloadCasePath, payload);

  console.log("✔ Payload saved:", payloadDefaultPath);
  console.log("✔ Payload (case) saved:", payloadCasePath);
}

main();
