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

  // Use real Google Chrome if available
  const browser = await chromium.launchPersistentContext('', {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 800 },
    storageState: storage,
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    geolocation: { latitude: 25.006625, longitude: 121.534203 },
    // slowMo: 50,
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://m.uber.com');

    // Ensure we're on the ride flow
    await page.waitForLoadState('networkidle');

    // Click pickup if necessary (this script assumes pickup is already set via storageState by the interactive login)
    // Click drop combobox and type NTU
    const dropSelector = '[data-testid="enhancer-container-drop0"] [role="combobox"]';
    await page.waitForSelector(dropSelector, { timeout: 5000 });
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

    // Click Search
    const search = page.getByRole('button', { name: 'Search' });
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
