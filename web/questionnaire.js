(function () {
  const parts = window.location.pathname.split("/");
  const sessionId = parts[parts.length - 1];

  const elDim = document.getElementById("dimension");
  const elProg = document.getElementById("progress");
  const elQ = document.getElementById("questionText");
  const elOpts = document.getElementById("options");
  const elNext = document.getElementById("nextBtn");
  const elTimer = document.getElementById("timer");
  const elDebug = document.getElementById("debug");

  let startedAtMs = Date.now();
  let selected = null;   // scale/mc: {questionId, score, label}
  let typedText = "";    // open_text
  let currentQuestion = null;

  let countdown = null;
  let remaining = null;

  function stopTimer() {
    if (countdown) clearInterval(countdown);
    countdown = null;
    remaining = null;
    elTimer.textContent = "";
  }

  function startTimer(seconds) {
    stopTimer();
    if (!seconds || typeof seconds !== "number") return;

    remaining = seconds;
    elTimer.textContent = `Time limit: ${remaining}s`;

    countdown = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        remaining = 0;
        elTimer.textContent = `Time limit: 0s`;
        clearInterval(countdown);
        countdown = null;
      } else {
        elTimer.textContent = `Time limit: ${remaining}s`;
      }
    }, 1000);
  }

  async function apiGet(url) {
    const r = await fetch(url, { method: "GET" });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.error) || `GET ${url} failed`);
    return j;
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.error) || `POST ${url} failed`);
    return j;
  }

  function enableNextIfReady() {
    if (!currentQuestion) return;

    if (currentQuestion.type === "open_text") {
      const min = typeof currentQuestion.min_chars === "number" ? currentQuestion.min_chars : 15;
      elNext.disabled = (typedText.trim().length < min);
      return;
    }

    elNext.disabled = !selected;
  }

  function renderOpenText(q, progress) {
    selected = null;
    typedText = "";
    currentQuestion = q;

    elNext.textContent = "Next";
    elDim.textContent = q.dimensionName ? `Dimension: ${q.dimensionName}` : "";
    elProg.textContent = `Question ${progress.index} of ${progress.total}`;
    elQ.textContent = q.text || "";

    const min = typeof q.min_chars === "number" ? q.min_chars : 15;

    elOpts.innerHTML = `
      <div style="margin-top:18px;">
        <textarea id="openText" rows="6"
          style="width:100%; font-size:18px; padding:14px; border-radius:10px; border:1px solid #ddd; outline:none;"
          placeholder="Write your answer here... (minimum ${min} characters)"></textarea>
        <div style="margin-top:10px; color:#666; font-size:14px;" id="charInfo">0 / ${min}</div>
      </div>
    `;

    const ta = document.getElementById("openText");
    const info = document.getElementById("charInfo");

    ta.addEventListener("input", () => {
      typedText = ta.value || "";
      const len = typedText.trim().length;
      info.textContent = `${len} / ${min}`;
      enableNextIfReady();
    });

    startedAtMs = Date.now();
    startTimer(q.time_limit_seconds || null);

    elDebug.textContent = `Session: ${sessionId}`;
    enableNextIfReady();
  }

  function renderOptionsQuestion(q, progress) {
    selected = null;
    typedText = "";
    currentQuestion = q;

    elNext.textContent = "Next";
    elOpts.innerHTML = "";

    elDim.textContent = q.dimensionName ? `Dimension: ${q.dimensionName}` : "";
    elProg.textContent = `Question ${progress.index} of ${progress.total}`;
    elQ.textContent = q.text || "";

    const options = q.options || [];
    if (options.length === 0) {
      elOpts.innerHTML = `<div style="color:#b00; font-size:16px;">
        This question has no options configured. Please contact the administrator.
      </div>`;
      elNext.disabled = true;
      return;
    }

    options.forEach((opt) => {
      const row = document.createElement("label");
      row.className = "opt";
      row.innerHTML = `
        <input type="radio" name="opt" value="${opt.score}">
        <div>
          <div style="font-size:18px; color:#111;">${opt.label}</div>
        </div>
      `;

      row.addEventListener("click", () => {
        const input = row.querySelector("input");
        input.checked = true;
        selected = { questionId: q.id, score: opt.score, label: opt.label };
        enableNextIfReady();
      });

      elOpts.appendChild(row);
    });

    startedAtMs = Date.now();
    startTimer(q.time_limit_seconds || null);

    elDebug.textContent = `Session: ${sessionId}`;
    enableNextIfReady();
  }

  async function finalizeAndShowPDFs() {
    stopTimer();

    elDim.textContent = "";
    elProg.textContent = `Completed`;
    elQ.innerHTML = `<div class="done"><strong>Thank you.</strong> Generating your reports now…</div>`;
    elOpts.innerHTML = `<div style="color:#666; font-size:16px;">Please wait…</div>`;

    elNext.disabled = true;
    elNext.textContent = "Done";

    try {
      const result = await apiPost(`/api/session/${encodeURIComponent(sessionId)}/complete`, {});
      const links = result.links;

      if (!links) {
        elOpts.innerHTML = `<div style="color:#b00; font-size:16px;">
          PDFs were not generated (no links returned). Check server console output.
        </div>`;
        return;
      }

      elQ.innerHTML = `<div class="done"><strong>Thank you.</strong> You have completed the assessment.</div>`;
      elOpts.innerHTML = `
        <div style="margin-top:10px; font-size:16px; color:#444;">
          Your reports are ready:
        </div>

        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:16px;">
          <a href="${links.executive}" target="_blank"
             style="display:inline-block; padding:14px 18px; border-radius:12px; background:#111; color:#fff; text-decoration:none; font-size:16px;">
            Executive PDF
          </a>

          <a href="${links.hr}" target="_blank"
             style="display:inline-block; padding:14px 18px; border-radius:12px; background:#111; color:#fff; text-decoration:none; font-size:16px;">
            HR PDF
          </a>

          <a href="${links.academic}" target="_blank"
             style="display:inline-block; padding:14px 18px; border-radius:12px; background:#111; color:#fff; text-decoration:none; font-size:16px;">
            Academic PDF
          </a>
        </div>

        <div style="margin-top:18px; color:#666; font-size:14px;">
          Case ID: <b>${result.caseId}</b>
        </div>
      `;

      elDebug.textContent = `Session: ${sessionId}`;
    } catch (e) {
      elOpts.innerHTML = `<div style="color:#b00; font-size:16px;">
        Error while generating PDFs: ${e.message || String(e)}
      </div>`;
    }
  }

  async function loadNext() {
    const payload = await apiGet(`/api/session/${encodeURIComponent(sessionId)}/next`);

    if (payload.done) {
      await finalizeAndShowPDFs();
      return;
    }

    const { question, progress } = payload;

    if (question.type === "open_text") {
      renderOpenText(question, progress);
    } else {
      renderOptionsQuestion(question, progress);
    }
  }

  elNext.addEventListener("click", async () => {
    if (!currentQuestion) return;

    const timeMs = Date.now() - startedAtMs;

    elNext.disabled = true;
    elNext.textContent = "Saving…";

    try {
      if (currentQuestion.type === "open_text") {
        await apiPost(`/api/session/${encodeURIComponent(sessionId)}/answer`, {
          questionId: currentQuestion.id,
          text: typedText,
          timeMs
        });
      } else {
        if (!selected) throw new Error("Please select an option.");
        await apiPost(`/api/session/${encodeURIComponent(sessionId)}/answer`, {
          questionId: selected.questionId,
          score: selected.score,
          label: selected.label,
          timeMs
        });
      }

      stopTimer();
      await loadNext();
    } catch (e) {
      elNext.textContent = "Next";
      enableNextIfReady();
      alert(e.message || String(e));
    }
  });

  loadNext().catch((e) => {
    alert(e.message || String(e));
  });
})();
