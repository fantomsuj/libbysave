# LibbySave

LibbySave is a Manifest V3 Chrome extension that turns online book discovery into a library action:

- Shows ebook and audiobook availability inline on New York Times and Goodreads pages.
- Checks multiple OverDrive/Libby libraries and surfaces copies, holds, and estimated waits.
- Offers explicit **Borrow now** and **Place hold** actions that finish inside the user's signed-in Libby tab.
- Sends a whole book list to a user-selected Libby tag with progress, pause, skip, and review controls.
- Does not require or collect a library card number, PIN, or Libby password.

## Install the MVP

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose this repository's root directory.
5. Pin LibbySave, open its popup, and add a library name and OverDrive slug. For `nypl.overdrive.com`, the slug is `nypl`.
6. Open a supported NYT Best Sellers or Goodreads page.

No build step or production dependencies are required.

## How it works

### Availability

Book-site content scripts extract title/author pairs and request catalog checks from the service worker. The catalog adapter queries OverDrive's public Thunder catalog endpoint, scores possible title/author matches, and returns the best format and availability for each configured library.

### Borrowing and holds

The user must click **Borrow now** or **Place hold** for a specific title and library. LibbySave stores a two-minute, title-specific authorization, opens the exact Libby media page, and clicks only controls matching that authorized action. It never changes the user's default lending period and never borrows or places holds during list imports.

### Tag imports

The popup sends selected books to a persisted import queue. LibbySave opens searches in the chosen library and attempts to select the configured tag through Libby's visible UI. If that tag is missing, it conservatively attempts to create it through exact **New Tag** and **Create** controls. When the interface is ambiguous or changes, automation pauses and asks the user to finish or skip the current title instead of guessing.

## Supported sources

- New York Times book and Best Seller pages
- Goodreads book pages, lists, and shelves

The extractor/provider boundaries are deliberately small so StoryGraph, Bookshop.org, pasted ISBN lists, and an approved OverDrive API client can be added later.

## Development

```bash
npm test
npm run check
```

Tests use Node's built-in test runner. There is no bundler and no remotely hosted executable code.

## Important limitations

- The availability endpoint is public but undocumented for third-party production use. Before Chrome Web Store distribution, request official OverDrive API access or confirm permitted usage.
- Libby is a dynamic web app. The import/circulation automation uses accessible labels and conservative matching, but Libby UI changes can require selector updates.
- List extraction is best-effort because NYT and Goodreads can change their markup.

## License

MIT. The product behavior was informed by the GPL-licensed [Available Reads](https://github.com/rhollister/goodreads) extension, but LibbySave is an independent implementation and contains no copied Available Reads source.
