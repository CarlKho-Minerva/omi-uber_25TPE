// server.mjs (FINAL - DIRECT TRANSPLANT OF THE PROVEN SCRIPT)
import express from "express";
import { chromium } from "playwright";
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
  HEADLESS_MODE: false, // KEEP THIS FALSE TO WATCH IT WORK!
  SEND_NOTIFICATIONS: false,
  OMI_APP_ID: process.env.OMI_APP_ID,
  OMI_APP_SECRET: process.env.OMI_APP_SECRET,
  PORT: process.env.PORT || 3000,
  GEOLOCATION: {
    latitude: 25.006625,
    longitude: 121.534203,
  },
};
// ==============================================================================

const app = express();
app.use(express.json());

// --- MAIN WEBHOOK ENDPOINT ---
app.post("/webhook", async (req, res) => {
  console.log("\n--- NEW WEBHOOK RECEIVED ---");
  const userId = req.query.uid;
  const transcript = (req.body.transcript_segments || [])
    .map((segment) => segment.text)
    .join(" ")
    .toLowerCase();

  if (!userId || !transcript.includes("uber to")) {
    return res.status(400).send("Invalid request");
  }

  const destination = transcript.split("uber to")[1].trim();
  console.log(`Parsed Destination: "${destination}" for User: ${userId}`);

  res.status(200).send("Processing request");

  (async () => {
    await sendOmiNotification(
      userId,
      `Okay, preparing your Uber to ${destination}...`
    );
    try {
      const rideDetails = await getUberPrice(destination, CONFIG.GEOLOCATION);
      const confirmationMessage = `Ride to ${destination}: ${rideDetails.priceText} (${rideDetails.eta}). Tap to confirm.`;
      await sendOmiNotification(userId, confirmationMessage);
    } catch (error) {
      console.error("Playwright automation failed:", error);
      await sendOmiNotification(
        userId,
        "Sorry, I was unable to get Uber details right now."
      );
    }
  })();
});

// --- THE CORE PLAYWRIGHT LOGIC (DIRECTLY FROM YOUR WORKING SCRIPT) ---
async function getUberPrice(destination, geolocation) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const storageStatePath = path.resolve(__dirname, "auth.json");

  if (!fs.existsSync(storageStatePath)) {
    throw new Error("auth.json not found. Please run codegen first.");
  }

  const browser = await chromium.launch({
    headless: CONFIG.HEADLESS_MODE,
    channel: "chrome",
  });
  const context = await browser.newContext({
    storageState: storageStatePath,
    geolocation: geolocation,
    permissions: ["geolocation"],
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    console.log("Navigating to m.uber.com...");
    await page.goto("https://m.uber.com");

    // --- START OF PROVEN, WORKING LOGIC ---
    console.log("Starting robust pickup handling...");
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
        const useCurrent = page
          .getByRole("option", {
            name: /current location|Your current location|Use my location|Use current location/i,
          })
          .first();
        if ((await useCurrent.count()) > 0) await useCurrent.click();

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

    console.log("Waiting for dropoff selector...");
    const dropSelector =
      '[data-testid="enhancer-container-drop0"] [role="combobox"]';
    await page.waitForSelector(dropSelector, { timeout: 30000 });

    console.log(`Typing destination: "${destination}"`);
    await page.click(dropSelector);
    await page.fill(dropSelector, destination);

    try {
      const firstSuggestion = page
        .getByRole("option", { name: new RegExp(destination, "i") })
        .first();
      await firstSuggestion.waitFor({ timeout: 2000 });
      await firstSuggestion.click();
    } catch (err) {
      await page.keyboard.press("Enter");
    }

    console.log("Waiting for Search button to be enabled...");
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

    console.log("Clicking Search button...");
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) =>
          /search/i.test(
            (b.getAttribute("aria-label") || b.innerText || "").trim()
          ) && !b.disabled
      );
      if (btn) btn.click();
    });

    console.log("Waiting for ride options listbox...");
    await page.waitForSelector("role=listbox", { timeout: 30000 });

    console.log("Parsing ride options...");
    const options = page.locator("role=option");
    const firstOption = options.first();
    const allText = await firstOption.locator("p").allTextContents();
    const priceText = allText.pop() || "";
    const eta = allText.find((t) => /min/i.test(t)) || "N/A";

    // --- END OF PROVEN, WORKING LOGIC ---

    console.log(`Scraped Details: Price=${priceText}, ETA=${eta}`);
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
app.listen(CONFIG.PORT, () => {
  console.log(`Omi Uber App server listening on port ${CONFIG.PORT}`);
});
