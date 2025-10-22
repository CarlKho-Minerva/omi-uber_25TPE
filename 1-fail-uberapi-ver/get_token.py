# get_token.py
# This is a one-time use script to get your access tokens.

from uber_rides.auth import AuthorizationCodeGrant
import webbrowser

CLIENT_ID = ""
CLIENT_SECRET = ""
REDIRECT_URI = "http://localhost:5000/oauth/callback"

auth_flow = AuthorizationCodeGrant(
    CLIENT_ID,
    ["request"],  # The 'scope' we need to request rides
    CLIENT_SECRET,
    REDIRECT_URI,
)

# Step 1: Get the authorization URL
auth_url = auth_flow.get_authorization_url()
print("--- STEP 1: AUTHORIZE YOUR APP ---")
print("1. A browser window will now open.")
print("2. Log in to your Uber account.")
print("3. Click 'Allow' to grant access to your application.")
print("------------------------------------")
webbrowser.open(auth_url)

# Step 2: Paste the redirect URL
redirect_url = input(
    "4. After allowing, you will be redirected to a blank page. Copy the FULL URL from your browser's address bar and paste it here: "
)

# Step 3: Exchange the code for a token
try:
    session = auth_flow.get_session(redirect_url)
    credentials = session.oauth2credential
    print("\n--- SUCCESS! YOUR CREDENTIALS ---")
    print("ACCESS TOKEN: ", credentials.access_token)
    print("REFRESH TOKEN:", credentials.refresh_token)
    print("\n--- SAVE THESE! You will need the ACCESS TOKEN for the next step. ---")
except Exception as e:
    print("\n--- ERROR ---")
    print("Could not get token. Please check your Client ID, Secret, and Redirect URI.")
    print(e)
