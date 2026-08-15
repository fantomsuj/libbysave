# LibbySave Privacy

LibbySave stores the following information locally in Chrome:

- Library display names and OverDrive slugs
- The user's preferred Libby tag name
- A temporary list-import queue
- A temporary, two-minute authorization when the user explicitly clicks Borrow or Place hold

LibbySave does not request, read, collect, or transmit library card numbers, PINs, Libby passwords, browsing history, selected text, or page content. Generic book detection is deterministic and runs locally in the active tab only after the user chooses **Find books on this page**. There is no AI service or external extraction provider.

On `open.spotify.com`, LibbySave reads only page content needed to recognize audiobooks: visible text, accessible labels, audiobook URLs, and public embedded metadata. It does not request Spotify credentials, use Spotify private/internal APIs, or read listening history.

Only the resulting title, author, and optional ISBN candidates are shown in the popup. Title and author searches are sent directly from the extension to OverDrive's catalog service only when the user asks to check availability. When the user requests an import, borrow, or hold action, the extension opens `libbyapp.com`, where the user's existing Libby session handles authentication.

The extension uses Chrome's `activeTab` and `scripting` permissions instead of persistent access to every website. Its permanent site access remains limited to supported dedicated book-list sites, Libby, and the OverDrive catalog endpoint.
