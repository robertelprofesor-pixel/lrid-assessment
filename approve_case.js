/**
 * LRID Approval Gate + Payload Builder (MVP)
 *
 * Input:
 *  - data/draft_<case_id>.json
 *  - approvals/approval_<case_id>.json  (created automatically if missing)
 *
 * Output:
 *  - data/payload_<case_id>.json
 *  - data/payload.json  (last approved payload used by index.js)
 *
 * Usage:
 *  node approve_case.js data/draft_LRID-20251220-0001.json
 */

const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function slugify(input) {
  return String(input || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w\-]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "Unknown";
}

function dimensionInterpretation(dim, score) {
  // Short, neutral, board-safe language (you can refine later)
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
  if (!inputArg) {
    console.error("Usage: node approve_case.js data/draft_<case_id>.json");
    process.exit(1);
  }

  const projectRoot = __dirname;
  const draftPath = path.isAbsolute(inputArg) ? inputArg : path.join(projectRoot, inputArg);

  if (!fs.existsSync(draftPath)) {
    console.error("Draft file not found:", draftPath);
    process.exit(1);
  }

  const draft = readJson(draftPath);
  const caseId = draft?.meta?.case_id || "UNKNOWN_CASE";

  // Approval file location
  const approvalsDir = path.join(projectRoot, "approvals");
  ensureDir(approvalsDir);
  const approvalPath = path.join(approvalsDir, `approval_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_"));

  // If missing approval file, create a template and stop
  if (!fs.existsSync(approvalPath)) {
    const template = {
      meta: {
        case_id: caseId,
        created_at: new Date().toISOString(),
        expert_name: "Prof. Robert Karaszewski"
      },
      decision: {
        status: "REVIEW", 
        // Allowed: REVIEW | APPROVE | ADJUST | DEBRIEF
        notes: "Set status to APPROVE, ADJUST, or DEBRIEF."
      },
      adjustments: {
        // Optional numeric overrides (only if ADJUST)
        dimension_scores_override: {
          "DI": null, "RP": null, "MA": null, "AC": null, "PR": null, "ED": null
        },
        // Optional narrative overrides (only if ADJUST)
        narrative_override: {
          "executive_thesis_sentence": null,
          "top_assets": [],
          "top_risks": [],
          "actions_30_days": [],
          "hr_role_fit_summary": null,
          "academic_profile_statement": null,
          "academic_tradeoffs": null,
          "academic_cc_overview": null
        }
      }
    };

    writeJson(approvalPath, template);
    console.log("✔ Created approval template:", path.relative(projectRoot, approvalPath));
    console.log("➡ Open it, set decision.status to APPROVE / ADJUST / DEBRIEF, then re-run approve_case.js.");
    process.exit(0);
  }

  const approval = readJson(approvalPath);
  const status = approval?.decision?.status || "REVIEW";

  if (!["APPROVE", "ADJUST", "DEBRIEF"].includes(status)) {
    console.log("Approval status is not final yet:", status);
    console.log("➡ Set approvals/approval_" + caseId + ".json → decision.status = APPROVE / ADJUST / DEBRIEF");
    process.exit(0);
  }

  // If DEBRIEF: do not generate payload
  if (status === "DEBRIEF") {
    console.log("DEBRIEF selected. No payload generated. Conduct debrief, then update approval to APPROVE/ADJUST.");
    process.exit(0);
  }

  // Build final dimension scores (draft + optional overrides)
  const draftScores = draft?.draft_scoring?.dimension_scores || {};
  const overrides = approval?.adjustments?.dimension_scores_override || {};
  const dims = ["DI", "RP", "MA", "AC", "PR", "ED"];

  const finalDimScores = {};
  for (const d of dims) {
    const o = overrides[d];
    if (status === "ADJUST" && typeof o === "number") finalDimScores[d] = o;
    else finalDimScores[d] = typeof draftScores[d] === "number" ? draftScores[d] : 0.0;
  }

  // Aggregate scores
  const hsri = typeof draft?.draft_scoring?.aggregate_scores?.hsri === "number"
    ? draft.draft_scoring.aggregate_scores.hsri
    : (Number(((finalDimScores.DI + finalDimScores.MA + finalDimScores.PR + finalDimScores.ED) / 4).toFixed(2)));

  const oi = typeof draft?.draft_scoring?.aggregate_scores?.oi === "number"
    ? draft.draft_scoring.aggregate_scores.oi
    : (Number(((finalDimScores.DI + finalDimScores.RP + finalDimScores.AC) / 3).toFixed(2)));

  // Bands
  const instrumentBands = { risk_zone_max: 2.79, mixed_max: 3.30 };
  function bandFor(score) {
    if (score <= instrumentBands.risk_zone_max) return "Risk Zone";
    if (score <= instrumentBands.mixed_max) return "Mixed / Context-dependent";
    return "Functional Strength";
  }

  // High-stakes
  const highStakes = draft?.red_flags?.high_stakes?.status || "OFF";

  // Narrative (draft + optional overrides)
  const dn = draft?.draft_narrative || {};
  const no = approval?.adjustments?.narrative_override || {};

  const executiveThesis =
    (status === "ADJUST" && typeof no.executive_thesis_sentence === "string" && no.executive_thesis_sentence.trim())
      ? no.executive_thesis_sentence.trim()
      : (dn.executive_thesis_sentence || "");

  const topAssets =
    (status === "ADJUST" && Array.isArray(no.top_assets) && no.top_assets.length > 0)
      ? no.top_assets
      : (Array.isArray(dn.top_assets) && dn.top_assets.length > 0 ? dn.top_assets : defaultAssets(finalDimScores));

  const topRisks =
    (status === "ADJUST" && Array.isArray(no.top_risks) && no.top_risks.length > 0)
      ? no.top_risks
      : (Array.isArray(dn.top_risks) && dn.top_risks.length > 0 ? dn.top_risks : defaultRisks(finalDimScores));

  const actions30 =
    (status === "ADJUST" && Array.isArray(no.actions_30_days) && no.actions_30_days.length > 0)
      ? no.actions_30_days
      : (Array.isArray(dn.actions_30_days) ? dn.actions_30_days : []);

  const hrSummary =
    (status === "ADJUST" && typeof no.hr_role_fit_summary === "string" && no.hr_role_fit_summary.trim())
      ? no.hr_role_fit_summary.trim()
      : (dn.hr_role_fit_summary || "");

  const academicProfile =
    (status === "ADJUST" && typeof no.academic_profile_statement === "string" && no.academic_profile_statement.trim())
      ? no.academic_profile_statement.trim()
      : (dn.academic_profile_statement || "");

  const academicTradeoffs =
    (status === "ADJUST" && typeof no.academic_tradeoffs === "string" && no.academic_tradeoffs.trim())
      ? no.academic_tradeoffs.trim()
      : (dn.academic_tradeoffs || "");

  const academicCC =
    (status === "ADJUST" && typeof no.academic_cc_overview === "string" && no.academic_cc_overview.trim())
      ? no.academic_cc_overview.trim()
      : (dn.academic_cc_overview || "");

  // Build executive table rows
  const execRows = buildExecRows(finalDimScores);

  // Build red flags block from draft (with snippets)
  const rfItems = (draft?.red_flags?.items || []).filter(x => x.status && x.status !== "NONE");
  let execRedFlagsHtml = "<p><b>No critical red flags detected.</b></p>";
  if (rfItems.length > 0) {
    const list = rfItems.map(rf => {
      const sn = (rf?.evidence?.snippets || []).slice(0, 2).map(s => s.text).filter(Boolean);
      const snPart = sn.length ? ` — <i>${sn.join(" / ")}</i>` : "";
      return `<li><b>${rf.rf_id}</b>: ${rf.title}${snPart}</li>`;
    }).join("");
    execRedFlagsHtml = `<ul>${list}</ul>`;
  }

  // Subject info (from responses is not available here; keep generic; you’ll pass subject_name in payload meta later or use draft source)
  const subjectName = draft?.meta?.case_id ? draft.meta.case_id : "LRID Subject";

  // Final payload (matches your existing templates)
  const payload = {
    meta: {
      subject_name: subjectName,
      report_date: new Date().toISOString().slice(0, 10),
      version: `LRID v${draft?.meta?.instrument_version || "1.0"}`,
      use_limitations: "This report is a decision-support diagnostic. It is not a psychological, medical, or psychiatric assessment.",
      data_ethics_note: "Results should be interpreted by qualified professionals within an organizational or educational context.",
      what_it_measures: "Decision integrity, ethical boundary management, manipulation awareness, attention control, power handling, and correction readiness.",
      what_it_does_not_measure: "Personality traits, intelligence, emotional disorders, or mental health conditions.",
      limitations: "Results depend on contextual pressure, self-report accuracy, and situational variables at the time of assessment."
    },

    confidence: {
      score: String(draft?.confidence?.score ?? ""),
      level: String(draft?.confidence?.level ?? "")
    },

    scores: {
      hsri: String(hsri.toFixed(2)),
      oi: String(oi.toFixed(2))
    },

    bands: {
      hsri: bandFor(hsri),
      oi: bandFor(oi)
    },

    high_stakes: {
      status: highStakes
    },

    exec: {
      thesis_sentence: executiveThesis
    },

    tables: {
      exec_dimensions_rows: execRows
    },

    lists: {
      exec_top_assets_li: toLi(topAssets),
      exec_top_risks_li: toLi(topRisks),
      exec_30day_actions_li: toLi(actions30),

      hr_strengths_safeguards_li: toLi(topAssets),
      hr_development_actions_li: toLi(topRisks),
      hr_interventions_li: toLi(actions30),

      academic_reflection_prompts_li: toLi([
        "Which decision criteria remain stable under extreme pressure?",
        "Where do personal judgment and formal governance diverge?",
        "How do power dynamics shape openness to correction?"
      ])
    },

    blocks: {
      exec_red_flags: execRedFlagsHtml,
      hr_dimension_cards: "<p><b>DI/RP/MA/AC/PR/ED</b> summaries prepared from draft scoring.</p>",
      hr_risks: rfItems.length ? `<ul>${rfItems.map(r => `<li>${r.title}</li>`).join("")}</ul>` : "<ul><li>No elevated HR risk flags detected.</li></ul>",
      academic_frameworks: "<p>This profile can be interpreted through decision hygiene, authority bias mitigation, and governance guardrails frameworks.</p>",
      academic_cc_details: "<ul><li>CC insights available in the draft assessment.</li></ul>"
    },

    academic: {
      profile_statement: academicProfile,
      tradeoffs: academicTradeoffs,
      cc_overview: academicCC
    },

    hr: {
      role_fit_summary: hrSummary
    }
  };

  // Save payload per case + copy to data/payload.json for index.js
  const dataDir = path.join(projectRoot, "data");
  ensureDir(dataDir);

  const payloadCasePath = path.join(dataDir, `payload_${caseId}.json`.replace(/[^a-zA-Z0-9_.-]/g, "_"));
  const payloadDefaultPath = path.join(dataDir, "payload.json");

  writeJson(payloadCasePath, payload);
  writeJson(payloadDefaultPath, payload);

  console.log("✔ Payload created:", path.relative(projectRoot, payloadCasePath));
  console.log("✔ Payload copied to:", path.relative(projectRoot, payloadDefaultPath));
  console.log("➡ Next: run `npm run pdf` to generate PDFs (or use generate_reports.js for one-command flow).");
}

main();
