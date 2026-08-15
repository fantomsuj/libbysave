(function (root, factory) {
  const api = factory(root.LibbySaveShared);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveSpotify = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Shared) {
  "use strict";

  const AUDIOBOOK_SIGNAL = /\baudio\s*book\b/i;
  const NARRATOR_LABEL = /\b(?:narrat(?:ed|or)s?|read)\s+by\b/i;
  const AUTHOR_LABEL = /\b(?:written\s+by|author(?:s)?\s*:?|by)\s+([^\n|•]+?)(?=\s+(?:narrat(?:ed|or)s?|read)\s+by\b|\n|\||•|$)/i;

  function extractRecords(records, page, options) {
    const pageSignal = AUDIOBOOK_SIGNAL.test([
      page?.kind,
      page?.heading,
      page?.description,
      page?.ariaLabel,
      page?.url
    ].filter(Boolean).join(" "));
    const books = [];

    (records || []).forEach((record) => {
      const signalText = [record.kind, record.text, record.ariaLabel, record.subtitle, record.href].filter(Boolean).join(" ");
      if (!AUDIOBOOK_SIGNAL.test(signalText) && !pageSignal && record.kind !== "Audiobook") return;
      const title = Shared.cleanTitle(titleFromLabel(record.title || record.ariaLabel));
      const author = Shared.cleanAuthor(selectAuthor(record));
      if (!title || !author || NARRATOR_LABEL.test(author)) return;
      books.push({
        title,
        author,
        preferredFormat: "audiobook",
        sourceId: record.sourceId || spotifyId(record.href),
        node: record.node || null
      });
    });

    return options?.dedupe === false ? books : Shared.dedupeBooks(books);
  }

  function selectAuthor(record) {
    const explicit = (record.authorCandidates || [])
      .map(cleanAttribution)
      .find(Boolean);
    if (explicit) return explicit;
    const text = String(record.text || "").replace(/\b(?:narrat(?:ed|or)s?|read)\s+by\b[^\n|•]*/ig, "");
    const match = text.match(AUTHOR_LABEL);
    return match ? cleanAttribution(match[0]) : "";
  }

  function cleanAttribution(value) {
    let text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text || NARRATOR_LABEL.test(text) && !AUTHOR_LABEL.test(text)) return "";
    text = text.split(NARRATOR_LABEL)[0];
    text = text
      .replace(/^\s*(?:written\s+by|authors?\s*:?|by)\s+/i, "")
      .replace(/\s+(?:audiobook|unabridged)\s*$/i, "")
      .trim();
    return text;
  }

  function titleFromLabel(value) {
    return String(value || "")
      .replace(/^\s*(?:play|open)\s+/i, "")
      .replace(/\s*[,|•–—-]\s*audiobook.*$/i, "")
      .trim();
  }

  function spotifyId(href) {
    return String(href || "").match(/\/(?:show|audiobook)\/([^/?#]+)/)?.[1] || "";
  }

  function scanDocument(doc, pageUrl) {
    const records = structuredRecords(doc);
    const page = pageRecord(doc, pageUrl);
    const single = singlePageRecord(doc, pageUrl, page);
    if (single) records.unshift(single);

    doc.querySelectorAll("a[href*='/show/'], a[href*='/audiobook/']").forEach((link) => {
      const container = cardContainer(link);
      if (!container) return;
      const titleNode = container.querySelector("h2, h3, [role='heading']") || link;
      const title = titleNode === link
        ? link.getAttribute("aria-label") || link.getAttribute("title") || visibleText(link).split("\n")[0]
        : titleNode.textContent;
      records.push({
        title,
        authorCandidates: cardAuthorCandidates(container, titleNode, title),
        text: visibleText(container),
        ariaLabel: link.getAttribute("aria-label") || "",
        subtitle: container.getAttribute("aria-label") || "",
        href: link.href || link.getAttribute("href"),
        sourceId: spotifyId(link.href || link.getAttribute("href")),
        node: container
      });
    });

    return extractRecords(records, page, { dedupe: false });
  }

  function cardAuthorCandidates(container, titleNode, title) {
    const explicit = [...container.querySelectorAll("[data-testid*='author' i], [aria-label*='author' i]")]
      .map((node) => node.textContent || node.getAttribute("aria-label"));
    const subtitles = [...container.querySelectorAll("p, [data-encore-id='text']")]
      .filter((node) => node !== titleNode && !node.contains?.(titleNode))
      .map(visibleText)
      .filter((value) => {
        const text = String(value || "").trim();
        return text && text.length <= 120 && Shared.normalize(text) !== Shared.normalize(title)
          && !/audiobook|episode|chapter|hour|minute|listener|follower|narrat(?:ed|or)|read by/i.test(text);
      });
    return [...explicit, ...subtitles];
  }

  function singlePageRecord(doc, pageUrl, page) {
    if (!/\/(?:show|audiobook)\//.test(String(pageUrl || ""))) return null;
    const main = doc.querySelector("main") || doc.body;
    const heading = main?.querySelector("h1, [role='heading'][aria-level='1']");
    if (!heading) return null;
    const text = visibleText(main);
    if (!AUDIOBOOK_SIGNAL.test([page.kind, page.description, text].join(" "))) return null;
    return {
      title: heading.textContent,
      text,
      authorCandidates: [...main.querySelectorAll("[data-testid*='author' i], [aria-label*='author' i]")]
        .map((node) => node.textContent || node.getAttribute("aria-label")),
      href: pageUrl,
      kind: "Audiobook",
      node: heading.parentElement || main
    };
  }

  function structuredRecords(doc) {
    const records = [];
    doc.querySelectorAll("script[type='application/ld+json']").forEach((script) => {
      try {
        walkJson(JSON.parse(script.textContent), (item) => {
          if (!item || typeof item !== "object" || !/AudioBook|Book/i.test(String(item["@type"] || ""))) return;
          const authors = Array.isArray(item.author) ? item.author : [item.author];
          records.push({
            kind: String(item["@type"]),
            title: item.name || item.headline,
            authorCandidates: authors.map((author) => author?.name || author).filter(Boolean),
            text: item.description || "",
            href: item.url || "",
            sourceId: spotifyId(item.url)
          });
        });
      } catch (_) {
        // Ignore malformed public metadata.
      }
    });
    return records;
  }

  function pageRecord(doc, url) {
    const meta = (name) => doc.querySelector(`meta[property='${name}'], meta[name='${name}']`)?.content || "";
    return {
      url,
      kind: meta("og:type"),
      heading: doc.querySelector("h1")?.textContent || meta("og:title"),
      description: meta("og:description") || meta("description"),
      ariaLabel: doc.querySelector("main")?.getAttribute("aria-label") || ""
    };
  }

  function cardContainer(link) {
    let node = link;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const text = visibleText(node);
      if (/\baudio\s*book\b|\bwritten\s+by\b|\bnarrated\s+by\b/i.test(text) && text.length < 900) return node;
      if (node.matches?.("article, li, [role='listitem'], [data-testid*='card' i]")) return node;
    }
    return link.parentElement;
  }

  function visibleText(node) {
    return String(node?.innerText || node?.textContent || "").replace(/\s*\n\s*/g, "\n").trim();
  }

  function walkJson(value, visit) {
    if (!value || typeof value !== "object") return;
    visit(value);
    Object.values(value).forEach((child) => {
      if (Array.isArray(child)) child.forEach((item) => walkJson(item, visit));
      else walkJson(child, visit);
    });
  }

  return { cleanAttribution, extractRecords, scanDocument, selectAuthor, spotifyId, titleFromLabel };
});
