(function (root, factory) {
  const api = factory(root.LibbySaveShared);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveBookSearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Shared) {
  "use strict";

  const SEARCH_ENDPOINT = "https://openlibrary.org/search.json";
  const RECOGNIZED_HOSTS = [
    "goodreads.com", "www.goodreads.com", "app.thestorygraph.com", "thestorygraph.com",
    "open.spotify.com", "amazon.com", "www.amazon.com", "bookshop.org", "www.bookshop.org",
    "openlibrary.org", "books.google.com"
  ];
  const STOP_SEGMENTS = new Set(["book", "books", "show", "product", "dp", "gp", "audiobook", "title"]);

  class ProviderError extends Error {
    constructor(message, code, retryAfter) {
      super(message);
      this.name = "ProviderError";
      this.code = code || "provider-error";
      this.retryAfter = retryAfter || null;
    }
  }

  class OpenLibraryProvider {
    constructor(options) {
      this.fetchImpl = options?.fetchImpl || globalThis.fetch;
      this.endpoint = options?.endpoint || SEARCH_ENDPOINT;
    }

    async search(rawInput, options) {
      const parsed = parseInput(rawInput);
      if (!parsed.query && !parsed.isbn) return [];
      if (options?.offline) throw new ProviderError("You appear to be offline.", "offline");
      const params = new URLSearchParams({
        limit: String(Math.min(Math.max(options?.limit || 12, 1), 20)),
        lang: options?.language || "en",
        fields: [
          "key", "title", "subtitle", "author_name", "cover_i", "isbn", "edition_key",
          "edition_count", "first_publish_year", "publisher", "language", "format"
        ].join(",")
      });
      if (parsed.isbn) params.set("isbn", parsed.isbn);
      else if (parsed.authorOnly) params.set("author", parsed.author);
      else {
        params.set("q", parsed.query);
        if (parsed.title && parsed.author) {
          params.set("title", parsed.title);
          params.set("author", parsed.author);
        }
      }
      let response;
      try {
        response = await this.fetchImpl(`${this.endpoint}?${params}`, {
          signal: options?.signal,
          headers: { Accept: "application/json" }
        });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new ProviderError("Book search is unavailable while offline.", "offline");
      }
      if (response.status === 429) {
        throw new ProviderError("Open Library is rate limiting searches. Try again shortly.", "rate-limited", response.headers?.get?.("retry-after"));
      }
      if (!response.ok) throw new ProviderError(`Book search returned ${response.status}.`, "provider-error");
      const payload = await response.json();
      return rankCandidates((payload.docs || []).map((doc) => normalizeDocument(doc, parsed)), parsed).slice(0, options?.limit || 12);
    }
  }

  function parseInput(rawInput) {
    const raw = String(rawInput || "").trim();
    const compact = raw.replace(/[\s-]/g, "");
    const isbn = validIsbn(compact) ? compact.toUpperCase() : extractIsbn(raw);
    if (isbn) return { raw, isbn, query: isbn, title: "", author: "", kind: "isbn", confidence: "high" };

    const url = parseBookUrl(raw);
    if (url) {
      return {
        raw, sourceUrl: raw, recognizedUrl: true, hostname: url.hostname,
        isbn: url.isbn || "", query: url.isbn || url.query, title: url.title || "", author: url.author || "",
        kind: "url", confidence: url.isbn ? "high" : url.query ? "medium" : "review"
      };
    }

    const byMatch = raw.match(/^(.+?)\s+(?:by|—|–|\|)\s+(.+)$/i);
    if (byMatch) {
      return { raw, query: raw, title: byMatch[1].trim(), author: byMatch[2].trim(), kind: "title-author", confidence: "high" };
    }
    const words = raw.split(/\s+/).filter(Boolean);
    return {
      raw, query: raw, title: raw, author: "", authorOnly: false,
      kind: words.length <= 3 ? "general" : "title", confidence: "medium"
    };
  }

  function parseBookUrl(value) {
    if (!/^https?:\/\//i.test(String(value || "").trim())) return null;
    let url;
    try { url = new URL(value); } catch (_) { return null; }
    const hostname = url.hostname.toLowerCase();
    if (!RECOGNIZED_HOSTS.includes(hostname) && !hostname.endsWith(".amazon.com")) return null;
    const isbn = extractIsbn(`${url.pathname} ${url.search}`);
    if (isbn) return { hostname, isbn, query: isbn };

    const segments = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    const usable = segments
      .filter((segment) => !STOP_SEGMENTS.has(segment.toLowerCase()))
      .filter((segment) => !/^[a-f0-9-]{16,}$/i.test(segment) && !/^\d+$/.test(segment))
      .map((segment) => segment.replace(/^\d+[^a-z]+/i, "").replace(/[-_.]+/g, " ").trim())
      .filter((segment) => segment.length > 2);
    const slug = usable.sort((a, b) => b.length - a.length)[0] || "";
    const titleAuthor = slug.match(/^(.+?)\s+by\s+(.+)$/i);
    return {
      hostname,
      query: slug,
      title: titleAuthor ? titleAuthor[1] : slug,
      author: titleAuthor ? titleAuthor[2] : ""
    };
  }

  function extractIsbn(value) {
    const matches = String(value || "").toUpperCase().match(/(?:97[89][\s-]?)?(?:\d[\s-]?){8,11}[\dX]/g) || [];
    return matches.map((match) => match.replace(/[\s-]/g, "")).find(validIsbn) || "";
  }

  function validIsbn(value) {
    const isbn = String(value || "").replace(/[\s-]/g, "").toUpperCase();
    if (/^\d{13}$/.test(isbn)) {
      const sum = [...isbn.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
      return (10 - (sum % 10)) % 10 === Number(isbn[12]);
    }
    if (/^\d{9}[\dX]$/.test(isbn)) {
      const sum = [...isbn].reduce((total, digit, index) => total + (digit === "X" ? 10 : Number(digit)) * (10 - index), 0);
      return sum % 11 === 0;
    }
    return false;
  }

  function normalizeDocument(doc, parsed) {
    const isbns = [...new Set((doc.isbn || []).map((isbn) => String(isbn).replace(/[\s-]/g, "").toUpperCase()).filter(validIsbn))];
    const formats = [...new Set((doc.format || []).map(normalizeFormat).filter(Boolean))];
    const workKey = String(doc.key || "").replace(/^\//, "");
    const sourceUrl = parsed.sourceUrl || "";
    return {
      provider: "open-library",
      providerId: workKey,
      title: doc.title || "Untitled",
      subtitle: doc.subtitle || "",
      authors: (doc.author_name || []).filter(Boolean),
      author: (doc.author_name || [])[0] || "Author unknown",
      isbns,
      isbn10: isbns.find((isbn) => isbn.length === 10) || "",
      isbn13: isbns.find((isbn) => isbn.length === 13) || "",
      coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
      edition: editionLabel(doc),
      editionCount: Number(doc.edition_count) || (doc.edition_key || []).length || 1,
      editionKeys: (doc.edition_key || []).slice(0, 12),
      formats,
      formatHints: formats,
      firstPublished: doc.first_publish_year || null,
      publishers: (doc.publisher || []).slice(0, 4),
      canonicalUrl: workKey ? `https://openlibrary.org/${workKey}` : "",
      sourceUrls: sourceUrl ? [sourceUrl] : [],
      source: sourceUrl ? parsed.hostname : "Open Library"
    };
  }

  function editionLabel(doc) {
    const parts = [];
    if (doc.first_publish_year) parts.push(String(doc.first_publish_year));
    if (doc.publisher?.[0]) parts.push(doc.publisher[0]);
    return parts.join(" · ") || `${Number(doc.edition_count) || 1} edition${Number(doc.edition_count) === 1 ? "" : "s"}`;
  }

  function normalizeFormat(value) {
    const text = String(value || "").toLowerCase();
    if (/audio/.test(text)) return "audiobook";
    if (/ebook|electronic|kindle/.test(text)) return "ebook";
    if (/paperback/.test(text)) return "paperback";
    if (/hardcover|hardback/.test(text)) return "hardcover";
    return "";
  }

  function rankCandidates(candidates, parsed) {
    return candidates.map((candidate) => {
      let score;
      if (parsed.isbn) score = candidate.isbns.includes(parsed.isbn) ? 1 : 0;
      else {
        const titleTarget = parsed.title || parsed.query;
        const titleScore = fuzzyScore(titleTarget, `${candidate.title} ${candidate.subtitle || ""}`);
        const authorScore = fuzzyScore(parsed.author || parsed.query, candidate.authors.join(" "));
        score = parsed.author
          ? titleScore * 0.74 + authorScore * 0.26
          : parsed.kind === "general" ? Math.max(titleScore, authorScore) : titleScore;
      }
      const confidence = score >= 0.84 ? "high" : score >= 0.62 ? "medium" : "review";
      return { ...candidate, matchScore: Math.round(score * 100) / 100, confidence };
    }).sort((a, b) => b.matchScore - a.matchScore || b.editionCount - a.editionCount || a.title.localeCompare(b.title));
  }

  function fuzzyScore(left, right) {
    const a = Shared.normalize(left);
    const b = Shared.normalize(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    const token = Shared.tokenScore(a, b);
    const distance = levenshtein(a, b);
    const edit = 1 - distance / Math.max(a.length, b.length, 1);
    const prefix = a.startsWith(b) || b.startsWith(a) ? 0.92 : 0;
    return Math.max(token, edit, prefix);
  }

  function levenshtein(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const saved = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + Number(a[i - 1] !== b[j - 1]));
        previous = saved;
      }
    }
    return row[b.length];
  }

  function parseMultiline(value) {
    return String(value || "").split(/\r?\n/).map((line, index) => ({ index, line: line.trim(), parsed: parseInput(line) })).filter((entry) => entry.line);
  }

  return {
    SEARCH_ENDPOINT, RECOGNIZED_HOSTS, ProviderError, OpenLibraryProvider,
    parseInput, parseBookUrl, parseMultiline, extractIsbn, validIsbn,
    normalizeDocument, rankCandidates, fuzzyScore
  };
});
