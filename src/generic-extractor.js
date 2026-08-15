(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveGenericExtractor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PLATFORM_HOSTS = /(?:goodreads\.com|amazon\.[a-z.]+|audible\.[a-z.]+|bookshop\.org|books\.google\.|openlibrary\.org|worldcat\.org|barnesandnoble\.com|storygraph\.com|libro\.fm|kobo\.com|open\.spotify\.com)/i;
  const FALSE_TITLES = /^(?:read more|learn more|sign up|log in|home|books?|recommendations?|related posts?|share|comments?|subscribe|privacy policy|terms)$/i;

  function normalize(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase();
  }

  function decode(value) {
    return String(value || "")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  }

  function text(value) {
    return decode(String(value || "").replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  }

  function attrs(tag) {
    const output = {};
    for (const match of String(tag || "").matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      output[match[1].toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? "");
    }
    return output;
  }

  function authorName(value) {
    if (Array.isArray(value)) return value.map(authorName).filter(Boolean).join(", ");
    if (value && typeof value === "object") return value.name || value["@id"] || "";
    return String(value || "").replace(/^\s*by\s+/i, "").trim();
  }

  function validIsbn(value) {
    const digits = String(value || "").replace(/[^0-9X]/gi, "").toUpperCase();
    if (digits.length === 10) {
      const sum = [...digits].reduce((total, char, index) => total + (char === "X" ? 10 : Number(char)) * (10 - index), 0);
      return sum % 11 === 0 ? digits : "";
    }
    if (digits.length === 13) {
      const sum = [...digits].slice(0, 12).reduce((total, char, index) => total + Number(char) * (index % 2 ? 3 : 1), 0);
      return (10 - (sum % 10)) % 10 === Number(digits[12]) ? digits : "";
    }
    return "";
  }

  function candidate(title, author, confidence, evidence, extra) {
    title = text(title).replace(/^['“”]|['“”]$/g, "").trim();
    author = text(author).replace(/^by\s+/i, "").replace(/[.,;:]+$/, "").trim();
    if (!plausibleTitle(title)) return null;
    if (author && (!/\p{L}/u.test(author) || author.length > 120 || /^https?:/i.test(author))) author = "";
    return { title, author, confidence, evidence: [evidence], ...(extra || {}) };
  }

  function plausibleTitle(title) {
    if (!title || title.length < 2 || title.length > 180 || FALSE_TITLES.test(title)) return false;
    const words = title.split(/\s+/);
    return words.length <= 24 && /\p{L}/u.test(title) && !/^https?:/i.test(title);
  }

  function walk(value, visit) {
    if (!value || typeof value !== "object") return;
    visit(value);
    Object.values(value).forEach((child) => {
      if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
      else if (child && typeof child === "object") walk(child, visit);
    });
  }

  function fromJsonLd(input) {
    const output = [];
    for (const match of input.html.matchAll(/<script\b([^>]*)type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        walk(JSON.parse(match[2]), (item) => {
          const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
          if (!types.some((type) => /^(?:book|audiobook)$/i.test(String(type || "")))) return;
          const isbn = validIsbn(item.isbn || item.productID || "");
          const found = candidate(item.name || item.headline, authorName(item.author || item.creator), 0.98, "schema.org Book", isbn ? { isbn } : null);
          if (found) output.push(found);
        });
      } catch (_) {
        // Invalid publisher JSON-LD is ignored locally.
      }
    }
    return output;
  }

  function collectMeta(html) {
    const meta = {};
    for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
      const values = attrs(match[0]);
      const key = String(values.property || values.name || values.itemprop || "").toLowerCase();
      if (key && values.content) meta[key] = values.content;
    }
    return meta;
  }

  function fromMetadata(input) {
    const meta = collectMeta(input.html);
    const output = [];
    const isbn = validIsbn(meta["book:isbn"] || meta.isbn || meta["product:isbn"] || "");
    const isBook = /book|audiobook/i.test(meta["og:type"] || "") || Boolean(meta["book:title"] || isbn);
    if (isBook) {
      const found = candidate(meta["book:title"] || meta["og:title"] || meta.title, meta["book:author"] || meta.author || meta["article:author"], 0.9, isbn ? "book metadata + ISBN" : "Open Graph book metadata", isbn ? { isbn } : null);
      if (found) output.push(found);
      else if (isbn) output.push({ title: `ISBN ${isbn}`, author: "", isbn, confidence: 0.78, evidence: ["ISBN metadata"] });
    }
    for (const match of input.html.matchAll(/\bISBN(?:-1[03])?\s*[:#]?\s*((?:97[89][\s-]?)?\d(?:[\s-]?\d){8,11}[\s-]?[\dX])\b/gi)) {
      const value = validIsbn(match[1]);
      if (value && !output.some((book) => book.isbn === value)) output.push({ title: `ISBN ${value}`, author: "", isbn: value, confidence: 0.72, evidence: ["ISBN"] });
    }
    return output;
  }

  function titleAndAuthor(fragment) {
    const titleMatch = fragment.match(/<(?:h[1-6]|strong|b|[a-z]+\b[^>]*(?:itemprop=["']name["']|class=["'][^"']*(?:title|book-name)[^"']*["']))[^>]*>([\s\S]*?)<\//i);
    const body = text(fragment);
    const byline = body.match(/\bby\s+([\p{Lu}][\p{L}.'’-]+(?:\s+(?:[\p{Lu}][\p{L}.'’-]+|and|&)){1,5})/u);
    return { title: titleMatch ? text(titleMatch[1]) : "", author: byline?.[1] || "" };
  }

  function fromRepeatedCards(input) {
    const output = [];
    const fragments = [];
    for (const match of input.html.matchAll(/<(article|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) fragments.push(match[0]);
    for (const fragment of fragments.slice(0, 300)) {
      const pair = titleAndAuthor(fragment);
      const found = candidate(pair.title, pair.author, pair.author ? 0.78 : 0.58, "repeated title-and-author card");
      if (found && pair.author) output.push(found);
    }
    return output;
  }

  function fromPlatformLinks(input) {
    const output = [];
    for (const match of input.html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const values = attrs(match[1]);
      if (!values.href || !PLATFORM_HOSTS.test(values.href)) continue;
      let title = text(match[2]);
      if (!plausibleTitle(title) || title.split(/\s+/).length < 2) {
        const slug = values.href.match(/\/(?:book\/show\/\d+[-.]?|dp\/|product\/|books\/)([^/?#]+)/i)?.[1] || "";
        title = decodeURIComponent(slug).replace(/[-_]+/g, " ");
      }
      const found = candidate(title, "", 0.55, "recognized book-platform link", { sourceUrl: values.href });
      if (found) output.push(found);
    }
    return output;
  }

  function strongTitle(line) {
    const match = line.match(/<(?:strong|b|em|cite)[^>]*>([\s\S]*?)<\/(?:strong|b|em|cite)>\s*(?:[-–—,:]\s*)?by\s+([^<\n]{3,100})/i);
    return match ? { title: text(match[1]), author: text(match[2]) } : null;
  }

  function plausibleProsePair(title, author) {
    const words = title.trim().split(/\s+/);
    if (words.length < 1 || words.length > 14 || /^(?:this|that|it|read|review|written|recommended|edited|foreword)$/i.test(words[0])) return false;
    const capitalized = words.filter((word) => /^(?:[A-Z0-9“'\[]|a$|an$|and$|at$|for$|in$|of$|on$|the$|to$|with$)/.test(word)).length;
    return capitalized / words.length >= 0.75 && /^[\p{Lu}][\p{L}.'’-]+(?:\s+(?:[\p{Lu}][\p{L}.'’-]+|and|&)){1,5}$/u.test(author.trim());
  }

  function fromProse(input) {
    const output = [];
    const htmlLines = input.html.replace(/<\/(?:p|li|h[1-6]|div)>/gi, "$&\n").split(/\n/).slice(0, 3000);
    for (const line of htmlLines) {
      const emphasized = strongTitle(line);
      if (emphasized) {
        const found = candidate(emphasized.title, emphasized.author, 0.72, "emphasized ‘Title by Author’ prose");
        if (found) output.push(found);
        continue;
      }
      const plain = text(line);
      const match = plain.match(/(?:^|[•\d.)]\s+)([“\p{Lu}][^.!?;:\n]{1,140}?)\s+by\s+([\p{Lu}][\p{L}.'’-]+(?:\s+(?:[\p{Lu}][\p{L}.'’-]+|and|&)){1,5})(?=$|[.,;])/u);
      if (match && plausibleProsePair(match[1], match[2])) {
        const found = candidate(match[1], match[2], 0.62, "‘Title by Author’ prose");
        if (found) output.push(found);
      }
    }
    return output;
  }

  function fromSelection(input) {
    if (!input.selectedText) return [];
    const output = [];
    for (const line of String(input.selectedText).split(/[\n\r]+/).slice(0, 200)) {
      const match = line.trim().match(/^(?:[-*•\d.)]\s*)?[“"]?(.{2,140}?)[”"]?\s+(?:[-–—,:]\s*)?by\s+(.{3,100})$/i);
      if (!match || !plausibleProsePair(match[1], match[2])) continue;
      const found = candidate(match[1], match[2], 0.76, "selected text");
      if (found) output.push(found);
    }
    return output;
  }

  const deterministicProviders = [
    { id: "json-ld", extract: fromJsonLd },
    { id: "metadata", extract: fromMetadata },
    { id: "cards", extract: fromRepeatedCards },
    { id: "platform-links", extract: fromPlatformLinks },
    { id: "selection", extract: fromSelection },
    { id: "prose", extract: fromProse }
  ];

  function merge(books) {
    const output = [];
    for (const book of books.filter(Boolean).sort((a, b) => b.confidence - a.confidence)) {
      const titleKey = normalize(book.title.replace(/^ISBN\s+/i, ""));
      const existing = output.find((item) => {
        if (book.isbn && item.isbn === book.isbn) return true;
        if (normalize(item.title.replace(/^ISBN\s+/i, "")) !== titleKey) return false;
        return !item.author || !book.author || normalize(item.author) === normalize(book.author);
      });
      if (!existing) output.push({ ...book, selected: book.confidence >= 0.6 });
      else {
        existing.evidence = [...new Set([...existing.evidence, ...book.evidence])];
        existing.confidence = Math.max(existing.confidence, book.confidence);
        if (!existing.author && book.author) existing.author = book.author;
        if (!existing.isbn && book.isbn) existing.isbn = book.isbn;
      }
    }
    return output.slice(0, 100);
  }

  function createPipeline(options) {
    const fallbackProvider = options?.fallbackProvider || null;
    return {
      async extract(input) {
        const safeInput = { html: String(input?.html || "").slice(0, 1500000), selectedText: String(input?.selectedText || "").slice(0, 50000), url: String(input?.url || "") };
        const deterministic = merge(deterministicProviders.flatMap((provider) => provider.extract(safeInput)));
        if (deterministic.length || !fallbackProvider) return deterministic;
        return merge(await fallbackProvider.extract(safeInput));
      }
    };
  }

  return { createPipeline, deterministicProviders, validIsbn, merge };
});
