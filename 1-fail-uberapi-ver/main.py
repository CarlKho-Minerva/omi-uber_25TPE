# main.py
from fastapi import FastAPI, Request
import logging
from uber_rides.session import Session
from uber_rides.client import UberRidesClient

# --- CONFIGURATION ---
# Paste your Server Token from the Uber Developer Dashboard
SERVER_TOKEN = 'fIwqcfcoRWAfFLTNTxjIl_2COC41BYTm4z0jrIsV'

# Set up basic logging to see requests in the terminal
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- INITIALIZE UBER CLIENT ---
# We use the simple Session with a Server Token for estimates
session = Session(server_token=SERVER_TOKEN)
client = UberRidesClient(session)

# Create an instance of the FastAPI application
app = FastAPI()

# --- WEBHOOK ENDPOINT ---
@app.post("/webhook")
async def receive_omi_webhook(request: Request):
    payload = await request.json()
    logger.info("--- OMI WEBHOOK RECEIVED ---")
    logger.info(payload)
    logger.info("----------------------------")

    # --- UBER LOGIC STARTS HERE ---
    try:
        # For now, we will use HARDCODED coordinates for our test.
        # Start: San Francisco City Hall
        start_latitude = 37.779280
        start_longitude = -122.419230
        # End: Golden Gate Bridge Welcome Center
        end_latitude = 37.807650
        end_longitude = -122.474810

        logger.info("Requesting price estimates from Uber API...")

        # Make the API call to get price estimates
        response = client.get_price_estimates(
            start_latitude=start_latitude,
            start_longitude=start_longitude,
            end_latitude=end_latitude,
            end_longitude=end_longitude
        )

        estimates = response.json.get('prices')

        # Log the successful result
        logger.info("--- UBER ESTIMATES RECEIVED ---")
        logger.info(estimates)
        logger.info("-------------------------------")

    except Exception as e:
        logger.error("--- UBER API ERROR ---")
        logger.error(e)
        logger.error("----------------------")

    return {"status": "success", "message": "Webhook processed"}