(function () {
  "use strict";
  const Shared = globalThis.LibbySaveShared;
  const Automation = globalThis.LibbySaveAutomation;
  const targets = new Map();
  let importState = null, circulation = null, receipts = [], running = false, timer = null;
  let phaseStartedAt = Date.now(), lastPath = location.pathname;
  let diagnostic = { state: "starting", code: "INIT", explanation: "Inspecting the Libby page." };
  init();

  async function init() {
    const [circulationResponse, importResponse] = await Promise.all([
      chrome.runtime.sendMessage({ type: "GET_CIRCULATION" }),
      chrome.runtime.sendMessage({ type: "GET_IMPORT" })
    ]);
    circulation = circulationResponse?.pendingCirculation || null;
    receipts = circulationResponse?.circulationReceipts || [];
    importState = importResponse?.importState || null;
    if (circulation) renderCirculationPanel();
    else if (importState && !["complete", "stopped"].includes(importState.status)) renderImportPanel();
    else return;
    chrome.storage.onChanged.addListener(onStorageChanged);
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-checked", "aria-busy", "disabled"] });
    schedule();
  }

  function onStorageChanged(changes, area) {
    if (area !== "local") return;
    if (changes.pendingCirculation) { circulation = changes.pendingCirculation.newValue || null; if (circulation) renderCirculationPanel(); }
    if (changes.importState) { importState = changes.importState.newValue || null; if (!circulation) renderImportPanel(); }
    schedule();
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 450); }

  async function run() {
    if (running) return;
    running = true;
    try {
      if (location.pathname !== lastPath) { lastPath = location.pathname; phaseStartedAt = Date.now(); }
      if (circulation) await runCirculation();
      else if (importState?.status === "running") await runImport();
    } catch (error) {
      await pauseSafely("AUTOMATION_ERROR", error.message || "Unexpected automation error.");
    } finally {
      running = false;
      if (((circulation && circulation.status !== "paused") || importState?.status === "running") && diagnostic.state !== Automation.STATES.SUCCESS) timer = setTimeout(run, 900);
    }
  }

  async function runImport() {
    const book = importState.books[importState.index];
    if (!book) return;
    const snapshot = inspectPage({ book, librarySlug: importState.librarySlug, tagName: importState.targetTag });
    await applyDecision(Automation.decideImport(snapshot, {
      book, tagName: importState.targetTag, clickedSteps: importState.machine?.clickedSteps || [], elapsedMs: Date.now() - phaseStartedAt
    }), "import");
  }

  async function runCirculation() {
    const snapshot = inspectPage({ book: { title: circulation.title, author: circulation.author }, librarySlug: circulation.librarySlug, mediaId: circulation.mediaId });
    await applyDecision(Automation.decideCirculation(snapshot, {
      authorization: circulation, receipts, clickedSteps: circulation.clickedSteps || [], elapsedMs: Date.now() - phaseStartedAt, now: Date.now()
    }), "circulation");
  }

  async function applyDecision(decision, mode) {
    diagnostic = sanitizeDiagnostic(decision, mode);
    renderDiagnostics(mode);
    if (decision.effect === "wait") return;
    if (decision.effect === "pause") { await pauseSafely(decision.code, decision.explanation); return; }
    if (decision.effect === "complete") {
      if (mode === "circulation") {
        const response = await chrome.runtime.sendMessage({ type: "COMPLETE_CIRCULATION", authorizationId: circulation.id, outcome: "success", code: decision.code });
        receipts = response?.circulationReceipts || receipts; circulation = null; renderCirculationPanel(true);
      } else {
        const response = await chrome.runtime.sendMessage({ type: "ADVANCE_IMPORT", result: "saved", detail: decision.code });
        importState = response.importState; phaseStartedAt = Date.now(); renderImportPanel();
        if (response.nextUrl) location.assign(response.nextUrl);
      }
      return;
    }
    const target = targets.get(decision.targetKey);
    if (!target || !target.isConnected) { await pauseSafely("TARGET_RERENDERED", "The verified control changed before it could be used. Automation stopped without clicking."); return; }
    if (mode === "circulation") {
      const response = await chrome.runtime.sendMessage({ type: "RECORD_CIRCULATION_STEP", authorizationId: circulation.id, step: decision.step });
      if (!response?.ok || !response.allowed) { await pauseSafely(response?.code || "STEP_REJECTED", "The one-shot circulation guard rejected this click."); return; }
      circulation = response.pendingCirculation;
    } else {
      const response = await chrome.runtime.sendMessage({ type: "RECORD_IMPORT_STEP", importId: importState.id, index: importState.index, step: decision.step, machineState: decision.state, code: decision.code });
      if (!response?.ok || !response.allowed) { await pauseSafely(response?.code || "IMPORT_STEP_REJECTED", "The import transition guard rejected this action."); return; }
      importState = response.importState;
    }
    phaseStartedAt = Date.now();
    if (decision.effect === "input") setInput(target, decision.value); else constrainedClick(target, decision);
  }

  function constrainedClick(element, decision) {
    const label = accessibleLabel(element);
    if (Automation.isForbiddenLabel(label)) throw new Error(`Blocked forbidden action: ${label}`);
    if (decision.step.startsWith("circulation") && !/^(borrow|borrow!|place hold|place a hold|hold)$/i.test(label)) throw new Error("Authorized circulation target changed before click");
    if (!decision.step.startsWith("circulation") && /^(borrow|borrow!|borrow now|place hold|place a hold|hold)$/i.test(label)) throw new Error("Import workflow refused a circulation action");
    element.scrollIntoView({ block: "center" });
    element.click();
  }

  function setInput(input, value) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function pauseSafely(code, explanation) {
    diagnostic = { ...diagnostic, state: Automation.STATES.AMBIGUOUS, code, explanation };
    if (circulation) {
      await chrome.runtime.sendMessage({ type: "PAUSE_CIRCULATION", authorizationId: circulation.id, code });
      circulation.status = "paused"; renderCirculationPanel();
    } else if (importState) {
      const response = await chrome.runtime.sendMessage({ type: "UPDATE_IMPORT_STATUS", status: "paused", code });
      importState = response.importState; renderImportPanel();
    }
    renderDiagnostics(circulation ? "circulation" : "import");
  }

  function inspectPage(context) {
    targets.clear();
    let sequence = 0;
    const makeKey = (element, prefix) => { const key = `${prefix}-${sequence++}`; targets.set(key, element); return key; };
    const controls = [...document.querySelectorAll("button, [role='button'], a[href]")].map((element) => ({
      key: makeKey(element, "control"), label: accessibleLabel(element), disabled: element.disabled || element.getAttribute("aria-disabled") === "true",
      inDialog: Boolean(element.closest("[role='dialog'], [aria-modal='true']")),
      inCirculationArea: /borrow|hold|loan/i.test(element.closest("section, article, dialog, [role='dialog']")?.getAttribute("aria-label") || ""), nearbyDanger: accessibleLabel(element)
    }));
    const dialog = document.querySelector("[role='dialog'], [aria-modal='true']");
    const tagScope = dialog && /tag|save/i.test(accessibleLabel(dialog) + " " + (dialog.textContent || "")) ? dialog : null;
    const tags = tagScope ? [...tagScope.querySelectorAll("button, label, [role='option'], [role='checkbox'], input[type='checkbox']")].map((element) => ({
      key: makeKey(element, "tag"), label: accessibleLabel(element), checked: element.checked || element.getAttribute("aria-checked") === "true" || element.closest("label")?.querySelector("input")?.checked === true
    })) : [];
    const inputs = tagScope ? [...tagScope.querySelectorAll("input")].map((element) => ({ key: makeKey(element, "input"), label: `${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""}`.trim(), value: element.value })) : [];
    const results = [...document.querySelectorAll("a[href*='/media/'], a[href*='/library/']")].map((element) => {
      const card = element.closest("article, li, [role='listitem']") || element.parentElement;
      const heading = card?.querySelector("h1, h2, h3, [data-testid*='title']");
      const author = card?.querySelector("[data-testid*='author'], [class*='author'], [rel='author']");
      return { key: makeKey(element, "result"), title: heading?.textContent?.trim() || accessibleLabel(element), author: author?.textContent?.trim() || "", cardText: card?.textContent?.trim() || accessibleLabel(element) };
    });
    const libraryMatch = location.pathname.match(/\/(?:library|search)\/([^/]+)/);
    const mediaMatch = location.pathname.match(/\/([^/]+)$/);
    const pageTitle = document.querySelector("main h1, h1")?.textContent?.trim() || "";
    const statuses = [...document.querySelectorAll("[role='status'], [role='alert'], [aria-live]")].map((node) => node.textContent.trim()).filter(Boolean);
    const targetTag = Shared.normalize(context.tagName || "");
    const tagConfirmation = statuses.find((text) => { const value = Shared.normalize(text); return targetTag && (value === `saved to ${targetTag}` || value === `${targetTag} saved`); }) ? targetTag : "";
    const circulationSuccess = statuses.some((text) => /^(borrowed|loan successful|on your shelf)$/i.test(text)) ? "borrow" : statuses.some((text) => /^(hold placed|you're on the wait list|on hold)$/i.test(text)) ? "hold" : "";
    return {
      controls, tags, inputs, results, dialogKind: tagScope ? "tags" : dialog ? "other" : "",
      pathKind: /\/search\//.test(location.pathname) ? "search" : /\/library\//.test(location.pathname) ? "media" : "other",
      busy: document.querySelector("[aria-busy='true']") !== null, librarySlug: libraryMatch?.[1] || "",
      mediaId: context.mediaId && location.pathname.includes(String(context.mediaId)) ? String(context.mediaId) : (mediaMatch?.[1] || ""),
      identityMatches: libraryMatch?.[1] === context.librarySlug && Shared.tokenScore(context.book?.title || "", pageTitle || document.title) >= .82,
      tagConfirmation, circulationSuccess
    };
  }

  function accessibleLabel(element) { return String(element.getAttribute?.("aria-label") || element.getAttribute?.("title") || element.textContent || "").replace(/\s+/g, " ").trim(); }
  function sanitizeDiagnostic(decision, mode) {
    return { mode, state: decision.state, code: decision.code, explanation: decision.explanation, page: `${location.origin}${location.pathname}`,
      importId: mode === "import" ? importState?.id : undefined, authorizationId: mode === "circulation" ? circulation?.id : undefined,
      mediaId: mode === "circulation" ? circulation?.mediaId : undefined, library: mode === "circulation" ? circulation?.librarySlug : importState?.librarySlug, at: new Date().toISOString() };
  }

  function renderImportPanel() {
    let panel = document.getElementById("libbysave-import-panel");
    if (!importState) { panel?.remove(); return; }
    if (!panel) { panel = document.createElement("aside"); panel.id = "libbysave-import-panel"; document.documentElement.appendChild(panel); }
    const book = importState.books[importState.index], complete = importState.status === "complete";
    panel.innerHTML = `<div class="libbysave-panel-head"><span class="libbysave-panel-logo">L</span><strong>LibbySave</strong></div><div class="libbysave-panel-body"><div class="libbysave-progress"><i style="width:${complete ? 100 : Math.round((importState.index / importState.books.length) * 100)}%"></i></div><p class="libbysave-kicker">${complete ? "Import complete" : `Saving ${importState.index + 1} of ${importState.books.length}`}</p><h3>${escapeHtml(complete ? `${importState.results.length} titles processed` : book?.title)}</h3><p>${escapeHtml(book?.author || "")}<br><span>Tag: ${escapeHtml(importState.targetTag)}</span></p><div class="libbysave-panel-actions">${complete ? `<button data-action="done" class="primary">Done</button>` : `<button data-action="toggle" class="primary">${importState.status === "paused" ? "Continue" : "Pause"}</button><button data-action="skip">Skip</button><button data-action="saved">I saved it</button>`}</div><small>Import mode cannot Borrow or Place hold.</small><div class="libbysave-diagnostic"></div></div>`;
    panel.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", onImportAction)); renderDiagnostics("import");
  }

  async function onImportAction(event) {
    const action = event.currentTarget.dataset.action;
    if (action === "done") { await chrome.runtime.sendMessage({ type: "STOP_IMPORT" }); importState = null; renderImportPanel(); return; }
    if (action === "toggle") {
      const status = importState.status === "paused" ? "running" : "paused";
      const response = await chrome.runtime.sendMessage({ type: "UPDATE_IMPORT_STATUS", status, code: "USER_TOGGLE" });
      importState = response.importState; phaseStartedAt = Date.now(); renderImportPanel(); schedule();
    }
    if (action === "skip" || action === "saved") {
      const response = await chrome.runtime.sendMessage({ type: "ADVANCE_IMPORT", result: action === "skip" ? "skipped" : "saved", detail: "Confirmed by user" });
      importState = response.importState; renderImportPanel(); if (response.nextUrl) location.assign(response.nextUrl);
    }
  }

  function renderCirculationPanel(done) {
    let panel = document.getElementById("libbysave-circulation-panel");
    if (!circulation && !done) { panel?.remove(); return; }
    if (!panel) { panel = document.createElement("aside"); panel.id = "libbysave-circulation-panel"; document.documentElement.appendChild(panel); }
    panel.innerHTML = `<span class="libbysave-panel-logo">L</span><div><strong>${done ? "Action confirmed" : circulation?.action === "borrow" ? "Authorized borrow" : "Authorized hold"}</strong><p>${done ? "Libby confirmed success." : escapeHtml(circulation?.title)}</p><div class="libbysave-diagnostic"></div></div>${done ? "" : `<button data-action="cancel">Stop</button>`}`;
    panel.querySelector("[data-action='cancel']")?.addEventListener("click", async () => { await chrome.runtime.sendMessage({ type: "COMPLETE_CIRCULATION", authorizationId: circulation.id, outcome: "cancelled", code: "USER_CANCELLED" }); circulation = null; panel.remove(); });
    renderDiagnostics("circulation"); if (done) setTimeout(() => panel.remove(), 3000);
  }

  function renderDiagnostics(mode) {
    const panel = document.getElementById(mode === "circulation" ? "libbysave-circulation-panel" : "libbysave-import-panel");
    const node = panel?.querySelector(".libbysave-diagnostic"); if (!node) return;
    node.innerHTML = `<details><summary>Diagnostic: ${escapeHtml(diagnostic.code)}</summary><p>${escapeHtml(diagnostic.explanation)}</p><code>${escapeHtml(JSON.stringify(diagnostic))}</code><button type="button">Copy diagnostics</button></details>`;
    node.querySelector("button").addEventListener("click", () => navigator.clipboard?.writeText(JSON.stringify(diagnostic, null, 2)));
  }
  function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value || ""); return div.innerHTML; }
})();
