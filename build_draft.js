const fs = require("fs");
const path = require("path");

const STORAGE_ROOT = process.env.LRID_STORAGE || path.join(__dirname, ".runtime");
const DATA_DIR = process.env.LRID_DATA_DIR || path.join(STORAGE_ROOT, "data");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function nowIso() {
  return new Date().toISOString();
}

// MVP scoring helpers (zostawiamy proste – stabilność > “finezja”)
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function avg(nums) {
  const arr = (nums || []).filter((x) => typeof x === "number" && !Number.isNaN(x));
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function bandFor(score, cfg) {
  if (score <= cfg.risk_zone_max) return "Risk Zone";
  if (score <= cfg.mixed_max) return "Mixed / Context-dependent";
  return "Functional Strength";
}

function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error("Usage: node build_draft.js <path_to_responses_json>");
    process.exit(1);
  }

  ensureDir(DATA_DIR);

  const responsesPath = path.isAbsolute(inputArg) ? inputArg : path.join(process.cwd(), inputArg);
  if (!fs.existsSync(responsesPath)) {
    console.error("Responses file not found:", responsesPath);
    process.exit(1);
  }

  const r = readJson(responsesPath);
  const caseId = r?.case_id || "UNKNOWN_CASE";

  // VERY SIMPLE draft structure (dopasowana do approve_case.js)
  // Jeśli masz bardziej rozbudowaną wersję draft engine – później podmienimy,
  // ale to jest stabilne i działa.
  const bandsCfg = { risk_zone_max: 2.79, mixed_max: 3.30 };

  // w MVP: każda odpowiedź skali 1-5; single_choice traktujemy jako 1-5 (idx+1)
  const answers = Array.isArray(r.answers) ? r.answers : [];
  const values = answers.map((a) => {
    if (!a) return null;
    if (a.type === "scale") return clamp(Number(a.value), 1, 5);
    if (a.type === "single_choice") return clamp(Number(a.value) + 1, 1, 5);
    return null;
  });

  // sztuczne (ale stabilne) rozbicie na 6 wymiarów:
  const dims = ["DI", "RP", "MA", "AC", "PR", "ED"];
  const buckets = { DI: [], RP: [], MA: [], AC: [], PR: [], ED: [] };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== "number") continue;
    const d = dims[i % dims.length];
    buckets[d].push(v);
  }

  const dimension_scores = {};
  for (const d of dims) {
    const s = Number(avg(buckets[d]).toFixed(2));
    dimension_scores[d] = s;
  }

  const hsri = Number(((dimension_scores.DI + dimension_scores.MA + dimension_scores.PR + dimension_scores.ED) / 4).toFixed(2));
  const oi = Number(((dimension_scores.DI + dimension_scores.RP + dimension_scores.AC) / 3).toFixed(2));

  const draft = {
    meta: {
      case_id: caseId,
      created_at: nowIso(),
      respondent_name: r?.respondent?.name || "",
      respondent_email: r?.respondent?.email || "",
      respondent_org: r?.respondent?.organization || ""
    },

    validation: {
      status: "OK",
      completeness: {
        expected_questions: answers.length,
        answered_questions: answers.length
      },
      soft_warnings: []
    },

    confidence: {
      level: "MVP",
      score: 0.6
    },

    consistency_checks: {
      status: "MVP",
      items: []
    },

    red_flags: {
      high_stakes: { status: "OFF" },
      items: []
    },

    draft_scoring: {
      dimension_scores,
      aggregate_scores: { hsri, oi },
      bands: {
        hsri: bandFor(hsri, bandsCfg),
        oi: bandFor(oi, bandsCfg)
      }
    },

    draft_narrative: {
      executive_thesis_sentence: "",
      top_assets: [],
      top_risks: [],
      actions_30_days: [],
      hr_role_fit_summary: "",
      academic_profile_statement: "",
      academic_tradeoffs: "",
      academic_cc_overview: ""
    }
  };

  const outPath = path.join(DATA_DIR, `draft_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  writeJson(outPath, draft);

  console.log("✔ Draft created:", outPath);
}

main();
