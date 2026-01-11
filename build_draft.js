/**
 * LRID Draft Builder (stable)
 *
 * Input:  responses_<case_id>.json (from runtime data dir)
 * Output: draft_<case_id>.json (in same runtime data dir)
 *
 * Stability goals:
 * - NEVER produces UNKNOWN_CASE as final filename
 * - Extracts case_id from multiple possible locations
 * - Generates a safe fallback case_id if missing
 * - Avoids overwriting drafts by making filename unique if needed
 *
 * Usage:
 *   node build_draft.js "/abs/path/to/responses_XXX.json"
 *
 * Environment:
 *   LRID_DATA_DIR=/tmp/lrid/data
 */

const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
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

function extractCaseId(responses, responsesPath) {
  // Try all common places where case_id might exist
  // 1) top-level case_id
  // 2) meta.case_id
  // 3) meta.session_id or session_id as fallback
  // 4) parse from filename responses_<id>.json
  const fromTop = responses?.case_id;
  const fromMeta = responses?.meta?.case_id;
  const fromSession = pickFirstString(responses?.session_id, responses?.meta?.session_id);

  let fromFilename = null;
  const base = path.basename(responsesPath);
  const m = base.match(/^responses_(.+)\.json$/);
  if (m && m[1]) fromFilename = m[1];

  const cid = pickFirstString(fromTop, fromMeta, fromFilename);
  if (cid) return cid;

  // If still missing, build a stable fallback that is still unique and traceable
  if (fromSession) {
    return `LRID-${nowStamp()}-${safeSlug(fromSession).slice(-10)}`;
  }
  return `LRID-${nowStamp()}-NOCASEID`;
}

function uniqueDraftPath(dataDir, desiredName) {
  const base = desiredName.replace(/\.json$/i, "");
  let candidate = path.join(dataDir, `${base}.json`);
  if (!fs.existsSync(candidate)) return candidate;

  // If exists, add increment
  for (let i = 2; i <= 200; i++) {
    candidate = path.join(dataDir, `${base}__${i}.json`);
    if (!fs.existsSync(candidate)) return candidate;
  }

  // Last resort: timestamp suffix
  return path.join(dataDir, `${base}__${nowStamp()}.json`);
}

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Missing input file. Example: node build_draft.js /tmp/lrid/data/responses_XXX.json");
    process.exit(1);
  }

  const projectRoot = __dirname;
  const dataDir = process.env.LRID_DATA_DIR
    ? path.resolve(process.env.LRID_DATA_DIR)
    : path.join(projectRoot, "data");

  ensureDir(dataDir);

  const responsesPath = path.isAbsolute(inputArg) ? inputArg : path.join(dataDir, inputArg);

  if (!fs.existsSync(responsesPath)) {
    console.error("Responses file not found:", responsesPath);
    process.exit(1);
  }

  const responses = readJson(responsesPath);

  // Optional instrument schema (do not hard-fail if missing)
  const instrumentPath = path.join(projectRoot, "schemas", "instrument.v1.json");
  let instrument = null;
  if (fs.existsSync(instrumentPath)) {
    try {
      instrument = readJson(instrumentPath);
    } catch (e) {
      instrument = null;
    }
  }

  const caseIdRaw = extractCaseId(responses, responsesPath);
  const caseId = safeSlug(caseIdRaw);

  const expectedQuestions = instrument?.expected_questions || null;
  const minExpectedSeconds = instrument?.min_expected_seconds || null;

  const answers = Array.isArray(responses?.answers) ? responses.answers : [];
  const durationSeconds =
    typeof responses?.meta?.duration_seconds === "number"
      ? responses.meta.duration_seconds
      : typeof responses?.duration_seconds === "number"
      ? responses.duration_seconds
      : null;

  const hardErrors = [];
  const warnings = [];

  if (expectedQuestions !== null && answers.length > 0 && answers.length !== expectedQuestions) {
    warnings.push(`Expected ${expectedQuestions} answers but got ${answers.length}.`);
  }

  if (minExpectedSeconds !== null && durationSeconds !== null && durationSeconds < minExpectedSeconds) {
    warnings.push(`Duration ${durationSeconds}s is below minimum ${minExpectedSeconds}s.`);
  }

  // Build a review-friendly draft object
  const draft = {
    meta: {
      case_id: caseId,
      created_at: new Date().toISOString(),
      source_responses_file: responsesPath
    },
    instrument: instrument
      ? {
          version: instrument?.version || "unknown",
          expected_questions: instrument?.expected_questions || null
        }
      : {
          version: "unknown",
          expected_questions: null
        },
    responses,
    validation: {
      status: hardErrors.length > 0 ? "FAIL" : "PASS",
      hard_errors: hardErrors,
      warnings
    },
    draft_scoring: {
      note: "Draft created for review workflow. Scoring can be enriched downstream."
    },
    draft_narrative: {
      note: "Narrative can be generated downstream (approval/report pipeline)."
    }
  };

  const desiredName = `draft_${caseId}.json`;
  const outPath = uniqueDraftPath(dataDir, desiredName);

  writeJson(outPath, draft);

  console.log("OK Draft created");
  console.log(outPath);
}

main();

