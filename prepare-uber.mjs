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

    // Robust pickup handling: try selectors, wait for pickup to be populated after selecting current location
    const pickupCandidates = [
      '[data-testid="enhancer-container-pickup0"] [role="combobox"]',
      '[data-testid^="enhancer-container"] [role="combobox"]',
      'role=combobox[name=/pickup/i]',
      'role=combobox >> nth=0',
    ];
    let pickupSet = false;
    for (const sel of pickupCandidates) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() === 0) continue;
        await loc.scrollIntoViewIfNeeded();
        await loc.click({ timeout: 8000 });

        // look for 'Use current location' option by common texts
        const useCurrent = page.getByRole('option', { name: /current location|Your current location|Use my location|Use current location/i }).first();
        if (await useCurrent.count() > 0) {
          await useCurrent.click();
        } else {
          // fallback to clicking any button that looks like a location pin/center control
          const centerBtn = page.locator('button:has(img[alt="Center"]), button[aria-label*="location" i], button:has(svg)').first();
          if (await centerBtn.count() > 0) {
            await centerBtn.click();
          }
        }

        // wait for pickup combobox to contain a non-empty text (address) — up to 6s
        try {
          await page.waitForFunction((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            const txt = el.innerText || el.getAttribute('aria-label') || '';
            return txt.trim().length > 3;
          }, sel, { timeout: 6000 });
          pickupSet = true;
          break;
        } catch (e) {
          // not populated yet, try next selector
          continue;
        }
      } catch (err) {
        continue;
      }
    }
    if (!pickupSet) {
      console.warn('Pickup not explicitly set — proceeding (may result in Search remaining disabled).');
    }

    // Wait for the dropoff combobox to appear (with debug screenshot on timeout)
    const dropSelector = '[data-testid="enhancer-container-drop0"] [role="combobox"]';
    try {
      await page.waitForSelector(dropSelector, { timeout: 30000 });
    } catch (err) {
      const debugOut = path.resolve(process.cwd(), 'scripts', 'debug-uber.png');
      try { await page.screenshot({ path: debugOut, fullPage: true }); console.error('Timeout waiting for drop selector — saved debug screenshot to', debugOut); } catch(e){}
      throw err;
    }

    // Type NTU and select the exact NTU suggestion when present
    await page.click(dropSelector);
    await page.fill(dropSelector, 'Digital Plaza');
    // wait for suggestions to populate
    try {
      const ntuOption = page.getByRole('option', { name: /台大校園內卓越聯合中心|台大校園內/ }).first();
      await ntuOption.waitFor({ timeout: 800 });
      await ntuOption.click();
    } catch (err) {
      // fallback: press Enter to accept the first suggestion
      await page.keyboard.press('Enter');
    }

    // Click Search when enabled — find and click the real button via page.evaluate to avoid locator instability
    try {
      await page.waitForFunction(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => {
          const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
          return /search/i.test(label) && !b.disabled;
        });
        return !!btn;
      }, null, { timeout: 30000 });
    } catch (err) {
      const debugOut = path.resolve(process.cwd(), 'scripts', 'debug-search-wait.png');
      try { await page.screenshot({ path: debugOut, fullPage: true }); console.error('Search button did not become enabled — saved', debugOut); } catch(e){}
      throw err;
    }

    // click the button via evaluate
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => {
        const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
        return /search/i.test(label) && !b.disabled;
      });
      if (btn) btn.click();
    });

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
