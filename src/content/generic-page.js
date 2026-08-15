(function () {
  "use strict";

  if (globalThis.__libbySaveGenericPageLoaded) return;
  globalThis.__libbySaveGenericPageLoaded = true;

  const Extractor = globalThis.LibbySaveGenericExtractor;
  const pipeline = Extractor.createPipeline();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "GENERIC_SCAN_PAGE") return false;
    scan().then((books) => sendResponse({
      ok: true,
      books: books.map((book) => ({ ...book, source: "Page scan", sourceUrl: location.href })),
      site: document.title || location.hostname,
      provider: "generic"
    })).catch((error) => sendResponse({ ok: false, error: error.message, books: [] }));
    return true;
  });

  async function scan() {
    return pipeline.extract({
      html: document.documentElement?.outerHTML || "",
      selectedText: String(globalThis.getSelection?.() || ""),
      url: location.href
    });
  }
})();
