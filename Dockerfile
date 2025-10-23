# Use the official Playwright image which includes browsers and all dependencies
FROM mcr.microsoft.com/playwright/javascript:v1-jammy

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install project dependencies
RUN npm install

# Copy the rest of your application's code into the container
COPY . .

# --- This line is not needed because the base image already has browsers installed ---
RUN npx playwright install --with-deps chrome

# Tell Railway what port your app listens on
EXPOSE 8080

# The command to start your application
CMD ["node", "server.mjs"]