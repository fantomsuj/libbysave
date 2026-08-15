(function () {
  "use strict";

  const Shared = globalThis.LibbySaveShared;
  const FORBIDDEN = /borrow|place hold|return|renew|purchase/i;
  let state = null;
  let running = false;
  let phaseStartedAt = Date.now();
  let observer;
  let tagCreationAttempted = false;

  init();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.importState) {
      state = changes.importState.newValue || null;
      renderPanel();
      if (state?.status === "running") scheduleAutomation();
    }
  });

  async function init() {
    await runPendingCirculation();
    const response = await chrome.runtime.sendMessage({ type: "GET_IMPORT" });
    state = response?.importState;
    if (!state || ["complete", "stopped"].includes(state.status)) return;
    renderPanel();
    observer = new MutationObserver(scheduleAutomation);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleAutomation();
  }

  async function runPendingCirculation() {
    const response = await chrome.runtime.sendMessage({ type: "GET_CIRCULATION" });
    const pending = response?.pendingCirculation;
    if (!pending) return;
    if (pending.expiresAt < Date.now() || !location.pathname.includes(pending.mediaId)) {
      if (pending.expiresAt < Date.now()) await chrome.runtime.sendMessage({ type: "COMPLETE_CIRCULATION" });
      return;
    }

    const overlay = circulationPanel(pending);
    document.documentElement.appendChild(overlay);
    const allowed = pending.action === "borrow" ? /^(borrow|borrow!)$/i : /^(place hold|place a hold|hold)$/i;
    const success = pending.action === "borrow" ? /borrowed|on your shelf|open book/i : /hold placed|on hold|manage hold/i;
    const deadline = Date.now() + 20000;
    let clicks = 0;
    while (Date.now() < deadline && clicks < 3) {
      if (success.test(document.body.innerText)) {
        overlay.querySelector("p").textContent = pending.action === "borrow" ? "Borrowed successfully." : "Hold placed successfully.";
        await chrome.runtime.sendMessage({ type: "COMPLETE_CIRCULATION" });
        setTimeout(() => overlay.remove(), 2600);
        return;
      }
      const button = [...document.querySelectorAll("button, [role='button']")].find((element) => {
        const label = `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`.trim();
        return allowed.test(label);
      });
      if (button) {
        button.scrollIntoView({ block: "center" });
        button.click();
        clicks += 1;
      }
      await wait(800);
    }
    overlay.querySelector("p").textContent = "Libby needs your attention to finish this action.";
    overlay.querySelector("button").hidden = false;
  }

  function circulationPanel(pending) {
    const panel = document.createElement("aside");
    panel.id = "libbysave-circulation-panel";
    panel.innerHTML = `<span class="libbysave-panel-logo">L</span><div><strong>${pending.action === "borrow" ? "Borrowing" : "Placing hold"}</strong><p>${escapeHtml(pending.title)}</p></div><button hidden>Dismiss</button>`;
    panel.querySelector("button").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "COMPLETE_CIRCULATION" });
      panel.remove();
    });
    return panel;
  }

  function renderPanel() {
    let panel = document.getElementById("libbysave-import-panel");
    if (!state) {
      panel?.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = "libbysave-import-panel";
      document.documentElement.appendChild(panel);
    }
    const book = state.books[state.index];
    const complete = state.status === "complete";
    panel.innerHTML = `
      <div class="libbysave-panel-head"><span class="libbysave-panel-logo">L</span><strong>LibbySave</strong><button data-action="close" aria-label="Close">×</button></div>
      <div class="libbysave-panel-body">
        <div class="libbysave-progress"><i style="width:${complete ? 100 : Math.round((state.index / state.books.length) * 100)}%"></i></div>
        <p class="libbysave-kicker">${complete ? "Import complete" : `Saving ${state.index + 1} of ${state.books.length}`}</p>
        <h3>${escapeHtml(complete ? `${state.results.length} titles processed` : book?.title)}</h3>
        ${complete ? `<p>Review your <strong>${escapeHtml(state.targetTag)}</strong> tag in Libby.</p>` : `<p>${escapeHtml(book?.author || "")}<br><span>Tag: ${escapeHtml(state.targetTag)}</span></p>`}
        <div class="libbysave-panel-actions">
          ${complete ? `<button data-action="done" class="primary">Done</button>` : `
            <button data-action="toggle" class="primary">${state.status === "paused" ? "Continue" : "Pause"}</button>
            <button data-action="skip">Skip</button>
            <button data-action="saved">I saved it</button>`}
        </div>
        <small>${complete ? "No books were borrowed or placed on hold." : "Automation only uses search and tag controls—never Borrow or Place Hold."}</small>
      </div>`;
    panel.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", onAction));
  }

  async function onAction(event) {
    const action = event.currentTarget.dataset.action;
    if (action === "close") document.getElementById("libbysave-import-panel")?.remove();
    if (action === "done") {
      await chrome.runtime.sendMessage({ type: "STOP_IMPORT" });
      state = null;
      renderPanel();
    }
    if (action === "toggle") {
      const status = state.status === "paused" ? "running" : "paused";
      const response = await chrome.runtime.sendMessage({ type: "UPDATE_IMPORT_STATUS", status });
      state = response.importState;
      renderPanel();
      if (status === "running") scheduleAutomation();
    }
    if (action === "skip") await advance("skipped", "Skipped by user");
    if (action === "saved") await advance("saved", "Confirmed by user");
  }

  function scheduleAutomation() {
    if (running || state?.status !== "running") return;
    running = true;
    setTimeout(async () => {
      try { await automate(); } finally { running = false; }
    }, 700);
  }

  async function automate() {
    if (!state || state.status !== "running") return;
    const currentBook = state.books[state.index];
    if (!currentBook) return;

    const tagChoice = findTagChoice(state.targetTag);
    if (tagChoice) {
      clickSafe(tagChoice);
      await wait(500);
      await advance("saved", "Tag selected automatically");
      return;
    }

    if (await tryCreateTag(state.targetTag)) {
      phaseStartedAt = Date.now();
      return;
    }

    const saveButton = findButton(/^(save|tag|add tag|manage tags)$/i);
    if (saveButton) {
      clickSafe(saveButton);
      phaseStartedAt = Date.now();
      return;
    }

    if (/\/search\//.test(location.pathname)) {
      const match = findBookResult(currentBook);
      if (match) {
        clickSafe(match);
        phaseStartedAt = Date.now();
        return;
      }
    }

    if (Date.now() - phaseStartedAt > 12000) {
      state.status = "paused";
      await chrome.runtime.sendMessage({ type: "UPDATE_IMPORT_STATUS", status: "paused" });
      renderPanel();
    }
  }

  function findBookResult(book) {
    const links = [...document.querySelectorAll("a[href]")].filter((link) => /\/library\/|\/media\//.test(link.getAttribute("href") || ""));
    return links
      .map((link) => ({ link, score: Shared.tokenScore(book.title, link.closest("article, li, [role='listitem'], div")?.textContent || link.textContent) }))
      .filter(({ score }) => score >= 0.55)
      .sort((a, b) => b.score - a.score)[0]?.link || null;
  }

  function findTagChoice(tagName) {
    const normalizedTarget = Shared.normalize(tagName);
    const dialog = document.querySelector("[role='dialog'], [aria-modal='true']") || document;
    return [...dialog.querySelectorAll("button, label, [role='option'], [role='checkbox']")].find((element) => {
      if (FORBIDDEN.test(element.textContent || "")) return false;
      return Shared.normalize(element.textContent) === normalizedTarget;
    }) || null;
  }

  function findButton(pattern) {
    return [...document.querySelectorAll("button, [role='button']")].find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim();
      return !FORBIDDEN.test(label) && pattern.test(label);
    }) || null;
  }

  async function tryCreateTag(tagName) {
    const dialog = document.querySelector("[role='dialog'], [aria-modal='true']");
    if (!dialog || !/tag/i.test(dialog.textContent || "")) return false;
    const nameInput = [...dialog.querySelectorAll("input")].find((input) => {
      const label = `${input.getAttribute("aria-label") || ""} ${input.getAttribute("placeholder") || ""}`;
      return /tag.*name|name.*tag/i.test(label);
    });
    if (nameInput) {
      nameInput.focus();
      nameInput.value = tagName;
      nameInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: tagName }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));
      const create = [...dialog.querySelectorAll("button, [role='button']")].find((button) => /^create$/i.test(button.textContent.trim()));
      if (create) {
        clickSafe(create);
        return true;
      }
    }
    if (!tagCreationAttempted) {
      const newTag = [...dialog.querySelectorAll("button, [role='button']")].find((button) => /^(new tag|create tag)$/i.test(button.textContent.trim()));
      if (newTag) {
        tagCreationAttempted = true;
        clickSafe(newTag);
        await wait(350);
        return true;
      }
    }
    return false;
  }

  function clickSafe(element) {
    const label = `${element.getAttribute?.("aria-label") || ""} ${element.textContent || ""}`;
    if (FORBIDDEN.test(label)) throw new Error("Refused a borrowing action");
    element.scrollIntoView({ block: "center" });
    element.click();
  }

  async function advance(result, detail) {
    const response = await chrome.runtime.sendMessage({ type: "ADVANCE_IMPORT", result, detail });
    state = response.importState;
    phaseStartedAt = Date.now();
    renderPanel();
    if (response.nextUrl) location.assign(response.nextUrl);
  }

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value || "");
    return div.innerHTML;
  }
})();
