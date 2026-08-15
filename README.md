# LibbySave

LibbySave is a Manifest V3 Chrome extension that turns online book discovery into a library action:

- Searches for books directly from the popup by title, author, ISBN, or a recognized book URL.
- Finds libraries by name, city, state/province, postal code, or OverDrive domain without requiring slug knowledge.
- Saves a persistent reading list locally before availability checks finish.
- Shows Libby availability inline on Spotify Audiobook, New York Times, and Goodreads pages.
- Checks multiple OverDrive/Libby libraries and surfaces copies, holds, and estimated waits.
- Offers explicit **Borrow now** and **Place hold** actions that finish inside the user's signed-in Libby tab.
- Sends a whole book list to a user-selected Libby tag with progress, pause, skip, and review controls.
- Does not require or collect a library card number, PIN, or Libby password.

## Install the MVP

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose this repository's root directory.
5. Pin LibbySave, open its popup, and find your library by name, city, state/province, ZIP/postal code, or OverDrive domain.
6. Select one or more library systems. LibbySave stores the correct OverDrive identifier automatically.
7. Type `The Stranger Camus`, use Arrow keys to choose the result, and press Enter to save it.
8. Optionally open a Spotify audiobook/title collection, NYT Best Sellers page, or Goodreads page for inline availability.

No build step or production dependencies are required.

## How it works

### Library directory

Library setup searches Libby's official locator service at `locate.libbyapp.com`, which returns the libraries, branches, consortiums, and regional systems currently discoverable through Libby. It requires no API key. Results are normalized behind the replaceable `LibraryDirectoryProvider` in `src/library-directory.js`, then ranked deterministically: exact names, name prefixes, city/state or postal matches, and loose fuzzy matches.

The provider queries the maintained remote directory instead of shipping a redistributable snapshot. Up to 30 recent query result sets are cached in `chrome.storage.local` for seven days, so the popup does not download or parse the full directory at startup and a recent query can still work offline. Direct slug/domain input may also be resolved through OverDrive's catalog endpoint. A small advanced manual-slug form remains available when an institution is missing or the provider is unavailable.

Existing `{ name, slug }` settings migrate in place to settings version 2; names and slugs are preserved while optional directory metadata is added only for newly selected results. Multiple libraries are supported and duplicate slugs are rejected.

### Popup search and Saved books

The search field is focused whenever the popup opens. Searches are debounced and run through a replaceable `OpenLibraryProvider` in `src/book-search.js`. It supports title, title plus author, author, ISBN-10, ISBN-13, common book links, minor spelling errors, subtitles, and alternate editions. Results include covers, authors, ISBNs, publishers, edition counts, dates, and format hints when Open Library supplies them.

Open Library requires no embedded API secret and explicitly supports low-volume, human-facing book discovery and library tools. LibbySave stays within the default one-request-per-second limit, keeps only a short-lived in-memory response cache, requests a small field set, and does not use Open Library as a bulk backend. See the official [API usage guidelines and rate limits](https://openlibrary.org/developers/api) and [Search API documentation](https://openlibrary.org/dev/docs/api/search).

Pressing Enter or **Save** writes the selected metadata to `chrome.storage.local` immediately. Availability enrichment begins as a separate message afterward, so an offline or slow Libby check cannot prevent the save. The Saved view supports:

- available-now, wait-list, ebook, and audiobook filters
- remove and Undo/restore
- availability refresh
- canonical/source and matched Libby links
- explicit, title-specific Borrow or Place hold
- selecting several saved books and sending confirmed selections to a Libby tag

Books deduplicate by a shared ISBN first, then normalized title and author. Repeated discoveries merge useful source URLs. Storage version 3 migrates legacy saved arrays and sanitizes malformed entries without replacing settings, libraries, import state, or circulation authorization.

Choose **Paste a list** for multiline entry. Each non-empty line is searched independently and shown with its proposed match. Weak matches are labeled **Review** and start unchecked; the extension never silently saves an ambiguous line.

### Availability

Source adapters extract title/author pairs and request catalog checks from the service worker. The Spotify adapter reads visible DOM, accessible labels, audiobook URLs, and public embedded metadata; it does not use Spotify credentials or private APIs. The isolated catalog adapter queries OverDrive's public Thunder endpoint, scores possible matches, and returns availability for each configured library. Spotify discoveries prefer matching audiobooks even when the audiobook has a wait; an available ebook is shown as an alternative only when no matching audiobook exists.

### Borrowing and holds

The user must click **Borrow now** or **Place hold** for a specific title and library. LibbySave stores a 90-second authorization bound to the title, library, media ID, and action. A persisted one-shot transition ledger prevents rerenders or event replay from repeating a completed circulation action. The state machine clicks only an exact authorized control, permits a second click only inside a confirmation dialog, and pauses for sign-in or ambiguity. It never changes the user's default lending period and never borrows or places holds during list imports.

### Tag imports

The popup sends selected books to a persisted import queue. LibbySave opens searches in the chosen library and requires a high-confidence title/author match with a clear margin over alternatives. It selects or creates the configured tag through exact visible controls and advances only after the tag is visibly checked or Libby emits an exact saved status. When the interface is ambiguous or changes, automation pauses and asks the user to finish or skip the current title instead of guessing.

The in-page panel exposes sanitized state, failure code, path, media/library identifiers, and an explanation for the proposed or stopped action. It never includes cookies, storage values, card numbers, credentials, query strings, or session data.

## Supported sources

- New York Times book and Best Seller pages
- Goodreads book pages, lists, and shelves
- Spotify audiobook title pages, collections, genres, recommendations, and search results

Spotify's adapter also handles client-side navigation and conservatively rescans relevant additions from virtualized lists. Books already seen on the current Spotify route are retained for popup review and whole-list tag import, while duplicate cards and injected badges are deduplicated.

The extractor/provider boundaries are deliberately small so StoryGraph, Bookshop.org, pasted ISBN lists, and an approved OverDrive API client can be added later.

## Development

```bash
npm test
npm run check
```

Tests use Node's built-in test runner. There is no bundler and no remotely hosted executable code.

Coverage includes title, author, combined title/author, ISBN-10/13, URL parsing, fuzzy spelling, editions, keyboard navigation, Enter-to-save behavior, Undo/restore, duplicate prevention, asynchronous availability enrichment, multiline review, ambiguous matches, offline/rate-limit errors, storage migration, and corrupted saved data. Directory tests cover exact library names, city/state, postal codes, fuzzy misspellings, consortium metadata, duplicate prevention, multiple selections, legacy settings migration, manual fallback, empty/error responses, caching, direct slug lookup, and deterministic ranking.

## Important limitations

- The availability endpoint is public but undocumented for third-party production use. Before Chrome Web Store distribution, request official OverDrive API access or confirm permitted usage.
- Open Library documents its search API for low-volume, human-facing discovery, but should not be treated as a high-traffic or bulk metadata backend. LibbySave's provider boundary allows a future approved catalog source to replace it.
- Libby's locator is authoritative for what Libby currently makes discoverable, but it is not a separately documented third-party API contract. Coverage and available branch metadata depend on the provider; some results omit city, postal code, or country. Confirm production usage with OverDrive before Chrome Web Store distribution.
- New uncached library searches require a connection. An unexpired cached query and the advanced manual-slug fallback remain available offline.
- Opaque links that contain no human-readable title or ISBN (some Spotify and StoryGraph URLs) can be recognized but may still require the user to type or copy the visible title for a reliable match. No broad host permission is added merely to scrape pasted links.
- Libby is a dynamic web app. The import/circulation automation uses accessible labels and conservative matching, but Libby UI changes can require selector updates.
- List extraction is best-effort because Spotify, NYT, and Goodreads can change their markup. Spotify detection intentionally skips cards that do not expose enough public audiobook/title/author information.

## License

MIT. The product behavior was informed by the GPL-licensed [Available Reads](https://github.com/rhollister/goodreads) extension, but LibbySave is an independent implementation and contains no copied Available Reads source.
