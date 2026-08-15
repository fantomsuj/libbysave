(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.LibbySaveDirectory = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CACHE_VERSION = 1;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const CACHE_LIMIT = 30;

  function normalize(value) {
    return String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function slugFromQuery(value) {
    const input = String(value || "").trim().toLowerCase();
    if (!input) return "";
    try {
      const url = new URL(input.includes("://") ? input : `https://${input}`);
      if (url.hostname.endsWith(".overdrive.com")) return url.hostname.split(".")[0];
      if (url.hostname === "libbyapp.com") {
        return url.pathname.match(/\/(?:library|search)\/([^/]+)/)?.[1] || "";
      }
    } catch (_) {
      // A bare identifier is handled below.
    }
    return /^[a-z0-9-]{2,40}$/.test(input) ? input : "";
  }

  function editDistance(left, right) {
    const a = normalize(left);
    const b = normalize(right);
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const old = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = old;
      }
    }
    return row[b.length];
  }

  function fuzzyScore(query, value) {
    const q = normalize(query);
    const candidate = normalize(value);
    if (!q || !candidate) return 0;
    if (candidate.includes(q)) return 1;
    const distance = editDistance(q, candidate.slice(0, Math.max(q.length, Math.min(candidate.length, q.length + 4))));
    return Math.max(0, 1 - distance / Math.max(q.length, candidate.length));
  }

  function rankLibrary(query, library) {
    const q = normalize(query);
    const queriedSlug = slugFromQuery(query);
    const names = [library.name, ...(library.branchNames || [])].map(normalize).filter(Boolean);
    const places = [library.city, library.region, library.regionCode, library.country, library.countryCode, library.postalCode,
      ...(library.branches || []).flatMap((branch) => [branch.name, branch.city, branch.region, branch.regionCode, branch.postalCode])]
      .map(normalize).filter(Boolean);
    const slug = normalize(library.slug);
    let tier = 4;
    let score = 0;
    if (names.some((name) => name === q) || slug === q || queriedSlug === library.slug) {
      tier = 0;
      score = 1;
    } else if (names.some((name) => name.startsWith(q)) || slug.startsWith(q)) {
      tier = 1;
      score = 1;
    } else if (places.some((place) => place === q || place.startsWith(q)) || places.join(" ").includes(q)) {
      tier = 2;
      score = 1;
    } else {
      score = Math.max(...names.map((name) => fuzzyScore(q, name)), fuzzyScore(q, slug));
      tier = 3;
    }
    return { tier, score };
  }

  function rankLibraries(query, libraries) {
    return [...(libraries || [])]
      .map((library) => ({ library, rank: rankLibrary(query, library) }))
      .filter(({ rank }) => rank.tier < 3 || rank.score >= 0.35)
      .sort((left, right) => left.rank.tier - right.rank.tier
        || right.rank.score - left.rank.score
        || normalize(left.library.name).localeCompare(normalize(right.library.name))
        || String(left.library.slug).localeCompare(String(right.library.slug)))
      .map(({ library }) => library);
  }

  function digitalDomain(system) {
    const link = (system.links || []).find((candidate) => candidate.name === "DigitalLibraryUrl");
    return String(link?.url || `${system.fulfillmentId}.overdrive.com`).replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  function librariesFromLocator(payload) {
    const grouped = new Map();
    for (const branch of payload?.branches || []) {
      for (const system of branch.systems || []) {
        if (!system.fulfillmentId) continue;
        const slug = String(system.fulfillmentId).toLowerCase();
        const existing = grouped.get(slug);
        const library = existing || {
          id: system.id || system.websiteId || slug,
          websiteId: system.websiteId || null,
          name: system.name || slug,
          slug,
          domain: digitalDomain(system),
          isConsortium: Boolean(system.isConsortium),
          city: branch.city || "",
          region: branch.region || "",
          regionCode: branch.regionCode || "",
          postalCode: branch.postalCode || "",
          country: branch.country || "",
          countryCode: branch.countryCode || "",
          branchNames: [],
          branches: []
        };
        if (branch.name && !library.branchNames.includes(branch.name)) library.branchNames.push(branch.name);
        if (!library.branches.some((candidate) => candidate.id === branch.id)) {
          library.branches.push({
            id: branch.id,
            name: branch.name || "",
            city: branch.city || "",
            region: branch.region || "",
            regionCode: branch.regionCode || "",
            postalCode: branch.postalCode || "",
            country: branch.country || "",
            countryCode: branch.countryCode || ""
          });
        }
        grouped.set(slug, library);
      }
    }
    return [...grouped.values()];
  }

  function libraryFromDirect(payload) {
    if (!payload?.fulfillmentId && !payload?.preferredKey && !payload?.id) return null;
    const slug = String(payload.fulfillmentId || payload.preferredKey || payload.id).toLowerCase();
    return {
      id: payload.accessId || payload.websiteId || slug,
      websiteId: payload.websiteId || null,
      name: payload.name || slug,
      slug,
      domain: `${slug}.overdrive.com`,
      isConsortium: Boolean(payload.isConsortium),
      city: "",
      region: "",
      regionCode: "",
      postalCode: "",
      country: "",
      countryCode: "",
      branchNames: []
    };
  }

  function migrateSettings(settings) {
    const source = settings && typeof settings === "object" ? settings : {};
    const seen = new Set();
    const libraries = (source.libraries || []).map((library) => {
      const slug = slugFromQuery(library?.slug || library?.domain || library?.url || "");
      if (!slug || seen.has(slug)) return null;
      seen.add(slug);
      return {
        ...library,
        name: String(library.name || slug),
        slug,
        domain: String(library.domain || `${slug}.overdrive.com`),
        isConsortium: Boolean(library.isConsortium),
        source: library.source || "legacy"
      };
    }).filter(Boolean);
    return {
      ...source,
      libraries,
      targetTag: source.targetTag || "Saved from LibbySave",
      autoCheck: source.autoCheck !== false,
      settingsVersion: 2
    };
  }

  function manualLibrary(name, input) {
    const slug = slugFromQuery(input);
    if (!slug) return null;
    return { name: String(name || slug).trim() || slug, slug, domain: `${slug}.overdrive.com`, isConsortium: false, source: "manual" };
  }

  function addLibrarySelection(libraries, library) {
    const current = [...(libraries || [])];
    if (!library?.slug || current.some((candidate) => candidate.slug === library.slug)) return current;
    return [...current, library];
  }

  function chooseLocation(query, library) {
    const q = normalize(query);
    const branch = (library.branches || []).find((candidate) => q.includes(normalize(candidate.city)) && candidate.city)
      || (library.branches || []).find((candidate) => normalize(candidate.name).startsWith(q))
      || library.branches?.[0];
    return branch ? { ...library, ...branch, id: library.id, name: library.name, slug: library.slug, domain: library.domain, isConsortium: library.isConsortium } : library;
  }

  class LibraryDirectoryProvider {
    constructor({ fetcher, cache, now = Date.now, locatorBase = "https://locate.libbyapp.com", thunderBase = "https://thunder.api.overdrive.com" }) {
      this.fetcher = fetcher;
      this.cache = cache;
      this.now = now;
      this.locatorBase = locatorBase;
      this.thunderBase = thunderBase;
    }

    async search(rawQuery) {
      const query = String(rawQuery || "").trim();
      if (query.length < 2) return [];
      const key = normalize(query);
      const cached = await this.cache.get(key);
      if (cached && cached.version === CACHE_VERSION && this.now() - cached.savedAt < CACHE_TTL_MS) return cached.results;

      let locatorResults = [];
      let locatorError = null;
      try {
        const response = await this.fetcher(`${this.locatorBase}/autocomplete/${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error(`Library directory returned ${response.status}`);
        locatorResults = librariesFromLocator(await response.json());
      } catch (error) {
        locatorError = error;
      }

      const slug = slugFromQuery(query);
      if (slug) {
        try {
          const response = await this.fetcher(`${this.thunderBase}/v2/libraries/${encodeURIComponent(slug)}?x-client-id=dewey`);
          if (response.ok) {
            const direct = libraryFromDirect(await response.json());
            if (direct && !locatorResults.some((library) => library.slug === direct.slug)) locatorResults.push(direct);
          }
        } catch (_) {
          // The official locator remains the source of truth for natural-language search.
        }
      }

      if (locatorError && !locatorResults.length) throw locatorError;
      const results = rankLibraries(query, locatorResults).slice(0, 12).map((library) => chooseLocation(query, library));
      await this.cache.set(key, { version: CACHE_VERSION, savedAt: this.now(), results }, CACHE_LIMIT);
      return results;
    }
  }

  return {
    CACHE_LIMIT,
    CACHE_TTL_MS,
    LibraryDirectoryProvider,
    addLibrarySelection,
    editDistance,
    fuzzyScore,
    librariesFromLocator,
    libraryFromDirect,
    manualLibrary,
    migrateSettings,
    normalize,
    rankLibraries,
    rankLibrary,
    slugFromQuery
  };
});
