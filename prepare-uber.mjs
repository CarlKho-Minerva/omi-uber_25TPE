import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

(async () => {
  const workspace = path.resolve(new URL('..', import.meta.url).pathname, '..');
  const storage = path.resolve(process.cwd(), 'auth.json');
  if (!fs.existsSync(storage)) {
    console.error('auth.json not found in current working directory. Run `npx playwright codegen --save-storage=auth.json https://m.uber.com` first or copy your storage file to the project root.');
    process.exit(1);
  }

  // Launch real Google Chrome (if available) and create a context that uses the saved storage state.
  // Using launch() + newContext({ storageState }) ensures Playwright applies the saved auth correctly.
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: storage,
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    geolocation: { latitude: 25.006625, longitude: 121.534203 },
  });

  try {
    const page = await context.newPage();
    await page.goto('https://m.uber.com');

    // Ensure pickup uses current location: try several pickup combobox selectors and select 'Use current location'.
    const pickupCandidates = [
      '[data-testid="enhancer-container-pickup0"] [role="combobox"]',
      'role=combobox[name=/pickup/i]',
      'role=combobox >> nth=0',
    ];
    let pickupFound = false;
    for (const sel of pickupCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() === 0) continue;
        await loc.scrollIntoViewIfNeeded();
        await loc.click({ timeout: 5000 });
        pickupFound = true;

        // Try to click obvious "current location" options
        const useCurrentOption = page.getByRole('option', { name: /current location|Your current location|Use my location/i }).first();
        if (await useCurrentOption.count() > 0) {
          await useCurrentOption.click();
        } else {
          // Fallback: click map 'Show your location' / center button if present
          const centerBtn = page.locator('button:has(img[alt="Center"])').first();
          if (await centerBtn.count() > 0) {
            await centerBtn.click();
          } else {
            console.warn('Could not find an explicit "Use current location" control for pickup (selector=' + sel + ').');
          }
        }
        break;
      } catch (err) {
        // try next candidate
        continue;
      }
    }
    if (!pickupFound) {
      console.warn('Pickup combobox not found with any candidate selectors. Continuing; pickup may be empty.');
    }

    // Ensure we're on the ride flow by waiting for the dropoff combobox to appear.
    // Save a debug screenshot if the selector does not appear in time.
    const dropSelector = '[data-testid="enhancer-container-drop0"] [role="combobox"]';
    try {
      await page.waitForSelector(dropSelector, { timeout: 30000 });
    } catch (err) {
      const debugOut = path.resolve(process.cwd(), 'scripts', 'debug-uber.png');
      try {
        await page.screenshot({ path: debugOut, fullPage: true });
        console.error('Timeout waiting for drop selector — saved debug screenshot to', debugOut);
      } catch (screenshotErr) {
        console.error('Failed to save debug screenshot:', screenshotErr);
      }
      throw err;
    }
  await page.click(dropSelector);
    await page.fill(dropSelector, 'NTU');
    await page.waitForTimeout(800);

    // Choose NTU suggestion (best-effort by matching text)
    const opt = await page.locator('role=option >> text=台大校園內').first();
    if (await opt.count() > 0) {
      await opt.click();
    } else {
      // fallback: press Enter to accept the first suggestion
      await page.keyboard.press('Enter');
    }

    // Click Search when enabled
    const search = page.getByRole('button', { name: 'Search' });
    try {
      // Wait until Search is present and enabled (not disabled)
      await page.waitForFunction(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const label = b.getAttribute('aria-label') || b.innerText || '';
          return /search/i.test(label.trim());
        });
        return !!btn && !btn.disabled;
      }, null, { timeout: 30000 });
    } catch (err) {
      const debugOut = path.resolve(process.cwd(), 'scripts', 'debug-search-wait.png');
      try { await page.screenshot({ path: debugOut, fullPage: true }); console.error('Search button did not become enabled — saved', debugOut); } catch(e){}
      throw err;
    }
    await search.click();

    // Wait for product selection to populate
    await page.waitForSelector('role=listbox', { timeout: 10000 });

    // Find the cheapest option by parsing visible prices
    const options = page.locator('role=option');
    const count = await options.count();
    let cheapestIndex = -1;
    let cheapestPrice = Number.POSITIVE_INFINITY;

    for (let i = 0; i < count; i++) {
      const optHandle = options.nth(i);
      const priceText = (await optHandle.locator('p').allTextContents()).pop() || '';
      const match = priceText.match(/NT\$\s*([0-9,]+)(?:-(?:[0-9,]+))?/);
      if (match) {
        const price = Number(match[1].replace(/,/g, ''));
        if (price < cheapestPrice) {
          cheapestPrice = price;
          cheapestIndex = i;
        }
      }
    }

    if (cheapestIndex === -1) {
      console.warn('Could not determine cheapest option; selecting first option');
      await options.first().click();
    } else {
      await options.nth(cheapestIndex).click();
    }

    // Take screenshot of the prepared ride (do not request)
    const out = path.resolve(process.cwd(), 'scripts', 'prepare-screenshot.png');
    await page.screenshot({ path: out, fullPage: true });
    console.log('Prepared cheapest ride and saved screenshot to', out);

    // Keep the browser open for manual verification (user can request or cancel)
    console.log('Leaving browser open for manual verification. Close it when done.');
  } catch (err) {
    console.error('Error during automation:', err);
  }
})();
