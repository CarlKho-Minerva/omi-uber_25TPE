Prepare-only Playwright script

What this does
- Launches real Google Chrome (Playwright `channel: 'chrome'`) with your saved `auth.json` storage state.
- Grants geolocation and sets a sample coordinate near Taipei (adjustable in the script).
- Fills Dropoff with "NTU" and selects the NTU campus suggestion when available.
- Clicks "Search" to load ride options, selects the cheapest visible option, takes a screenshot at `scripts/prepare-screenshot.png`, and leaves the browser open for manual verification.

Important safety notes
- This script will NOT click any "Request" / "Order" button. It only prepares the ride and takes a screenshot.
- You must have `auth.json` in the project root (same folder as this repository) — it is required to re-use your logged-in session.
- The script runs a real Chrome instance (not headless). Make sure Chrome is installed on your system.

Requirements
- Node.js 18+ and Playwright installed. From the repository root run:

```bash
npm init -y
npm i -D playwright
npx playwright install
```

Run the script

```bash
node --experimental-specifier-resolution=node scripts/prepare-uber.mjs
```

If your system has multiple Chrome installs or Playwright cannot find Chrome, you can edit the script to point to the Chrome executable by launching a persistent context with `executablePath` in the options.

Troubleshooting
- If the script opens an unauthenticated browser, make sure `auth.json` contains valid cookies and localStorage and that it's in the repository root.
- To use a different geolocation, edit the `geolocation` option in `scripts/prepare-uber.mjs`.
- If Playwright complains about channels, update Playwright and ensure `playwright install` ran successfully.
