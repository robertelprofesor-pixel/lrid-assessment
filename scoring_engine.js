const fs = require("fs");
const path = require("path");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function mean(nums) {
  const arr = nums.filter(n => typeof n === "number" && Number.isFinite(n));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function scoreLikert5(val, reverse = false) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return reverse ? (6 - n) : n;
}

function evaluatePredicate(answer, pred) {
  // pred supports equals, in, gte_likert
  if (!answer) return false;
  const r = answer.response;

  if (pred.equals !== undefined) return String(r) === String(pred.equals);
  if (pred.in !== undefined) return Array.isArray(pred.in) && pred.in.map(String).includes(String(r));

  if (pred.gte_likert !== undefined) {
    const n = Number(r);
    return Number.isFinite(n) && n >= Number(pred.gte_likert);
  }

  return false;
}

function runScoring({ responsesPath }) {
  const root = __dirname;

  const instrument = readJson(path.join(root, "schemas", "instrument.v1.json"));
  const scoring = readJson(path.join(root, "schemas", "scoring.v1.json"));
  const cc = readJson(path.join(root, "schemas", "consistency.v1.json"));

  const responses = readJson(responsesPath);
  const answers = Array.isArray(responses.answers) ? responses.answers : [];

  // Map answers by question_id
  const byId = {};
  for (const a of answers) byId[a.question_id] = a;

  // Score each question
  const scored_items = [];
  const reverseSet = new Set(scoring.reverse_scored_question_ids || []);
  const mcScores = scoring.multiple_choice_scores || {};

  for (const q of (instrument.question_bank || [])) {
    const a = byId[q.question_id];
    if (!a) continue;

    let s = null;

    if (q.type === "likert_5") {
      s = scoreLikert5(a.response, reverseSet.has(q.question_id));
    } else if (q.type === "multiple_choice") {
      const map = mcScores[q.question_id];
      if (map && map[String(a.response)] !== undefined) s = Number(map[String(a.response)]);
    } else if (q.type === "open_text") {
      s = null; // handled narratively / red flags; not scored by default
    }

    scored_items.push({
      question_id: q.question_id,
      dimension: q.dimension,
      type: q.type,
      response: a.response,
      score: s
    });
  }

  // Dimension scores = mean of scored items in that dimension
  const dims = ["DI", "RP", "MA", "AC", "PR", "ED"];
  const dimension_scores = {};
  const dim_items = {};

  for (const d of dims) {
    const items = scored_items.filter(x => x.dimension === d && typeof x.score === "number");
    dim_items[d] = items;
    dimension_scores[d] = mean(items.map(x => x.score));
  }

  // Aggregate indices
  const OI = mean([dimension_scores.DI, dimension_scores.RP, dimension_scores.AC]);
  const HSRI = mean([dimension_scores.DI, dimension_scores.MA, dimension_scores.PR, dimension_scores.ED]);

  // Consistency checks
  const hits = [];
  for (const rule of (cc.consistency_checks || [])) {
    const logic = rule.logic || {};
    if (logic.type !== "contradiction_pair") continue;

    const ifOk = (logic.if || []).every(p => evaluatePredicate(byId[p.question_id], p));
    const andOk = (logic.and || []).every(p => evaluatePredicate(byId[p.question_id], p));

    if (ifOk && andOk) {
      hits.push({
        cc_id: rule.cc_id,
        title: rule.title,
        severity: rule.severity,
        message: logic.message
      });
    }
  }

  // Confidence score
  const base = Number(cc.confidence_adjustments?.base_confidence ?? 0.85);
  const penalty = cc.confidence_adjustments?.per_cc_hit_penalty || { LOW: 0.03, MEDIUM: 0.06, HIGH: 0.10 };
  const floor = Number(cc.confidence_adjustments?.floor ?? 0.55);

  let conf = base;
  for (const h of hits) conf -= Number(penalty[h.severity] ?? 0.06);
  conf = Math.max(floor, Number(conf.toFixed(2)));

  const level = conf >= 0.8 ? "HIGH" : (conf >= 0.65 ? "MEDIUM" : "LOW");

  return {
    scoring: {
      dimension_scores,
      aggregate_scores: {
        oi: OI ? Number(OI.toFixed(2)) : null,
        hsri: HSRI ? Number(HSRI.toFixed(2)) : null
      },
      scored_items
    },
    consistency: {
      hits,
      confidence: {
        score: conf,
        level
      }
    }
  };
}

module.exports = { runScoring };
