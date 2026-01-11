const fs = require("fs");
const path = require("path");

const STORAGE_ROOT = process.env.LRID_STORAGE || path.join(__dirname, ".runtime");
const DATA_DIR = process.env.LRID_DATA_DIR || path.join(STORAGE_ROOT, "data");
const APPROVALS_DIR = process.env.LRID_APPROVALS_DIR || path.join(STORAGE_ROOT, "approvals");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function dimensionInterpretation(dim, score) {
  const s = Number(score || 0);
  const band = s <= 2.79 ? "Risk Zone" : (s <= 3.3 ? "Mixed / Context-dependent" : "Functional Strength");

  const base = {
    DI: "Decision logic clarity, criteria discipline, defensibility under scrutiny.",
    RP: "Ownership, accountability, responsibility alignment.",
    MA: "Resistance to authority pressure, manipulation cues, social influence.",
    AC: "Attention filtering, prioritization, noise vs signal separation.",
    PR: "Openness to correction, dissent bandwidth, power/ego management.",
    ED: "Ethical boundary stability, exception tolerance, drift risk."
  }[dim] || "Dimension summary.";

  const note =
    band === "Functional Strength" ? "Consistently strong signal in typical conditions." :
    band === "Mixed / Context-dependent" ? "Performance varies under pressure and context." :
    "Elevated risk signal; requires guardrails and expert attention.";

  return { band, note: `${base} ${note}` };
}

function buildExecRows(finalDimScores) {
  const order = ["DI", "RP", "MA", "AC", "PR", "ED"];
  const labels = {
    DI: "Decision Integrity (DI)",
    RP: "Responsibility & Ownership (RP)",
    MA: "Manipulation Awareness (MA)",
    AC: "Attention Control (AC)",
    PR: "Power & Correction (PR)",
    ED: "Ethical Drift Resistance (ED)"
  };

  return order.map((d) => {
    const score = Number(finalDimScores[d] ?? 0).toFixed(2);
    const interp = dimensionInterpretation(d, score);
    return `<tr><td>${labels[d]}</td><td>${score}</td><td>${interp.band}</td><td>${interp.note}</td></tr>`;
  }).join("");
}

function pickTopDims(finalDimScores, n = 2, direction = "high") {
  const dims = Object.keys(finalDimScores);
  const pairs = dims.map(d => [d, Number(finalDimScores[d] || 0)]);
  pairs.sort((a, b) => direction === "high" ? b[1] - a[1] : a[1] - b[1]);
  return pairs.slice(0, n).map(p => p[0]);
}

function defaultAssets(finalDimScores) {
  const top = pickTopDims(finalDimScores, 2, "high");
  const map = {
    DI: "Strong decision structure and defensible criteria.",
    RP: "High accountability and ownership of outcomes.",
    MA: "Good resistance to pressure and influence tactics.",
    AC: "Effective focus under complexity and noise.",
    PR: "Healthy correction bandwidth and openness to challenge.",
    ED: "Stable ethical boundaries under pressure."
  };
  return top.map(d => map[d]).filter(Boolean);
}

function defaultRisks(finalDimScores) {
  const bottom = pickTopDims(finalDimScores, 2, "low");
  const map = {
    DI: "Risk of weak decision traceability when time-compressed.",
    RP: "Risk of over-centralized ownership limiting team learning loops.",
    MA: "Risk of authority pressure bias in critical decisions.",
    AC: "Risk of attention narrowing and missing weak signals.",
    PR: "Risk of reduced openness to corrective feedback under stress.",
    ED: "Risk of procedural exceptions becoming normalized under pressure."
  };
  return bottom.map(d => map[d]).filter(Boolean);
}

function toLi(items) {
  return (items || []).map(x => `<li>${String(x)}</li>`).join("");
}

function main() {
  const inputArg = process.argv[2];
  const isAuto = process.argv.includes("--auto");

  if (!inputArg) {
    console.error("Usage: node approve_case.js <path_to_draft_json> [--auto]");
    process.exit(1);
  }

  ensureDir(DATA_DIR);
  ensureDir(APPROVALS_DIR);

  const draftPath = path.isAbsolute(inputArg) ? inputArg : path.join(process.cwd(), inputArg);
  if (!fs.existsSync(draftPath)) {
    console.error("Draft file not found:", draftPath);
    process.exit(1);
  }

  const draft = readJson(draftPath);
  const caseId = draft?.meta?.case_id || "UNKNOWN_CASE";

  const approvalPath = path.join(APPROVALS_DIR, `approval_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_"));

  // create template if missing
  if (!fs.existsSync(approvalPath)) {
    const template = {
      meta: {
        case_id: caseId,
        created_at: new Date().toISOString(),
        expert_name: "Prof. Robert Karaszewski"
      },
      decision: {
        status: "REVIEW",
        operator_notes: ""
      },
      overrides: {
        executive_summary: "",
        risk_notes: "",
        recommendations: ""
      },
      adjustments: {
        dimension_scores_override: {
          DI: null, RP: null, MA: null, AC: null, PR: null, ED: null
        }
      }
    };

    writeJson(approvalPath, template);

    console.log("✔ Created approval template:", approvalPath);
    if (isAuto) process.exit(0);
    console.log("➡ Set decision.status to APPROVE / ADJUST / DEBRIEF and re-run.");
    process.exit(0);
  }

  const approval = readJson(approvalPath);
  const status = approval?.decision?.status || "REVIEW";

  if (!["APPROVE", "ADJUST", "DEBRIEF"].includes(status)) {
    console.log("Approval status is not final yet:", status);
    process.exit(0);
  }

  if (status === "DEBRIEF") {
    console.log("DEBRIEF selected. No payload generated.");
    process.exit(0);
  }

  const draftScores = draft?.draft_scoring?.dimension_scores || {};
  const overrides = approval?.adjustments?.dimension_scores_override || {};
  const dims = ["DI", "RP", "MA", "AC", "PR", "ED"];

  const finalDimScores = {};
  for (const d of dims) {
    const o = overrides[d];
    if (status === "ADJUST" && typeof o === "number") finalDimScores[d] = o;
    else finalDimScores[d] = typeof draftScores[d] === "number" ? draftScores[d] : 0.0;
  }

  const hsri = typeof draft?.draft_scoring?.aggregate_scores?.hsri === "number"
    ? draft.draft_scoring.aggregate_scores.hsri
    : Number(((finalDimScores.DI + finalDimScores.MA + finalDimScores.PR + finalDimScores.ED) / 4).toFixed(2));

  const oi = typeof draft?.draft_scoring?.aggregate_scores?.oi === "number"
    ? draft.draft_scoring.aggregate_scores.oi
    : Number(((finalDimScores.DI + finalDimScores.RP + finalDimScores.AC) / 3).toFixed(2));

  const execRows = buildExecRows(finalDimScores);

  const topAssets = defaultAssets(finalDimScores);
  const topRisks = defaultRisks(finalDimScores);

  const subjectName = draft?.meta?.respondent_name || "Unknown";
  const reportDate = new Date().toISOString().slice(0, 10);

  const payload = {
    meta: {
      case_id: caseId,
      subject_name: subjectName,
      report_date: reportDate,
      expert_name: approval?.meta?.expert_name || "Prof. Robert Karaszewski",
      decision_status: status
    },

    scores: {
      dimension_scores: finalDimScores,
      hsri,
      oi
    },

    tables: {
      exec_dimensions_rows: execRows
    },

    lists: {
      exec_top_assets_li: toLi(topAssets),
      exec_top_risks_li: toLi(topRisks),
      exec_30day_actions_li: toLi([])
    },

    narrative: {
      executive_summary: approval?.overrides?.executive_summary || "",
      risk_notes: approval?.overrides?.risk_notes || "",
      recommendations: approval?.overrides?.recommendations || ""
    }
  };

  const payloadCasePath = path.join(DATA_DIR, `payload_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  const payloadDefaultPath = path.join(DATA_DIR, "payload.json");

  writeJson(payloadCasePath, payload);
  writeJson(payloadDefaultPath, payload);

  console.log("✔ Payload created:", payloadCasePath);
  console.log("✔ Payload copied to:", payloadDefaultPath);
}

main();
