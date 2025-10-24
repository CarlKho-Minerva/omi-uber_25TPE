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
  AUTO_CONFIRM_RIDE: true, // DANGER: THIS WILL REQUEST A REAL UBER AND COST MONEY.
  HEADLESS_MODE: true,
  SEND_NOTIFICATIONS: true,
  OMI_APP_ID: process.env.OMI_APP_ID,
  OMI_APP_SECRET: process.env.OMI_APP_SECRET,
  PORT: process.env.PORT || 8080,
};
// ==============================================================================

const app = express();
app.use(express.json());

// Health check endpoint for the cloud platform
app.get("/", (req, res) => {
  res.status(200).send("Omi Uber App is running!");
});

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
        const confirmationMessage = `Ride from ${origin} to ${destination}: ${rideDetails.priceText} (${rideDetails.eta}). Uber will send a notification when the ride is confirmed.`;
        await sendOmiNotification(userId, confirmationMessage);
      } catch (error) {
        console.error("Playwright automation failed:", error);
        // await sendOmiNotification(
        //   userId,
        //   "Sorry, I was unable to get details."
        // );
      }
    })();
  } else {
    res.status(200).send("No action taken.");
  }
});

// --- THE CORE PLAYWRIGHT LOGIC (FINAL MULTI-USER VERSION) ---
async function getUberPrice(userId, origin, destination) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // THE CRITICAL CHANGE FOR MULTI-USER:
  // It now looks for a unique auth file for each user inside the 'auth_sessions' folder.
  const storageStatePath = path.resolve(
    __dirname,
    "auth_sessions",
    `${userId}_auth.json`
  );

  if (!fs.existsSync(storageStatePath)) {
    // We throw a more user-friendly error now.
    throw new Error(
      `Authentication file not found for this user. Please complete the one-time setup.`
    );
  }

  const browser = await chromium.launch({
    headless: CONFIG.HEADLESS_MODE,
    channel: "chrome",
    bypassCSP: true,
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

    console.log(`Scraped Details: Price=${priceText}, ETA=${eta}`);
    // --- START OF FINAL, ROBUST DEMO BLOCK ---
    if (CONFIG.AUTO_CONFIRM_RIDE) {
      console.log("[LIVE MODE] Selecting first ride option...");
      await firstOption.click();

      // Give the page a moment to react and potentially render the modal
      await page.waitForTimeout(1500);

      // --- PRECISE FIX: DEFENSIVELY PRESS ESCAPE TO CLOSE ANY MODAL ---
      console.log("[LIVE MODE] Defensively checking for any pop-up modal...");

      // A generic locator for any dialog box on the page
      const anyDialog = page.locator('div[role="dialog"]').first();

      // Check if the dialog actually appeared and is visible
      if ((await anyDialog.count()) > 0 && (await anyDialog.isVisible())) {
        console.log(
          "[LIVE MODE] Modal detected. Pressing 'Escape' key to close it."
        );
        // The most reliable way to close a modal
        await page.keyboard.press("Escape");
        // Wait for the dismiss animation to complete before proceeding
        await page.waitForTimeout(1000);
      } else {
        console.log(
          "[LIVE MODE] No modal found. Continuing directly to request button."
        );
      }
      // --- END OF FIX ---

      console.log("[LIVE MODE] Finding the 'Request' button...");
      const requestButton = page.locator(
        'button[data-testid="request_trip_button"]'
      );

      console.log("[LIVE MODE] Scrolling to the 'Request' button...");
      await requestButton.scrollIntoViewIfNeeded();

      console.log("[LIVE MODE] Clicking final 'Request' button...");
      await requestButton.click();

      console.log(
        "[LIVE MODE] Ride requested! Waiting 15 seconds for Uber's system to process..."
      );
      await page.waitForTimeout(15000);
    }
    // --- END OF LIVE CONFIRMATION LOGIC ---

    return { priceText: priceText.trim(), eta: eta.trim() };
  } catch (error) {
    const debugPath = path.resolve(__dirname, "playwright-error.png");
    await page.screenshot({ path: debugPath, fullPage: true });
    console.error(`Debug screenshot saved to ${debugPath}`);
    throw error;
  } finally {
    console.log("Closing browser.");
    // await browser.close();
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

// ==============================================================================
// --- ONBOARDING FLOW ---
// ==============================================================================

// This endpoint serves the beautiful, Uber-styled instruction page.
app.get("/onboarding", (req, res) => {
  const userId = req.query.uid;
  if (!userId) {
    return res
      .status(400)
      .send("<h1>Error: Omi User ID is missing from the link.</h1>");
  }
  res.send(generateOnboardingHTML(userId));
});

// --- THE SAVE ENDPOINT (WITH CRITICAL FIX) ---
app.post(
  "/save_auth",
  express.text({ type: "text/plain" }),
  async (req, res) => {
    const userId = req.query.uid;
    const rawBody = req.body;

    if (!userId || !rawBody || !rawBody.includes("=")) {
      return res.status(400).send("Missing user ID or auth content.");
    }

    try {
      // Step 1: Extract the content after the first '='. This is the raw JSON string.
      const authContent = rawBody.substring(rawBody.indexOf("=") + 1);

      // Step 2: Validate that the extracted string is proper JSON. No decoding is needed.
      JSON.parse(authContent);

      // Step 3: The rest of the logic remains the same.
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const userAuthDir = path.resolve(__dirname, "auth_sessions");
      if (!fs.existsSync(userAuthDir)) {
        fs.mkdirSync(userAuthDir, { recursive: true });
      }
      const userAuthPath = path.resolve(userAuthDir, `${userId}_auth.json`);

      // Step 4: Save the original, validated content.
      fs.writeFileSync(userAuthPath, authContent);

      console.log(`Successfully saved auth session for user: ${userId}`);
      res.send(
        "<h1>Success!</h1><p>Your Uber account is linked. You can now close this window and start using the app.</p>"
      );
    } catch (error) {
      console.error(`Failed to save auth for user ${userId}:`, error.message);
      res
        .status(500)
        .send(
          "<h1>Error</h1><p>The content you pasted was not valid JSON. Please copy the entire file contents and try again.</p>"
        );
    }
  }
);

// This function generates the beautiful HTML page.
function generateOnboardingHTML(userId) {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Link Your Uber Account</title>
        <style>
            @import url('https://d3i4yxtzktqr9n.cloudfront.net/web-eats-legacy/v1/css/UberMoveText.css');
            body { margin: 0; font-family: 'Uber Move Text', sans-serif; background-color: #f6f6f6; color: #111; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 20px; box-sizing: border-box; }
            .container { background-color: #fff; padding: 48px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 600px; width: 100%; }
            .header { font-family: 'Uber Move', sans-serif; font-size: 36px; font-weight: 700; margin-bottom: 24px; }
            p, li { font-size: 16px; line-height: 1.6; color: #545454; }
            ol { padding-left: 20px; }
            code { background: #eee; padding: 5px 8px; border-radius: 5px; font-family: monospace; word-break: break-all; border: 1px solid #e0e0e0; }
            textarea { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; margin-top: 16px; resize: vertical; box-sizing: border-box; }
            button { background-color: #000; color: #fff; border: none; padding: 14px 24px; font-size: 16px; font-weight: 500; border-radius: 8px; cursor: pointer; width: 100%; margin-top: 24px; transition: background-color 0.2s; }
            button:hover { background-color: #333; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">Link Your Uber Account</div>
            <p>To use voice commands with Omi, this app needs to securely link your Uber session. Your password is never seen or stored by our service.</p>
            <h3>Instructions</h3>
            <ol>
                <li><b>On a computer</b>, open a terminal and run this command:</li>
                <li><code>npx playwright codegen --save-storage=auth.json https://m.uber.com</code></li>
                <li>A new browser will open. Please <b>log in to your Uber account.</b></li>
                <li>After you are logged in, close that browser window.</li>
                <li>A file named <b>auth.json</b> will be saved. Open it with a text editor.</li>
                <li>Copy the <b>entire contents</b> of the file and paste it into the box below.</li>
            </ol>
            <form action="/save_auth?uid=${userId}" method="post" enctype="text/plain">
                <textarea name="auth_content" rows="8" placeholder="Paste the entire contents of your auth.json file here..." required></textarea>
                <button type="submit">Save My Uber Session</button>
            </form>
        </div>
    </body>
    </html>
  `;
}

app.listen(CONFIG.PORT, () => {
  console.log(`Omi Uber App server listening on port ${CONFIG.PORT}`);
});
