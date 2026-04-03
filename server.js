const express = require("express");
const fetch = require("node-fetch");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require("cors");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Active monitors ──────────────────────────────────────────────────────────
const activeMonitors = {};

// ─── Email ────────────────────────────────────────────────────────────────────
async function sendAlertEmail(to, subject, html) {
  if (!process.env.ALERT_EMAIL || !process.env.ALERT_EMAIL_PASSWORD) {
    console.log("Email not configured:", subject);
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.ALERT_EMAIL, pass: process.env.ALERT_EMAIL_PASSWORD },
    });
    await transporter.sendMail({ from: process.env.ALERT_EMAIL, to, subject, html });
    console.log("Email sent:", subject);
    return true;
  } catch (err) {
    console.error("Email error:", err.message);
    return false;
  }
}

// ─── Fetch current price only ─────────────────────────────────────────────────
async function getCurrentPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const data = await res.json();
  return parseFloat(data.chart.result[0].meta.regularMarketPrice.toFixed(2));
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────
async function getQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);
  return res.json();
}

async function getOptions(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Options error: ${res.status}`);
  return res.json();
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses += Math.abs(diff);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(2));
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return { macdLine: parseFloat((ema12 - ema26).toFixed(2)), ema12, ema26, bullish: ema12 > ema26 };
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period);
  return { upper: parseFloat((mean + 2 * std).toFixed(2)), middle: parseFloat(mean.toFixed(2)), lower: parseFloat((mean - 2 * std).toFixed(2)) };
}

function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++)
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  return parseFloat((trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(2));
}

function calcStochastic(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;
  const hh = Math.max(...highs.slice(-period)), ll = Math.min(...lows.slice(-period));
  const cur = closes[closes.length - 1];
  return hh === ll ? 50 : parseFloat(((cur - ll) / (hh - ll) * 100).toFixed(2));
}

function calcWilliamsR(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;
  const hh = Math.max(...highs.slice(-period)), ll = Math.min(...lows.slice(-period));
  const cur = closes[closes.length - 1];
  return hh === ll ? -50 : parseFloat(((hh - cur) / (hh - ll) * -100).toFixed(2));
}

function calcOBVTrend(closes, volumes) {
  let obv = 0;
  const obvValues = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) obv += volumes[i];
    else if (closes[i] < closes[i-1]) obv -= volumes[i];
    obvValues.push(obv);
  }
  const recent = obvValues.slice(-10);
  return { obv: parseFloat((obv / 1e6).toFixed(1)), trend: recent[recent.length-1] > recent[0] ? "RISING" : "FALLING" };
}

function analyzeVolume(volumes) {
  const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const today = volumes[volumes.length - 1];
  const ratio = today / avg20;
  return { today, avg20: Math.round(avg20), ratio: parseFloat(ratio.toFixed(2)), trend: ratio > 1.2 ? "HIGH" : ratio < 0.8 ? "LOW" : "AVERAGE" };
}

function findSupportResistance(highs, lows, closes, currentPrice) {
  const recentH = highs.slice(-60), recentL = lows.slice(-60);
  const supports = [], resistances = [];
  for (let i = 2; i < recentL.length - 2; i++) {
    if (recentL[i] < recentL[i-1] && recentL[i] < recentL[i-2] && recentL[i] < recentL[i+1] && recentL[i] < recentL[i+2])
      supports.push(parseFloat(recentL[i].toFixed(2)));
    if (recentH[i] > recentH[i-1] && recentH[i] > recentH[i-2] && recentH[i] > recentH[i+1] && recentH[i] > recentH[i+2])
      resistances.push(parseFloat(recentH[i].toFixed(2)));
  }
  return {
    supports: [...new Set(supports)].filter(s => s < currentPrice).sort((a,b) => b-a).slice(0,3),
    resistances: [...new Set(resistances)].filter(r => r > currentPrice).sort((a,b) => a-b).slice(0,3),
  };
}

// ─── Fetch all market data ────────────────────────────────────────────────────
async function fetchMarketData() {
  const [quoteData, optionsData] = await Promise.all([
    getQuote("TSLA"),
    getOptions("TSLA").catch(() => null),
  ]);
  const chart = quoteData.chart.result[0];
  const meta = chart.meta;
  const q = chart.indicators.quote[0];
  const closes = q.close.filter(Boolean);
  const highs = q.high.filter(Boolean);
  const lows = q.low.filter(Boolean);
  const volumes = q.volume.filter(Boolean);
  const currentPrice = parseFloat(meta.regularMarketPrice.toFixed(2));
  const prevClose = parseFloat(meta.chartPreviousClose.toFixed(2));

  let impliedVolatility = null, nearATMOptions = [];
  if (optionsData?.optionChain?.result?.[0]) {
    const calls = optionsData.optionChain.result[0].options?.[0]?.calls || [];
    nearATMOptions = calls.filter(c => Math.abs(c.strike - currentPrice) < currentPrice * 0.05).slice(0, 3)
      .map(c => ({ type: "CALL", strike: c.strike, lastPrice: c.lastPrice, iv: c.impliedVolatility ? parseFloat((c.impliedVolatility * 100).toFixed(1)) : null, expiration: new Date(c.expiration * 1000).toLocaleDateString() }));
    if (calls[0]?.impliedVolatility) impliedVolatility = parseFloat((calls[0].impliedVolatility * 100).toFixed(1));
  }

  const volumeAnalysis = analyzeVolume(volumes);
  const { supports, resistances } = findSupportResistance(highs, lows, closes, currentPrice);

  return {
    price: { current: currentPrice, previousClose: prevClose, change: parseFloat(((currentPrice - prevClose) / prevClose * 100).toFixed(2)), week52High: parseFloat(meta.fiftyTwoWeekHigh.toFixed(2)), week52Low: parseFloat(meta.fiftyTwoWeekLow.toFixed(2)) },
    volume: volumeAnalysis,
    indicators: {
      rsi: calcRSI(closes), macd: calcMACD(closes),
      ema20: calcEMA(closes, 20), ema50: calcEMA(closes, 50), ema200: calcEMA(closes, 200),
      bollinger: calcBollinger(closes), atr: calcATR(highs, lows, closes),
      stochastic: calcStochastic(highs, lows, closes), williamsR: calcWilliamsR(highs, lows, closes),
      obv: calcOBVTrend(closes, volumes),
    },
    levels: { supports, resistances },
    options: { impliedVolatility, nearATMOptions },
  };
}

// ─── Analyze endpoint ─────────────────────────────────────────────────────────
app.get("/api/analyze", async (req, res) => {
  try {
    const marketData = await fetchMarketData();
    const { price, volume, indicators, levels, options } = marketData;
    const { rsi, macd, ema20, ema50, ema200, bollinger, atr, stochastic, williamsR, obv } = indicators;

    const prompt = `You are an elite options trading analyst. You have LIVE TSLA data. User is a DAY TRADER (0-1 days) with $10 on Robinhood.

LIVE DATA: ${JSON.stringify(marketData, null, 2)}

Return ONLY valid JSON, no markdown:
{
  "signal": "BUY" or "SELL" or "HOLD",
  "confidence": "LOW" or "MEDIUM" or "HIGH",
  "signalExplanation": "2-3 sentences using real data values.",
  "accuracyScore": number,
  "indicatorConsensus": { "bullish": number, "bearish": number, "neutral": number },
  "currentPrice": ${price.current},
  "priceChange": ${price.change},
  "weekHigh": ${price.week52High},
  "weekLow": ${price.week52Low},
  "volume": "${Math.round(volume.today/1e6)}M",
  "avgVolume": "${Math.round(volume.avg20/1e6)}M",
  "exitStrategy": {
    "recommendedHoldTime": string,
    "latestExitTime": string,
    "sellSignals": [string, string, string, string, string],
    "doNotHoldIf": [string, string],
    "dayTradingTips": string
  },
  "probability": {
    "overallPercent": number,
    "factors": [
      {"label":"Trend Alignment","score":number,"note":string},
      {"label":"Momentum (MACD/RSI/Stoch)","score":number,"note":string},
      {"label":"Volume & OBV","score":number,"note":string},
      {"label":"Options Delta (est.)","score":number,"note":string},
      {"label":"Implied Volatility","score":number,"note":string},
      {"label":"Support/Resistance","score":number,"note":string},
      {"label":"Williams %R","score":number,"note":string}
    ],
    "verdict": string
  },
  "scenarios": [
    {"type":"bull","label":"Bull Case","probability":string,"tslaTarget":number,"tenDollarResult":string},
    {"type":"base","label":"Base Case","probability":string,"tslaTarget":number,"tenDollarResult":string},
    {"type":"bear","label":"Bear Case","probability":string,"tslaTarget":number,"tenDollarResult":string},
    {"type":"worst","label":"Worst Case","probability":string,"tslaTarget":number,"tenDollarResult":string}
  ],
  "entryPrice": number,
  "entryNote": string,
  "stopLoss": number,
  "stopNote": string,
  "profitTarget": number,
  "targetNote": string,
  "riskReward": string,
  "atrNote": string,
  "budget": {
    "suggestedOptionType": "CALL" or "PUT",
    "strikePrice": number,
    "expiration": string,
    "estimatedOptionCost": string,
    "maxLoss": "$10",
    "estimatedGain": string,
    "robinhoodNote": string
  },
  "indicators": [
    {"name":"RSI (14)","value":"${rsi}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"MACD","value":"${macd?.macdLine}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"EMA 20","value":"$${ema20}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"EMA 50","value":"$${ema50}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"EMA 200","value":"$${ema200}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"Bollinger Bands","value":string,"signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"Stochastic","value":"${stochastic}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"Williams %R","value":"${williamsR}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"OBV Trend","value":"${obv.trend}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"ATR (14)","value":"$${atr}","signal":"VOLATILITY","color":"yellow","meaning":string},
    {"name":"Volume Trend","value":"${volume.trend}","signal":string,"color":"green" or "red" or "yellow","meaning":string},
    {"name":"Implied Volatility","value":"${options.impliedVolatility ? options.impliedVolatility+"%" : "N/A"}","signal":string,"color":"green" or "red" or "yellow","meaning":string}
  ],
  "support": [
    {"level":${levels.supports[0]||price.current*0.95},"strength":"STRONG"},
    {"level":${levels.supports[1]||price.current*0.90},"strength":"MODERATE"},
    {"level":${levels.supports[2]||price.current*0.85},"strength":"WEAK"}
  ],
  "resistance": [
    {"level":${levels.resistances[0]||price.current*1.05},"strength":"STRONG"},
    {"level":${levels.resistances[1]||price.current*1.10},"strength":"MODERATE"},
    {"level":${levels.resistances[2]||price.current*1.15},"strength":"WEAK"}
  ],
  "analysis": "5-6 plain English sentences with real values. Day trading focused.",
  "robinhoodSteps": "6-8 numbered steps to place this exact day trade with $10 including when to check back and close same day."
}`;

    const aiResponse = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 3500,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = aiResponse.content[0].text;
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI parsing failed");
    const analysis = JSON.parse(jsonMatch[0]);
    analysis._rawData = { fetchedAt: new Date().toISOString(), indicators: marketData.indicators, volume: marketData.volume };

    res.json({ success: true, data: analysis });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Live price endpoint ──────────────────────────────────────────────────────
app.get("/api/price", async (req, res) => {
  try {
    const price = await getCurrentPrice("TSLA");
    res.json({ success: true, price });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start monitor ────────────────────────────────────────────────────────────
app.post("/api/monitor/start", async (req, res) => {
  const { email, entryPrice, stopLoss, profitTarget, signal, optionType } = req.body;
  if (!email || !entryPrice || !stopLoss || !profitTarget)
    return res.status(400).json({ success: false, error: "Missing fields" });

  const id = Date.now().toString();

  await sendAlertEmail(email, "🟢 TSLA Monitor Started",
    `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px">
      <h2 style="color:#00e5ff">📊 TSLA Monitor Active</h2>
      <p><strong style="color:#00ff88">Signal:</strong> ${signal} ${optionType}</p>
      <p><strong style="color:#00e5ff">Entry:</strong> $${entryPrice}</p>
      <p><strong style="color:#ff3b5c">Stop Loss:</strong> $${stopLoss}</p>
      <p><strong style="color:#00ff88">Profit Target:</strong> $${profitTarget}</p>
      <p style="color:#4a6b85;margin-top:12px;font-size:12px">Checking price every 3 minutes. You'll be emailed when either level is hit.</p>
    </div>`
  );

  const intervalId = setInterval(async () => {
    try {
      const monitor = activeMonitors[id];
      if (!monitor || monitor.triggered) { clearInterval(intervalId); delete activeMonitors[id]; return; }

      const currentPrice = await getCurrentPrice("TSLA");
      console.log(`[Monitor ${id}] $${currentPrice} | Stop:$${stopLoss} | Target:$${profitTarget}`);

      let subject = "", html = "", triggered = false;

      const isBuy = signal === "BUY";
      const hitStop = isBuy ? currentPrice <= stopLoss : currentPrice >= stopLoss;
      const hitTarget = isBuy ? currentPrice >= profitTarget : currentPrice <= profitTarget;

      if (hitStop) {
        triggered = true;
        subject = "🔴 SELL NOW — Stop Loss Hit — TSLA Analyzer";
        html = `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px">
          <h2 style="color:#ff3b5c">🔴 STOP LOSS HIT — SELL IMMEDIATELY</h2>
          <p style="font-size:20px">TSLA is at <strong style="color:#ff3b5c">$${currentPrice}</strong></p>
          <p>Your stop loss was <strong>$${stopLoss}</strong>.</p>
          <div style="background:rgba(255,59,92,0.1);padding:12px;border-left:3px solid #ff3b5c;margin-top:12px">
            <strong>Open Robinhood NOW and sell your option to limit your loss.</strong>
          </div>
        </div>`;
      } else if (hitTarget) {
        triggered = true;
        subject = "🟢 TAKE PROFIT — Target Hit — TSLA Analyzer";
        html = `<div style="font-family:monospace;background:#060a0f;color:#c8dff0;padding:24px">
          <h2 style="color:#00ff88">🟢 PROFIT TARGET HIT — SELL AND TAKE GAINS!</h2>
          <p style="font-size:20px">TSLA is at <strong style="color:#00ff88">$${currentPrice}</strong></p>
          <p>Your target was <strong>$${profitTarget}</strong>.</p>
          <div style="background:rgba(0,255,136,0.1);padding:12px;border-left:3px solid #00ff88;margin-top:12px">
            <strong>Open Robinhood NOW and sell your option to lock in profits!</strong>
          </div>
        </div>`;
      }

      if (triggered) {
        monitor.triggered = true;
        clearInterval(intervalId);
        await sendAlertEmail(email, subject, html);
        delete activeMonitors[id];
      }
    } catch (err) { console.error(`Monitor error:`, err.message); }
  }, 3 * 60 * 1000);

  activeMonitors[id] = { email, entryPrice, stopLoss, profitTarget, signal, optionType, intervalId, triggered: false };
  res.json({ success: true, monitorId: id });
});

// ─── Stop monitor ─────────────────────────────────────────────────────────────
app.post("/api/monitor/stop", (req, res) => {
  const { monitorId } = req.body;
  if (activeMonitors[monitorId]) {
    clearInterval(activeMonitors[monitorId].intervalId);
    delete activeMonitors[monitorId];
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "Not found" });
  }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TSLA Analyzer on port ${PORT}`));
