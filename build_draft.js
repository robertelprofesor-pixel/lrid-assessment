/**
 * LRID Draft Engine (MVP)
 * Input:  responses_<case_id>.json
 * Output: draft_<case_id>.json
 *
 * NEW (Railway-safe):
 * - Uses LRID_DATA_DIR for output folder (and can read relative inputs from there).
 * - Default keeps legacy behavior: ./data under project root.
 *
 * Usage (local):
 *   node build_draft.js data/responses_<case_id>.json
 *
 * Usage (Railway/server):
 *   LRID_DATA_DIR=/tmp/lrid/data node build_draft.js /tmp/lrid/data/responses_<case_id>.json
 */

const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function safeFileName(name) {
  return String(name || "").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function getDataDir(projectRoot) {
  // If provided (Railway/server), write drafts into runtime data dir.
  // Otherwise, keep legacy local behavior: ./data.
  return process.env.LRID_DATA_DIR
    ? path.resolve(process.env.LRID_DATA_DIR)
    : path.join(projectRoot, "data");
}

function resolveInputPath(projectRoot, dataDir, inputArg) {
  // If absolute, use it.
  if (path.isAbsolute(inputArg)) return inputArg;

  // If user passes "data/xxx.json" keep legacy behavior relative to repo root.
  // Else if user passes "responses_..." treat it as inside dataDir.
  if (inputArg.startsWith("data" + path.sep) || inputArg.startsWith("data/")) {
    return path.join(projectRoot, inputArg);
  }
  return path.join(dataDir, inputArg);
}

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Provide input file, e.g. node build_draft.js data/responses_<case_id>.json");
    process.exit(1);
  }

  const projectRoot = __dirname;
  const instrumentPath = path.join(projectRoot, "schemas", "instrument.v1.json");

  if (!fs.existsSync(instrumentPath)) {
    console.error("Missing schemas/instrument.v1.json");
    process.exit(1);
  }

  const instrument = readJson(instrumentPath);
  const dataDir = getDataDir(projectRoot);

  if (!fs.existsSync(dataDir)) {
    // Try to create if runtime directory (server) didn't create it yet
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const responsesPath = resolveInputPath(projectRoot, dataDir, inputArg);

  if (!fs.existsSync(responsesPath)) {
    console.error("Input responses file not found:", responsesPath);
    process.exit(1);
  }

  const responses = readJson(responsesPath);

  const caseId = responses?.meta?.case_id || "UNKNOWN_CASE";
  const expectedQuestions = instrument.expected_questions || 0;
  const minExpectedSeconds = instrument.min_expected_seconds || 0;

  // --- validation basics (kept from your draft engine intent) ---
  const answers = responses?.answers || [];
  const durationSeconds = responses?.meta?.duration_seconds || 0;

  const hardErrors = [];
  const warnings = [];

  if (expectedQuestions > 0 && answers.length !== expectedQuestions) {
    warnings.push(
      `Expected ${expectedQuestions} answers (instrument.expected_questions) but got ${answers.length}.`
    );
  }

  if (minExpectedSeconds > 0 && durationSeconds > 0 && durationSeconds < minExpectedSeconds) {
    warnings.push(
      `Duration ${durationSeconds}s is below min_expected_seconds ${minExpectedSeconds}s (may indicate rushed completion).`
    );
  }

  // --- scoring placeholder (kept minimal – your scoring_engine may refine later) ---
  // This file’s job is to produce draft_* that review panel can load.
  const draft = {
    meta: {
      case_id: caseId,
      created_at: new Date().toISOString(),
      source_responses_file: responsesPath
    },
    instrument: {
      version: instrument?.version || "unknown",
      expected_questions: expectedQuestions
    },
    responses: responses,
    validation: {
      status: hardErrors.length > 0 ? "FAIL" : "PASS",
      hard_errors: hardErrors,
      warnings: warnings
    },
    draft_scoring: {
      // Your existing pipeline may overwrite/enrich later.
      note: "Draft generated server-side for review workflow."
    },
    draft_narrative: {
      note: "Narrative will be generated downstream (approve_case / report generator)."
    }
  };

  const outName = safeFileName(`draft_${caseId}.json`);
  const outPath = path.join(dataDir, outName);

  writeJson(outPath, draft);

  console.log("✔ Draft created:", outPath);
  if (draft.validation.status === "FAIL") {
    console.log("⚠ Draft has hard validation errors. See draft.validation.hard_errors");
  }
}

main();

