# uvicorn main:app --reload

from fastapi import FastAPI, Request
import logging

# Set up basic logging to see requests in the terminal
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Create an instance of the FastAPI application
app = FastAPI()


# Define a "route" for the root URL
@app.get("/")
def read_root():
    logger.info("Root URL was accessed. The server is running!")
    return {"Hello": "World"}


# Define the route for our Omi webhook
# This will listen for POST requests at the /webhook URL
@app.post("/webhook")
async def receive_omi_webhook(request: Request):
    # Get the JSON data that Omi sends
    payload = await request.json()

    # Print the received data to the terminal for debugging
    logger.info("--- OMI WEBHOOK RECEIVED ---")
    logger.info(payload)
    logger.info("----------------------------")

    # Send a simple response back
    return {"status": "success", "message": "Webhook received"}
