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
    renderSettings(); bindEvents(); await scanDedicatedPage(); renderPageState();
  }

  function bindEvents() {
    $("#settingsToggle").addEventListener("click", () => setup.classList.toggle("hidden"));
    $("#addLibrary").addEventListener("click", () => addLibraryRow({ name:"", slug:"" }));
    $("#saveSettings").addEventListener("click", saveSettings);
    $("#checkAll").addEventListener("click", checkSelected);
    $("#importAll").addEventListener("click", importSelected);
    $("#findBooksEmpty").addEventListener("click", findBooks);
    $("#findBooksAgain").addEventListener("click", findBooks);
  }

  async function activeTab() { return (await chrome.tabs.query({ active:true, currentWindow:true }))[0]; }

  async function scanDedicatedPage() {
    const tab = await activeTab();
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type:"SCAN_PAGE" });
      if (response?.ok && response.books?.length) {
        books = response.books.map((book) => ({ ...book, confidence:1, evidence:["Dedicated site adapter"], selected:true }));
        $("#siteLabel").textContent = response.site || "Book list → Libby";
        return true;
      }
    } catch (_) { /* Generic pages have no persistent content script. */ }
    return false;
  }

  async function findBooks(event) {
    const button = event.currentTarget;
    button.disabled = true; button.textContent = "Scanning…";
    availabilityByKey.clear();
    try {
      if (await scanDedicatedPage()) { renderPageState(); return; }
      const tab = await activeTab();
      await chrome.scripting.executeScript({ target:{ tabId:tab.id }, files:["src/generic-extractor.js", "src/content/generic-page.js"] });
      const response = await chrome.tabs.sendMessage(tab.id, { type:"GENERIC_SCAN_PAGE" });
      books = response?.books || [];
      $("#siteLabel").textContent = response?.site || "Page scan";
      if (!books.length) toast("No likely books found. Try selecting a reading list first.");
      renderPageState();
    } catch (_) {
      books = []; renderPageState(); toast("Chrome doesn’t allow scanning this page.");
    } finally {
      button.disabled = false;
      button.textContent = button.id === "findBooksEmpty" ? "Find books on this page" : "Find again";
    }
  }

  function renderPageState() {
    if (!settings.libraries.length) setup.classList.remove("hidden");
    empty.classList.toggle("hidden", books.length > 0);
    booksSection.classList.toggle("hidden", books.length === 0);
    if (books.length) { $("#bookCount").textContent = String(books.length); renderBooks(); }
  }

  function renderSettings() {
    libraryRows.innerHTML = "";
    (settings.libraries.length ? settings.libraries : [{ name:"", slug:"" }]).forEach(addLibraryRow);
    $("#targetTag").value = settings.targetTag; $("#importTag").value = settings.targetTag; $("#autoCheck").checked = settings.autoCheck !== false; renderLibrarySelect();
  }

  function addLibraryRow(library) {
    const row = document.createElement("div"); row.className = "library-row";
    row.innerHTML = `<input data-field="name" aria-label="Library name" placeholder="NYPL" value="${escapeAttr(library.name || "")}"><input data-field="slug" aria-label="OverDrive slug" placeholder="nypl" value="${escapeAttr(library.slug || "")}"><button aria-label="Remove library">×</button>`;
    row.querySelector("button").addEventListener("click", () => row.remove()); libraryRows.appendChild(row);
  }

  async function saveSettings() {
    const libraries = [...libraryRows.querySelectorAll(".library-row")].map((row) => ({ name:row.querySelector("[data-field='name']").value.trim(), slug:Shared.librarySlug(row.querySelector("[data-field='slug']").value) })).filter((library) => library.slug).map((library) => ({ ...library, name:library.name || library.slug }));
    settings = { libraries, targetTag:$("#targetTag").value.trim() || "Saved from LibbySave", autoCheck:$("#autoCheck").checked };
    await chrome.storage.local.set({ settings }); $("#importTag").value = settings.targetTag; renderLibrarySelect(); setup.classList.add("hidden"); toast("Settings saved");
    const tab = await activeTab(); chrome.tabs.sendMessage(tab.id, { type:"REFRESH_INLINE" }).catch(() => {});
  }

  function renderLibrarySelect() {
    $("#importLibrary").innerHTML = settings.libraries.length ? settings.libraries.map((library) => `<option value="${escapeAttr(library.slug)}">${escapeHtml(library.name)}</option>`).join("") : `<option value="">Add a library first</option>`;
  }

  function confidence(book) {
    const score = Number(book.confidence ?? 1); return score >= .85 ? ["high", "High confidence"] : score >= .6 ? ["medium", "Medium confidence"] : ["low", "Low confidence"];
  }

  function renderBooks() {
    $("#bookList").innerHTML = books.map((book,index) => {
      const [level,label] = confidence(book); const key = Shared.bookKey(book);
      return `<article class="book-card" data-index="${index}"><div class="book-top"><input class="book-select" type="checkbox" ${book.selected === false ? "" : "checked"} aria-label="Include ${escapeAttr(book.title)}"><div class="book-fields"><input class="book-title-input" aria-label="Book title" value="${escapeAttr(book.title)}"><input class="book-author-input" aria-label="Book author" placeholder="Author unknown" value="${escapeAttr(book.author || "")}"><div class="book-meta"><span class="confidence confidence-${level}">${label}</span><span class="evidence">${escapeHtml((book.evidence || []).join(" + "))}</span></div></div><button class="remove-book" aria-label="Remove ${escapeAttr(book.title)}">×</button></div><div class="availability-list" data-key="${escapeAttr(key)}"><span class="book-author">Not checked yet</span></div></article>`;
    }).join("");
    document.querySelectorAll(".book-card").forEach((card) => {
      const index = Number(card.dataset.index);
      card.querySelector(".book-select").addEventListener("change", (event) => { books[index].selected = event.target.checked; });
      card.querySelector(".book-title-input").addEventListener("change", (event) => editBook(index,"title",event.target.value));
      card.querySelector(".book-author-input").addEventListener("change", (event) => editBook(index,"author",event.target.value));
      card.querySelector(".remove-book").addEventListener("click", () => { books.splice(index,1); renderPageState(); });
    });
  }

  function editBook(index, field, value) {
    books[index][field] = field === "title" ? Shared.cleanTitle(value) : Shared.cleanAuthor(value);
    books[index].evidence = ["Edited by you"]; books[index].confidence = 1; availabilityByKey.clear(); renderBooks();
  }

  function selectedBooks() { return books.filter((book) => book.selected !== false && book.title); }

  async function checkSelected() {
    if (!settings.libraries.length) { setup.classList.remove("hidden"); toast("Add your library first"); return; }
    const targets = selectedBooks(); if (!targets.length) { toast("Select at least one book"); return; }
    $("#checkAll").textContent = "Checking…";
    const response = await chrome.runtime.sendMessage({ type:"CHECK_BOOKS", books:targets, libraries:settings.libraries });
    (response?.results || []).forEach((entry) => { availabilityByKey.set(entry.key, entry.libraries || []); renderAvailability(entry.key, entry.libraries || []); });
    summarize(); $("#checkAll").textContent = "Check again";
  }

  function renderAvailability(key, results) {
    const container = [...document.querySelectorAll(".availability-list")].find((node) => node.dataset.key === key); if (!container) return;
    const book = books.find((candidate) => Shared.bookKey(candidate) === key);
    container.innerHTML = results.map((result) => { const name=result.library?.name || result.library?.slug || "Library"; const action=result.status === "available" ? "borrow" : result.status === "wait" ? "hold" : ""; const button=action ? `<button data-action="${action}" data-library="${escapeAttr(result.library.slug)}">${action === "borrow" ? "Borrow now" : "Place hold"}</button>` : ""; return `<div class="availability ${escapeAttr(result.status)}"><i class="dot"></i><span><strong>${escapeHtml(name)}</strong> · ${escapeHtml(availabilityText(result))}</span>${button}</div>`; }).join("") || `<span class="book-author">No library results</span>`;
    container.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", () => circulate(button,book,results)));
  }

  async function circulate(button,book,results) {
    const result=results.find((candidate) => candidate.library?.slug === button.dataset.library); button.disabled=true; button.textContent="Opening Libby…";
    const response=await chrome.runtime.sendMessage({ type:"START_CIRCULATION", action:button.dataset.action, book, result });
    if (!response?.ok) { button.disabled=false; button.textContent=button.dataset.action === "borrow" ? "Borrow now" : "Place hold"; toast(response?.error || "Couldn’t open Libby"); }
  }

  function availabilityText(result) {
    if (result.status === "available") return result.isAlternative ? "Ebook available as an alternative" : `${result.format === "audiobook" ? "Audiobook" : "Ebook"} available now`;
    if (result.status === "wait") {
      const wait=result.estimatedWaitDays ? `about ${Math.max(1,Math.ceil(result.estimatedWaitDays/7))} week wait` : `${result.holdsCount || ""} holds`.trim();
      return `${result.format === "audiobook" ? "Audiobook" : "Ebook"} · ${wait}`;
    }
    if (result.status === "notify") return "not owned · Notify Me"; if (result.status === "error") return result.error || "couldn’t check"; return "not found";
  }

  function summarize() { const all=[...availabilityByKey.values()].flat(); $("#summary").innerHTML=`<strong>${all.filter((r) => r.status === "available").length}</strong> available now · <strong>${all.filter((r) => r.status === "wait").length}</strong> with a wait`; }

  async function importSelected() {
    const selected=selectedBooks(); const response=await chrome.runtime.sendMessage({ type:"START_IMPORT", books:selected, targetTag:$("#importTag").value.trim() || settings.targetTag, librarySlug:$("#importLibrary").value });
    if (!response?.ok) toast(response?.error || "Couldn’t start import");
  }

  function toast(message) { const node=$("#toast"); node.textContent=message; node.classList.add("show"); setTimeout(() => node.classList.remove("show"),2200); }
  function escapeHtml(value) { const div=document.createElement("div"); div.textContent=String(value || ""); return div.innerHTML; }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g,"&quot;"); }
})();
