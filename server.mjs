// server.mjs
import express from "express";
import { chromium } from "playwright-extra";
import stealth from "puppeteer-extra-plugin-stealth";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

// ==============================================================================
// --- CONFIGURATION ---
// ==============================================================================
const CONFIG = {
  DEMO_MODE: false, // If true, calls the ride and cancels it immediately; False -> returns price and ETA only.
  HEADLESS_MODE: true, // KEEP FALSE TO WATCH!
  SEND_NOTIFICATIONS: true,
  OMI_APP_ID: process.env.OMI_APP_ID,
  OMI_APP_SECRET: process.env.OMI_APP_SECRET,
  PORT: process.env.PORT || 3000,
};
// ==============================================================================

const app = express();
app.use(express.json());

// --- MAIN WEBHOOK ENDPOINT ---
app.post("/webhook", async (req, res) => {
  console.log("\n--- REAL-TIME WEBHOOK RECEIVED ---");
  const userId = req.query.uid;
  const segments = req.body.segments;

  if (!userId || !Array.isArray(segments) || segments.length === 0) {
    return res.status(200).send("Waiting for data.");
  }

  const newText = segments
    .map((s) => s.text)
    .join(" ")
    .toLowerCase();
  console.log(`Chunk: "${newText}"`);

  const match = newText.match(
    /uber (?:from|starting at)\s+(.+?)\s+to\s+([^.]+)/
  );

  if (match && match[1] && match[2]) {
    const origin = match[1].trim();
    const destination = match[2].trim();
    console.log(`>>> TRIGGER DETECTED: From "${origin}" to "${destination}"`);

    res.status(200).send("Processing request");

    (async () => {
      await sendOmiNotification(
        userId,
        `Okay, preparing Uber from ${origin} to ${destination}...`
      );
      try {
        const rideDetails = await getUberPrice(userId, origin, destination);
        const confirmationMessage = `Ride from ${origin} to ${destination}: ${rideDetails.priceText} (${rideDetails.eta}). Tap to confirm.`;
        await sendOmiNotification(userId, confirmationMessage);
      } catch (error) {
        console.error("Playwright automation failed:", error);
        await sendOmiNotification(
          userId,
          "Sorry, I was unable to get details."
        );
      }
    })();
  } else {
    res.status(200).send("No action taken.");
  }
});

// --- THE CORE PLAYWRIGHT LOGIC (FAITHFUL ADAPTATION) ---
async function getUberPrice(userId, origin, destination) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const storageStatePath = path.resolve(
    __dirname,
    "auth_sessions",
    `${userId}_auth.json`
  );

  if (!fs.existsSync(storageStatePath)) {
    throw new Error("auth.json not found.");
  }

  const browser = await chromium.launch({
    headless: CONFIG.HEADLESS_MODE,
    channel: "chrome",
  });
  const context = await browser.newContext({
    storageState: storageStatePath,
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    console.log("Navigating to m.uber.com...");
    await page.goto("https://m.uber.com");

    // --- START OF BATTLE-TESTED LOGIC ---

    // Robust pickup handling
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
        await loc.click({ timeout: 5000 });

        // --- PRECISE CHANGE #1: TYPE THE ORIGIN INSTEAD OF CLICKING "CURRENT LOCATION" ---
        console.log(`Typing origin: "${origin}"`);
        await page.fill(sel, origin);
        await page.waitForTimeout(3500); // Wait for suggestions
        await page.keyboard.press("Enter");
        // --- END OF CHANGE #1 ---

        await page.waitForFunction(
          (s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            return (
              (el.innerText || el.getAttribute("aria-label") || "").trim()
                .length > 3
            );
          },
          sel,
          { timeout: 6000 }
        );
        pickupSet = true;
        console.log("Pickup location successfully set.");
        break;
      } catch (e) {
        continue;
      }
    }
    if (!pickupSet) console.warn("Pickup not explicitly set.");

    // Drop selector
    const dropSelector =
      '[data-testid="enhancer-container-drop0"] [role="combobox"]';
    await page.waitForSelector(dropSelector, { timeout: 30000 });

    // --- PRECISE CHANGE #2: TYPE THE DESTINATION VARIABLE ---
    console.log(`Typing destination: "${destination}"`);
    await page.click(dropSelector);
    await page.fill(dropSelector, destination);
    await page.waitForTimeout(3500); // Wait for suggestions
    await page.keyboard.press("Enter");
    // --- END OF CHANGE #2 ---

    // Wait for Search enabled
    await page.waitForFunction(
      () => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) =>
            /search/i.test(
              (b.getAttribute("aria-label") || b.innerText || "").trim()
            ) && !b.disabled
        );
        return !!btn;
      },
      null,
      { timeout: 30000 }
    );

    // Click Search
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) =>
          /search/i.test(
            (b.getAttribute("aria-label") || b.innerText || "").trim()
          ) && !b.disabled
      );
      if (btn) btn.click();
    });

    // Wait for product list
    await page.waitForSelector("role=listbox", { timeout: 30000 });

    // Parse ride options
    const options = page.locator("role=option");
    const firstOption = options.first();
    const allText = await firstOption.locator("p").allTextContents();
    const priceText = allText.pop() || "";
    const eta = allText.find((t) => /min/i.test(t)) || "N/A";

    // --- END OF BATTLE-TESTED LOGIC ---

    console.log(`Scraped Details: Price=${priceText}, ETA=${eta}`);
    // --- START OF NEW DEMO MODE BLOCK ---
    if (CONFIG.DEMO_MODE) {
      console.log("[DEMO MODE] Selecting first ride option...");
      await firstOption.click();
      await page.waitForTimeout(2000); // Wait for confirm button to appear

      console.log("[DEMO MODE] Clicking final 'Confirm' button...");
      // This selector targets the button that confirms the specific ride, e.g., "Confirm UberX"
      const confirmButton = page
        .getByRole("button", { name: /confirm/i })
        .first();
      await confirmButton.click();

      // Wait for the trip to be booked and the 'Cancel' option to appear
      await page.waitForTimeout(4000);

      console.log("[DEMO MODE] Clicking 'Cancel' button...");
      const cancelButton = page
        .getByRole("button", { name: /cancel/i })
        .first();
      await cancelButton.click();

      // Wait for the final cancellation confirmation dialog
      await page.waitForTimeout(1000);

      console.log("[DEMO MODE] Confirming the cancellation...");
      // This selector might need to be adjusted based on the exact text (e.g., "YES, CANCEL")
      const finalCancelButton = page
        .getByRole("button", { name: /yes, cancel/i })
        .first();
      if ((await finalCancelButton.count()) > 0) {
        await finalCancelButton.click();
      }

      console.log(
        "[DEMO MODE] Ride requested and canceled successfully for demo."
      );
      await page.waitForTimeout(2000); // Final pause to show it's done
    }
    // --- END OF NEW DEMO MODE BLOCK ---
    return { priceText: priceText.trim(), eta: eta.trim() };
  } catch (error) {
    const debugPath = path.resolve(__dirname, "playwright-error.png");
    await page.screenshot({ path: debugPath, fullPage: true });
    console.error(`Debug screenshot saved to ${debugPath}`);
    throw error;
  } finally {
    console.log("Closing browser.");
    await browser.close();
  }
}

// --- OMI NOTIFIER HELPER (Remains the same) ---
async function sendOmiNotification(userId, message) {
  if (!CONFIG.SEND_NOTIFICATIONS) {
    console.log(`(NOTIFICATIONS OFF) To ${userId}: "${message}"`);
    return;
  }
  if (!CONFIG.OMI_APP_ID || !CONFIG.OMI_APP_SECRET) {
    console.warn(
      "Omi credentials not set in .env file. Skipping notification."
    );
    return;
  }
  const url = `https://api.omi.me/v2/integrations/${
    CONFIG.OMI_APP_ID
  }/notification?uid=${encodeURIComponent(userId)}&message=${encodeURIComponent(
    message
  )}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.OMI_APP_SECRET}` },
    });
    if (!response.ok) {
      console.warn(
        `Omi API returned status ${
          response.status
        }. Body: ${await response.text()}`
      );
    } else {
      console.log("Notification sent successfully.");
    }
  } catch (error) {
    console.error("Failed to send Omi notification:", error.message);
  }
}

// --- START THE SERVER ---
app.get("/onboarding", (req, res) => {
  const userId = req.query.uid;
  if (!userId) {
    return res
      .status(400)
      .send("Invalid onboarding link. Please try installing the app again.");
  }
  // Simple HTML page with instructions
  res.send(`
    <html>
      <body style="font-family: sans-serif; padding: 20px;">
        <h1>Welcome to Uber for Omi! (One-Time Setup)</h1>
        <p>To use this app, you need to securely link your Uber account.</p>
        <h3>Instructions:</h3>
        <ol>
          <li><b>On a computer</b>, open your terminal (Command Prompt, PowerShell, or Terminal).</li>
          <li>Copy and paste this command and press Enter: <br>
            <code style="background: #eee; padding: 5px; border-radius: 5px;">npx playwright codegen --save-storage=auth.json https://m.uber.com</code>
          </li>
          <li>A new browser will open. <b>Log in to your Uber account.</b></li>
          <li>Once you're logged in, close that browser window.</li>
          <li>A file named <b>auth.json</b> will now be on your computer. Open it with any text editor.</li>
          <li>Copy the <b>entire contents</b> of the file.</li>
          <li>Paste the contents into the box below and click Save.</li>
        </ol>
        <hr>
        <form action="/save_auth?uid=${userId}" method="post">
          <textarea name="auth_content" rows="10" cols="80" placeholder="Paste the entire contents of your auth.json file here..."></textarea>
          <br><br>
          <button type="submit">Save My Uber Session</button>
        </form>
      </body>
    </html>
  `);
});

// This endpoint receives the pasted auth content and saves it.
app.post("/save_auth", express.text({ type: "*/*" }), async (req, res) => {
  const userId = req.query.uid;
  const authContent = req.body;

  if (!userId || !authContent) {
    return res.status(400).send("Missing user ID or auth content.");
  }

  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const userAuthDir = path.resolve(__dirname, "auth_sessions");
    // Ensure the directory exists
    if (!fs.existsSync(userAuthDir)) {
      fs.mkdirSync(userAuthDir, { recursive: true });
    }
    const userAuthPath = path.resolve(userAuthDir, `${userId}_auth.json`);

    // Validate it's proper JSON before saving
    JSON.parse(authContent);

    fs.writeFileSync(userAuthPath, authContent);
    console.log(`Successfully saved auth session for user: ${userId}`);
    res.send(
      "<h1>Success!</h1><p>Your Uber account is now linked. You can close this window and start using the app with your voice.</p>"
    );
  } catch (error) {
    console.error(`Failed to save auth for user ${userId}:`, error);
    res
      .status(500)
      .send(
        "<h1>Error</h1><p>The content you pasted was not valid JSON. Please try again.</p>"
      );
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`Omi Uber App server listening on port ${CONFIG.PORT}`);
});
