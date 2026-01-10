/**
 * LRID Draft Engine (MVP)
 * Input:  data/responses_<case_id>.json
 * Output: data/draft_<case_id>.json
 *
 * Usage:
 *   node build_draft.js data/responses_LRID-20251220-0001.json
 */

const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function nowIso() {
  const d = new Date();
  return d.toISOString();
}

function bandFor(score, bandsCfg) {
  if (score <= bandsCfg.risk_zone_max) return "Risk Zone";
  if (score <= bandsCfg.mixed_max) return "Mixed / Context-dependent";
  return "Functional Strength";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeText(s) {
  return String(s || "").toLowerCase();
}

function extractSnippet(text, keywords, maxChars = 160) {
  const t = String(text || "");
  if (!t.trim()) return null;

  // Try find first keyword occurrence and return nearby window
  const lower = t.toLowerCase();
  let idx = -1;
  for (const k of keywords || []) {
    const kidx = lower.indexOf(String(k).toLowerCase());
    if (kidx >= 0) {
      idx = kidx;
      break;
    }
  }
  if (idx < 0) {
    // fallback: first maxChars
    const sn = t.slice(0, maxChars);
    return { text: sn.length < t.length ? sn + "..." : sn, max_chars: maxChars };
  }
  const start = Math.max(0, idx - 40);
  const end = Math.min(t.length, idx + 120);
  let sn = t.slice(start, end);
  if (sn.length > maxChars) sn = sn.slice(0, maxChars);
  if (start > 0) sn = "..." + sn;
  if (end < t.length) sn = sn + "...";
  return { text: sn, max_chars: maxChars };
}

function validateAnswerType(ans, qDef) {
  const v = ans.response;

  if (qDef.type === "likert_5") {
    return Number.isInteger(v) && v >= 1 && v <= 5;
  }
  if (qDef.type === "multiple_choice") {
    return typeof v === "string" && ["A", "B", "C", "D"].includes(v);
  }
  if (qDef.type === "yes_no") {
    return typeof v === "boolean";
  }
  if (qDef.type === "open_text") {
    return typeof v === "string";
  }
  if (qDef.type === "consistency_check") {
    // often likert-like
    return (Number.isInteger(v) && v >= 1 && v <= 5) || typeof v === "string";
  }
  // unknown type → allow but warn
  return true;
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
  const responsesPath = path.isAbsolute(inputArg) ? inputArg : path.join(projectRoot, inputArg);

  if (!fs.existsSync(responsesPath)) {
    console.error("Input responses file not found:", responsesPath);
    process.exit(1);
  }

  const responses = readJson(responsesPath);

  const caseId = responses?.meta?.case_id || "UNKNOWN_CASE";
  const expectedQuestions = instrument.expected_questions || 0;
  const minExpectedSeconds = instrument.min_expected_seconds || 0;

  // Build lookup maps
  const qDefs = new Map();
  for (const q of instrument.questions || []) qDefs.set(q.id, q);

  const answers = Array.isArray(responses.answers) ? responses.answers : [];
  const answerById = new Map();
  for (const a of answers) answerById.set(a.question_id, a);

  // --- VALIDATION ---
  const hardErrors = [];
  const softWarnings = [];

  // Consent check (if present)
  const consentOk = responses?.respondent?.consent?.terms_accepted === true;
  if (responses?.respondent?.consent && !consentOk) {
    hardErrors.push("Consent not accepted (respondent.consent.terms_accepted != true).");
  }

  // Completeness
  const requiredIds = (instrument.questions || []).filter(q => q.required).map(q => q.id);
  const missing = requiredIds.filter(id => !answerById.has(id));
  if (missing.length > 0) {
    hardErrors.push(`Missing required answers: ${missing.join(", ")}`);
  }

  // Type checks + open text min chars
  for (const q of instrument.questions || []) {
    const ans = answerById.get(q.id);
    if (!ans) continue;

    if (!validateAnswerType(ans, q)) {
      hardErrors.push(`Invalid type/value for ${q.id} (expected ${q.type}).`);
      continue;
    }

    if (q.type === "open_text" && q.min_chars) {
      const len = String(ans.response || "").trim().length;
      if (len < q.min_chars) {
        softWarnings.push(`Open-text length low for ${q.id} (recommended ≥ ${q.min_chars} chars).`);
      }
    }
  }

  // Timing
  const durationSeconds = responses?.timing?.duration_seconds ?? 0;
  const flagTooFast = minExpectedSeconds > 0 ? durationSeconds < minExpectedSeconds : false;

  // Pattern checks (straight-lining / low variance on likert_5)
  const likerts = [];
  for (const q of instrument.questions || []) {
    if (q.type !== "likert_5") continue;
    const ans = answerById.get(q.id);
    if (!ans) continue;
    likerts.push(ans.response);
  }

  let flagStraightLining = false;
  let flagLowVariance = false;
  if (likerts.length >= 10) {
    const unique = new Set(likerts);
    if (unique.size === 1) flagStraightLining = true;
    if (unique.size <= 2) flagLowVariance = true;
  }

  // --- CONSISTENCY CHECKS ---
  const ccItems = [];
  let ccMismatchCount = 0;

  for (const set of instrument.consistency_sets || []) {
    const present = set.question_ids.filter(id => answerById.has(id));
    // If the set isn't fully present, skip (or warn)
    if (present.length < set.question_ids.length) {
      softWarnings.push(`Consistency set ${set.cc_id} incomplete (missing some question_ids).`);
      continue;
    }

    // MVP logic: detect mismatch if open_text contains exception keywords AND CC response indicates "high integrity"
    // You will refine this once you want exact CC scoring rules.
    let result = "OK";
    let severity = "LOW";
    let observations = "";

    // Heuristic example:
    // If any ED open text contains exception language -> and CC response is 4/5 -> mismatch.
    const texts = [];
    for (const qid of set.question_ids) {
      const a = answerById.get(qid);
      if (typeof a.response === "string") texts.push(a.response);
    }
    const combined = normalizeText(texts.join(" "));
    const exceptionHit = ["bypass", "skip", "exception", "shortcut", "deadline", "non-negotiable"].some(k => combined.includes(k));

    const ccAns = answerById.get(set.cc_id) || answerById.get(set.question_ids.find(x => x.startsWith("CC_")));
    const ccVal = ccAns && Number.isInteger(ccAns.response) ? ccAns.response : null;

    if (exceptionHit && ccVal !== null && ccVal >= 4) {
      result = "MISMATCH";
      severity = "MEDIUM";
      observations = "Integrity/values signal conflicts with exception-tolerance language under pressure.";
      ccMismatchCount += 1;
    }

    ccItems.push({
      cc_id: set.cc_id,
      description: set.description || "",
      result,
      severity,
      evidence: {
        question_ids: set.question_ids,
        observations
      }
    });
  }

  const ccStatus = ccMismatchCount > 0 ? "ATTENTION" : "OK";

  // --- RED FLAGS ---
  const rfItems = [];
  const triggers = [];

  for (const rule of instrument.red_flag_rules || []) {
    const openIds = rule?.trigger?.open_text_question_ids || [];
    const keywords = rule?.trigger?.keywords_any || [];

    let hit = false;
    let evidenceQ = [];
    let snippets = [];

    for (const qid of openIds) {
      const a = answerById.get(qid);
      if (!a || typeof a.response !== "string") continue;
      const txt = normalizeText(a.response);
      const matched = (keywords || []).some(k => txt.includes(String(k).toLowerCase()));
      if (matched) {
        hit = true;
        evidenceQ.push(qid);
        const sn = extractSnippet(a.response, keywords, 160);
        if (sn) snippets.push(sn);
      }
    }

    const status = hit ? "PRESENT" : "NONE";
    const severity = hit ? (rule.severity_if_triggered || "MEDIUM") : "LOW";

    if (hit) triggers.push(rule.rf_id);

    rfItems.push({
      rf_id: rule.rf_id,
      title: rule.title || "",
      status,
      severity,
      evidence: {
        question_ids: evidenceQ,
        snippets
      },
      system_rationale: hit
        ? "Rule-based trigger matched in open-text evidence."
        : ""
    });
  }

  // High-stakes ON if any HIGH severity RF present OR 2+ triggers
  const anyHigh = rfItems.some(x => x.status !== "NONE" && x.severity === "HIGH");
  const highStakesOn = anyHigh || triggers.length >= 2;

  // --- DRAFT SCORING (MVP) ---
  // For now: average of likert_5 answers per dimension.
  const dims = ["DI", "RP", "MA", "AC", "PR", "ED"];
  const dimBuckets = {};
  for (const d of dims) dimBuckets[d] = [];

  for (const q of instrument.questions || []) {
    if (q.type !== "likert_5") continue;
    if (!dims.includes(q.dimension)) continue;
    const ans = answerById.get(q.id);
    if (!ans) continue;
    dimBuckets[q.dimension].push(ans.response);
  }

  const dimensionScores = {};
  for (const d of dims) {
    const arr = dimBuckets[d];
    if (!arr || arr.length === 0) {
      dimensionScores[d] = 0.0;
      softWarnings.push(`No likert_5 items for dimension ${d}. Score set to 0.0.`);
    } else {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      // Normalize 1..5 -> 1.0..5.0, keep as-is, then clamp
      dimensionScores[d] = clamp(Number(avg.toFixed(2)), 1.0, 5.0);
    }
  }

  const dimensionBands = {};
  for (const d of dims) {
    dimensionBands[d] = bandFor(dimensionScores[d], instrument.bands);
  }

  // Aggregate HSRI & OI (MVP)
  // You can adjust formulas later. For now:
  // HSRI = mean(DI, MA, PR, ED) ; OI = mean(DI, RP, AC)
  const mean = (...vals) => {
    const valid = vals.filter(v => typeof v === "number" && v > 0);
    if (valid.length === 0) return 0.0;
    return Number((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(2));
  };

  const hsri = mean(dimensionScores.DI, dimensionScores.MA, dimensionScores.PR, dimensionScores.ED);
  const oi = mean(dimensionScores.DI, dimensionScores.RP, dimensionScores.AC);

  const aggregateBands = {
    hsri: bandFor(hsri, instrument.bands),
    oi: bandFor(oi, instrument.bands)
  };

  // --- CONFIDENCE (0..1) ---
  // Start 1.0, subtract penalties
  let conf = 1.0;
  const drivers = [];

  if (flagTooFast) {
    conf -= 0.15;
    drivers.push("Too fast completion time");
  }
  if (flagStraightLining) {
    conf -= 0.15;
    drivers.push("Straight-lining pattern detected");
  } else if (flagLowVariance) {
    conf -= 0.10;
    drivers.push("Low variance pattern detected");
  }
  if (ccMismatchCount > 0) {
    const penalty = Math.min(0.30, 0.10 * ccMismatchCount);
    conf -= penalty;
    drivers.push(`Consistency mismatch count: ${ccMismatchCount}`);
  }
  // Open text short warnings in ED/PR/MA reduce confidence slightly
  const openTextPenalty = softWarnings.some(w => w.toLowerCase().includes("open-text length low"))
    ? 0.10
    : 0.0;
  if (openTextPenalty) {
    conf -= openTextPenalty;
    drivers.push("Open-text evidence too short");
  }

  conf = clamp(Number(conf.toFixed(2)), 0.0, 1.0);
  let confLevel = "High";
  if (conf < 0.65) confLevel = "Caution";
  else if (conf < 0.80) confLevel = "Medium";

  // --- DRAFT NARRATIVE (minimal, can be improved later) ---
  const executiveThesis = highStakesOn
    ? "Draft indicates elevated decision-risk signals under pressure; expert confirmation required before report generation."
    : "Draft indicates functional decision discipline with context-dependent risks; expert review recommended.";

  // --- HANDOFF ---
  const autoGeneratePayloadAllowed = !highStakesOn && confLevel === "High" && hardErrors.length === 0;
  const recommendedExpertAction = hardErrors.length > 0 ? "REVIEW" : (highStakesOn ? "DEBRIEF" : "REVIEW");

  const draft = {
    meta: {
      case_id: caseId,
      instrument_id: instrument.instrument_id || "LRID",
      instrument_version: instrument.instrument_version || "1.0",
      generated_at: nowIso(),
      generated_by: { engine: "lrid-draft-engine", engine_version: "0.1.0" }
    },
    validation: {
      status: hardErrors.length > 0 ? "FAIL" : "PASS",
      hard_errors: hardErrors,
      soft_warnings: softWarnings,
      completeness: {
        expected_questions: expectedQuestions,
        answered_questions: answers.length,
        missing_question_ids: missing
      },
      timing_checks: {
        duration_seconds: durationSeconds,
        min_expected_seconds: minExpectedSeconds,
        flag_too_fast: flagTooFast
      },
      pattern_checks: {
        flag_straight_lining: flagStraightLining,
        flag_low_variance: flagLowVariance,
        notes: flagStraightLining
          ? "All Likert answers identical."
          : (flagLowVariance ? "Very low answer variance." : "Normal response variance observed.")
      }
    },
    confidence: {
      level: confLevel,
      score: conf,
      drivers,
      notes: ""
    },
    consistency_checks: {
      status: ccStatus,
      items: ccItems
    },
    red_flags: {
      high_stakes: {
        status: highStakesOn ? "ON" : "OFF",
        triggers
      },
      items: rfItems
    },
    draft_scoring: {
      dimension_scores: dimensionScores,
      dimension_bands: dimensionBands,
      aggregate_scores: { hsri, oi },
      aggregate_bands: aggregateBands,
      scoring_notes: "MVP rule-based scoring: per-dimension Likert averages + heuristic CC/RF."
    },
    draft_narrative: {
      executive_thesis_sentence: executiveThesis,
      top_assets: [],
      top_risks: [],
      actions_30_days: [],
      hr_role_fit_summary: "",
      academic_profile_statement: "",
      academic_tradeoffs: "",
      academic_cc_overview: ""
    },
    explainability: {
      dimension_drivers: [] // fill in v0.2 if you want explicit rule drivers per dimension
    },
    handoff: {
      recommended_expert_action: recommendedExpertAction,
      recommended_reason: highStakesOn
        ? "High-stakes triggers present."
        : (hardErrors.length > 0 ? "Hard validation errors present." : "No hard blockers; expert review recommended."),
      auto_generate_payload_allowed: autoGeneratePayloadAllowed
    }
  };

  // Output file name
  const outName = `draft_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const outPath = path.join(projectRoot, "data", outName);

  // Ensure data folder exists
  const dataDir = path.join(projectRoot, "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  writeJson(outPath, draft);
  console.log("✔ Draft created:", path.relative(projectRoot, outPath));

  if (draft.validation.status === "FAIL") {
    console.log("⚠ Draft has hard validation errors. See draft.validation.hard_errors");
  }
}

main();
