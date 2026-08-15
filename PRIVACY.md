# LibbySave Privacy

LibbySave stores the following information locally in Chrome:

- Library display names and OverDrive slugs
- Saved-book metadata: title, author, ISBNs, cover URL, edition and format hints, saved date, useful source URLs, selected Libby match, and latest availability
- The user's preferred Libby tag name
- A temporary list-import queue
- A temporary, two-minute authorization when the user explicitly clicks Borrow or Place hold

LibbySave does not request, read, collect, or transmit library card numbers, PINs, Libby passwords, browsing history, payment information, or the user's entire Saved list. Settings, Saved books, and task state are kept in `chrome.storage.local` and are not sent to the developer.

Popup book-search text is sent directly to Open Library's Search API at `openlibrary.org`. Search responses are kept only in a short-lived in-memory cache so the extension can debounce and avoid duplicate provider requests. LibbySave does not persist search history. Pasted URLs are parsed locally; the extension does not add broad website access merely to inspect those links.

On `open.spotify.com`, LibbySave reads only page content needed to recognize audiobooks: visible text, accessible labels, audiobook URLs, and public embedded metadata. It does not request Spotify credentials, use Spotify private/internal APIs, or read listening history.

After a book is saved, its title, author, and format hint are sent separately for each configured library to OverDrive's catalog service to retrieve availability. Saving does not wait for this enrichment. The Saved list is never uploaded as a collection. When the user requests an import, borrow, or hold action, the extension opens `libbyapp.com`, where the user's existing Libby session handles authentication.

The extension asks only for site access needed for its core behavior: Open Library search, the supported book-list pages (including only `https://open.spotify.com/*` for Spotify), Libby, and the OverDrive catalog endpoint.
