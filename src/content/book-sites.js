(function () {
  "use strict";

  const Shared = globalThis.LibbySaveShared;
  const nodeByKey = new Map();
  let books = [];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SCAN_PAGE") {
      books = scanPage();
      sendResponse({ ok: true, books: books.map(serializableBook), site: siteName() });
    }
    if (message?.type === "REFRESH_INLINE") {
      books = scanPage();
      void renderInline(books);
      sendResponse({ ok: true, count: books.length });
    }
  });

  init();

  async function init() {
    books = scanPage();
    const { settings } = await chrome.storage.local.get("settings");
    if (settings?.autoCheck && settings.libraries?.length && books.length) {
      await renderInline(books.slice(0, 30));
    }
  }

  function siteName() {
    if (location.hostname.includes("goodreads")) return "Goodreads";
    if (location.hostname.includes("nytimes")) return "The New York Times";
    return location.hostname;
  }

  function scanPage() {
    nodeByKey.clear();
    const found = location.hostname.includes("goodreads") ? scanGoodreads() : scanNyt();
    const clean = Shared.dedupeBooks(found.map((entry) => ({
      ...entry,
      title: Shared.cleanTitle(entry.title),
      author: Shared.cleanAuthor(entry.author),
      source: siteName(),
      sourceUrl: location.href
    })));
    clean.forEach((book) => {
      const original = found.find((candidate) => Shared.bookKey(candidate) === Shared.bookKey(book));
      if (original?.node) nodeByKey.set(Shared.bookKey(book), original.node);
    });
    return clean;
  }

  function scanGoodreads() {
    const output = [];
    const singleTitle = document.querySelector("h1.Text__title1, h1[data-testid='bookTitle'], h1#bookTitle");
    if (singleTitle) {
      const author = document.querySelector(".ContributorLink__name, [data-testid='name'], a.authorName span, [itemprop='author']")?.textContent;
      output.push({ title: singleTitle.textContent, author, node: singleTitle.parentElement });
    }

    document.querySelectorAll(".responsiveBook, tr.bookalike, table.tableList tr, [data-testid='bookListItem']").forEach((row) => {
      const titleNode = row.querySelector("a.gr-h3, a.bookTitle, [data-testid='bookTitle'], a[href*='/book/show/']");
      const authorNode = row.querySelector("[itemprop='author'], a.authorName, .ContributorLink__name, [data-testid='name']");
      if (titleNode) output.push({ title: titleNode.textContent, author: authorNode?.textContent, node: row });
    });
    return output;
  }

  function scanNyt() {
    const output = [];
    const candidates = document.querySelectorAll("article, main li, [data-testid*='book'], [class*='Book']");
    candidates.forEach((container) => {
      const titleNode = container.querySelector("h2, h3, [itemprop='name']");
      if (!titleNode) return;
      const title = titleNode.textContent?.trim();
      if (!title || title.length < 2 || title.length > 160) return;
      const explicit = container.querySelector("[itemprop='author'], [class*='author'], [class*='Author']")?.textContent;
      const byline = container.textContent?.match(/(?:^|\s)by\s+([^\n|•]+?)(?=\s{2,}|Publisher|$)/i)?.[1];
      const author = explicit || byline;
      if (!author || author.length > 120) return;
      output.push({ title, author, node: container });
    });

    document.querySelectorAll("script[type='application/ld+json']").forEach((script) => {
      try {
        const data = JSON.parse(script.textContent);
        walkJson(data, (item) => {
          if (!item || typeof item !== "object") return;
          if (!/Book/i.test(String(item["@type"] || ""))) return;
          const author = Array.isArray(item.author) ? item.author[0]?.name : item.author?.name || item.author;
          if (item.name) output.push({ title: item.name, author, node: document.querySelector("main") });
        });
      } catch (_) {
        // Ignore malformed publisher metadata.
      }
    });
    return output;
  }

  function walkJson(value, visit) {
    if (!value || typeof value !== "object") return;
    visit(value);
    Object.values(value).forEach((child) => {
      if (Array.isArray(child)) child.forEach((item) => walkJson(item, visit));
      else walkJson(child, visit);
    });
  }

  async function renderInline(targetBooks) {
    for (const book of targetBooks) {
      const key = Shared.bookKey(book);
      const node = nodeByKey.get(key);
      if (!node || node.querySelector?.(`[data-libbysave-key="${cssEscape(key)}"]`)) continue;
      const badge = document.createElement("div");
      badge.className = "libbysave-inline libbysave-loading";
      badge.dataset.libbysaveKey = key;
      badge.innerHTML = `<span class="libbysave-mark">L</span><span>Checking Libby…</span>`;
      node.appendChild(badge);
      const response = await chrome.runtime.sendMessage({ type: "CHECK_BOOK", book: serializableBook(book) });
      updateBadge(badge, response?.results || []);
    }
  }

  function updateBadge(badge, results) {
    const ranked = [...results].sort((a, b) => statusRank(a.status) - statusRank(b.status));
    const best = ranked[0];
    badge.classList.remove("libbysave-loading");
    if (!best || best.status === "error") {
      badge.classList.add("libbysave-muted");
      badge.innerHTML = `<span class="libbysave-mark">L</span><span>Couldn’t check Libby</span>`;
      return;
    }
    const label = availabilityLabel(best);
    const url = best.libbyUrl || best.searchUrl;
    badge.classList.add(`libbysave-${best.status}`);
    const action = best.status === "available" ? "borrow" : best.status === "wait" ? "hold" : "";
    badge.innerHTML = `<span class="libbysave-mark">L</span><a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>${action ? `<button type="button">${action === "borrow" ? "Borrow" : "Hold"}</button>` : ""}`;
    badge.querySelector("button")?.addEventListener("click", async () => {
      const book = books.find((candidate) => Shared.bookKey(candidate) === badge.dataset.libbysaveKey);
      await chrome.runtime.sendMessage({ type: "START_CIRCULATION", action, book: serializableBook(book), result: best });
    });
  }

  function availabilityLabel(result) {
    const library = result.library?.name || result.library?.slug || "your library";
    if (result.status === "available") return `${result.format === "audiobook" ? "Audiobook" : "Ebook"} available now · ${library}`;
    if (result.status === "wait") {
      const wait = result.estimatedWaitDays ? `~${Math.max(1, Math.ceil(result.estimatedWaitDays / 7))} week wait` : "Wait list";
      return `${wait} · ${library}`;
    }
    if (result.status === "notify") return `Notify Me · ${library}`;
    return `Not found · ${library}`;
  }

  function statusRank(status) {
    return ({ available: 0, wait: 1, notify: 2, "not-found": 3, error: 4 })[status] ?? 5;
  }

  function serializableBook(book) {
    return { title: book.title, author: book.author || "", source: book.source, sourceUrl: book.sourceUrl };
  }

  function cssEscape(value) {
    return CSS.escape(value);
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value || "");
    return div.innerHTML;
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }
})();
