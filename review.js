let STATE = {
  drafts: [],
  selectedDraftFile: null,
  selectedCaseId: null,
  approvalFile: null,
  draftObj: null,
  approvalObj: null,
  decisionStatus: null
};

function $(id) { return document.getElementById(id); }

function setStatus(msg, ok) {
  const box = $("status");
  if (!msg) {
    box.className = "status";
    box.innerText = "";
    return;
  }
  box.className = ok ? "status ok" : "status err";
  box.innerText = msg;
}

async function apiGet(url) {
  const res = await fetch(url, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function deriveCaseIdFromDraft(draftFile) {
  return draftFile.replace(/^draft_/, "").replace(/\.json$/, "");
}

function deriveApprovalFile(caseId) {
  return `approval_${caseId}.json`;
}

function setButtonsEnabled(enabled) {
  $("btnCreateTemplate").disabled = !enabled;
  $("btnLoadApproval").disabled = !enabled;
  $("btnSaveApproval").disabled = !enabled;
  $("btnFinalize").disabled = !enabled;
  $("operatorNotes").disabled = !enabled;
  $("ovExec").disabled = !enabled;
  $("ovRisk").disabled = !enabled;
  $("ovRecs").disabled = !enabled;
}

function highlightDecision(status) {
  STATE.decisionStatus = status || null;
  const row = $("decisionRow");
  const buttons = row.querySelectorAll(".radioBtn");
  buttons.forEach((b) => {
    const s = b.getAttribute("data-status");
    b.classList.toggle("active", s === STATE.decisionStatus);
  });
}

function setSelectedDraft(draftFile) {
  STATE.selectedDraftFile = draftFile;
  STATE.selectedCaseId = draftFile ? deriveCaseIdFromDraft(draftFile) : null;
  STATE.approvalFile = STATE.selectedCaseId ? deriveApprovalFile(STATE.selectedCaseId) : null;

  $("selectedDraftLabel").innerText = draftFile || "None";
  $("caseIdPill").innerText = `Case: ${STATE.selectedCaseId || "—"}`;

  $("pdfLinks").innerHTML = "";
  setStatus("", true);

  if (!draftFile) {
    setButtonsEnabled(false);
    STATE.draftObj = null;
    STATE.approvalObj = null;
    highlightDecision(null);
    $("operatorNotes").value = "";
    $("ovExec").value = "";
    $("ovRisk").value = "";
    $("ovRecs").value = "";
    renderDraftSnapshot(null);
    return;
  }

  setButtonsEnabled(true);
}

function renderDraftList() {
  const list = $("draftList");
  list.innerHTML = "";

  if (!STATE.drafts || STATE.drafts.length === 0) {
    list.innerHTML = `<div class="muted">No drafts found in data/</div>`;
    return;
  }

  STATE.drafts.forEach((f) => {
    const div = document.createElement("div");
    div.className = "item" + (STATE.selectedDraftFile === f ? " active" : "");
    div.innerHTML = `
      <div class="row">
        <div class="mono">${f}</div>
      </div>
      <div class="muted">Case: <span class="mono">${deriveCaseIdFromDraft(f)}</span></div>
    `;
    div.addEventListener("click", async () => {
      STATE.selectedDraftFile = f;
      renderDraftList();
      setSelectedDraft(f);
      await loadDraft();
      await tryLoadApprovalSilently();
    });
    list.appendChild(div);
  });
}

function renderDraftSnapshot(draft) {
  if (!draft) {
    $("kpiValidation").innerText = "—";
    $("kpiConfidence").innerText = "—";
    $("kpiConsistency").innerText = "—";
    $("kpiRedFlags").innerText = "—";
    $("kpiWarnings").innerText = "—";
    return;
  }

  const validation = draft.validation?.status || "—";
  const expected = draft.validation?.completeness?.expected_questions;
  const answered = draft.validation?.completeness?.answered_questions;
  const completeness = (expected && answered) ? `${answered}/${expected}` : "—";

  $("kpiValidation").innerText = `${validation} | completeness: ${completeness}`;

  const confLevel = draft.confidence?.level || "—";
  const confScore = (typeof draft.confidence?.score === "number") ? draft.confidence.score : null;
  $("kpiConfidence").innerText = confScore !== null ? `${confLevel} (${confScore})` : confLevel;

  const ccStatus = draft.consistency_checks?.status || "—";
  const ccCount = Array.isArray(draft.consistency_checks?.items) ? draft.consistency_checks.items.length : 0;
  $("kpiConsistency").innerText = `${ccStatus} | items: ${ccCount}`;

  const rfHigh = draft.red_flags?.high_stakes?.status || "—";
  const rfCount = Array.isArray(draft.red_flags?.items) ? draft.red_flags.items.length : 0;
  $("kpiRedFlags").innerText = `High-stakes: ${rfHigh} | items: ${rfCount}`;

  const warnings = Array.isArray(draft.validation?.soft_warnings) ? draft.validation.soft_warnings : [];
  $("kpiWarnings").innerHTML = warnings.length
    ? `<ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
    : "None";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refresh() {
  try {
    setStatus("Refreshing…", true);
    const data = await apiGet("/api/list");
    STATE.drafts = data.data.drafts || [];
    renderDraftList();

    if (!STATE.selectedDraftFile && STATE.drafts.length > 0) {
      const newest = STATE.drafts[0];
      setSelectedDraft(newest);
      renderDraftList();
      await loadDraft();
      await tryLoadApprovalSilently();
    }

    setStatus("", true);
  } catch (e) {
    setStatus(`Refresh failed:\n${e.message}`, false);
  }
}

async function loadDraft() {
  try {
    if (!STATE.selectedDraftFile) return;
    const data = await apiGet(`/api/draft/read?file=${encodeURIComponent(STATE.selectedDraftFile)}`);
    STATE.draftObj = data.draft;
    renderDraftSnapshot(STATE.draftObj);
  } catch (e) {
    STATE.draftObj = null;
    renderDraftSnapshot(null);
    setStatus(`Could not read draft:\n${e.message}`, false);
  }
}

async function createApprovalTemplate() {
  try {
    if (!STATE.selectedDraftFile) return;
    setStatus("Creating approval template…", true);

    const out = await apiPost("/api/approval/template", { draft_file: STATE.selectedDraftFile });
    STATE.approvalFile = out.approvalFile || deriveApprovalFile(STATE.selectedCaseId);

    setStatus(`Approval template ready: approvals/${STATE.approvalFile}`, true);
    await loadApproval();
  } catch (e) {
    setStatus(`Template failed:\n${e.message}`, false);
  }
}

async function loadApproval() {
  try {
    if (!STATE.approvalFile) throw new Error("Approval file unknown (create template first).");

    setStatus(`Loading approval: approvals/${STATE.approvalFile}…`, true);
    const data = await apiGet(`/api/approval/get?file=${encodeURIComponent(STATE.approvalFile)}`);

    STATE.approvalObj = data.approval;

    const status = STATE.approvalObj?.decision?.status || null;
    highlightDecision(status);

    $("operatorNotes").value = STATE.approvalObj?.decision?.operator_notes || "";
    $("ovExec").value = STATE.approvalObj?.overrides?.executive_summary || "";
    $("ovRisk").value = STATE.approvalObj?.overrides?.risk_notes || "";
    $("ovRecs").value = STATE.approvalObj?.overrides?.recommendations || "";

    setStatus("Approval loaded.", true);
  } catch (e) {
    setStatus(`Load approval failed:\n${e.message}`, false);
  }
}

async function tryLoadApprovalSilently() {
  try {
    if (!STATE.selectedCaseId) return;
    const af = deriveApprovalFile(STATE.selectedCaseId);
    STATE.approvalFile = af;

    const data = await apiGet(`/api/approval/get?file=${encodeURIComponent(af)}`);
    STATE.approvalObj = data.approval;

    const status = STATE.approvalObj?.decision?.status || null;
    highlightDecision(status);

    $("operatorNotes").value = STATE.approvalObj?.decision?.operator_notes || "";
    $("ovExec").value = STATE.approvalObj?.overrides?.executive_summary || "";
    $("ovRisk").value = STATE.approvalObj?.overrides?.risk_notes || "";
    $("ovRecs").value = STATE.approvalObj?.overrides?.recommendations || "";

    setStatus(`Loaded existing approval: approvals/${af}`, true);
  } catch {
    STATE.approvalObj = null;
    highlightDecision(null);
    $("operatorNotes").value = "";
    $("ovExec").value = "";
    $("ovRisk").value = "";
    $("ovRecs").value = "";
    setStatus("", true);
  }
}

function buildApprovalObject() {
  // If template exists, preserve meta/audit etc.
  const base = (STATE.approvalObj && typeof STATE.approvalObj === "object")
    ? structuredClone(STATE.approvalObj)
    : {
        meta: {
          product: "LRID",
          case_id: STATE.selectedCaseId,
          approval_id: `approval_${STATE.selectedCaseId}`,
          created_at: new Date().toISOString(),
          created_by: "operator",
          notes: "Approval decision recorded by operator. Human-in-the-loop gate."
        },
        decision: {
          status: "APPROVE",
          operator_notes: "",
          version_tag: "v1",
          lock_scoring: true
        },
        overrides: {
          executive_summary: "",
          risk_notes: "",
          recommendations: ""
        },
        audit: {
          decision_at: new Date().toISOString(),
          decision_by: "operator",
          reason_code: "STANDARD_APPROVAL"
        }
      };

  if (!base.decision) base.decision = {};
  base.decision.status = STATE.decisionStatus || base.decision.status || "APPROVE";
  base.decision.operator_notes = $("operatorNotes").value.trim();

  if (!base.overrides) base.overrides = {};
  base.overrides.executive_summary = $("ovExec").value.trim();
  base.overrides.risk_notes = $("ovRisk").value.trim();
  base.overrides.recommendations = $("ovRecs").value.trim();

  if (!base.audit) base.audit = {};
  base.audit.decision_at = new Date().toISOString();
  base.audit.decision_by = "operator";

  return base;
}

async function saveApproval() {
  try {
    if (!STATE.approvalFile) throw new Error("Approval file unknown. Create template first.");
    if (!STATE.decisionStatus) throw new Error("Select decision: APPROVE / ADJUST / DEBRIEF.");

    const obj = buildApprovalObject();

    setStatus(`Saving approval: approvals/${STATE.approvalFile}…`, true);
    await apiPost("/api/approval/save", { file: STATE.approvalFile, approval: obj });

    STATE.approvalObj = obj;
    setStatus("Saved.", true);
  } catch (e) {
    setStatus(`Save failed:\n${e.message}`, false);
  }
}

async function finalizeAndGenerate() {
  try {
    if (!STATE.selectedDraftFile) throw new Error("No draft selected.");
    if (!STATE.approvalFile) throw new Error("No approval file. Create template first.");
    if (!STATE.decisionStatus) throw new Error("Select decision first (APPROVE/ADJUST/DEBRIEF).");

    await saveApproval();

    $("btnFinalize").disabled = true;
    setStatus("Finalizing… generating PDFs…", true);

    const out = await apiPost("/api/approval/finalize", { draft_file: STATE.selectedDraftFile });

    const links = out.links;
    if (links) {
      $("pdfLinks").innerHTML = `
        <div class="muted"><b>PDFs ready:</b></div>
        <a href="${links.executive}" target="_blank">Executive PDF</a>
        <a href="${links.hr}" target="_blank">HR PDF</a>
        <a href="${links.academic}" target="_blank">Academic PDF</a>
        <div class="muted">Folder: <span class="mono">${out.latestOutFolder || "—"}</span></div>
      `;
    } else {
      $("pdfLinks").innerHTML = `<div class="muted">PDFs generated, but out folder not detected.</div>`;
    }

    setStatus("DONE. PDFs generated successfully.", true);
  } catch (e) {
    setStatus(`Finalize failed:\n${e.message}`, false);
  } finally {
    $("btnFinalize").disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  $("btnRefresh").addEventListener("click", refresh);
  $("btnCreateTemplate").addEventListener("click", createApprovalTemplate);
  $("btnLoadApproval").addEventListener("click", loadApproval);
  $("btnSaveApproval").addEventListener("click", saveApproval);
  $("btnFinalize").addEventListener("click", finalizeAndGenerate);

  // Decision buttons
  $("decisionRow").querySelectorAll(".radioBtn").forEach((b) => {
    b.addEventListener("click", () => {
      const status = b.getAttribute("data-status");
      highlightDecision(status);
      setStatus(`Decision set to ${status} (not saved yet).`, true);
    });
  });

  setButtonsEnabled(false);
  highlightDecision(null);
  renderDraftSnapshot(null);

  await refresh();
});
