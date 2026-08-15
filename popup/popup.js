(function () {
  "use strict";

  const Shared = globalThis.LibbySaveShared;
  const Directory = globalThis.LibbySaveDirectory;
  const BookSearch = globalThis.LibbySaveBookSearch;
  const SavedBooks = globalThis.LibbySaveSavedBooks;
  const Controller = globalThis.LibbySaveSearchController;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  let settings = { libraries: [], targetTag: "Saved from LibbySave", autoCheck: true };
  let searchResults = [];
  let activeResult = -1;
  let requestNumber = 0;
  let savedState = { version: SavedBooks.STORAGE_VERSION, items: [] };
  let pageBooks = [];
  let batchRows = [];
  let activeView = "search";
  let toastTimer = null;
  let librarySearchResults = [];
  let activeLibraryResult = -1;
  let librarySearchTimer = null;
  let librarySearchSequence = 0;
  const selectedSaved = new Set();
  const pageAvailability = new Map();
  const searchLater = Controller.debounce(search, 350);

  init();

  async function init() {
    const [stored, saved] = await Promise.all([
      chrome.storage.local.get("settings"),
      chrome.runtime.sendMessage({ type: "GET_SAVED_BOOKS" })
    ]);
    settings = Directory.migrateSettings({ ...settings, ...(stored.settings || {}) });
    await chrome.storage.local.set({ settings });
    savedState = saved?.savedBooks || savedState;
    renderSettings();
    renderSaved();
    bindEvents();
    scanActivePage();
    if (!settings.libraries.length) setSettingsOpen(true);
    setTimeout(() => (settings.libraries.length ? $("#bookSearch") : $("#librarySearch")).focus(), 0);
  }

  function bindEvents() {
    $("#bookSearch").addEventListener("input", () => {
      const query = $("#bookSearch").value.trim();
      if (query) showView("search");
      $("#searchStatus").textContent = query.length < 2 ? "Type at least 2 characters." : "Searching…";
      searchLater(query);
    });
    $("#bookSearch").addEventListener("keydown", onSearchKeydown);
    $("#batchToggle").addEventListener("click", () => showView(activeView === "batch" ? "search" : "batch"));
    $$(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
    $$(".examples button").forEach((button) => button.addEventListener("click", () => {
      $("#bookSearch").value = button.dataset.query;
      $("#bookSearch").dispatchEvent(new Event("input", { bubbles: true }));
      $("#bookSearch").focus();
    }));
    $("#settingsToggle").addEventListener("click", () => setSettingsOpen($("#setup").classList.contains("hidden")));
    $("#librarySearch").addEventListener("input", scheduleLibrarySearch);
    $("#librarySearch").addEventListener("keydown", onLibrarySearchKeydown);
    $("#addManualLibrary").addEventListener("click", addManualLibrary);
    $("#saveSettings").addEventListener("click", saveSettings);
    $("#reviewBatch").addEventListener("click", reviewBatch);
    $("#saveBatch").addEventListener("click", saveBatch);
    $$(".filters input").forEach((input) => input.addEventListener("change", renderSaved));
    $("#refreshSaved").addEventListener("click", refreshVisibleSaved);
    $("#importSaved").addEventListener("click", importSaved);
    $("#checkAll").addEventListener("click", checkAllPage);
    $("#importAll").addEventListener("click", importPage);
  }

  async function search(query) {
    const current = ++requestNumber;
    if (query.length < 2) {
      searchResults = [];
      renderSearchResults();
      $("#searchStatus").textContent = query ? "Type at least 2 characters." : "Type to find and save a book.";
      return;
    }
    $("#bookSearch").setAttribute("aria-busy", "true");
    try {
      const response = await chrome.runtime.sendMessage({ type: "SEARCH_BOOKS", query, limit: 12 });
      if (current !== requestNumber) return;
      if (!response?.ok) throw new Error(response?.error || "Search failed.");
      searchResults = response.results || [];
      activeResult = searchResults.length ? 0 : -1;
      renderSearchResults();
      const parsed = BookSearch.parseInput(query);
      $("#searchStatus").textContent = searchResults.length
        ? (parsed.recognizedUrl ? "Book link recognized. Review the match." : searchResults.length + " matches")
        : (parsed.recognizedUrl && !parsed.query ? "This link hides its title. Open it and search the visible title." : "No matches. Try a title plus author or ISBN.");
    } catch (error) {
      if (current !== requestNumber) return;
      searchResults = [];
      renderSearchResults();
      $("#searchStatus").textContent = /rate/i.test(error.message) ? "Search is rate limited. Try again in a moment." : /offline/i.test(error.message) ? "Offline. Saved books are still available." : error.message;
    } finally {
      if (current === requestNumber) $("#bookSearch").removeAttribute("aria-busy");
    }
  }

  function onSearchKeydown(event) {
    const action = Controller.keyboardAction(event.key, activeResult, searchResults.length, Boolean($("#bookSearch").value));
    if (action.type === "none") return;
    event.preventDefault();
    if (action.type === "move") {
      activeResult = action.index;
      renderSearchResults();
      document.querySelector(".result.active")?.scrollIntoView({ block: "nearest" });
    }
    if (action.type === "save") saveSearchResult(searchResults[action.index]);
    if (action.type === "clear") {
      $("#bookSearch").value = "";
      searchResults = [];
      activeResult = -1;
      renderSearchResults();
      $("#searchStatus").textContent = "Type to find and save a book.";
    }
    if (action.type === "close") window.close();
  }

  function renderSearchResults() {
    const list = $("#searchResults");
    $("#bookSearch").setAttribute("aria-expanded", String(Boolean(searchResults.length)));
    list.classList.toggle("hidden", !searchResults.length);
    list.innerHTML = searchResults.map((book, index) => {
      const saved = savedState.items.some((item) => !item.removedAt && SavedBooks.sameBook(item, book));
      const review = book.confidence === "review" ? '<span class="confidence review">Review</span>' : "";
      return '<div class="result ' + (index === activeResult ? "active" : "") + '" data-index="' + index + '" role="option" aria-selected="' + String(index === activeResult) + '">' +
        cover(book) + '<div class="result-copy"><span class="result-title">' + escapeHtml(book.title) + review + '</span><span class="result-meta">' + escapeHtml(book.authors?.join(", ") || book.author) + '</span><span class="result-edition">' + escapeHtml([book.edition, formatLabel(book.formats), book.editionCount > 1 ? book.editionCount + " editions" : ""].filter(Boolean).join(" · ")) + '</span></div>' +
        '<button class="result-action ' + (saved ? "saved" : "") + '" data-save="' + index + '" type="button">' + (saved ? "Saved" : "Save") + "</button></div>";
    }).join("");
    $$(".result").forEach((row) => row.addEventListener("mousemove", () => {
      activeResult = Number(row.dataset.index);
      $$(".result").forEach((candidate, index) => candidate.classList.toggle("active", index === activeResult));
    }));
    $$("[data-save]").forEach((button) => button.addEventListener("click", (event) => {
      event.stopPropagation();
      saveSearchResult(searchResults[Number(button.dataset.save)]);
    }));
  }

  async function saveSearchResult(book) {
    if (!book) return;
    const response = await chrome.runtime.sendMessage({ type: "SAVE_BOOK", book: { ...book, savedAt: new Date().toISOString(), enrichmentState: "pending" } });
    if (!response?.ok) return toast(response?.error || "Couldn’t save this book.");
    savedState = response.savedBooks;
    renderSaved();
    renderSearchResults();
    if (response.duplicate) {
      toast("Already in Saved.");
      return;
    }
    toast("Saved " + response.item.title, {
      label: "Undo",
      action: async () => {
        const undone = await chrome.runtime.sendMessage({ type: "REMOVE_SAVED_BOOK", id: response.item.id });
        savedState = undone.savedBooks;
        renderSaved();
        renderSearchResults();
      }
    });
    enrich(response.item.id);
  }

  async function enrich(id) {
    const response = await chrome.runtime.sendMessage({ type: "ENRICH_SAVED_BOOK", id });
    if (response?.item) {
      const index = savedState.items.findIndex((item) => item.id === id);
      if (index >= 0) savedState.items[index] = response.item;
      renderSaved();
    }
  }

  function showView(view) {
    activeView = view;
    ["search", "batch", "saved", "page"].forEach((name) => $("#" + name + "View").classList.toggle("hidden", name !== view));
    $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
    $("#batchToggle").textContent = view === "batch" ? "Back to search" : "Paste a list";
    if (view === "search") $("#bookSearch").focus();
  }

  async function reviewBatch() {
    const lines = BookSearch.parseMultiline($("#batchInput").value);
    batchRows = [];
    $("#batchResults").innerHTML = "";
    $("#saveBatch").classList.add("hidden");
    if (!lines.length) {
      $("#batchStatus").textContent = "Paste at least one book.";
      return;
    }
    $("#reviewBatch").disabled = true;
    for (let index = 0; index < lines.length; index += 1) {
      $("#batchStatus").textContent = "Matching " + (index + 1) + " of " + lines.length + "…";
      try {
        const response = await chrome.runtime.sendMessage({ type: "SEARCH_BOOKS", query: lines[index].line, limit: 5 });
        const match = response?.results?.[0] || null;
        batchRows.push({ ...lines[index], match, confirmed: Boolean(match && match.confidence !== "review") });
      } catch (error) {
        batchRows.push({ ...lines[index], match: null, confirmed: false, error: error.message });
      }
      renderBatch();
    }
    $("#reviewBatch").disabled = false;
    $("#batchStatus").textContent = "Review every proposed match. Ambiguous matches start unchecked.";
    $("#saveBatch").classList.toggle("hidden", !batchRows.some((row) => row.match));
  }

  function renderBatch() {
    $("#batchResults").innerHTML = batchRows.map((row, index) => {
      if (!row.match) return '<article class="batch-card review"><input type="checkbox" disabled><div><strong>' + escapeHtml(row.line) + '</strong><p class="book-author">' + escapeHtml(row.error || "No confident match. Edit this line and try again.") + "</p></div></article>";
      return '<article class="batch-card ' + (row.match.confidence === "review" ? "review" : "") + '"><input type="checkbox" data-batch="' + index + '" ' + (row.confirmed ? "checked" : "") + ' aria-label="Confirm ' + escapeAttr(row.match.title) + '"><div><strong>' + escapeHtml(row.match.title) + '</strong><p class="book-author">' + escapeHtml(row.match.author) + " · " + escapeHtml(row.match.edition) + (row.match.confidence === "review" ? " · Review required" : "") + "</p></div></article>";
    }).join("");
    $$("[data-batch]").forEach((input) => input.addEventListener("change", () => { batchRows[Number(input.dataset.batch)].confirmed = input.checked; }));
  }

  async function saveBatch() {
    const confirmed = batchRows.filter((row) => row.confirmed && row.match);
    if (!confirmed.length) return toast("Confirm at least one match.");
    $("#saveBatch").disabled = true;
    let saved = 0;
    for (const row of confirmed) {
      const response = await chrome.runtime.sendMessage({ type: "SAVE_BOOK", book: row.match });
      if (response?.ok) {
        savedState = response.savedBooks;
        saved += Number(!response.duplicate);
        if (!response.duplicate) enrich(response.item.id);
      }
    }
    $("#saveBatch").disabled = false;
    renderSaved();
    toast(saved + " book" + (saved === 1 ? "" : "s") + " saved.");
    showView("saved");
  }

  function renderSaved() {
    const filters = Object.fromEntries($$(".filters input").map((input) => [input.dataset.filter, input.checked]));
    const visible = SavedBooks.filterItems(savedState.items, filters);
    const active = savedState.items.filter((item) => !item.removedAt);
    $("#savedCount").textContent = String(active.length);
    $("#savedList").innerHTML = visible.length ? visible.map(savedCard).join("") : '<div class="empty compact"><h2>No saved books here</h2><p>Search above and press Enter to save your first book.</p></div>';
    $$("[data-select-saved]").forEach((input) => input.addEventListener("change", () => {
      if (input.checked) selectedSaved.add(input.dataset.selectSaved); else selectedSaved.delete(input.dataset.selectSaved);
      renderSavedImport();
    }));
    $$("[data-remove]").forEach((button) => button.addEventListener("click", () => removeSaved(button.dataset.remove)));
    $$("[data-restore]").forEach((button) => button.addEventListener("click", () => restoreSaved(button.dataset.restore)));
    $$("[data-refresh]").forEach((button) => button.addEventListener("click", () => enrich(button.dataset.refresh)));
    $$("[data-circulate]").forEach((button) => button.addEventListener("click", () => circulateSaved(button)));
    renderSavedImport();
  }

  function savedCard(book) {
    const results = book.availability || [];
    return '<article class="book-card ' + (book.removedAt ? "removed" : "") + '"><div class="book-main">' +
      '<input class="book-select" type="checkbox" data-select-saved="' + escapeAttr(book.id) + '" ' + (selectedSaved.has(book.id) ? "checked" : "") + " " + (book.removedAt ? "disabled" : "") + ' aria-label="Select ' + escapeAttr(book.title) + '">' +
      cover(book) + '<div class="book-copy"><h3 class="book-title">' + escapeHtml(book.title) + '</h3><p class="book-author">' + escapeHtml(book.author || "Author unknown") + '</p><p class="book-author">' + escapeHtml([book.edition, formatLabel(book.formats)].filter(Boolean).join(" · ")) + "</p>" +
      '<div class="book-links">' + externalLink(book.canonicalUrl || book.sourceUrls?.[0], "Book page") + externalLink(book.selectedLibbyMatch?.libbyUrl, "Open in Libby") + "</div></div></div>" +
      '<div class="availability-list">' + (book.enrichmentState === "pending" ? '<span class="book-author">Checking your libraries…</span>' : availabilityRows(results, book.id)) + "</div>" +
      '<div class="book-actions"><button data-refresh="' + escapeAttr(book.id) + '">Refresh availability</button>' + (book.removedAt ? '<button data-restore="' + escapeAttr(book.id) + '">Restore</button>' : '<button data-remove="' + escapeAttr(book.id) + '">Remove</button>') + "</div></article>";
  }

  function availabilityRows(results, id) {
    if (!results.length) return '<span class="book-author">No library match yet.</span>';
    return results.map((result, index) => {
      const action = result.status === "available" ? "borrow" : result.status === "wait" ? "hold" : "";
      return '<div class="availability ' + escapeAttr(result.status) + '"><i class="dot"></i><span><strong>' + escapeHtml(result.library?.name || result.library?.slug || "Library") + "</strong> · " + escapeHtml(availabilityText(result)) + '</span>' + (action ? '<button class="circulate" data-circulate="' + action + '" data-book="' + escapeAttr(id) + '" data-result="' + index + '">' + (action === "borrow" ? "Borrow" : "Hold") + "</button>" : "") + "</div>";
    }).join("");
  }

  async function removeSaved(id) {
    const response = await chrome.runtime.sendMessage({ type: "REMOVE_SAVED_BOOK", id });
    savedState = response.savedBooks;
    selectedSaved.delete(id);
    renderSaved();
    renderSearchResults();
    toast("Removed from Saved.", { label: "Undo", action: () => restoreSaved(id) });
  }

  async function restoreSaved(id) {
    const response = await chrome.runtime.sendMessage({ type: "RESTORE_SAVED_BOOK", id });
    savedState = response.savedBooks;
    renderSaved();
    renderSearchResults();
    toast("Restored to Saved.");
  }

  async function refreshVisibleSaved() {
    const ids = $$("#savedList [data-refresh]").map((button) => button.dataset.refresh);
    $("#refreshSaved").textContent = "Refreshing…";
    await Promise.all(ids.map(enrich));
    $("#refreshSaved").textContent = "Refresh";
  }

  function renderSavedImport() {
    const count = [...selectedSaved].filter((id) => savedState.items.some((item) => item.id === id && !item.removedAt)).length;
    $("#selectedSavedCount").textContent = String(count);
    $("#savedImport").classList.toggle("hidden", count === 0);
  }

  async function importSaved() {
    const books = savedState.items.filter((item) => selectedSaved.has(item.id) && !item.removedAt);
    const response = await chrome.runtime.sendMessage({ type: "START_IMPORT", books, targetTag: $("#savedImportTag").value.trim() || settings.targetTag, librarySlug: $("#savedImportLibrary").value });
    if (!response?.ok) toast(response?.error || "Couldn’t start tag import.");
  }

  async function circulateSaved(button) {
    const book = savedState.items.find((item) => item.id === button.dataset.book);
    const result = book?.availability?.[Number(button.dataset.result)];
    if (!book || !result) return;
    if (!window.confirm((button.dataset.circulate === "borrow" ? "Borrow " : "Place a hold on ") + book.title + " through " + (result.library?.name || result.library?.slug || "this library") + "?")) return;
    button.disabled = true;
    button.textContent = "Opening…";
    const response = await chrome.runtime.sendMessage({ type: "START_CIRCULATION", action: button.dataset.circulate, book, result });
    if (!response?.ok) {
      button.disabled = false;
      button.textContent = button.dataset.circulate === "borrow" ? "Borrow" : "Hold";
      toast(response?.error || "Couldn’t open Libby.");
    }
  }

  async function scanActivePage() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE" });
      pageBooks = response?.books || [];
      $("#siteLabel").textContent = response?.site || "Search from anywhere";
    } catch (_) {
      pageBooks = [];
    }
    $("#pageCount").textContent = String(pageBooks.length);
    $("#bookCount").textContent = String(pageBooks.length);
    $("#pageEmpty").classList.toggle("hidden", Boolean(pageBooks.length));
    $("#booksSection").classList.toggle("hidden", !pageBooks.length);
    renderPageBooks();
  }

  function renderPageBooks() {
    $("#bookList").innerHTML = pageBooks.map((book, index) => '<article class="book-card" data-index="' + index + '"><div class="book-main"><input class="book-select" type="checkbox" checked aria-label="Include ' + escapeAttr(book.title) + '"><div class="cover-placeholder">L</div><div class="book-copy"><h3 class="book-title">' + escapeHtml(book.title) + '</h3><p class="book-author">' + escapeHtml(book.author || "Author unknown") + '</p></div></div><div class="availability-list" data-key="' + escapeAttr(Shared.bookKey(book)) + '"><span class="book-author">Not checked yet</span></div></article>').join("");
  }

  async function checkAllPage() {
    if (!settings.libraries.length) {
      setSettingsOpen(true);
      return toast("Add your library first.");
    }
    $("#checkAll").textContent = "Checking…";
    const response = await chrome.runtime.sendMessage({ type: "CHECK_BOOKS", books: pageBooks, libraries: settings.libraries });
    (response?.results || []).forEach((entry) => {
      pageAvailability.set(entry.key, entry.libraries || []);
      const container = $$(".availability-list").find((node) => node.dataset.key === entry.key);
      if (container) {
        const book = pageBooks.find((candidate) => Shared.bookKey(candidate) === entry.key);
        container.innerHTML = pageAvailabilityRows(entry.libraries || [], entry.key);
        container.querySelectorAll("[data-page-circulate]").forEach((button) => button.addEventListener("click", () => {
          const result = (pageAvailability.get(entry.key) || [])[Number(button.dataset.result)];
          if (!window.confirm((button.dataset.pageCirculate === "borrow" ? "Borrow " : "Place a hold on ") + book.title + " through " + (result.library?.name || result.library?.slug || "this library") + "?")) return;
          chrome.runtime.sendMessage({ type: "START_CIRCULATION", action: button.dataset.pageCirculate, book, result }).then((reply) => {
            if (!reply?.ok) toast(reply?.error || "Couldn’t open Libby.");
          });
        }));
      }
    });
    const all = [...pageAvailability.values()].flat();
    $("#summary").innerHTML = "<strong>" + all.filter((item) => item.status === "available").length + "</strong> available now · <strong>" + all.filter((item) => item.status === "wait").length + "</strong> with a wait";
    $("#checkAll").textContent = "Check again";
  }

  function importPage() {
    const books = $$("#bookList .book-card").filter((card) => card.querySelector(".book-select").checked).map((card) => pageBooks[Number(card.dataset.index)]);
    chrome.runtime.sendMessage({ type: "START_IMPORT", books, targetTag: $("#importTag").value.trim() || settings.targetTag, librarySlug: $("#importLibrary").value }).then((response) => { if (!response?.ok) toast(response?.error || "Couldn’t start import."); });
  }

  function renderSettings() {
    renderSelectedLibraries();
    $("#targetTag").value = settings.targetTag;
    $("#importTag").value = settings.targetTag;
    $("#savedImportTag").value = settings.targetTag;
    $("#autoCheck").checked = settings.autoCheck !== false;
    renderLibrarySelects();
  }

  function scheduleLibrarySearch() {
    clearTimeout(librarySearchTimer);
    const query = $("#librarySearch").value.trim();
    activeLibraryResult = -1;
    if (query.length < 2) {
      librarySearchResults = [];
      renderLibraryResults();
      setLibraryStatus("Type at least 2 characters to search.");
      return;
    }
    setLibraryStatus("Searching Libby’s directory…");
    librarySearchTimer = setTimeout(() => searchLibraries(query), 220);
  }

  async function searchLibraries(query) {
    const sequence = ++librarySearchSequence;
    try {
      const response = await chrome.runtime.sendMessage({ type: "SEARCH_LIBRARIES", query });
      if (sequence !== librarySearchSequence) return;
      if (!response?.ok) throw new Error(response?.error || "Library search failed.");
      librarySearchResults = response.results || [];
      activeLibraryResult = librarySearchResults.length ? 0 : -1;
      renderLibraryResults();
      setLibraryStatus(librarySearchResults.length
        ? librarySearchResults.length + " " + (librarySearchResults.length === 1 ? "library" : "libraries") + " found."
        : "No libraries found for “" + query + "”. Try a nearby city or use the advanced option.");
    } catch (_) {
      if (sequence !== librarySearchSequence) return;
      librarySearchResults = [];
      renderLibraryResults();
      setLibraryStatus("Library search is unavailable. Check your connection or add a slug manually.");
    }
  }

  function renderLibraryResults() {
    const list = $("#libraryResults");
    list.classList.toggle("hidden", !librarySearchResults.length);
    $("#librarySearch").setAttribute("aria-expanded", String(Boolean(librarySearchResults.length)));
    $("#librarySearch").removeAttribute("aria-activedescendant");
    list.innerHTML = librarySearchResults.map((library, index) => {
      const location = [library.city, library.regionCode || library.region, library.countryCode && library.countryCode !== "US" ? library.countryCode : ""].filter(Boolean).join(", ");
      return '<div id="library-result-' + index + '" class="library-result' + (index === activeLibraryResult ? " active" : "") + '" role="option" aria-selected="' + String(index === activeLibraryResult) + '" data-index="' + index + '" tabindex="-1"><strong>' + escapeHtml(library.name) + (library.isConsortium ? '<span class="consortium-badge">Consortium</span>' : "") + '</strong><span>' + escapeHtml(location || "Location not listed") + '</span><span class="result-domain">' + escapeHtml(library.domain) + "</span></div>";
    }).join("");
    if (activeLibraryResult >= 0) $("#librarySearch").setAttribute("aria-activedescendant", "library-result-" + activeLibraryResult);
    list.querySelectorAll("[role=option]").forEach((option) => {
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => selectLibrary(librarySearchResults[Number(option.dataset.index)]));
    });
  }

  function onLibrarySearchKeydown(event) {
    if (event.key === "Escape") {
      librarySearchResults = [];
      activeLibraryResult = -1;
      renderLibraryResults();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key) || !librarySearchResults.length) return;
    event.preventDefault();
    if (event.key === "Enter") return selectLibrary(librarySearchResults[Math.max(0, activeLibraryResult)]);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    activeLibraryResult = (activeLibraryResult + delta + librarySearchResults.length) % librarySearchResults.length;
    renderLibraryResults();
    document.getElementById("library-result-" + activeLibraryResult)?.scrollIntoView({ block: "nearest" });
  }

  async function selectLibrary(library) {
    if (settings.libraries.some((candidate) => candidate.slug === library.slug)) {
      toast("That library is already added.");
    } else {
      settings.libraries = Directory.addLibrarySelection(settings.libraries, { ...library, source: "directory" });
      await persistSettings();
      await refreshInline();
      renderSelectedLibraries();
      renderLibrarySelects();
      toast(library.name + " added.");
    }
    $("#librarySearch").value = "";
    librarySearchResults = [];
    activeLibraryResult = -1;
    renderLibraryResults();
    setLibraryStatus("Type at least 2 characters to search.");
    $("#librarySearch").focus();
  }

  async function addManualLibrary() {
    const library = Directory.manualLibrary($("#manualName").value, $("#manualSlug").value);
    if (!library) {
      $("#manualError").textContent = "Enter a valid slug or OverDrive URL.";
      return;
    }
    $("#manualError").textContent = "";
    if (settings.libraries.some((candidate) => candidate.slug === library.slug)) {
      toast("That library is already added.");
      return;
    }
    settings.libraries = Directory.addLibrarySelection(settings.libraries, library);
    await persistSettings();
    await refreshInline();
    renderSelectedLibraries();
    renderLibrarySelects();
    $("#manualName").value = "";
    $("#manualSlug").value = "";
    toast(library.name + " added.");
  }

  function renderSelectedLibraries() {
    const container = $("#selectedLibraries");
    $("#selectedCount").textContent = settings.libraries.length + " selected";
    container.innerHTML = settings.libraries.length ? settings.libraries.map((library, index) => '<div class="selected-library"><strong>' + escapeHtml(library.name) + '</strong><small>' + escapeHtml(library.domain || library.slug + ".overdrive.com") + '</small><button data-index="' + index + '" aria-label="Remove ' + escapeAttr(library.name) + '">Remove</button></div>').join("") : '<p class="selected-empty">No libraries selected yet.</p>';
    container.querySelectorAll("button[data-index]").forEach((button) => button.addEventListener("click", async () => {
      settings.libraries.splice(Number(button.dataset.index), 1);
      await persistSettings();
      await refreshInline();
      renderSelectedLibraries();
      renderLibrarySelects();
    }));
  }

  function setLibraryStatus(message) {
    $("#libraryStatus").textContent = message;
  }

  async function persistSettings() {
    settings.targetTag = $("#targetTag").value.trim() || settings.targetTag || "Saved from LibbySave";
    settings.autoCheck = $("#autoCheck").checked;
    settings.settingsVersion = 2;
    await chrome.storage.local.set({ settings });
  }

  async function saveSettings() {
    await persistSettings();
    $("#importTag").value = settings.targetTag;
    $("#savedImportTag").value = settings.targetTag;
    renderLibrarySelects();
    setSettingsOpen(false);
    toast("Settings saved.");
    await refreshInline();
  }

  function setSettingsOpen(open) {
    $("#setup").classList.toggle("hidden", !open);
    $("main").classList.toggle("settings-open", open);
    $("#settingsToggle").setAttribute("aria-expanded", String(open));
    if (open) setTimeout(() => $("#librarySearch").focus(), 0);
  }

  async function refreshInline() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: "REFRESH_INLINE" }).catch(() => {});
  }

  function renderLibrarySelects() {
    const options = settings.libraries.length ? settings.libraries.map((library) => '<option value="' + escapeAttr(library.slug) + '">' + escapeHtml(library.name) + "</option>").join("") : '<option value="">Add a library first</option>';
    $("#importLibrary").innerHTML = options;
    $("#savedImportLibrary").innerHTML = options;
  }

  function availabilityText(result) {
    if (result.status === "available") return (result.format === "audiobook" ? "Audiobook" : "Ebook") + " available now";
    if (result.status === "wait") return (result.format === "audiobook" ? "Audiobook" : "Ebook") + " · " + (result.estimatedWaitDays ? "about " + Math.max(1, Math.ceil(result.estimatedWaitDays / 7)) + " week wait" : (result.holdsCount || "") + " holds");
    if (result.status === "notify") return "Not owned · Notify Me";
    if (result.status === "error") return result.error || "Couldn’t check";
    return "Not owned";
  }

  function pageAvailabilityRows(results, key) {
    if (!results.length) return '<span class="book-author">No library match yet.</span>';
    return results.map((result, index) => {
      const action = result.status === "available" ? "borrow" : result.status === "wait" ? "hold" : "";
      return '<div class="availability ' + escapeAttr(result.status) + '"><i class="dot"></i><span><strong>' + escapeHtml(result.library?.name || result.library?.slug || "Library") + "</strong> · " + escapeHtml(availabilityText(result)) + '</span>' + (action ? '<button data-page-circulate="' + action + '" data-key="' + escapeAttr(key) + '" data-result="' + index + '">' + (action === "borrow" ? "Borrow" : "Hold") + "</button>" : "") + "</div>";
    }).join("");
  }

  function cover(book) {
    return book.coverUrl ? '<img class="cover" src="' + escapeAttr(book.coverUrl) + '" alt="" loading="lazy">' : '<div class="cover-placeholder">L</div>';
  }
  function formatLabel(formats) { return (formats || []).map((value) => value.charAt(0).toUpperCase() + value.slice(1)).join(", "); }
  function externalLink(url, label) { return url ? '<a href="' + escapeAttr(url) + '" target="_blank" rel="noreferrer">' + escapeHtml(label) + "</a>" : ""; }

  function toast(message, undo) {
    clearTimeout(toastTimer);
    const node = $("#toast");
    node.querySelector("span").textContent = message;
    const button = node.querySelector("button");
    button.classList.toggle("hidden", !undo);
    button.textContent = undo?.label || "Undo";
    button.onclick = undo ? async () => { await undo.action(); hideToast(); } : null;
    node.classList.add("show");
    toastTimer = setTimeout(hideToast, undo ? 5000 : 2500);
  }
  function hideToast() { $("#toast").classList.remove("show"); }
  function escapeHtml(value) { const div = document.createElement("div"); div.textContent = String(value || ""); return div.innerHTML; }
  function escapeAttr(value) { return escapeHtml(value).replace(/"/g, "&quot;"); }
})();
