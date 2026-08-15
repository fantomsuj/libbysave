# LibbySave

LibbySave is a dependency-free Manifest V3 Chrome extension that turns online book discovery into a library action:

- Finds books in ordinary articles, blogs, and selected reading lists—without a site-specific adapter.
- Shows Libby availability inline on Spotify Audiobook, New York Times, and Goodreads pages.
- Checks multiple OverDrive/Libby libraries and surfaces copies, holds, and estimated waits.
- Offers explicit **Borrow now** and **Place hold** actions inside the user's signed-in Libby tab.
- Sends selected books to a user-selected Libby tag.
- Does not require or collect a library card number, PIN, or Libby password.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose this repository's root directory.
5. Pin LibbySave, open its popup, and add a library name and OverDrive slug. For `nypl.overdrive.com`, the slug is `nypl`.

## Find books on any page

Open LibbySave on an article or blog post and choose **Find books on this page**. You can optionally select a block of recommendations on the page first. The review screen shows each title's confidence and evidence, and lets you edit the title or author, remove false positives, and choose which books to check or save.

Detection is deterministic and runs inside the active tab. It considers:

- `schema.org/Book` and `Audiobook` JSON-LD
- Valid ISBN-10 and ISBN-13 metadata
- Open Graph book fields
- Repeated title-and-author cards
- Links to recognized book platforms
- Explicit selected text
- Conservative “Title by Author” prose patterns

No page content is transmitted to LibbySave or an AI service. The extractor is a provider pipeline with a disabled-by-default fallback boundary, so a future optional provider does not need to weaken the local deterministic path.

Chrome's `activeTab` and `scripting` permissions allow a scan only after the user opens the extension and explicitly requests it. LibbySave does not request blanket access to every site. Dedicated Spotify, New York Times, and Goodreads adapters take precedence over the generic scanner.

## Availability, borrowing, and holds

Title and author pairs are sent to the service worker only when availability is requested. The catalog adapter queries OverDrive's catalog endpoint and returns a scored match for each configured library.

The user must click **Borrow now** or **Place hold** for a specific title and library. LibbySave stores a two-minute, title-specific authorization, opens the exact Libby media page, and clicks only controls matching that authorized action.

## Tag imports

The popup sends only selected books to a persisted import queue. LibbySave opens searches in the chosen library and attempts to select or conservatively create the configured tag. Ambiguous states pause instead of guessing.

## Development

```bash
npm test
npm run check
```

Tests use Node's built-in test runner and HTML fixtures. There is no bundler, production dependency, remotely hosted executable code, or AI dependency.

## Important limitations

- The availability endpoint is public but undocumented for third-party production use. Before Chrome Web Store distribution, request official OverDrive API access or confirm permitted usage.
- Libby is a dynamic web app; UI changes can require selector updates.
- Generic extraction is intentionally conservative. Low-confidence platform links are unselected by default and should be reviewed.

## License

MIT. The product behavior was informed by the GPL-licensed [Available Reads](https://github.com/rhollister/goodreads) extension, but LibbySave is an independent implementation and contains no copied Available Reads source.
