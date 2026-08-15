# LibbySave Privacy

LibbySave stores the following information locally in Chrome:

- Library display names and OverDrive slugs
- The user's preferred Libby tag name
- A temporary list-import queue
- A temporary, two-minute authorization when the user explicitly clicks Borrow or Place hold

LibbySave does not request, read, collect, or transmit library card numbers, PINs, Libby passwords, browsing history, or payment information. Settings and task state are kept in `chrome.storage.local` and are not sent to the developer.

Title and author searches are sent directly from the extension to OverDrive's catalog service to retrieve availability. When the user requests an import, borrow, or hold action, the extension opens `libbyapp.com`, where the user's existing Libby session handles authentication.

The extension asks only for site access needed for its core behavior: supported book-list sites, Libby, and the OverDrive catalog endpoint.
