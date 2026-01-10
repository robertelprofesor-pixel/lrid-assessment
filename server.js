const fs = require("fs");
const path = require("path");
const express = require("express");
const crypto = require("crypto");
const { execSync } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

// =======================
// Middleware
// =======================
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// =======================
// Static hosting
// =======================
app.use(express.static(path.join(__dirname, "web")));
app.use("/config", express.static(path.join(__dirname, "config")));
app.use("/out", express.static(path.join(__dirname, "out")));

// =======================
// Helpers
// =======================
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf8");
}

function safeExec(cmd) {
  try {
    return execSync(cmd, { cwd: __dirname, stdio: "pipe" }).toString("utf8");
  } catch (e) {
    const out =
      (e.stdout ? e.stdout.toString("utf8") : "") +
      (e.stderr ? e.stderr.toString("utf8") : "");
    throw new Error(out || e.message);
  }
}

function isSafeFilename(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function randomId(prefix = "") {
  const id = crypto.randomBytes(10).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

function nowISO() {
  return new Date().toISOString();
}

function todayYMD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function listOutFoldersSorted() {
  const outDir = path.join(__dirname, "out");
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((f) => fs.statSync(path.join(outDir, f)).isDirectory())
    .map((f) => ({ folder: f, mtime: fs.statSync(path.join(outDir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.folder);
}

// =======================
// LRID 22 Instrument (config/questions.lrid.v1.json)
// =======================
const QUESTIONS_FILE = path.join(__dirname, "config", "questions.lrid.v1.json");

function loadConfigInstrument() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    throw new Error(`Missing questions file: ${QUESTIONS_FILE}`);
  }
  return readJSON(QUESTIONS_FILE);
}

function defaultLikertOptions() {
  return [
    { label: "1 — Very low", score: 1 },
    { label: "2 — Low", score: 2 },
    { label: "3 — Medium", score: 3 },
    { label: "4 — High", score: 4 },
    { label: "5 — Very high", score: 5 }
  ];
}

function flattenQuestions(configInstrument) {
  const flat = [];
  (configInstrument.dimensions || []).forEach((dim) => {
    (dim.questions || []).forEach((q) => {
      const qType = q.type || "scale";

      let options = q.options || [];
      if (qType === "scale" && (!options || options.length === 0)) {
        options = defaultLikertOptions();
      }
      if (qType === "open_text") options = [];

      flat.push({
        id: q.id,
        type: qType,
        text: q.text,
        time_limit_seconds: q.time_limit_seconds || null,
        min_chars: typeof q.min_chars === "number" ? q.min_chars : (qType === "open_text" ? 15 : null),
        dimensionId: dim.id,
        dimensionName: dim.name,
        options: (options || []).map((o) => ({ label: o.label, score: o.score }))
      });
    });
  });
  return flat;
}

let CONFIG_CACHE = null;
let FLAT_CACHE = null;

function getConfigCached() {
  if (!CONFIG_CACHE || !FLAT_CACHE) {
    CONFIG_CACHE = loadConfigInstrument();
    FLAT_CACHE = flattenQuestions(CONFIG_CACHE);
  }
  return { config: CONFIG_CACHE, flat: FLAT_CACHE };
}

function findFlatQuestion(questionId) {
  const { flat } = getConfigCached();
  return flat.find((q) => q.id === questionId) || null;
}

// =======================
// Sessions storage (file-based)
// =======================
function sessionsDir() {
  const d = path.join(__dirname, "sessions");
  ensureDir(d);
  return d;
}

function sessionPath(sessionId) {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

function createSession({ source, productId, email }) {
  const { flat } = getConfigCached();
  const sessionId = randomId("sess");

  const s = {
    sessionId,
    source: source || "direct",
    productId: productId || null,
    email: email || null,
    startedAt: nowISO(),
    completedAt: null,
    lastUpdatedAt: nowISO(),
    progress: {
      currentIndex: 0,
      totalQuestions: flat.length
    },
    respondent: {
      name: "",
      email: email || "",
      organization: ""
    },
    responses: [] // {questionId, valueScore?, optionLabel?, text?, timeMs, answeredAt}
  };

  writeJSON(sessionPath(sessionId), s);
  return s;
}

function readSession(sessionId) {
  const p = sessionPath(sessionId);
  if (!fs.existsSync(p)) return null;
  return readJSON(p);
}

function saveSession(sessionId, sessionObj) {
  sessionObj.lastUpdatedAt = nowISO();
  writeJSON(sessionPath(sessionId), sessionObj);
}

// =======================
// Systeme token validation (TEMP / local)
// =======================
function validateSystemeToken(token) {
  if (!token || typeof token !== "string") return { ok: false, error: "Missing token" };
  if (token.length < 6) return { ok: false, error: "Token too short" };
  return {
    ok: true,
    data: { productId: "LRID_PRO", email: null }
  };
}

// =======================
// Build “22-question” responses JSON from session
// =======================
function makeCaseId() {
  // LRID-YYYYMMDD-XXXX
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `LRID-${y}${m}${day}-${suffix}`;
}

function buildResponsesJsonFromSession(sessionObj, caseId) {
  const { config } = getConfigCached();

  const started_at = sessionObj.startedAt || nowISO();
  const submitted_at = nowISO();

  const answers = (sessionObj.responses || []).map((r) => {
    const q = findFlatQuestion(r.questionId);
    if (!q) return null;

    if (q.type === "open_text") {
      return {
        question_id: q.id,
        dimension_id: q.dimensionId,
        dimension_name: q.dimensionName,
        type: "open_text",
        value: String(r.text || "")
      };
    }

    return {
      question_id: q.id,
      dimension_id: q.dimensionId,
      dimension_name: q.dimensionName,
      type: q.type,
      value: String(r.valueScore ?? "")
    };
  }).filter(Boolean);

  return {
    case_id: caseId,
    tool: "LRID™",
    version: config?.meta?.version || "1.0-full22",
    timestamps: { started_at, submitted_at },
    respondent: {
      name: sessionObj.respondent?.name || "",
      email: sessionObj.respondent?.email || "",
      organization: sessionObj.respondent?.organization || ""
    },
    answers
  };
}

// =======================
// Scoring for 22-question instrument
// =======================
function mean(arr) {
  const nums = (arr || []).filter((x) => typeof x === "number" && Number.isFinite(x));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function scoreFromResponses(responses22) {
  // Dimension averages on numeric questions
  const dims = ["DI", "RP", "MA", "AC", "PR", "ED"];
  const dimScores = {};
  const dimCounts = {};

  for (const d of dims) {
    dimScores[d] = [];
    dimCounts[d] = 0;
  }

  for (const a of (responses22.answers || [])) {
    if (!dims.includes(a.dimension_id)) continue;

    if (a.type === "open_text") {
      // narrative only
      continue;
    }

    const n = Number(a.value);
    if (Number.isFinite(n) && n >= 1 && n <= 5) {
      dimScores[a.dimension_id].push(n);
      dimCounts[a.dimension_id] += 1;
    }
  }

  const finalDim = {};
  for (const d of dims) {
    const m = mean(dimScores[d]);
    finalDim[d] = m ? Number(m.toFixed(2)) : null;
  }

  const allDimVals = dims.map((d) => finalDim[d]).filter((x) => typeof x === "number");
  const OI = mean(allDimVals);
  // HSRI – “risk under stakes”: bardziej wrażliwe wymiary (DI + PR + ED)
  const hsVals = [finalDim.DI, finalDim.PR, finalDim.ED].filter((x) => typeof x === "number");
  const HSRI = mean(hsVals);

  // Confidence – prosto: im więcej odpowiedzi i im mniej braków, tym wyżej
  const answered = (responses22.answers || []).length;
  const expected = getConfigCached().flat.length;
  const completionRatio = expected ? answered / expected : 0;

  let confScore = 0.5;
  if (completionRatio >= 1) confScore = 0.78;
  else if (completionRatio >= 0.9) confScore = 0.65;
  else confScore = 0.45;

  let confLevel = "Medium";
  if (confScore >= 0.82) confLevel = "High";
  if (confScore < 0.6) confLevel = "Low";

  return {
    dimension_scores: finalDim,
    aggregate_scores: {
      oi: OI ? Number(OI.toFixed(2)) : null,
      hsri: HSRI ? Number(HSRI.toFixed(2)) : null
    },
    confidence: { score: Number(confScore.toFixed(2)), level: confLevel }
  };
}

function bandForScore(s) {
  if (typeof s !== "number") return "N/A";
  if (s < 2.8) return "Risk Zone";
  if (s < 3.3) return "Mixed / Context-dependent";
  return "Strong / Stable";
}

function interpretationForDim(dimId, score) {
  if (typeof score !== "number") return "N/A";
  if (score < 2.8) return "Risk Zone";
  if (score < 3.3) return "Mixed";
  return "Strong";
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

  return order
    .map((d) => {
      const s = finalDimScores[d];
      const scoreTxt = typeof s === "number" ? s.toFixed(2) : "N/A";
      const interp = interpretationForDim(d, s);
      const note =
        interp === "Strong"
          ? "Generally stable behavior under typical pressure."
          : interp === "Mixed"
          ? "Context-sensitive; needs guardrails in high-pressure decisions."
          : "Elevated risk signals; requires targeted intervention.";
      return `<tr><td>${labels[d]}</td><td>${scoreTxt}</td><td>${interp}</td><td>${note}</td></tr>`;
    })
    .join("");
}

function li(items) {
  return (items || []).map((x) => `<li>${x}</li>`).join("");
}

// =======================
// Build payload.json compatible with templates
// =======================
function buildPayload({ caseId, responses22, scoring }) {
  const subjectName =
    (responses22.respondent?.name && responses22.respondent.name.trim()) ||
    caseId;

  const reportDate = todayYMD();
  const version = "LRID v1.0";

  const oi = scoring.aggregate_scores.oi;
  const hsri = scoring.aggregate_scores.hsri;

  const thesis =
    (oi >= 3.3)
      ? "Generally stable leadership judgment profile with consistent decision discipline across pressure contexts."
      : (oi >= 2.8)
      ? "A mixed leadership judgment profile: performance is context-dependent, with potential shifts under time pressure."
      : "Elevated risk indicators: under pressure, judgment quality and governance discipline can degrade without strong guardrails.";

  const topAssets =
    (oi >= 3.3)
      ? [
          "Clear ownership of outcomes and decision follow-through",
          "Stable ethical boundary management under pressure",
          "Effective prioritization and attention control"
        ]
      : [
          "Ability to execute and move decisions forward",
          "Situational adaptability in ambiguous contexts",
          "Some capacity for self-correction when supported by structure"
        ];

  const topRisks =
    (oi < 2.8)
      ? [
          "Procedural shortcuts under deadlines (ethical drift risk)",
          "Narrowing feedback bandwidth when stakes rise",
          "Overconfidence in fast decisions without challenge loop"
        ]
      : [
          "Risk of inconsistency when time pressure is extreme",
          "Potential blind spots in correction openness under authority pressure",
          "Attention overload periods reducing decision quality"
        ];

  const actions30 =
    [
      "Introduce a decision log for high-stakes calls (criteria + alternatives + consequences)",
      "Apply a 2-minute challenge rule: one dissent voice must be heard before final decision",
      "Create a red-flag checklist for ethics and governance exceptions"
    ];

  const payload = {
    meta: {
      subject_name: subjectName,
      report_date: reportDate,
      version,
      use_limitations:
        "This report is a decision-support diagnostic for leadership development. It is not a psychological, medical, or psychiatric assessment.",
      data_ethics_note:
        "Results should be interpreted by qualified professionals within an organizational or educational context.",
      what_it_measures:
        "Decision integrity, resilience under pressure, manipulation awareness, attention control, power handling, and ethical drift resistance.",
      what_it_does_not_measure:
        "Personality traits, intelligence, emotional disorders, or mental health conditions.",
      limitations:
        "Results depend on context, pressure level, response accuracy, and situational variables at the time of assessment."
    },
    confidence: {
      score: String(scoring.confidence.score.toFixed(2)),
      level: scoring.confidence.level
    },
    scores: {
      hsri: typeof hsri === "number" ? hsri.toFixed(2) : "N/A",
      oi: typeof oi === "number" ? oi.toFixed(2) : "N/A"
    },
    bands: {
      hsri: bandForScore(hsri),
      oi: bandForScore(oi)
    },
    high_stakes: {
      status: (typeof hsri === "number" && hsri < 2.8) ? "ON" : "OFF"
    },
    exec: {
      thesis_sentence: thesis
    },
    tables: {
      exec_dimensions_rows: buildExecRows(scoring.dimension_scores)
    },
    lists: {
      exec_top_assets_li: li(topAssets),
      exec_top_risks_li: li(topRisks),
      exec_30day_actions_li: li(actions30),
      hr_strengths_safeguards_li: li(topAssets),
      hr_development_actions_li: li(topRisks),
      hr_interventions_li: li(actions30),
      academic_reflection_prompts_li: li([
        "Which dimension shows the highest variability under pressure and why?",
        "What would improve correction openness in your decision cycle?",
        "Where do you most often trade ethics for speed?"
      ])
    },
    blocks: {
      exec_red_flags: `<ul>${
        (typeof hsri === "number" && hsri < 2.8)
          ? "<li><b>HIGH-STAKES RISK</b>: Ethical and/or correction bandwidth may degrade under pressure.</li>"
          : "<li>No critical red flags detected in aggregate scoring.</li>"
      }</ul>`,
      hr_dimension_cards: "<p><b>DI/RP/MA/AC/PR/ED</b> summaries derived from 22-item instrument scoring.</p>",
      hr_risks: `<ul>${li(topRisks)}</ul>`,
      academic_frameworks:
        "<p>This profile can be interpreted through governance guardrails, decision-cycle design, and bias-mitigation frameworks.</p>",
      academic_cc_details: "<ul><li>Consistency checks: not enabled in 22-item version (planned extension).</li></ul>"
    },
    academic: {
      profile_statement:
        (oi >= 3.3)
          ? "A generally stable decision-maker balancing speed with governance discipline."
          : "A pragmatic decision-maker with context-dependent tradeoffs under time pressure.",
      tradeoffs:
        "Speed and autonomy vs. correction bandwidth and procedural rigor under pressure.",
      cc_overview:
        "Consistency checks are not enabled in the current 22-item version (planned extension)."
    },
    hr: {
      role_fit_summary:
        (oi >= 3.3)
          ? "Strong operational fit; maintain governance guardrails and keep challenge loops active for high-stakes decisions."
          : "Fit is context-dependent; recommend decision guardrails, feedback loop strengthening, and high-stakes challenge protocol."
    }
  };

  return payload;
}

// =======================
// Health
// =======================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: nowISO() });
});

// =======================
// Public start page
// =======================
app.get("/start", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <title>LRID™ Leadership Assessment</title>
        <style>
          body { font-family: Arial, sans-serif; background:#f5f5f5; padding:40px; }
          .box { background:white; padding:32px; max-width:860px; margin:auto; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.08); }
          h1 { margin:0 0 10px 0; font-size:56px; letter-spacing:-1px;}
          p { line-height:1.6; font-size:22px; color:#222;}
          .meta { color:#444; font-size:22px; }
          .btn { display:inline-block; padding:18px 30px; font-size:22px; background:#111; color:#fff; border-radius:12px; text-decoration:none; }
          .small { font-size:16px; color:#666; margin-top:18px; }
          .hr { height:1px; background:#eee; margin:18px 0; }
          ul { font-size:22px; color:#222; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>LRID™ Leadership Assessment</h1>
          <p class="meta">
            Estimated time: <strong>45–60 minutes</strong> • Please complete in one sitting if possible.
          </p>

          <div class="hr"></div>

          <p>
            <strong>This assessment is designed for leadership development.</strong>
            Your responses are confidential and will be used to generate your personalized report.
          </p>

          <p><strong>Before you begin:</strong></p>
          <ul>
            <li>Choose a quiet place and avoid interruptions.</li>
            <li>Answer honestly — the value is in accuracy, not perfection.</li>
            <li>Do not refresh the page unnecessarily.</li>
          </ul>

          <div class="hr"></div>

          <p>
            <a class="btn" href="/api/session/create">Start Assessment</a>
          </p>

          <p class="small">
            Note: This is the product entry page. Next step will display the actual questionnaire UI.
          </p>
        </div>
      </body>
    </html>
  `);
});

// =======================
// Systeme.io entry (redirect after payment)
// =======================
app.get("/systeme/start", (req, res) => {
  try {
    const token = req.query.token;
    const v = validateSystemeToken(token);
    if (!v.ok) return res.status(400).send(`Invalid token: ${v.error}`);

    const s = createSession({
      source: "systeme",
      productId: v.data.productId,
      email: v.data.email
    });

    return res.redirect(`/questionnaire/${encodeURIComponent(s.sessionId)}`);
  } catch (e) {
    return res.status(500).send(e.message);
  }
});

// =======================
// Create session (direct start)
// =======================
app.get("/api/session/create", (req, res) => {
  try {
    const s = createSession({ source: "direct", productId: null, email: null });
    return res.redirect(`/questionnaire/${encodeURIComponent(s.sessionId)}`);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Questionnaire page
// =======================
app.get("/questionnaire/:id", (req, res) => {
  return res.sendFile(path.join(__dirname, "web", "questionnaire.html"));
});

// =======================
// Get next question for a session
// =======================
app.get("/api/session/:id/next", (req, res) => {
  try {
    const sessionId = req.params.id;
    const s = readSession(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session not found" });

    const { flat } = getConfigCached();
    const idx = s.progress?.currentIndex ?? 0;
    const total = flat.length;

    if (idx >= total) {
      return res.json({
        ok: true,
        done: true,
        progress: { index: total, total }
      });
    }

    const q = flat[idx];

    res.json({
      ok: true,
      done: false,
      progress: { index: idx + 1, total },
      question: {
        id: q.id,
        type: q.type,
        text: q.text,
        time_limit_seconds: q.time_limit_seconds,
        min_chars: q.min_chars,
        dimensionName: q.dimensionName,
        options: (q.options || []).map((o) => ({ label: o.label, score: o.score }))
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Save answer and advance
// Body for scale/mc: { questionId, score, label, timeMs }
// Body for open_text: { questionId, text, timeMs }
// =======================
app.post("/api/session/:id/answer", (req, res) => {
  try {
    const sessionId = req.params.id;
    const s = readSession(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session not found" });

    const body = req.body || {};
    const questionId = body.questionId;

    if (!questionId || typeof questionId !== "string") {
      return res.status(400).json({ ok: false, error: "Missing questionId" });
    }

    const q = findFlatQuestion(questionId);
    if (!q) {
      return res.status(400).json({ ok: false, error: "Unknown questionId" });
    }

    // Prevent duplicates
    const exists = (s.responses || []).some((r) => r.questionId === questionId);
    if (exists) {
      return res.status(400).json({ ok: false, error: "This question is already answered in this session." });
    }

    let record = {
      questionId,
      timeMs: typeof body.timeMs === "number" ? body.timeMs : null,
      answeredAt: nowISO()
    };

    if (q.type === "open_text") {
      const text = body.text;
      if (typeof text !== "string") {
        return res.status(400).json({ ok: false, error: "Missing text (string) for open_text question" });
      }
      const trimmed = text.trim();
      const minChars = typeof q.min_chars === "number" ? q.min_chars : 15;
      if (trimmed.length < minChars) {
        return res.status(400).json({ ok: false, error: `Please enter at least ${minChars} characters.` });
      }
      record.text = trimmed;
    } else {
      const score = body.score;
      if (typeof score !== "number") {
        return res.status(400).json({ ok: false, error: "Missing score (number)" });
      }
      record.valueScore = score;
      record.optionLabel = body.label || null;
    }

    s.responses = s.responses || [];
    s.responses.push(record);

    s.progress.currentIndex = (s.progress.currentIndex ?? 0) + 1;
    saveSession(sessionId, s);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// COMPLETE: generate payload + PDFs and return links
// =======================
app.post("/api/session/:id/complete", (req, res) => {
  try {
    const sessionId = req.params.id;
    const s = readSession(sessionId);
    if (!s) return res.status(404).json({ ok: false, error: "Session not found" });

    const { flat } = getConfigCached();
    const expected = flat.length;
    const answered = (s.responses || []).length;

    if (answered < expected) {
      return res.status(400).json({
        ok: false,
        error: `Session not complete: answered ${answered}/${expected}`
      });
    }

    // Mark completed
    s.completedAt = nowISO();
    saveSession(sessionId, s);

    // Build case + responses file
    const caseId = makeCaseId();
    const dataDir = path.join(__dirname, "data");
    ensureDir(dataDir);

    const responses22 = buildResponsesJsonFromSession(s, caseId);
    const responsesFile = `responses_${caseId}.json`;
    const responsesPath = path.join(dataDir, responsesFile);
    writeJSON(responsesPath, responses22);

    // Score + payload
    const scoring = scoreFromResponses(responses22);
    const payload = buildPayload({ caseId, responses22, scoring });

    const payloadCasePath = path.join(dataDir, `payload_${caseId}.json`);
    const payloadLatestPath = path.join(dataDir, "payload.json");
    writeJSON(payloadCasePath, payload);
    writeJSON(payloadLatestPath, payload);

    // Generate PDFs using existing generator (index.js reads data/payload.json)
    const pdfOutput = safeExec("node index.js");

    // Find latest out folder
    const outFolders = listOutFoldersSorted();
    const latestOut = outFolders[0] || null;

    return res.json({
      ok: true,
      caseId,
      responsesFile: `data/${responsesFile}`,
      payloadFile: `data/payload_${caseId}.json`,
      pdfOutput,
      latestOutFolder: latestOut,
      links: latestOut
        ? {
            executive: `/out/${latestOut}/executive.pdf`,
            hr: `/out/${latestOut}/hr.pdf`,
            academic: `/out/${latestOut}/academic.pdf`
          }
        : null
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// =======================
// Root routes
// =======================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "web", "index.html"));
});

app.get("/review", (req, res) => {
  res.sendFile(path.join(__dirname, "web", "review.html"));
});

// =======================
// Start
// =======================
app.listen(PORT, () => {
  console.log(`✔ LRID™ Server running at http://localhost:${PORT}`);
  console.log(`- Public Start: http://localhost:${PORT}/start`);
  console.log(`- Systeme Start (test): http://localhost:${PORT}/systeme/start?token=TEST_TOKEN_12345`);
  console.log(`- Health:       http://localhost:${PORT}/api/health`);
});
