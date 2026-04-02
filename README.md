# TSLA Options Analyzer — Setup & Deployment Guide

## What This App Does
- Fetches **live, real-time** TSLA price, volume, and options data from Yahoo Finance
- Calculates **12 technical indicators** (RSI, MACD, EMA 20/50/200, Bollinger Bands, Stochastic, Williams %R, OBV, ATR, Volume, Implied Volatility)
- Uses **Claude AI** to synthesize all indicators into a trade recommendation
- Gives you a **$10 beginner trade plan** with step-by-step Robinhood instructions
- Teaches you what everything means with built-in explanations

---

## STEP 1 — Get Your Anthropic API Key

1. Go to **https://console.anthropic.com**
2. Sign up or log in
3. Click **"API Keys"** in the left sidebar
4. Click **"Create Key"**, name it "TSLA Analyzer", copy the key
5. **Save it somewhere safe** — you only see it once

---

## STEP 2 — Deploy to Railway (Free Hosting)

Railway gives you free hosting with no credit card required.

### 2a. Create a GitHub repository

1. Go to **https://github.com** and sign in (or create a free account)
2. Click the **"+"** button → **"New repository"**
3. Name it `tsla-analyzer`, set it to **Public**, click **Create repository**
4. On your computer, open a terminal in the folder where these files are
5. Run these commands one by one:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/tsla-analyzer.git
   git push -u origin main
   ```
   (Replace YOUR_USERNAME with your GitHub username)

### 2b. Deploy on Railway

1. Go to **https://railway.app** and sign in with GitHub
2. Click **"New Project"**
3. Click **"Deploy from GitHub repo"**
4. Select your `tsla-analyzer` repository
5. Railway will automatically detect it's a Node.js app and deploy it
6. Wait about 2 minutes for the first deploy to finish

### 2c. Add your API key to Railway

1. In Railway, click on your project
2. Click the **"Variables"** tab
3. Click **"New Variable"**
4. Name: `ANTHROPIC_API_KEY`
5. Value: paste your API key from Step 1
6. Click **Add** — Railway will automatically redeploy

### 2d. Get your URL

1. Click the **"Settings"** tab in Railway
2. Under **"Domains"**, click **"Generate Domain"**
3. You'll get a URL like `tsla-analyzer-production.up.railway.app`
4. **That's your app!** Open it in any browser or on your phone

---

## STEP 3 — Using the App

1. Open your Railway URL on any device
2. Click **"▶ RUN LIVE ANALYSIS"**
3. Watch it fetch live data in real time (takes 10–20 seconds)
4. Read the results — everything has an **EXPLAIN THIS** button that teaches you what it means
5. Follow the **Step-by-Step Robinhood Guide** at the bottom to place the trade

---

## Alternative: Run Locally on Your Computer

If you want to test it on your own computer first:

1. Install **Node.js** from https://nodejs.org (download the LTS version)
2. Open a terminal in the `tsla-analyzer` folder
3. Run: `npm install`
4. Run: `ANTHROPIC_API_KEY=your_key_here npm start` (Mac/Linux)
   Or on Windows: create a file called `.env` with `ANTHROPIC_API_KEY=your_key_here` then run `npm start`
5. Open your browser and go to **http://localhost:3000**

---

## Updating the App

Whenever you want to update your app:
1. Make your changes to the files
2. Run: `git add . && git commit -m "Update" && git push`
3. Railway automatically redeploys within 1–2 minutes

---

## Costs

- **Railway free tier**: 500 hours/month free — more than enough for personal use
- **Anthropic API**: Each analysis call costs roughly $0.01–0.03. With $5 in API credits you can run ~200+ analyses
- **Yahoo Finance data**: Completely free, no API key needed

---

## Troubleshooting

**"Error: server error 500"** — Check that your ANTHROPIC_API_KEY is set correctly in Railway Variables

**"Cannot connect"** — Make sure Railway has finished deploying (check the Deploy tab for status)

**Analysis takes long** — Normal! It's fetching live data + running AI analysis. Usually 10–25 seconds.

**Data looks wrong** — Yahoo Finance occasionally has delays. Try running the analysis again.
