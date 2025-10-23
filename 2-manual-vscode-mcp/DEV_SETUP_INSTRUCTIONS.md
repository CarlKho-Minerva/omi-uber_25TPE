# Omi Uber App: First-Time Setup

Welcome! To use this app, you first need to link it securely to your Uber account. This is a one-time setup that saves your login session so our automation can get ride estimates for you.

**Your login details are saved ONLY on your computer and are never sent to our servers.**

## Instructions

1. **Open Your Computer's Terminal:** You will need to run a single command from your computer's command line.
2. **Navigate to a Directory:** Go to any folder you like, for example, your Desktop.
3. **Run the Playwright Command:** Copy and paste the following command into your terminal and press Enter:

    ```bash
    npx playwright codegen --save-storage=auth.json https://m.uber.com
    ```

4. **Log In to Uber:** A special Chromium browser window will open. Please log in to your Uber account as you normally would.
    * **IMPORTANT:** This browser is a clean version of Chromium and is not your regular Chrome. Google may flag this as an "unsafe login." This is expected. Please proceed with any two-factor authentication (OTP) that Uber or Google requires. This is a standard security measure.

5. **Confirm Login:** Once you are successfully logged in and see the main Uber map screen, you can close the Chromium browser window.

6. **Find Your `auth.json` file:** A new file named `auth.json` will have been created in the directory where you ran the command.

7. **Provide the Session File:** In the Omi app, you will be prompted to upload or paste the contents of this `auth.json` file. This completes the setup!

You are now ready to use the "Uber to..." command.
