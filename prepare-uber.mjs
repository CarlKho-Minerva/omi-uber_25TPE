import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

console.log('prepare-uber starting — single clean copy.');

(async () => {
  const workspace = path.resolve(new URL('..', import.meta.url).pathname, '..');
  const storage = path.resolve(process.cwd(), 'auth.json');
  if (!fs.existsSync(storage)) {
    console.error('auth.json not found in current working directory. Run `npx playwright codegen --save-storage=auth.json https://m.uber.com` first or copy your storage file to the project root.');
    process.exit(1);
  }

  // Launch a single browser instance
  console.log('Launching browser (single instance)');
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: storage,
    permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    geolocation: { latitude: 25.006625, longitude: 121.534203 },
  });

  try {
    const page = await context.newPage();
    await page.goto('https://m.uber.com');

    // Robust pickup handling
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
        await loc.click({ timeout: 800 });
        const useCurrent = page.getByRole('option', { name: /current location|Your current location|Use my location|Use current location/i }).first();
        if (await useCurrent.count() > 0) {
          await useCurrent.click();
        } else {
          const centerBtn = page.locator('button:has(img[alt="Center"]), button[aria-label*="location" i], button:has(svg)').first();
          if (await centerBtn.count() > 0) await centerBtn.click();
        }
        try {
          await page.waitForFunction((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            const txt = el.innerText || el.getAttribute('aria-label') || '';
            return txt.trim().length > 3;
          }, sel, { timeout: 6000 });
          pickupSet = true; break;
        } catch (e) { continue; }
      } catch (e) { continue; }
    }
    if (!pickupSet) console.warn('Pickup not explicitly set — proceeding (may result in Search remaining disabled).');

    // Drop selector
    const dropSelector = '[data-testid="enhancer-container-drop0"] [role="combobox"]';
    try { await page.waitForSelector(dropSelector, { timeout: 30000 }); }
    catch (err) { const debugOut = path.resolve(process.cwd(), 'scripts', 'debug-uber.png'); try { await page.screenshot({ path: debugOut, fullPage: true }); console.error('Timeout waiting for drop selector — saved debug screenshot to', debugOut); } catch(e){} throw err; }

    // Type dropoff and selection (user-tested)
    await page.click(dropSelector);
    await page.fill(dropSelector, 'Digital Plaza');
    try { const ntuOption = page.getByRole('option', { name: /台大校園內卓越聯合中心|台大校園內/ }).first(); await ntuOption.waitFor({ timeout: 800 }); await ntuOption.click(); }
    catch (err) { await page.keyboard.press('Enter'); }

    // Wait for Search enabled — diagnostics if not
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
      const debugJson = path.resolve(process.cwd(), 'scripts', 'debug-search-wait.json');
      try { await page.screenshot({ path: debugOut, fullPage: true }); } catch(e){}
      try { const btns = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map(b => ({ text: (b.innerText||'').slice(0,120), aria: b.getAttribute('aria-label'), disabled: !!b.disabled }))); fs.writeFileSync(debugJson, JSON.stringify({ buttons: btns }, null, 2), 'utf8'); console.error('Search button did not become enabled — saved', debugOut, 'and', debugJson); } catch (e) {}
      throw err;
    }

    // Click Search
    await page.evaluate(() => { const btn = Array.from(document.querySelectorAll('button')).find(b => { const label = (b.getAttribute('aria-label') || b.innerText || '').trim(); return /search/i.test(label) && !b.disabled; }); if (btn) btn.click(); });

    // Wait for product list
    await page.waitForSelector('role=listbox', { timeout: 10000 });

    // Defensive: close Price Breakdown dialog if present
    try {
      const dialog = page.locator('role=dialog, dialog').first();
      if (await dialog.count() > 0) {
        const heading = await dialog.locator('h1, h2, h3, text=Price Breakdown').first().count();
        if (heading > 0) {
          const closeBtn = dialog.getByRole('button', { name: /close|ok|dismiss/i }).first();
          if (await closeBtn.count() > 0) await closeBtn.click(); else { const xBtn = dialog.locator('button[aria-label="Close"], button:has(svg)').first(); if (await xBtn.count() > 0) await xBtn.click(); }
          await page.waitForTimeout(300);
        }
      }
    } catch (e) {}

    // Parse ride options and write JSON
    const options = page.locator('role=option');
    const count = await options.count();
    const rides = [];
    for (let i = 0; i < count; i++) {
      const optHandle = options.nth(i);
      const titleParts = await optHandle.locator('p').allTextContents();
      const aria = await optHandle.getAttribute('aria-label');
      const priceText = (await optHandle.locator('p').allTextContents()).pop() || aria || '';
      const match = priceText.match(/NT\$\s*([0-9,]+)(?:-(?:[0-9,]+))?/);
      const numeric = match ? Number(match[1].replace(/,/g, '')) : null;
      const paraTexts = await optHandle.locator('p').allTextContents();
      const eta = paraTexts.find(t => /mins|min|away|AM|PM|away/i.test(t)) || '';
      rides.push({ index: i, title: titleParts.join(' | '), priceText: priceText.trim(), price: numeric, eta: eta.trim() });
    }
    const outJson = path.resolve(process.cwd(), 'scripts', 'ride-options.json');
    try { fs.mkdirSync(path.dirname(outJson), { recursive: true }); fs.writeFileSync(outJson, JSON.stringify(rides, null, 2), 'utf8'); console.log('Saved ride options to', outJson); } catch(e) { console.error('Failed to write ride options JSON:', e); }

    // Screenshot
    const out = path.resolve(process.cwd(), 'scripts', 'prepare-screenshot.png');
    await page.screenshot({ path: out, fullPage: true });
    console.log('Captured screenshot to', out);

    // Select cheapest option
    let cheapestIndex = -1; let cheapestPrice = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const optHandle = options.nth(i);
      const priceText = (await optHandle.locator('p').allTextContents()).pop() || '';
      const match = priceText.match(/NT\$\s*([0-9,]+)(?:-(?:[0-9,]+))?/);
      if (match) { const price = Number(match[1].replace(/,/g, '')); if (price < cheapestPrice) { cheapestPrice = price; cheapestIndex = i; } }
    }
    if (cheapestIndex === -1) { console.warn('Could not determine cheapest option; selecting first option'); await options.first().click(); }
    else { await options.nth(cheapestIndex).click(); }

    console.log('Prepared cheapest ride. Leaving browser open for manual verification. Close it when done.');

  } catch (err) {
    console.error('Error during automation:', err);
  }
})();
(async () => {
  const workspace = path.resolve(new URL("..", import.meta.url).pathname, "..");
  const storage = path.resolve(process.cwd(), "auth.json");
  if (!fs.existsSync(storage)) {
    console.error(
      "auth.json not found in current working directory. Run `npx playwright codegen --save-storage=auth.json https://m.uber.com` first or copy your storage file to the project root."
    );
    process.exit(1);
  }

  // Launch real Google Chrome (if available) and create a context that uses the saved storage state.
  // Using launch() + newContext({ storageState }) ensures Playwright applies the saved auth correctly.
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: storage,
    permissions: ["geolocation", "clipboard-read", "clipboard-write"],
    geolocation: { latitude: 25.006625, longitude: 121.534203 },
  });

  try {
    const page = await context.newPage();
    await page.goto("https://m.uber.com");

    // Robust pickup handling: try selectors, wait for pickup to be populated after selecting current location
    const pickupCandidates = [
      '[data-testid="enhancer-container-pickup0"] [role="combobox"]',
      '[data-testid^="enhancer-container"] [role="combobox"]',
      "role=combobox[name=/pickup/i]",
      "role=combobox >> nth=0",
    ];
    let pickupSet = false;
    for (const sel of pickupCandidates) {
      try {
        const loc = page.locator(sel).first();
        if ((await loc.count()) === 0) continue;
        await loc.scrollIntoViewIfNeeded();
        await loc.click({ timeout: 2000 });

        // look for 'Use current location' option by common texts
        const useCurrent = page
          .getByRole("option", {
            name: /current location|Your current location|Use my location|Use current location/i,
          })
          .first();
        if ((await useCurrent.count()) > 0) {
          await useCurrent.click();
        } else {
          // fallback to clicking any button that looks like a location pin/center control
          const centerBtn = page
            .locator(
              'button:has(img[alt="Center"]), button[aria-label*="location" i], button:has(svg)'
            )
            .first();
          if ((await centerBtn.count()) > 0) {
            await centerBtn.click();
          }
        }

        // wait for pickup combobox to contain a non-empty text (address) — up to 6s
        try {
          await page.waitForFunction(
            (s) => {
              const el = document.querySelector(s);
              if (!el) return false;
              const txt = el.innerText || el.getAttribute("aria-label") || "";
              return txt.trim().length > 3;
            },
            sel,
            { timeout: 6000 }
          );
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
      console.warn(
        "Pickup not explicitly set — proceeding (may result in Search remaining disabled)."
      );
    }

    // Wait for the dropoff combobox to appear (with debug screenshot on timeout)
    const dropSelector =
      '[data-testid="enhancer-container-drop0"] [role="combobox"]';
    try {
      await page.waitForSelector(dropSelector, { timeout: 30000 });
    } catch (err) {
      const debugOut = path.resolve(process.cwd(), "scripts", "debug-uber.png");
      try {
        await page.screenshot({ path: debugOut, fullPage: true });
        console.error(
          "Timeout waiting for drop selector — saved debug screenshot to",
          debugOut
        );
      } catch (e) {}
      throw err;
    }

    // Type NTU and select the exact NTU suggestion when present
    await page.click(dropSelector);
    await page.fill(dropSelector, "Digital Plaza");
    // wait for suggestions to populate
    try {
      const ntuOption = page
        .getByRole("option", { name: /台大校園內卓越聯合中心|台大校園內/ })
        .first();
      await ntuOption.waitFor({ timeout: 800 });
      await ntuOption.click();
    } catch (err) {
      // fallback: press Enter to accept the first suggestion
      await page.keyboard.press("Enter");
    }

    // Click Search when enabled — find and click the real button via page.evaluate to avoid locator instability
    try {
      await page.waitForFunction(
        () => {
          const btn = Array.from(document.querySelectorAll("button")).find(
            (b) => {
              const label = (
                b.getAttribute("aria-label") ||
                b.innerText ||
                ""
              ).trim();
              return /search/i.test(label) && !b.disabled;
            }
          );
          return !!btn;
        },
        null,
        { timeout: 30000 }
      );
    } catch (err) {
      const debugOut = path.resolve(
        process.cwd(),
        "scripts",
        "debug-search-wait.png"
      );
      try {
        await page.screenshot({ path: debugOut, fullPage: true });
        console.error("Search button did not become enabled — saved", debugOut);
      } catch (e) {}
      throw err;
    }

    // click the button via evaluate
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => {
        const label = (
          b.getAttribute("aria-label") ||
          b.innerText ||
          ""
        ).trim();
        return /search/i.test(label) && !b.disabled;
      });
      if (btn) btn.click();
    });

    // Wait for product selection to populate
    await page.waitForSelector("role=listbox", { timeout: 10000 });

    // Parse visible ride options (do NOT click any option to avoid opening modals)
    const options = page.locator("role=option");
    const count = await options.count();
    const rides = [];
    for (let i = 0; i < count; i++) {
      const optHandle = options.nth(i);
      // Collect text contents for title/labels and price info
      const titleParts = await optHandle.locator("p").allTextContents();
      const aria = await optHandle.getAttribute("aria-label");
      const priceText =
        (await optHandle.locator("p").allTextContents()).pop() || aria || "";
      // Try to extract a numeric price (lower bound of range or single price)
      const match = priceText.match(/NT\$\s*([0-9,]+)(?:-(?:[0-9,]+))?/);
      const numeric = match ? Number(match[1].replace(/,/g, "")) : null;
      // Try to extract ETA or time text from other paragraphs
      const paraTexts = await optHandle.locator("p").allTextContents();
      const eta =
        paraTexts.find((t) => /mins|min|away|AM|PM|away/i.test(t)) || "";
      rides.push({
        index: i,
        title: titleParts.join(" | "),
        priceText: priceText.trim(),
        price: numeric,
        eta: eta.trim(),
      });
    }

    // Save parsed rides to JSON for later processing
    const outJson = path.resolve(process.cwd(), "scripts", "ride-options.json");
    try {
      fs.mkdirSync(path.dirname(outJson), { recursive: true });
      fs.writeFileSync(outJson, JSON.stringify(rides, null, 2), "utf8");
      console.log("Saved ride options to", outJson);
    } catch (e) {
      console.error("Failed to write ride options JSON:", e);
    }

    // Find the cheapest option by parsing visible prices
    let cheapestIndex = -1;
    let cheapestPrice = Number.POSITIVE_INFINITY;

    for (let i = 0; i < count; i++) {
      const optHandle = options.nth(i);
      const priceText =
        (await optHandle.locator("p").allTextContents()).pop() || "";
      const match = priceText.match(/NT\$\s*([0-9,]+)(?:-(?:[0-9,]+))?/);
      if (match) {
        const price = Number(match[1].replace(/,/g, ""));
        if (price < cheapestPrice) {
          cheapestPrice = price;
          cheapestIndex = i;
        }
      }
    }

    if (cheapestIndex === -1) {
      console.warn(
        "Could not determine cheapest option; selecting first option"
      );
      await options.first().click();
    } else {
      await options.nth(cheapestIndex).click();
    }

    // Take screenshot of the prepared ride (do not request)
    const out = path.resolve(
      process.cwd(),
      "scripts",
      "prepare-screenshot.png"
    );
    await page.screenshot({ path: out, fullPage: true });
    console.log("Prepared cheapest ride and saved screenshot to", out);

    // Keep the browser open for manual verification (user can request or cancel)
    console.log(
      "Leaving browser open for manual verification. Close it when done."
    );
  } catch (err) {
    console.error("Error during automation:", err);
  }
})();