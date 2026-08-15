(function () {
  "use strict";

  const Shared = globalThis.LibbySaveShared;
  const State = globalThis.LibbySavePopupState;
  let settings = { libraries: [], targetTag: "Saved from LibbySave", autoCheck: true };
  let pageBooks = [];
  let recent = [];
  let currentBook = null;
  let currentResults = [];

  const $ = (selector) => document.querySelector(selector);
  const setup = $("#setup");
  const startState = $("#startState");
  const resultSection = $("#resultSection");
  const noLibraries = $("#noLibraries");
  const status = $("#status");

  init();

  async function init() {
    const stored = await chrome.storage.local.get(["settings", "recentSearches"]);
    settings = { ...settings, ...(stored.settings || {}) };
    recent = Array.isArray(stored.recentSearches) ? stored.recentSearches : [];
    renderSettings();
    renderRecents();
    bindEvents();
    updateLibraryCount();
    await scanActivePage();
    if (!settings.libraries.length) showNoLibraries(false);
  }

  function bindEvents() {
    $("#settingsToggle").addEventListener("click", toggleSettings);
    $("#openSetup").addEventListener("click", () => showSettings(true));
    $("#addLibrary").addEventListener("click", () => addLibraryRow({ name: "", slug: "" }));
    $("#saveSettings").addEventListener("click", saveSettings);
    $("#searchForm").addEventListener("submit", (event) => {
      event.preventDefault();
      search($("#searchInput").value);
    });
    $("#searchInput").addEventListener("input", (event) => $("#clearSearch").classList.toggle("hidden", !event.target.value));
    $("#clearSearch").addEventListener("click", clearSearch);
    $("#checkAll").addEventListener("click", checkPageBooks);
    $("#importAll").addEventListener("click", importSelected);
    $("#saveBook").addEventListener("click", saveCurrentBook);
  }

  async function scanActivePage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE" });
      pageBooks = response?.books || [];
      $("#siteLabel").textContent = response?.site || "Books → your library";
    } catch (_) {
      pageBooks = [];
    }
    renderPageBooks();
  }

  function toggleSettings() {
    showSettings(setup.classList.contains("hidden"));
  }

  function showSettings(show) {
    setup.classList.toggle("hidden", !show);
    $("#settingsToggle").setAttribute("aria-expanded", String(show));
    $("#settingsToggle").setAttribute("aria-label", show ? "Close settings" : "Open settings");
    if (show) setup.querySelector("input")?.focus();
  }

  function renderSettings() {
    const rows = $("#libraryRows");
    rows.textContent = "";
    (settings.libraries.length ? settings.libraries : [{ name: "", slug: "" }]).forEach(addLibraryRow);
    $("#targetTag").value = settings.targetTag;
    $("#importTag").value = settings.targetTag;
    $("#autoCheck").checked = settings.autoCheck !== false;
    renderLibrarySelect();
  }

  function addLibraryRow(library) {
    const row = document.createElement("div");
    row.className = "library-row";
    const name = input("Library name", "Library name", library.name || "");
    name.dataset.field = "name";
    const slug = input("OverDrive slug", "nypl", library.slug || "");
    slug.dataset.field = "slug";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove library");
    remove.textContent = "×";
    remove.addEventListener("click", () => row.remove());
    row.append(name, slug, remove);
    $("#libraryRows").appendChild(row);
  }

  async function saveSettings() {
    const libraries = [...document.querySelectorAll(".library-row")]
      .map((row) => ({ name: row.querySelector("[data-field='name']").value.trim(), slug: Shared.librarySlug(row.querySelector("[data-field='slug']").value) }))
      .filter((library) => library.slug)
      .map((library) => ({ ...library, name: library.name || library.slug }));
    settings = { libraries, targetTag: $("#targetTag").value.trim() || "Saved from LibbySave", autoCheck: $("#autoCheck").checked };
    await chrome.storage.local.set({ settings });
    $("#importTag").value = settings.targetTag;
    renderLibrarySelect();
    updateLibraryCount();
    showSettings(false);
    toast("Settings saved");
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: "REFRESH_INLINE" });
    } catch (_) { /* The active page may not have a LibbySave content script. */ }
    if (!libraries.length) showNoLibraries(true);
    else if (currentBook) await checkCurrentBook();
    else showStart();
  }

  function renderLibrarySelect() {
    const select = $("#importLibrary");
    select.textContent = "";
    if (!settings.libraries.length) {
      select.add(new Option("Add a library first", ""));
      return;
    }
    settings.libraries.forEach((library) => select.add(new Option(library.name, library.slug)));
  }

  async function search(rawQuery) {
    const parsed = State.parseSearch(rawQuery);
    if (!parsed.query) {
      showStart();
      return;
    }
    if (!settings.libraries.length) {
      showNoLibraries(true);
      return;
    }
    currentBook = { title: parsed.title, author: parsed.author, isbn: parsed.isbn, source: "Popup search", sourceUrl: "" };
    recent = State.recentSearches(recent, parsed.query, 5);
    await chrome.storage.local.set({ recentSearches: recent });
    renderRecents();
    await checkCurrentBook();
  }

  async function checkCurrentBook() {
    showResultLoading();
    try {
      const response = await chrome.runtime.sendMessage({ type: "CHECK_BOOK", book: currentBook, libraries: settings.libraries });
      if (!response?.ok) throw new Error(response?.error || "Libby did not respond.");
      currentResults = response.results || [];
      const usable = currentResults.filter((item) => item?.status !== "error");
      if (!usable.length && currentResults.some((item) => item?.status === "error")) {
        showError(currentResults.find((item) => item?.error)?.error || "Couldn’t reach Libby. Try again.");
        return;
      }
      if (!usable.some((item) => item?.title)) {
        showNoResults();
        return;
      }
      renderResult();
    } catch (error) {
      showError(error.message || "Couldn’t reach Libby. Try again.");
    }
  }

  function showResultLoading() {
    startState.classList.add("hidden");
    noLibraries.classList.add("hidden");
    resultSection.classList.remove("hidden");
    setStatus("Checking your libraries…", "loading");
    $("#bookResult").innerHTML = `<div class="cover-shell"><span class="cover-fallback">BOOK</span></div><div class="result-copy"><span class="match-pill neutral">Searching</span><h1>${escapeHtml(currentBook.title)}</h1><p class="author">${escapeHtml(currentBook.author || "Finding the best match…")}</p></div>`;
    $("#availabilityList").innerHTML = settings.libraries.map(() => `<div class="availability-skeleton" aria-hidden="true"></div>`).join("");
    $("#saveBook").classList.add("hidden");
  }

  function renderResult() {
    hideStatus();
    const best = State.bestResult(currentResults);
    const displayBook = best ? { ...currentBook, title: best.title || currentBook.title, author: best.author || currentBook.author } : currentBook;
    const match = State.matchTone(best);
    const card = $("#bookResult");
    card.textContent = "";
    const cover = document.createElement("div");
    cover.className = "cover-shell";
    if (best?.coverUrl) {
      const image = document.createElement("img");
      image.src = best.coverUrl;
      image.alt = `Cover of ${displayBook.title}`;
      image.width = 76;
      image.height = 114;
      image.addEventListener("error", () => { cover.textContent = ""; cover.append(fallbackCover()); });
      cover.append(image);
    } else cover.append(fallbackCover());
    const copy = document.createElement("div");
    copy.className = "result-copy";
    const pill = document.createElement("span");
    pill.className = `match-pill ${match.tone}`;
    pill.textContent = match.label;
    const title = document.createElement("h1");
    title.textContent = displayBook.title;
    const author = document.createElement("p");
    author.className = "author";
    author.textContent = displayBook.author || "Author unknown";
    const format = document.createElement("div");
    format.className = "format";
    format.textContent = best ? formatName(best.format) : "Format unavailable";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit-match";
    edit.textContent = "Edit search or choose another match";
    edit.addEventListener("click", () => { $("#searchInput").focus(); $("#searchInput").select(); });
    copy.append(pill, title, author, format, edit);
    const matches = uniqueMatches(currentResults);
    if (matches.length > 1) {
      const label = document.createElement("label");
      label.className = "field match-select";
      const caption = document.createElement("span");
      caption.textContent = "Choose a different match";
      const select = document.createElement("select");
      matches.forEach((match) => select.add(new Option(`${match.title} — ${match.author || "Author unknown"}`, `${match.title}\u0000${match.author || ""}`, false, match.title === displayBook.title && match.author === displayBook.author)));
      select.addEventListener("change", async () => {
        const [selectedTitle, selectedAuthor] = select.value.split("\u0000");
        currentBook = { ...currentBook, title: selectedTitle, author: selectedAuthor };
        await checkCurrentBook();
      });
      label.append(caption, select);
      copy.append(label);
    }
    currentBook = displayBook;
    card.append(cover, copy);
    renderAvailability();
    const save = $("#saveBook");
    save.textContent = `Save to ${settings.targetTag}`;
    save.classList.remove("hidden");
  }

  function renderAvailability() {
    const list = $("#availabilityList");
    list.textContent = "";
    settings.libraries.forEach((library, index) => {
      const result = currentResults.find((item) => item?.library?.slug === library.slug) || currentResults[index] || { library, status: "error", error: "No response" };
      const view = State.availabilityView(result);
      const card = document.createElement("article");
      card.className = `library-card ${view.tone}`;
      const copy = document.createElement("div");
      const name = document.createElement("h3");
      name.textContent = library.name;
      const availability = document.createElement("div");
      availability.className = "availability-status";
      const label = document.createElement("strong");
      label.textContent = view.label;
      availability.append(label, document.createTextNode(view.detail));
      copy.append(name, availability);
      card.append(copy);
      if (view.action) {
        const action = document.createElement("button");
        action.type = "button";
        action.className = `button ${view.action === "borrow" ? "primary" : "secondary"}`;
        action.textContent = view.actionLabel;
        action.addEventListener("click", () => confirmCirculation(view, result, action));
        card.append(action);
      }
      list.append(card);
    });
    $("#libraryCount").textContent = `${settings.libraries.length} connected`;
  }

  async function confirmCirculation(view, result, button) {
    const library = result.library?.name || result.library?.slug || "this library";
    const verb = view.action === "borrow" ? "borrow" : "place a hold on";
    const confirmed = await confirmAction(`${view.actionLabel} this title?`, `LibbySave will open Libby and ${verb} “${currentBook.title}” at ${library}. This authorization applies only to this title, library, media record, and action.`);
    if (!confirmed) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "Opening Libby…";
    const response = await chrome.runtime.sendMessage({ type: "START_CIRCULATION", action: view.action, book: currentBook, result });
    if (!response?.ok) {
      button.disabled = false;
      button.textContent = original;
      toast(response?.error || "Couldn’t open Libby");
    }
  }

  function confirmAction(title, copy) {
    const dialog = $("#confirmDialog");
    $("#confirmTitle").textContent = title;
    $("#confirmCopy").textContent = copy;
    $("#confirmAction").textContent = title.replace(" this title?", "");
    dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
  }

  async function saveCurrentBook() {
    const library = settings.libraries[0];
    if (!currentBook || !library) return;
    const button = $("#saveBook");
    button.disabled = true;
    button.textContent = "Opening Libby…";
    const response = await chrome.runtime.sendMessage({ type: "START_IMPORT", books: [currentBook], targetTag: settings.targetTag, librarySlug: library.slug });
    if (!response?.ok) {
      button.disabled = false;
      button.textContent = `Save to ${settings.targetTag}`;
      toast(response?.error || "Couldn’t start save");
    }
  }

  function renderRecents() {
    const section = $("#recentSection");
    const list = $("#recentSearches");
    list.textContent = "";
    section.classList.toggle("hidden", !recent.length);
    recent.forEach((query) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recent-chip";
      button.textContent = query;
      button.addEventListener("click", () => { $("#searchInput").value = query; $("#clearSearch").classList.remove("hidden"); search(query); });
      list.append(button);
    });
  }

  function renderPageBooks() {
    const section = $("#pageSection");
    const empty = $("#empty");
    const list = $("#pageBooks");
    list.textContent = "";
    section.classList.toggle("hidden", !pageBooks.length);
    empty.classList.toggle("hidden", Boolean(pageBooks.length || recent.length));
    pageBooks.forEach((book, index) => {
      const row = document.createElement("div");
      row.className = "page-book";
      const select = document.createElement("input");
      select.type = "checkbox";
      select.checked = true;
      select.setAttribute("aria-label", `Include ${book.title}`);
      select.dataset.index = String(index);
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = book.title;
      const author = document.createElement("small");
      author.textContent = book.author || "Author unknown";
      copy.append(title, author);
      const check = document.createElement("button");
      check.type = "button";
      check.textContent = "Check";
      check.addEventListener("click", () => {
        $("#searchInput").value = [book.title, book.author ? `by ${book.author}` : ""].filter(Boolean).join(" ");
        $("#clearSearch").classList.remove("hidden");
        currentBook = book;
        checkCurrentBook();
      });
      row.append(select, copy, check);
      list.append(row);
    });
  }

  async function checkPageBooks() {
    if (!settings.libraries.length) { showNoLibraries(true); return; }
    const button = $("#checkAll");
    button.disabled = true;
    button.textContent = "Checking…";
    const response = await chrome.runtime.sendMessage({ type: "CHECK_BOOKS", books: pageBooks, libraries: settings.libraries });
    (response?.results || []).forEach((entry, index) => {
      const best = State.bestResult(entry.libraries || []);
      const rowButton = $("#pageBooks").children[index]?.querySelector("button");
      if (!rowButton) return;
      rowButton.textContent = best?.status === "available" ? "Available" : best?.status === "wait" ? State.availabilityView(best).label : "View";
    });
    button.disabled = false;
    button.textContent = "Check again";
  }

  async function importSelected() {
    const selected = [...document.querySelectorAll("#pageBooks input:checked")].map((box) => pageBooks[Number(box.dataset.index)]);
    const response = await chrome.runtime.sendMessage({ type: "START_IMPORT", books: selected, targetTag: $("#importTag").value.trim() || settings.targetTag, librarySlug: $("#importLibrary").value });
    if (!response?.ok) toast(response?.error || "Couldn’t start save");
  }

  function showStart() {
    currentBook = null;
    currentResults = [];
    hideStatus();
    resultSection.classList.add("hidden");
    noLibraries.classList.add("hidden");
    startState.classList.remove("hidden");
    renderPageBooks();
  }

  function clearSearch() {
    $("#searchInput").value = "";
    $("#clearSearch").classList.add("hidden");
    showStart();
    $("#searchInput").focus();
  }

  function showNoLibraries(openSettings) {
    startState.classList.add("hidden");
    resultSection.classList.add("hidden");
    noLibraries.classList.remove("hidden");
    hideStatus();
    if (openSettings) showSettings(true);
  }

  function showNoResults() {
    resultSection.classList.add("hidden");
    startState.classList.remove("hidden");
    setStatus(`No results for “${currentBook.title}.” Try adding the author or checking the ISBN.`, "error");
  }

  function showError(message) {
    resultSection.classList.add("hidden");
    startState.classList.remove("hidden");
    setStatus(message, "error");
  }

  function setStatus(message, tone) {
    status.textContent = message;
    status.className = `status-banner ${tone || ""}`.trim();
  }

  function hideStatus() {
    status.textContent = "";
    status.className = "status-banner hidden";
  }

  function updateLibraryCount() {
    const count = settings.libraries.length;
    $("#footerCount").textContent = `${count} ${count === 1 ? "library" : "libraries"} connected`;
  }

  function fallbackCover() {
    const fallback = document.createElement("span");
    fallback.className = "cover-fallback";
    fallback.textContent = "NO COVER";
    return fallback;
  }

  function formatName(value) {
    return /audio/i.test(value || "") ? "Audiobook" : "Ebook";
  }

  function uniqueMatches(results) {
    const seen = new Set();
    return (results || []).filter((result) => {
      if (!result?.title) return false;
      const key = `${result.title}\u0000${result.author || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function input(label, placeholder, value) {
    const node = document.createElement("input");
    node.setAttribute("aria-label", label);
    node.placeholder = placeholder;
    node.value = value;
    node.autocomplete = "off";
    return node;
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    setTimeout(() => node.classList.remove("show"), 2400);
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value || "");
    return div.innerHTML;
  }
})();
