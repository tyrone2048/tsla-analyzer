const express = require("express");
const fetch = require("node-fetch");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helper: fetch from Yahoo Finance v8 quote ───────────────────────────────
async function getQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance quote error: ${res.status}`);
  const data = await res.json();
  return data;
}

// ─── Helper: fetch options chain ─────────────────────────────────────────────
async function getOptions(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/options/${symbol}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`Yahoo Finance options error: ${res.status}`);
  return res.json();
}

// ─── Calculate RSI ────────────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

// ─── Calculate EMA ────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

// ─── Calculate MACD ──────────────────────────────────────────────────────────
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = parseFloat((ema12 - ema26).toFixed(2));
  // Signal line would need more data points; approximate
  return { macdLine, ema12, ema26, bullish: macdLine > 0 };
}

// ─── Calculate Bollinger Bands ───────────────────────────────────────────────
function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: parseFloat((mean + 2 * std).toFixed(2)),
    middle: parseFloat(mean.toFixed(2)),
    lower: parseFloat((mean - 2 * std).toFixed(2)),
  };
}

// ─── Calculate Average True Range (ATR) ─────────────────────────────────────
function calcATR(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return parseFloat(atr.toFixed(2));
}

// ─── Find Support & Resistance ───────────────────────────────────────────────
function findSupportResistance(highs, lows, closes, currentPrice) {
  const recent = closes.slice(-60);
  const recentHighs = highs.slice(-60);
  const recentLows = lows.slice(-60);

  // Find local extremes
  const supports = [];
  const resistances = [];

  for (let i = 2; i < recent.length - 2; i++) {
    // Local low = support
    if (recentLows[i] < recentLows[i-1] && recentLows[i] < recentLows[i-2] &&
        recentLows[i] < recentLows[i+1] && recentLows[i] < recentLows[i+2]) {
      supports.push(parseFloat(recentLows[i].toFixed(2)));
    }
    // Local high = resistance
    if (recentHighs[i] > recentHighs[i-1] && recentHighs[i] > recentHighs[i-2] &&
        recentHighs[i] > recentHighs[i+1] && recentHighs[i] > recentHighs[i+2]) {
      resistances.push(parseFloat(recentHighs[i].toFixed(2)));
    }
  }

  // Filter: supports below current price, resistances above
  const filteredSupports = [...new Set(supports)]
    .filter(s => s < currentPrice)
    .sort((a, b) => b - a)
    .slice(0, 3);

  const filteredResistances = [...new Set(resistances)]
    .filter(r => r > currentPrice)
    .sort((a, b) => a - b)
    .slice(0, 3);

  return { supports: filteredSupports, resistances: filteredResistances };
}

// ─── Compute Volume Analysis ─────────────────────────────────────────────────
function analyzeVolume(volumes) {
  const recent = volumes.slice(-5);
  const avg20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const todayVol = recent[recent.length - 1];
  const ratio = todayVol / avg20;
  return {
    today: todayVol,
    avg20: Math.round(avg20),
    ratio: parseFloat(ratio.toFixed(2)),
    trend: ratio > 1.2 ? "HIGH" : ratio < 0.8 ? "LOW" : "AVERAGE",
  };
}

// ─── Stochastic Oscillator ───────────────────────────────────────────────────
function calcStochastic(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;
  const slice_h = highs.slice(-period);
  const slice_l = lows.slice(-period);
  const currentClose = closes[closes.length - 1];
  const highestHigh = Math.max(...slice_h);
  const lowestLow = Math.min(...slice_l);
  if (highestHigh === lowestLow) return 50;
  const k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
  return parseFloat(k.toFixed(2));
}

// ─── Williams %R ─────────────────────────────────────────────────────────────
function calcWilliamsR(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;
  const slice_h = highs.slice(-period);
  const slice_l = lows.slice(-period);
  const currentClose = closes[closes.length - 1];
  const highestHigh = Math.max(...slice_h);
  const lowestLow = Math.min(...slice_l);
  if (highestHigh === lowestLow) return -50;
  const wr = ((highestHigh - currentClose) / (highestHigh - lowestLow)) * -100;
  return parseFloat(wr.toFixed(2));
}

// ─── On-Balance Volume (OBV) trend ──────────────────────────────────────────
function calcOBVTrend(closes, volumes) {
  let obv = 0;
  const obvValues = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv += volumes[i];
    else if (closes[i] < closes[i - 1]) obv -= volumes[i];
    obvValues.push(obv);
  }
  const recentOBV = obvValues.slice(-10);
  const trend = recentOBV[recentOBV.length - 1] > recentOBV[0] ? "RISING" : "FALLING";
  return { obv: parseFloat((obv / 1e6).toFixed(1)), trend };
}

// ─── Main analysis endpoint ───────────────────────────────────────────────────
app.get("/api/analyze", async (req, res) => {
  try {
    // 1. Fetch real-time data from Yahoo Finance
    const [quoteData, optionsData] = await Promise.all([
      getQuote("TSLA"),
      getOptions("TSLA").catch(() => null),
    ]);

    const chart = quoteData.chart.result[0];
    const meta = chart.meta;
    const quotes = chart.indicators.quote[0];

    const closes = quotes.close.filter(Boolean);
    const highs = quotes.high.filter(Boolean);
    const lows = quotes.low.filter(Boolean);
    const volumes = quotes.volume.filter(Boolean);
    const timestamps = chart.timestamp;

    const currentPrice = parseFloat(meta.regularMarketPrice.toFixed(2));
    const prevClose = parseFloat(meta.chartPreviousClose.toFixed(2));
    const priceChange = parseFloat(((currentPrice - prevClose) / prevClose * 100).toFixed(2));
    const week52High = parseFloat(meta.fiftyTwoWeekHigh.toFixed(2));
    const week52Low = parseFloat(meta.fiftyTwoWeekLow.toFixed(2));
    const marketCap = meta.marketCap
      ? `$${(meta.marketCap / 1e9).toFixed(0)}B`
      : "N/A";

    // 2. Calculate all technical indicators
    const rsi = calcRSI(closes);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const ema200 = calcEMA(closes, 200);
    const macd = calcMACD(closes);
    const bollinger = calcBollinger(closes);
    const atr = calcATR(highs, lows, closes);
    const stoch = calcStochastic(highs, lows, closes);
    const williamsR = calcWilliamsR(highs, lows, closes);
    const volumeAnalysis = analyzeVolume(volumes);
    const obv = calcOBVTrend(closes, volumes);
    const { supports, resistances } = findSupportResistance(highs, lows, closes, currentPrice);

    // 3. Options chain data
    let optionsSummary = "Options data unavailable";
    let impliedVolatility = null;
    let nearATMOptions = [];
    if (optionsData?.optionChain?.result?.[0]) {
      const chain = optionsData.optionChain.result[0];
      const calls = chain.options?.[0]?.calls || [];
      const puts = chain.options?.[0]?.puts || [];
      // Find near ATM options
      nearATMOptions = calls
        .filter(c => Math.abs(c.strike - currentPrice) < currentPrice * 0.05)
        .slice(0, 3)
        .map(c => ({
          type: "CALL",
          strike: c.strike,
          lastPrice: c.lastPrice,
          iv: c.impliedVolatility ? parseFloat((c.impliedVolatility * 100).toFixed(1)) : null,
          delta: c.delta || null,
          expiration: new Date(c.expiration * 1000).toLocaleDateString(),
        }));
      if (calls[0]?.impliedVolatility) {
        impliedVolatility = parseFloat((calls[0].impliedVolatility * 100).toFixed(1));
      }
      optionsSummary = `${calls.length} calls, ${puts.length} puts available. Near-ATM IV: ${impliedVolatility ? impliedVolatility + "%" : "N/A"}`;
    }

    // 4. Build comprehensive market data summary for AI
    const marketData = {
      price: {
        current: currentPrice,
        previousClose: prevClose,
        change: priceChange,
        week52High,
        week52Low,
        marketCap,
      },
      volume: volumeAnalysis,
      indicators: {
        rsi,
        macd,
        ema20,
        ema50,
        ema200,
        bollinger,
        atr,
        stochastic: stoch,
        williamsR,
        obv,
      },
      levels: {
        supports,
        resistances,
      },
      options: {
        summary: optionsSummary,
        impliedVolatility,
        nearATMOptions,
      },
    };

    // 5. Send to Claude AI for expert analysis
    const prompt = `You are an elite options trading analyst with 20+ years experience, and also a patient teacher for beginners. You have been given LIVE, REAL-TIME market data for TSLA (Tesla Inc.) pulled directly from Yahoo Finance right now.

LIVE MARKET DATA:
${JSON.stringify(marketData, null, 2)}

Using ALL of this real data, provide a comprehensive options trading recommendation for a complete beginner who has $10 to start on Robinhood. Your analysis should be as accurate as possible — use ALL the indicators together to form a consensus view, not just one or two.

ACCURACY FRAMEWORK — use all of these:
- RSI: overbought >70, oversold <30
- MACD: bullish if macdLine > 0 and rising, bearish if < 0 and falling
- EMA trend: price vs EMA20, EMA50, EMA200 alignment
- Bollinger Bands: position within bands
- Stochastic: overbought >80, oversold <20
- Williams %R: overbought >-20, oversold <-80
- OBV: confirms or diverges from price trend
- ATR: for realistic stop loss and target placement
- Volume: confirms or weakens the signal
- Support/Resistance: entry, stop, and target placement
- Options IV: high IV means expensive options, adjust sizing advice

Return ONLY valid JSON, no markdown, no code fences:

{
  "signal": "BUY" or "SELL" or "HOLD",
  "confidence": "LOW" or "MEDIUM" or "HIGH",
  "signalExplanation": "2-3 plain English sentences explaining what this signal means and why — reference the actual live data values.",
  "accuracyScore": number (your honest assessment of signal accuracy 0-100, based on how many indicators agree),
  "indicatorConsensus": { "bullish": number, "bearish": number, "neutral": number },
  "currentPrice": ${currentPrice},
  "priceChange": ${priceChange},
  "weekHigh": ${week52High},
  "weekLow": ${week52Low},
  "volume": "${Math.round(volumeAnalysis.today / 1e6)}M",
  "avgVolume": "${Math.round(volumeAnalysis.avg20 / 1e6)}M",
  "probability": {
    "overallPercent": number (realistic 0-100),
    "factors": [
      { "label": "Trend Alignment", "score": number, "note": string },
      { "label": "Momentum (MACD/RSI/Stoch)", "score": number, "note": string },
      { "label": "Volume & OBV", "score": number, "note": string },
      { "label": "Options Delta (est.)", "score": number, "note": string },
      { "label": "Implied Volatility", "score": number, "note": string },
      { "label": "Support/Resistance", "score": number, "note": string },
      { "label": "Williams %R", "score": number, "note": string }
    ],
    "verdict": "2-3 sentences explaining the probability in plain English, referencing real data values."
  },
  "scenarios": [
    { "type": "bull", "label": "Bull Case", "probability": string, "tslaTarget": number, "tenDollarResult": string },
    { "type": "base", "label": "Base Case", "probability": string, "tslaTarget": number, "tenDollarResult": string },
    { "type": "bear", "label": "Bear Case", "probability": string, "tslaTarget": number, "tenDollarResult": string },
    { "type": "worst", "label": "Worst Case", "probability": string, "tslaTarget": number, "tenDollarResult": string }
  ],
  "entryPrice": number,
  "entryNote": string,
  "stopLoss": number,
  "stopNote": string,
  "profitTarget": number,
  "targetNote": string,
  "riskReward": string,
  "atrNote": "Plain English explanation of what the ATR of ${atr} means for this trade",
  "budget": {
    "suggestedOptionType": "CALL" or "PUT",
    "strikePrice": number (use real near-ATM strikes from the options data if available),
    "expiration": string,
    "estimatedOptionCost": string,
    "maxLoss": "$10",
    "estimatedGain": string,
    "robinhoodNote": string
  },
  "indicators": [
    { "name": "RSI (14)", "value": "${rsi}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "MACD", "value": "${macd?.macdLine}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "EMA 20", "value": "$${ema20}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "EMA 50", "value": "$${ema50}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "EMA 200", "value": "$${ema200}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "Bollinger Bands", "value": string, "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "Stochastic", "value": "${stoch}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "Williams %R", "value": "${williamsR}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "OBV Trend", "value": "${obv.trend}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "ATR (14)", "value": "$${atr}", "signal": "VOLATILITY", "color": "yellow", "meaning": string },
    { "name": "Volume Trend", "value": "${volumeAnalysis.trend}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string },
    { "name": "Implied Volatility", "value": "${impliedVolatility ? impliedVolatility + "%" : "N/A"}", "signal": string, "color": "green" or "red" or "yellow", "meaning": string }
  ],
  "support": [
    { "level": ${supports[0] || currentPrice * 0.95}, "strength": "STRONG" },
    { "level": ${supports[1] || currentPrice * 0.90}, "strength": "MODERATE" },
    { "level": ${supports[2] || currentPrice * 0.85}, "strength": "WEAK" }
  ],
  "resistance": [
    { "level": ${resistances[0] || currentPrice * 1.05}, "strength": "STRONG" },
    { "level": ${resistances[1] || currentPrice * 1.10}, "strength": "MODERATE" },
    { "level": ${resistances[2] || currentPrice * 1.15}, "strength": "WEAK" }
  ],
  "analysis": "5-6 plain English sentences for a beginner. Reference the REAL indicator values. Summarize what the indicators say together, overall trend, momentum, and the one biggest risk right now.",
  "robinhoodSteps": "Numbered step-by-step guide (6-8 steps) for a complete beginner. Be very specific: what to search on Robinhood, how to navigate to options, which option type to tap, which exact strike price and expiration to pick based on the real data, how much to spend, how to set a stop loss, and when/how to take profit."
}`;

    const aiResponse = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = aiResponse.content[0].text;
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI response parsing failed");
    const analysis = JSON.parse(jsonMatch[0]);

    // Inject raw market data for transparency
    analysis._rawData = {
      fetchedAt: new Date().toISOString(),
      indicators: marketData.indicators,
      volume: marketData.volume,
    };

    res.json({ success: true, data: analysis });

  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve index.html for all other routes
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`TSLA Analyzer running on port ${PORT}`));
