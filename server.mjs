// server.mjs (Secure Version)
import express from "express";
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// --- CONFIGURATION ---
const OMI_APP_ID = process.env.OMI_APP_ID;
const OMI_APP_SECRET = process.env.OMI_APP_SECRET;
const PORT = process.env.PORT || 3000;

// --- A simple in-memory store for pending rides ---
const pendingRides = new Map();

// --- OMI NOTIFIER HELPER ---
async function sendOmiNotification(userId, message) {
  console.log(`Sending notification to ${userId}: "${message}"`);
  const url = `https://api.omi.me/v2/integrations/${OMI_APP_ID}/notification?uid=${encodeURIComponent(
    userId
  )}&message=${encodeURIComponent(message)}`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${OMI_APP_SECRET}` },
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OMI API Error: ${response.statusText} - ${errorBody}`);
    }
    console.log("Notification sent successfully.");
  } catch (error) {
    console.error("Failed to send Omi notification:", error);
  }
}

// --- SETUP EXPRESS APP ---
const app = express();
app.use(express.json());

// --- THE MAIN WEBHOOK ENDPOINT (FINAL CORRECTED VERSION) ---
app.post("/webhook", async (req, res) => {
  console.log("--- NEW WEBHOOK RECEIVED FROM OMI ---");
  console.log("Query Parameters Received:", req.query);
  console.log("Full Request Body Received:", JSON.stringify(req.body, null, 2));

  const userId = req.query.uid;

  // --- THE FIX IS HERE ---
  // We now correctly read the transcript from the "transcript_segments" array.
  // We map over each segment, get its text, and join them together with a space.
  const transcript = (req.body.transcript_segments || [])
    .map((segment) => segment.text)
    .join(" ")
    .toLowerCase();

  // --- VALIDATION LOGIC ---
  if (!userId) {
    console.error('VALIDATION FAILED: No "uid" found in query parameters.');
    return res.status(400).send("Invalid request: Missing user ID.");
  }

  // Check if we were able to build a transcript
  if (!transcript) {
    console.error(
      'VALIDATION FAILED: The request body does not contain "transcript_segments".'
    );
    return res
      .status(400)
      .send("Invalid request: Payload is missing transcript data.");
  }

  // Check for the trigger phrase
  if (!transcript.includes("uber to")) {
    console.error(
      `VALIDATION FAILED: Transcript "${transcript}" does not contain "uber to".`
    );
    return res.status(400).send("Invalid request: Trigger phrase not found.");
  }

  console.log(
    "Validation successful. Proceeding with Playwright automation..."
  );

  // 1. Parse the destination
  const destination = transcript.split("uber to")[1].trim();
  console.log(`Parsed Destination: ${destination} for User: ${userId}`);

  // 2. Send the "Preparing" notification
  await sendOmiNotification(
    userId,
    `Okay, preparing your Uber to ${destination}..`
  );
  res.status(200).send("Processing request");

  // 3. Launch Playwright in the background
  try {
    const rideDetails = await getUberPrice(destination);
    const rideId = Date.now().toString();
    pendingRides.set(rideId, { userId, destination });
    const confirmationMessage = `Ride to ${destination}: ${rideDetails.priceText} (${rideDetails.eta}). Tap here to confirm.`;
    await sendOmiNotification(userId, confirmationMessage);
  } catch (error) {
    console.error("Playwright automation failed:", error);
    await sendOmiNotification(
      userId,
      "Sorry, I was unable to get Uber details right now."
    );
  }
});

// --- THE PLAYWRIGHT LOGIC ---
async function getUberPrice(destination) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const storageStatePath = path.resolve(__dirname, "auth.json");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();

  try {
    console.log("Navigating to m.uber.com...");
    await page.goto("https://m.uber.com", { waitUntil: "domcontentloaded" });

    console.log("Filling destination...");
    await page.getByLabel("Where to?").fill(destination);
    await page.keyboard.press("Enter");

    console.log("Waiting for ride options...");
    await page.waitForSelector("role=listbox");

    const firstOption = page.locator("role=option").first();
    const priceText =
      (await firstOption.locator("p").allTextContents()).pop() || "";
    const eta =
      (await firstOption.locator("p").allTextContents()).find((t) =>
        /min/i.test(t)
      ) || "N/A";

    console.log(`Scraped Details: Price=${priceText}, ETA=${eta}`);
    return { priceText: priceText.trim(), eta: eta.trim() };
  } finally {
    await browser.close();
  }
}

// --- START THE SERVER ---
app.listen(PORT, () => {
  console.log(`Omi Uber App server listening on port ${PORT}`);
  console.log(`Webhook endpoint: http://localhost:${PORT}/webhook`);
});
