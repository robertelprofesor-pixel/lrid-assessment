/* LRID™ Intake – robust version with visible status + logs
   Loads:  /config/questions.lrid.v1.json
   Saves:  POST /api/intake/submit -> data/responses_<case_id>.json
*/

let LRID_QUESTIONS = null;

function $(id) {
  return document.getElementById(id);
}

function nowIso() {
  return new Date().toISOString();
}

function makeCaseId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 9999)).padStart(4, "0");
  return `LRID-${y}${m}${day}-${rand}`;
}

function setStatus(msg, mode) {
  const box = $("status");
  if (!box) {
    console.warn("STATUS BOX NOT FOUND (#status).");
    return;
  }

  if (!msg) {
    box.style.display = "none";
    box.innerText = "";
    return;
  }

  box.style.display = "block";
  box.innerText = msg;
  box.style.border = "1px solid #ddd";
  box.style.borderRadius = "12px";
  box.style.padding = "10px 12px";
  box.style.margin = "12px 0";
  box.style.whiteSpace = "pre-wrap";

  if (mode === "error") {
    box.style.background = "#fff3f3";
    box.style.borderColor = "#f2bcbc";
    box.style.color = "#8a1f1f";
  } else if (mode === "success") {
    box.style.background = "#f2fff5";
    box.style.borderColor = "#bde7c6";
    box.style.color = "#145a22";
  } else {
    box.style.background = "#fafafa";
    box.style.borderColor = "#e8e8e8";
    box.style.color = "#333";
  }
}

function createEl(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") el.className = v;
    else if (k === "text") el.innerText = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.appendChild(c);
  return el;
}

function flattenQuestions(data) {
  const all = [];
  (data.dimensions || []).forEach((dim) => {
    (dim.questions || []).forEach((q) => {
      all.push({
        ...q,
        dimension_id: dim.id,
        dimension_name: dim.name
      });
    });
  });
  return all;
}

async function loadQuestions() {
  console.log("[LRID] intake.js loaded");
  setStatus("Loading questions…", "info");

  try {
    const res = await fetch("/config/questions.lrid.v1.json", { cache: "no-store" });
    console.log("[LRID] questions fetch status:", res.status);

    if (!res.ok) throw new Error(`Cannot load questions JSON (HTTP ${res.status})`);

    LRID_QUESTIONS = await res.json();

    console.log("[LRID] dimensions:", (LRID_QUESTIONS.dimensions || []).length);
    console.log("[LRID] total questions:", flattenQuestions(LRID_QUESTIONS).length);

    renderApp(LRID_QUESTIONS);
    setStatus("", "info");
  } catch (e) {
    console.error(e);
    setStatus(
      "Unable to load questions.\n\nCheck:\n- http://localhost:3000/config/questions.lrid.v1.json\n- server.js running via: npm run serve:intake",
      "error"
    );
  }
}

function renderApp(data) {
  const app = $("app");
  app.innerHTML = "";

  app.appendChild(
    createEl("div", { className: "card" }, [
      createEl("h1", { text: `${data.meta?.tool || "LRID™"} – Intake` }),
      createEl("div", {
        className: "muted",
        text: `${data.meta?.note || ""} Estimated time: ${data.meta?.estimated_time_minutes || 45} minutes.`
      }),
      createEl("div", {
        className: "muted",
        text: `Loaded questions: ${flattenQuestions(data).length}`
      })
    ])
  );

  const form = createEl("form", { id: "lridForm" });

  // respondent block
  const respondentCard = createEl("div", { className: "card" });
  respondentCard.appendChild(createEl("h2", { text: "Respondent details" }));
  respondentCard.appendChild(
    createEl("label", {
      html:
        `Full name<br><input type="text" name="respondent_name" ` +
        `style="width:100%;padding:8px;border:1px solid #ddd;border-radius:10px" placeholder="e.g., Robert K.">`
    })
  );
  respondentCard.appendChild(
    createEl("label", {
      html:
        `Email (optional)<br><input type="email" name="respondent_email" ` +
        `style="width:100%;padding:8px;border:1px solid #ddd;border-radius:10px" placeholder="name@company.com">`
    })
  );
  respondentCard.appendChild(
    createEl("label", {
      html:
        `Organization (optional)<br><input type="text" name="respondent_org" ` +
        `style="width:100%;padding:8px;border:1px solid #ddd;border-radius:10px" placeholder="Company / Institution">`
    })
  );
  form.appendChild(respondentCard);

  // questions
  (data.dimensions || []).forEach((dim) => {
    const section = createEl("section", { className: "card" });
    section.appendChild(createEl("h2", { text: dim.name }));

    (dim.questions || []).forEach((q) => {
      const block = createEl("div", { className: "question" });
      block.appendChild(createEl("p", { text: q.text }));

      if (q.time_limit_seconds) {
        block.appendChild(createEl("div", { className: "muted", text: `Time guidance: ~${q.time_limit_seconds}s` }));
      }

      if (q.type === "single_choice") {
        const opts = Array.isArray(q.options) ? q.options : [];
        if (opts.length === 0) {
          block.appendChild(createEl("div", { className: "muted", text: "No options defined." }));
        } else {
          opts.forEach((opt, idx) => {
            const label = document.createElement("label");
            const input = document.createElement("input");
            input.type = "radio";
            input.name = q.id;
            input.value = String(idx);
            label.appendChild(input);
            label.appendChild(document.createTextNode(" " + (opt.label || String(opt))));
            block.appendChild(label);
          });
        }
      } else if (q.type === "scale") {
        const min = q.scale?.min ?? 1;
        const max = q.scale?.max ?? 5;

        const input = document.createElement("input");
        input.type = "range";
        input.min = String(min);
        input.max = String(max);
        input.name = q.id;
        input.value = String(Math.ceil((min + max) / 2));

        const valueLabel = createEl("div", { className: "muted", text: `Selected: ${input.value}` });
        input.addEventListener("input", () => (valueLabel.innerText = `Selected: ${input.value}`));

        block.appendChild(input);
        block.appendChild(valueLabel);
      } else if (q.type === "open_text") {
        const ta = document.createElement("textarea");
        ta.name = q.id;
        ta.rows = 4;
        ta.placeholder = "Type your answer here…";
        block.appendChild(ta);
      } else {
        block.appendChild(createEl("div", { className: "muted", text: `Unsupported question type: ${q.type}` }));
      }

      section.appendChild(block);
    });

    form.appendChild(section);
  });

  // submit card
  const submitCard = createEl("div", { className: "card" });
  submitCard.appendChild(createEl("h2", { text: "Submit" }));
  submitCard.appendChild(createEl("div", { className: "muted", text: "Submit stores your answers as a case file on the server." }));

  const submitBtn = createEl("button", { type: "submit", id: "submitBtn", text: "Submit responses" });
  submitCard.appendChild(submitBtn);
  form.appendChild(submitCard);

  const startedAt = nowIso();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    console.log("[LRID] submit clicked");

    const btn = $("submitBtn");
    if (btn) btn.disabled = true;

    try {
      const caseId = makeCaseId();
      const submittedAt = nowIso();

      const allQs = flattenQuestions(LRID_QUESTIONS);
      const answers = collectAnswers(form, allQs);

      const missing = answers.filter((a) => !a.value).map((a) => a.question_id);
      if (missing.length > 0) {
        setStatus(`Please answer all questions.\nMissing: ${missing.join(", ")}`, "error");
        return;
      }

      const payload = {
        case_id: caseId,
        tool: LRID_QUESTIONS.meta?.tool || "LRID™",
        version: LRID_QUESTIONS.meta?.version || "1.0",
        timestamps: { started_at: startedAt, submitted_at: submittedAt },
        respondent: {
          name: (form.elements["respondent_name"]?.value || "").trim(),
          email: (form.elements["respondent_email"]?.value || "").trim(),
          organization: (form.elements["respondent_org"]?.value || "").trim()
        },
        answers,
        raw: { user_agent: navigator.userAgent }
      };

      setStatus("Submitting…", "info");

      const res = await fetch("/api/intake/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      console.log("[LRID] submit response status:", res.status);

      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) throw new Error(out.error || `Submit failed (HTTP ${res.status})`);

      setStatus(`Submitted successfully.\nCase ID: ${caseId}\nSaved: ${out.file}`, "success");
      console.log("[LRID] saved:", out.file);

    } catch (err) {
      console.error(err);
      setStatus(`Submit failed:\n${err.message}`, "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  app.appendChild(form);
}

function collectAnswers(form, allQs) {
  return allQs.map((q) => {
    let value = "";

    if (q.type === "single_choice") {
      const chosen = form.querySelector(`input[name="${q.id}"]:checked`);
      value = chosen ? chosen.value : "";
    } else if (q.type === "scale") {
      const el = form.elements[q.id];
      value = el ? String(el.value) : "";
    } else if (q.type === "open_text") {
      const el = form.elements[q.id];
      value = el ? String(el.value).trim() : "";
    } else {
      value = "";
    }

    return {
      question_id: q.id,
      dimension_id: q.dimension_id,
      dimension_name: q.dimension_name,
      type: q.type,
      value
    };
  });
}

document.addEventListener("DOMContentLoaded", loadQuestions);
