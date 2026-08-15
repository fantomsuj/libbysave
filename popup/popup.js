(function () {
  "use strict";

  const Shared = globalThis.LibbySaveShared;
  let settings = { libraries: [], targetTag: "Saved from LibbySave", autoCheck: true };
  let books = [];
  const availabilityByKey = new Map();

  const $ = (selector) => document.querySelector(selector);
  const libraryRows = $("#libraryRows");
  const setup = $("#setup");
  const empty = $("#empty");
  const booksSection = $("#booksSection");

  init();

  async function init() {
    const stored = await chrome.storage.local.get("settings");
    settings = { ...settings, ...(stored.settings || {}) };
    renderSettings();
    bindEvents();
    await scanActivePage();
  }

  function bindEvents() {
    $("#settingsToggle").addEventListener("click", () => setup.classList.toggle("hidden"));
    $("#addLibrary").addEventListener("click", () => addLibraryRow({ name: "", slug: "" }));
    $("#saveSettings").addEventListener("click", saveSettings);
    $("#checkAll").addEventListener("click", checkAll);
    $("#importAll").addEventListener("click", importAll);
  }

  async function scanActivePage() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE" });
      books = response?.books || [];
      $("#siteLabel").textContent = response?.site || "Book lists → Libby";
    } catch (_) {
      books = [];
    }
    if (!settings.libraries.length) setup.classList.remove("hidden");
    if (!books.length) {
      empty.classList.remove("hidden");
      booksSection.classList.add("hidden");
      return;
    }
    empty.classList.add("hidden");
    booksSection.classList.remove("hidden");
    $("#bookCount").textContent = String(books.length);
    renderBooks();
  }

  function renderSettings() {
    libraryRows.innerHTML = "";
    const rows = settings.libraries.length ? settings.libraries : [{ name: "", slug: "" }];
    rows.forEach(addLibraryRow);
    $("#targetTag").value = settings.targetTag;
    $("#importTag").value = settings.targetTag;
    $("#autoCheck").checked = settings.autoCheck !== false;
    renderLibrarySelect();
  }

  function addLibraryRow(library) {
    const row = document.createElement("div");
    row.className = "library-row";
    row.innerHTML = `<input data-field="name" aria-label="Library name" placeholder="NYPL" value="${escapeAttr(library.name || "")}"><input data-field="slug" aria-label="OverDrive slug" placeholder="nypl" value="${escapeAttr(library.slug || "")}"><button aria-label="Remove library">×</button>`;
    row.querySelector("button").addEventListener("click", () => row.remove());
    libraryRows.appendChild(row);
  }

  async function saveSettings() {
    const libraries = [...libraryRows.querySelectorAll(".library-row")]
      .map((row) => ({
        name: row.querySelector("[data-field='name']").value.trim(),
        slug: Shared.librarySlug(row.querySelector("[data-field='slug']").value)
      }))
      .filter((library) => library.slug)
      .map((library) => ({ ...library, name: library.name || library.slug }));
    settings = {
      libraries,
      targetTag: $("#targetTag").value.trim() || "Saved from LibbySave",
      autoCheck: $("#autoCheck").checked
    };
    await chrome.storage.local.set({ settings });
    $("#importTag").value = settings.targetTag;
    renderLibrarySelect();
    setup.classList.add("hidden");
    toast("Settings saved");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { type: "REFRESH_INLINE" }).catch(() => {});
  }

  function renderLibrarySelect() {
    const select = $("#importLibrary");
    select.innerHTML = settings.libraries.length
      ? settings.libraries.map((library) => `<option value="${escapeAttr(library.slug)}">${escapeHtml(library.name)}</option>`).join("")
      : `<option value="">Add a library first</option>`;
  }

  function renderBooks() {
    const list = $("#bookList");
    list.innerHTML = books.map((book, index) => {
      const key = Shared.bookKey(book);
      return `<article class="book-card" data-index="${index}"><div class="book-top"><div><h3 class="book-title">${escapeHtml(book.title)}</h3><p class="book-author">${escapeHtml(book.author || "Author unknown")}</p></div><input class="book-select" type="checkbox" checked aria-label="Include ${escapeAttr(book.title)}"></div><div class="availability-list" data-key="${escapeAttr(key)}"><span class="book-author">Not checked yet</span></div></article>`;
    }).join("");
  }

  async function checkAll() {
    if (!settings.libraries.length) {
      setup.classList.remove("hidden");
      toast("Add your library first");
      return;
    }
    $("#checkAll").textContent = "Checking…";
    const response = await chrome.runtime.sendMessage({ type: "CHECK_BOOKS", books, libraries: settings.libraries });
    (response?.results || []).forEach((entry) => {
      availabilityByKey.set(entry.key, entry.libraries || []);
      renderAvailability(entry.key, entry.libraries || []);
    });
    summarize();
    $("#checkAll").textContent = "Check again";
  }

  function renderAvailability(key, results) {
    const container = [...document.querySelectorAll(".availability-list")].find((node) => node.dataset.key === key);
    if (!container) return;
    const book = books.find((candidate) => Shared.bookKey(candidate) === key);
    container.innerHTML = results.map((result) => {
      const name = result.library?.name || result.library?.slug || "Library";
      const detail = availabilityText(result);
      const action = result.status === "available" ? "borrow" : result.status === "wait" ? "hold" : "";
      const button = action ? `<button data-action="${action}" data-key="${escapeAttr(key)}" data-library="${escapeAttr(result.library.slug)}">${action === "borrow" ? "Borrow now" : "Place hold"}</button>` : "";
      return `<div class="availability ${escapeAttr(result.status)}"><i class="dot"></i><span><strong>${escapeHtml(name)}</strong> · ${escapeHtml(detail)}</span>${button}</div>`;
    }).join("") || `<span class="book-author">No library results</span>`;
    container.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", () => circulate(button, book, results)));
  }

  async function circulate(button, book, results) {
    const result = results.find((candidate) => candidate.library?.slug === button.dataset.library);
    button.disabled = true;
    button.textContent = button.dataset.action === "borrow" ? "Opening Libby…" : "Opening Libby…";
    const response = await chrome.runtime.sendMessage({ type: "START_CIRCULATION", action: button.dataset.action, book, result });
    if (!response?.ok) {
      button.disabled = false;
      button.textContent = button.dataset.action === "borrow" ? "Borrow now" : "Place hold";
      toast(response?.error || "Couldn’t open Libby");
    }
  }

  function availabilityText(result) {
    if (result.status === "available") return result.isAlternative ? "Ebook available as an alternative" : `${result.format === "audiobook" ? "Audiobook" : "Ebook"} available now`;
    if (result.status === "wait") {
      const wait = result.estimatedWaitDays ? `about ${Math.max(1, Math.ceil(result.estimatedWaitDays / 7))} week wait` : `${result.holdsCount || ""} holds`.trim();
      return `${result.format === "audiobook" ? "Audiobook" : "Ebook"} · ${wait}`;
    }
    if (result.status === "notify") return "not owned · Notify Me";
    if (result.status === "error") return result.error || "couldn’t check";
    return "not found";
  }

  function summarize() {
    const all = [...availabilityByKey.values()].flat();
    const available = all.filter((result) => result.status === "available").length;
    const wait = all.filter((result) => result.status === "wait").length;
    $("#summary").innerHTML = `<strong>${available}</strong> available now · <strong>${wait}</strong> with a wait`;
  }

  async function importAll() {
    const selected = [...document.querySelectorAll(".book-card")]
      .filter((card) => card.querySelector(".book-select").checked)
      .map((card) => books[Number(card.dataset.index)]);
    const response = await chrome.runtime.sendMessage({
      type: "START_IMPORT",
      books: selected,
      targetTag: $("#importTag").value.trim() || settings.targetTag,
      librarySlug: $("#importLibrary").value
    });
    if (!response?.ok) toast(response?.error || "Couldn’t start import");
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    setTimeout(() => node.classList.remove("show"), 2200);
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value || "");
    return div.innerHTML;
  }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, "&quot;"); }
})();
