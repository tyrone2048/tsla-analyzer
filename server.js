const express = require("express");
const fetch = require("node-fetch");
const Anthropic = require("@anthropic-ai/sdk");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

process.on("uncaughtException", (err) => { console.error("[CRASH PREVENTED]", err.message); });
process.on("unhandledRejection", (reason) => { console.error("[REJECTION]", reason?.message || reason); });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Files ────────────────────────────────────────────────────────────────────
const DATA_FILE    = path.join(__dirname, "challenge_data.json");
const LEARN_FILE   = path.join(__dirname, "smc_learning.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = { balance:10, startingBalance:10, trades:[], milestones:[] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch(e) { return { balance:10, startingBalance:10, trades:[], milestones:[] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }

function loadLearning() {
  if (!fs.existsSync(LEARN_FILE)) {
    const d = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      setupData: [],       // Every SMC setup ever traded
      bestStocks: {},      // Win rate per stock
      bestTimes: {},       // Win rate per hour
      bestGapSizes: [],    // What gap % worked
      bestConditions: [],  // What market conditions worked
      insights: []         // Auto-generated insights
    };
    fs.writeFileSync(LEARN_FILE, JSON.stringify(d,null,2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(LEARN_FILE,"utf8")); }
  catch(e) { return { totalTrades:0, wins:0, losses:0, setupData:[], bestStocks:{}, bestTimes:{}, bestGapSizes:[], bestConditions:[], insights:[] }; }
}
function saveLearning(d) { fs.writeFileSync(LEARN_FILE, JSON.stringify(d,null,2)); }

const MILESTONES = [25,50,100,250,500,1000,2500,5000,10000];
function checkMilestone(old, nw, existing) {
  for (const m of MILESTONES) { if(old<m&&nw>=m&&!(existing||[]).includes(m)) return m; }
  return null;
}

// ─── Watchlist ────────────────────────────────────────────────────────────────
// LOW PRICE stocks (under $20) — good for small balance
const CHEAP_WATCHLIST = ["LWM","SOUN","SOFI","MARA","RIOT","PLTR","HOOD","NIO","PLUG","BBAI"];

// HIGHER PRICE stocks (for bigger balance)
const PREMIUM_WATCHLIST = ["QQQ","TSLA","NVDA","AMD","AAPL","SPY","META","AMZN"];

// Combined watchlist — cheap stocks first since balance is small
const WATCHLIST = [...CHEAP_WATCHLIST, ...PREMIUM_WATCHLIST];

// ─── Email ────────────────────────────────────────────────────────────────────
const activeMonitors = {};
async function sendEmail(to, subject, html) {
  if (!process.env.ALERT_EMAIL || !process.env.ALERT_EMAIL_PASSWORD) return false;
  try {
    const t = nodemailer.createTransport({ service:"gmail", auth:{ user:process.env.ALERT_EMAIL, pass:process.env.ALERT_EMAIL_PASSWORD }});
    await t.sendMail({ from:process.env.ALERT_EMAIL, to, subject, html });
    return true;
  } catch(e) { console.error("Email:", e.message); return false; }
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcRSI(c, p=14) {
  if (!c || c.length < p+1) return null;
  let g=0, l=0;
  for (let i=1; i<=p; i++) { const d=c[i]-c[i-1]; if(d>=0) g+=d; else l+=Math.abs(d); }
  let ag=g/p, al=l/p;
  for (let i=p+1; i<c.length; i++) {
    const d=c[i]-c[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p;
    al=(al*(p-1)+(d<0?Math.abs(d):0))/p;
  }
  return al===0?100:parseFloat((100-100/(1+ag/al)).toFixed(2));
}

function calcATR(h, l, c, p=14) {
  if (!h || h.length < p+1) return null;
  const t=[];
  for (let i=1; i<h.length; i++) t.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return parseFloat((t.slice(-p).reduce((a,b)=>a+b,0)/p).toFixed(4));
}

// ─── SMC Core Detection ───────────────────────────────────────────────────────
// THE STRATEGY: FVG + Liquidity + BOS + Green candle confirmation
function detectSMCSetup(closes, highs, lows, opens, volumes) {
  if (!closes || closes.length < 15) return { step:0, fvg:null, liquidity:null, bos:null, entrySignal:null, plain:"Not enough candle data yet.", direction:"CALL" };

  const result = {
    step: 0,           // 1=FVG found, 2=Liquidity identified, 3=BOS confirmed, 4=Price in FVG, 5=ENTER NOW
    fvg: null,         // The fair value gap
    liquidity: null,   // Liquidity levels
    bos: null,         // Break of structure level
    entrySignal: null, // ENTER_NOW or WAIT
    plain: "",         // Plain English explanation
    direction: "CALL"
  };

  // STEP 1 — Find Fair Value Gaps
  // Three candles where wick of candle 1 and wick of candle 3 do NOT overlap
  const fvgs = [];
  for (let i=2; i<closes.length; i++) {
    const c1High = highs[i-2];
    const c1Low  = lows[i-2];
    const c3High = highs[i];
    const c3Low  = lows[i];

    // Bullish FVG: candle 3 low is ABOVE candle 1 high — gap between them
    if (c3Low > c1High) {
      const gapPct = parseFloat(((c3Low - c1High) / c1High * 100).toFixed(2));
      if (gapPct >= 0.2) { // Only meaningful gaps
        fvgs.push({
          type: "BULLISH",
          top: parseFloat(c3Low.toFixed(3)),
          bottom: parseFloat(c1High.toFixed(3)),
          gapPct,
          candleIdx: i
        });
      }
    }

    // Bearish FVG: candle 3 high is BELOW candle 1 low
    if (c3High < c1Low) {
      const gapPct = parseFloat(((c1Low - c3High) / c1Low * 100).toFixed(2));
      if (gapPct >= 0.2) {
        fvgs.push({
          type: "BEARISH",
          top: parseFloat(c1Low.toFixed(3)),
          bottom: parseFloat(c3High.toFixed(3)),
          gapPct,
          candleIdx: i
        });
      }
    }
  }

  if (fvgs.length === 0) {
    result.plain = "No Fair Value Gap detected yet. Waiting for a fast candle move that leaves a gap.";
    return result;
  }

  result.step = 1;
  const latestFVG = fvgs[fvgs.length - 1];
  result.fvg = latestFVG;

  // STEP 2 — Find Liquidity (swing highs/lows where stop losses cluster)
  const swingHighs = [], swingLows = [];
  for (let i=2; i<highs.length-2; i++) {
    if (highs[i]>highs[i-1]&&highs[i]>highs[i-2]&&highs[i]>highs[i+1]&&highs[i]>highs[i+2])
      swingHighs.push({ price: highs[i], idx: i });
    if (lows[i]<lows[i-1]&&lows[i]<lows[i-2]&&lows[i]<lows[i+1]&&lows[i]<lows[i+2])
      swingLows.push({ price: lows[i], idx: i });
  }

  const currentPrice = closes[closes.length - 1];

  if (swingHighs.length > 0 || swingLows.length > 0) {
    result.step = 2;
    result.liquidity = {
      buySide: swingHighs.slice(-3).map(h => parseFloat(h.price.toFixed(3))),
      sellSide: swingLows.slice(-3).map(l => parseFloat(l.price.toFixed(3)))
    };
  }

  // STEP 3 — Break of Structure
  // Bullish BOS: current price breaks above previous swing high
  let bos = null;
  if (swingHighs.length >= 1) {
    const lastHigh = swingHighs[swingHighs.length - 1].price;
    if (currentPrice > lastHigh) {
      bos = { type:"BULLISH", level: parseFloat(lastHigh.toFixed(3)) };
    }
  }
  if (!bos && swingLows.length >= 1) {
    const lastLow = swingLows[swingLows.length - 1].price;
    if (currentPrice < lastLow) {
      bos = { type:"BEARISH", level: parseFloat(lastLow.toFixed(3)) };
    }
  }

  if (!bos) {
    result.plain = `FVG found at $${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}. Liquidity at $${swingHighs.slice(-1)[0]?.price.toFixed(2)||"?"}. Waiting for price to BREAK the previous high to confirm direction.`;
    return result;
  }

  result.step = 3;
  result.bos = bos;
  result.direction = bos.type === "BULLISH" ? "CALL" : "PUT";

  // STEP 4 — Is price pulling back into the FVG zone?
  const inFVG = currentPrice >= latestFVG.bottom && currentPrice <= latestFVG.top;
  const approachingFVG = bos.type === "BULLISH" ?
    currentPrice > latestFVG.bottom && currentPrice < latestFVG.top * 1.02 :
    currentPrice < latestFVG.top && currentPrice > latestFVG.bottom * 0.98;

  if (!inFVG && !approachingFVG) {
    result.plain = `BOS confirmed ${bos.type} at $${bos.level.toFixed(2)}. FVG zone is $${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}. Waiting for price to PULL BACK into this zone.`;
    return result;
  }

  result.step = 4;

  // STEP 5 — Green (or red) confirmation candle inside FVG
  const lastOpen  = opens ? opens[opens.length-1] : currentPrice;
  const lastClose = closes[closes.length-1];
  const isGreen = lastClose > lastOpen;
  const isRed   = lastClose < lastOpen;

  const confirmed = (bos.type==="BULLISH" && isGreen) || (bos.type==="BEARISH" && isRed);

  if (confirmed) {
    result.step = 5;
    result.entrySignal = "ENTER_NOW";
    result.plain = `🟢 ENTER NOW: ${bos.type==="BULLISH"?"Green":"Red"} candle formed inside FVG ($${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}) after BOS at $${bos.level.toFixed(2)}. This is your exact entry signal.`;
  } else {
    result.entrySignal = "WAIT_CANDLE";
    result.plain = `Price is inside FVG zone ($${latestFVG.bottom.toFixed(2)}-$${latestFVG.top.toFixed(2)}). WAIT for a ${bos.type==="BULLISH"?"GREEN":"RED"} candle to form here — that is your entry signal.`;
  }

  return result;
}

// ─── Top-Down Multi-Timeframe Analysis (TradesBySci Method) ──────────────────
// Step 1: 4-hour chart → Daily Bias (bullish or bearish)
// Step 2: 1-hour chart → Indication (swing high/low break)
// Step 3: 15-min chart → Confirmation zone (pullback forming)
// Step 4: 5-min chart  → Exact entry (ICC candle confirmation)

async function getCandles(symbol, interval, range) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`, { headers:{"User-Agent":"Mozilla/5.0"} });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0] || {};
    const ts = result.timestamp || [];
    const bars = ts.map((t,i) => ({
      time: new Date(t*1000),
      open:  q.open?.[i],
      high:  q.high?.[i],
      low:   q.low?.[i],
      close: q.close?.[i],
      volume:q.volume?.[i] || 0
    })).filter(b => b.close != null && b.open != null);
    if (bars.length < 5) return null;
    return {
      bars,
      closes:  bars.map(b => b.close),
      opens:   bars.map(b => b.open),
      highs:   bars.map(b => b.high),
      lows:    bars.map(b => b.low),
      volumes: bars.map(b => b.volume),
      current: bars[bars.length-1].close
    };
  } catch(e) { return null; }
}

function getSwings(highs, lows, lookback=3) {
  const swingHighs = [], swingLows = [];
  for (let i=lookback; i<highs.length-lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j=1; j<=lookback; j++) {
      if (highs[i] <= highs[i-j] || highs[i] <= highs[i+j]) isHigh = false;
      if (lows[i] >= lows[i-j] || lows[i] >= lows[i+j]) isLow = false;
    }
    if (isHigh) swingHighs.push({ price: highs[i], idx: i });
    if (isLow)  swingLows.push({ price: lows[i], idx: i });
  }
  return { swingHighs, swingLows };
}

async function topDownAnalysis(symbol) {
  const result = {
    symbol,
    // Step 1 — 4H Bias
    bias4H: null,
    biasDirection: "NEUTRAL",
    biasReason: "",
    // Step 2 — 1H Indication
    indication1H: null,
    indicationConfirmed: false,
    // Step 3 — 15min Confirmation
    confirmation15m: null,
    pullbackForming: false,
    // Step 4 — 5min Entry
    entry5m: null,
    entryReady: false,
    // Overall
    overallStep: 0,
    totalSteps: 4,
    readyToTrade: false,
    plain: "",
    direction: "CALL"
  };

  try {
    // STEP 1 — 4-Hour chart: determine bias
    const c4h = await getCandles(symbol, "1h", "1mo"); // Yahoo doesn't have 4h, use 1h as proxy
    if (!c4h) { result.plain = "Could not fetch higher timeframe data."; return result; }

    const { swingHighs: sh4h, swingLows: sl4h } = getSwings(c4h.highs, c4h.lows, 4);
    const current = c4h.current;

    // Check for uptrend: recent swing highs and lows both going up
    let bullCount = 0, bearCount = 0;
    const recentHighs = sh4h.slice(-4);
    const recentLows  = sl4h.slice(-4);
    for (let i=1; i<recentHighs.length; i++) {
      if (recentHighs[i].price > recentHighs[i-1].price) bullCount++;
      else bearCount++;
    }
    for (let i=1; i<recentLows.length; i++) {
      if (recentLows[i].price > recentLows[i-1].price) bullCount++;
      else bearCount++;
    }

    const bias = bullCount > bearCount ? "BULLISH" : bearCount > bullCount ? "BEARISH" : "NEUTRAL";
    result.biasDirection = bias;
    result.bias4H = {
      direction: bias,
      bullCount,
      bearCount,
      lastSwingHigh: recentHighs[recentHighs.length-1]?.price,
      lastSwingLow:  recentLows[recentLows.length-1]?.price
    };
    result.biasReason = bias === "BULLISH"
      ? `1H chart shows higher highs and higher lows — bias is UP. Only look for CALL setups.`
      : bias === "BEARISH"
      ? `1H chart shows lower highs and lower lows — bias is DOWN. Only look for PUT setups.`
      : `Mixed structure — no clear bias. Be selective and wait for cleaner setup.`;
    result.direction = bias === "BEARISH" ? "PUT" : "CALL";
    result.overallStep = 1;

    // STEP 2 — 1-Hour chart: find indication (swing high/low break)
    const c1h = await getCandles(symbol, "1h", "5d");
    if (!c1h) { result.plain = `Step 1 ✅ Bias: ${bias}. Could not fetch 1H data for indication.`; return result; }

    const { swingHighs: sh1h, swingLows: sl1h } = getSwings(c1h.highs, c1h.lows, 3);
    const cur1h = c1h.current;

    let indication = null;
    if (bias === "BULLISH" && sh1h.length >= 1) {
      const lastHigh = sh1h[sh1h.length-1].price;
      if (cur1h > lastHigh) {
        indication = { type:"BULLISH", level: parseFloat(lastHigh.toFixed(2)), 
          plain: `Price broke above swing high at $${lastHigh.toFixed(2)} on 1H chart — bullish indication confirmed` };
      }
    } else if (bias === "BEARISH" && sl1h.length >= 1) {
      const lastLow = sl1h[sl1h.length-1].price;
      if (cur1h < lastLow) {
        indication = { type:"BEARISH", level: parseFloat(lastLow.toFixed(2)),
          plain: `Price broke below swing low at $${lastLow.toFixed(2)} on 1H chart — bearish indication confirmed` };
      }
    }

    if (!indication) {
      // Find what level needs to break
      const watchLevel = bias === "BULLISH"
        ? sh1h[sh1h.length-1]?.price
        : sl1h[sl1h.length-1]?.price;
      result.indication1H = null;
      result.plain = `Step 1 ✅ Bias: ${bias}. Step 2 ⏳ Waiting for price to break ${bias==="BULLISH"?"above":"below"} $${watchLevel?.toFixed(2)||"key level"} on 1H chart.`;
      return result;
    }

    result.indication1H = indication;
    result.indicationConfirmed = true;
    result.overallStep = 2;

    // STEP 3 — 15-min chart: confirmation (pullback to key zone)
    const c15m = await getCandles(symbol, "15m", "5d");
    if (!c15m) { result.plain = `Step 1 ✅ Step 2 ✅ Indication confirmed. Could not fetch 15M data.`; return result; }

    const cur15m = c15m.current;
    const recentCloses15m = c15m.closes.slice(-10);

    // Check if price is pulling back toward the indication level
    const indLevel = indication.level;
    const distFromLevel = Math.abs(cur15m - indLevel) / indLevel * 100;
    const pullbackForming = distFromLevel < 3; // Within 3% of indication level

    // Also check 15-min SMC for FVG
    const smc15m = detectSMCSetup(c15m.closes, c15m.highs, c15m.lows, c15m.opens, c15m.volumes);

    result.confirmation15m = {
      currentPrice: cur15m,
      indLevel,
      distFromLevel: parseFloat(distFromLevel.toFixed(2)),
      pullbackForming,
      fvg: smc15m?.fvg || null,
      fvgZone: smc15m?.fvgZone || null
    };
    result.pullbackForming = pullbackForming;

    if (!pullbackForming && smc15m?.step < 3) {
      result.plain = `Step 1 ✅ Bias: ${bias}. Step 2 ✅ Indication at $${indLevel}. Step 3 ⏳ Wait for pullback — price needs to return to $${indLevel.toFixed(2)} zone before entry.`;
      result.overallStep = 2;
      return result;
    }

    result.overallStep = 3;

    // STEP 4 — 5-min chart: exact entry (ICC confirmation candle)
    const c5m = await getCandles(symbol, "5m", "5d");
    if (!c5m) { result.plain = `Step 1 ✅ Step 2 ✅ Step 3 ✅ Pullback confirmed. Could not fetch 5M data.`; return result; }

    const smc5m = detectSMCSetup(c5m.closes, c5m.highs, c5m.lows, c5m.opens, c5m.volumes);
    const cur5m = c5m.current;
    const lastOpen5m = c5m.opens[c5m.opens.length-1];
    const isGreenCandle = cur5m > lastOpen5m;
    const isRedCandle = cur5m < lastOpen5m;

    const confirmationCandle = (bias === "BULLISH" && isGreenCandle) || (bias === "BEARISH" && isRedCandle);

    result.entry5m = {
      currentPrice: cur5m,
      isGreenCandle,
      confirmationCandle,
      smc5mStep: smc5m?.step || 0,
      fvgZone: smc5m?.fvgZone || null,
      entrySignal: smc5m?.entrySignal || null
    };

    if (confirmationCandle && (smc5m?.entrySignal === "ENTER_NOW" || pullbackForming)) {
      result.overallStep = 4;
      result.readyToTrade = true;
      result.entryReady = true;
      result.plain = `🟢 ALL 4 STEPS CONFIRMED: Bias ${bias} ✅ → Indication at $${indLevel} ✅ → Pullback ✅ → ${isGreenCandle?"Green":"Red"} candle confirmed ✅. ENTER NOW on 5-minute chart.`;
    } else if (smc5m?.entrySignal === "WAIT_CANDLE" || pullbackForming) {
      result.overallStep = 3;
      result.plain = `Step 1 ✅ Bias ${bias}. Step 2 ✅ Indication $${indLevel}. Step 3 ✅ Pullback forming. Step 4 ⏳ Waiting for ${bias==="BULLISH"?"green":"red"} confirmation candle on 5-minute chart.`;
    } else {
      result.plain = `Step 1 ✅ Bias ${bias}. Step 2 ✅ Indication $${indLevel}. Step 3 ⏳ Price not at pullback zone yet — wait.`;
      result.overallStep = 2;
    }

  } catch(e) {
    console.error(`[TopDown] ${symbol}:`, e.message);
    result.plain = `Analysis error for ${symbol}: ${e.message}`;
  }

  return result;
}

// ─── Fetch 5-minute candles ───────────────────────────────────────────────────
async function get5MinCandles(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=5m&range=5d`, { headers:{"User-Agent":"Mozilla/5.0"} });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators?.quote?.[0] || {};
    const timestamps = result.timestamp || [];
    const bars = timestamps.map((t,i) => ({
      time: new Date(t*1000),
      open:  q.open?.[i],
      high:  q.high?.[i],
      low:   q.low?.[i],
      close: q.close?.[i],
      volume:q.volume?.[i] || 0
    })).filter(b => b.close !== null && b.close !== undefined && b.open !== null);

    if (bars.length < 15) return null;

    // Only use today's bars for intraday analysis
    const today = new Date().toDateString();
    const todayBars = bars.filter(b => b.time.toDateString() === today);
    const useBars = todayBars.length >= 10 ? todayBars : bars.slice(-50);

    return {
      bars: useBars,
      closes:  useBars.map(b => b.close),
      opens:   useBars.map(b => b.open),
      highs:   useBars.map(b => b.high),
      lows:    useBars.map(b => b.low),
      volumes: useBars.map(b => b.volume),
      currentPrice: useBars[useBars.length-1].close
    };
  } catch(e) { return null; }
}

// ─── Fetch daily data for exhaustion check ────────────────────────────────────
async function getDailyData(symbol) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=60d`, { headers:{"User-Agent":"Mozilla/5.0"} });
    if (!r.ok) return null;
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta;
    const q = result.indicators?.quote?.[0] || {};
    const closes = (q.close||[]).filter(Boolean);
    const highs  = (q.high||[]).filter(Boolean);
    const lows   = (q.low||[]).filter(Boolean);
    const price  = parseFloat((meta.regularMarketPrice||0).toFixed(2));
    const prev   = parseFloat((meta.chartPreviousClose||price).toFixed(2));
    const change = parseFloat(((price-prev)/prev*100).toFixed(2));
    const atr    = calcATR(highs, lows, closes) || price * 0.02;
    const avgMove = parseFloat((atr/price*100).toFixed(2));
    const moveRatio = avgMove > 0 ? parseFloat((Math.abs(change)/avgMove).toFixed(1)) : 0;
    const exhaustion = moveRatio>=5?"EXTREMELY_EXHAUSTED":moveRatio>=3?"VERY_EXHAUSTED":moveRatio>=2?"EXHAUSTED":moveRatio>=1.5?"EXTENDED":"FRESH";

    // Options chain for real Ask prices
    let options = [];
    try {
      const or = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}`, { headers:{"User-Agent":"Mozilla/5.0"} });
      if (or.ok) {
        const od = await or.json();
        const calls = od.optionChain?.result?.[0]?.options?.[0]?.calls || [];
        options = calls
          .filter(c => c.ask > 0 && c.openInterest >= 50)
          .map(c => ({
            strike: c.strike,
            ask: parseFloat((c.ask||0).toFixed(2)),
            bid: parseFloat((c.bid||0).toFixed(2)),
            spread: parseFloat(((c.ask||0)-(c.bid||0)).toFixed(3)),
            spreadPct: c.ask > 0 ? parseFloat(((c.ask-c.bid)/c.ask*100).toFixed(1)) : 100,
            openInterest: c.openInterest || 0,
            expiration: new Date((c.expiration||0)*1000).toLocaleDateString(),
            totalCost: parseFloat(((c.ask||0)*100).toFixed(2))
          }))
          .sort((a,b) => a.strike - b.strike);
      }
    } catch(e) {}

    // News
    let news = { label:"NEUTRAL", headlines:[] };
    try {
      const nr = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5&enableFuzzyQuery=false`, { headers:{"User-Agent":"Mozilla/5.0"} });
      const nd = await nr.json();
      const articles = (nd.news||[]).filter(n => Date.now()-n.providerPublishTime*1000 < 24*60*60*1000);
      const bw=["surge","jump","gain","rise","rally","buy","upgrade","beat","profit","strong","positive","boost"];
      const mw=["drop","fall","loss","down","sell","downgrade","miss","decline","weak","negative","cut"];
      let bu=0, be=0;
      articles.forEach(n => { const t=(n.title||"").toLowerCase(); bw.forEach(w=>{if(t.includes(w))bu++;}); mw.forEach(w=>{if(t.includes(w))be++;}); });
      const tot = bu+be;
      const sc = tot > 0 ? Math.round(bu/tot*100) : 50;
      news = { label: sc>60?"BULLISH":sc<40?"BEARISH":"NEUTRAL", headlines: articles.slice(0,2).map(n=>n.title) };
    } catch(e) {}

    return { symbol, price, change, exhaustion, moveRatio, atr, rsi: calcRSI(closes), options, news };
  } catch(e) { return null; }
}

// ─── Market check ─────────────────────────────────────────────────────────────
async function getMarketStatus() {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1d&range=5d", { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const meta = d.chart?.result?.[0]?.meta;
    const spyChange = parseFloat(((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100).toFixed(2));
    const isExtreme = Math.abs(spyChange) > 3;
    const isBull = spyChange > 0.5;
    return { spyChange, isExtreme, isBull };
  } catch(e) { return { spyChange:0, isExtreme:false, isBull:true }; }
}

// ─── Time window ──────────────────────────────────────────────────────────────
function getTradingWindow() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  const h = et.getHours(), m = et.getMinutes(), t = h + m/60, day = et.getDay();
  if (day===0||day===6) return { canTrade:false, window:"WEEKEND", msg:"Market closed. Come back Monday.", killZone:false };
  if (t < 9.5)  return { canTrade:false, window:"PRE_MARKET", msg:"Market opens at 9:30 AM ET.", killZone:false };
  if (t < 10.0) return { canTrade:false, window:"TOO_EARLY", msg:"Wait until 10:00 AM — first 30 min too volatile.", killZone:false };
  // New York Kill Zone — ICT concept — best SMC entries happen here
  if (t >= 10.0 && t < 11.0) return { canTrade:true, window:"NY_KILL_ZONE", msg:"🎯 NEW YORK KILL ZONE — 10:00 to 11:00 AM. This is the BEST time for SMC setups. Institutional orders fire here.", killZone:true };
  if (t < 11.5) return { canTrade:true, window:"BEST_WINDOW", msg:"Still a good window. Fresh SMC setups only.", killZone:false };
  if (t < 12.0) return { canTrade:true, window:"GOOD", msg:"Good window ending soon. High confidence only.", killZone:false };
  if (t < 13.0) return { canTrade:false, window:"LUNCH", msg:"Lunch dead zone 12-1 PM. Volume dries up. Wait.", killZone:false };
  // New York PM Kill Zone
  if (t >= 13.3 && t < 14.0) return { canTrade:true, window:"NY_PM_KILL_ZONE", msg:"🎯 PM KILL ZONE — 1:30 to 2:00 PM. Second best window for SMC. Watch for afternoon setups.", killZone:true };
  if (t < 15.5) return { canTrade:true, window:"AFTERNOON", msg:"Afternoon window. High confidence setups only.", killZone:false };
  return { canTrade:false, window:"CLOSED", msg:"3:30 PM ET — no new trades. Close everything.", killZone:false };
}

// Daily Bias — determines if today is a BUY or SELL day
// Based on higher timeframe structure (ICT concept)
async function getDailyBias() {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/SPY?interval=1h&range=5d", { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const result = d.chart?.result?.[0];
    if (!result) return { bias:"NEUTRAL", reason:"Could not determine bias" };
    const q = result.indicators?.quote?.[0] || {};
    const closes = (q.close||[]).filter(Boolean);
    const highs  = (q.high||[]).filter(Boolean);
    const lows   = (q.low||[]).filter(Boolean);
    if (closes.length < 10) return { bias:"NEUTRAL", reason:"Not enough data" };

    // Check if making higher highs and higher lows (bullish) or lower highs/lows (bearish)
    const recentHighs = highs.slice(-8);
    const recentLows  = lows.slice(-8);
    let bullPoints = 0, bearPoints = 0;
    for (let i=1; i<recentHighs.length; i++) {
      if (recentHighs[i] > recentHighs[i-1]) bullPoints++;
      else bearPoints++;
      if (recentLows[i] > recentLows[i-1]) bullPoints++;
      else bearPoints++;
    }
    const bias = bullPoints > bearPoints*1.5 ? "BULLISH" : bearPoints > bullPoints*1.5 ? "BEARISH" : "NEUTRAL";
    const reason = bias==="BULLISH" ? "SPY making higher highs and higher lows on 1-hour chart — bias is UP today" :
                   bias==="BEARISH" ? "SPY making lower highs and lower lows on 1-hour chart — bias is DOWN today" :
                   "SPY structure mixed — no clear bias today, be selective";
    return { bias, reason, bullPoints, bearPoints };
  } catch(e) { return { bias:"NEUTRAL", reason:"Bias check failed" }; }
}

// ─── Learning System ──────────────────────────────────────────────────────────
function updateLearning(tradeData) {
  const learn = loadLearning();
  const { symbol, result, pnl, hour, gapPct, spyChange, exhaustion, fvgSize } = tradeData;

  learn.totalTrades++;
  if (result === "win") learn.wins++;
  else if (result === "loss") learn.losses++;

  // Record full setup
  learn.setupData.push({
    date: new Date().toISOString(),
    symbol, result, pnl, hour, gapPct, spyChange, exhaustion,
    topDownStep: tradeData.topDownStep || 0,
    biasDirection: tradeData.biasDirection || "NEUTRAL",
    wasReadyToTrade: tradeData.wasReadyToTrade || false
  });

  // Update per-stock win rate
  if (!learn.bestStocks[symbol]) learn.bestStocks[symbol] = { wins:0, losses:0, trades:0 };
  learn.bestStocks[symbol].trades++;
  if (result==="win") learn.bestStocks[symbol].wins++;
  else if (result==="loss") learn.bestStocks[symbol].losses++;

  // Update per-hour win rate
  const hourKey = `${hour}:00`;
  if (!learn.bestTimes[hourKey]) learn.bestTimes[hourKey] = { wins:0, losses:0, trades:0 };
  learn.bestTimes[hourKey].trades++;
  if (result==="win") learn.bestTimes[hourKey].wins++;
  else if (result==="loss") learn.bestTimes[hourKey].losses++;

  // Track gap sizes that worked
  if (gapPct) learn.bestGapSizes.push({ gapPct, result });

  // Generate insights after enough trades
  const insights = [];
  if (learn.totalTrades >= 3) {
    const wr = Math.round(learn.wins / learn.totalTrades * 100);
    insights.push(`Overall win rate: ${wr}% across ${learn.totalTrades} top-down trades`);

    // Best stock
    const stocks = Object.entries(learn.bestStocks)
      .filter(([,v]) => v.trades >= 2)
      .map(([k,v]) => ({ symbol:k, wr: Math.round(v.wins/v.trades*100), trades:v.trades }))
      .sort((a,b) => b.wr - a.wr);
    if (stocks.length > 0) {
      insights.push(`Best stock: ${stocks[0].symbol} (${stocks[0].wr}% win rate, ${stocks[0].trades} trades)`);
    }
    if (stocks.length > 1 && stocks[stocks.length-1].wr < 40) {
      insights.push(`Avoid: ${stocks[stocks.length-1].symbol} (only ${stocks[stocks.length-1].wr}% win rate)`);
    }

    // Best time
    const times = Object.entries(learn.bestTimes)
      .filter(([,v]) => v.trades >= 2)
      .map(([k,v]) => ({ hour:k, wr: Math.round(v.wins/v.trades*100), trades:v.trades }))
      .sort((a,b) => b.wr - a.wr);
    if (times.length > 0) insights.push(`Best entry time: ${times[0].hour} (${times[0].wr}% win rate)`);
    if (times.length > 1) {
      const worst = times[times.length-1];
      if (worst.wr < 40) insights.push(`Avoid trading at ${worst.hour} (${worst.wr}% win rate)`);
    }

    // Step 4 vs Step 3 win rate
    const step4trades = learn.setupData.filter(s => s.wasReadyToTrade);
    const step3trades = learn.setupData.filter(s => !s.wasReadyToTrade);
    if (step4trades.length >= 3) {
      const s4wr = Math.round(step4trades.filter(s=>s.result==="win").length/step4trades.length*100);
      insights.push(`Step 4 ENTER NOW setups: ${s4wr}% win rate (${step4trades.length} trades) — ${s4wr>=55?"RELIABLE":"needs more data"}`);
    }
    if (step3trades.length >= 3) {
      const s3wr = Math.round(step3trades.filter(s=>s.result==="win").length/step3trades.length*100);
      insights.push(`Step 3 WATCHING setups: ${s3wr}% win rate — ${s3wr>=55?"also works":"wait for Step 4 only"}`);
    }

    // Bias accuracy
    const bullTrades = learn.setupData.filter(s => s.biasDirection==="BULLISH");
    const bearTrades = learn.setupData.filter(s => s.biasDirection==="BEARISH");
    if (bullTrades.length >= 3) {
      const bwr = Math.round(bullTrades.filter(s=>s.result==="win").length/bullTrades.length*100);
      insights.push(`Bullish bias trades: ${bwr}% win rate`);
    }
  }

  learn.insights = insights;
  saveLearning(learn);
  return insights;
}

// ─── Find best setup using top-down analysis ─────────────────────────────────
async function findBestSMCSetup(market) {
  const learn = loadLearning();

  // Sort watchlist — prioritize stocks that have worked before
  const sortedWatchlist = [...WATCHLIST].sort((a, b) => {
    const aData = learn.bestStocks[a];
    const bData = learn.bestStocks[b];
    if (!aData && !bData) return 0;
    if (!aData) return 1;
    if (!bData) return -1;
    const aWR = aData.trades >= 2 ? aData.wins/aData.trades : 0.5;
    const bWR = bData.trades >= 2 ? bData.wins/bData.trades : 0.5;
    return bWR - aWR;
  });

  const results = [];

  // Analyze top 5 stocks with full top-down analysis
  const batch = sortedWatchlist.slice(0, 5);
  
  await Promise.allSettled(batch.map(async symbol => {
    try {
      // Run full top-down analysis (4H bias → 1H indication → 15m confirm → 5m entry)
      const [tdAnalysis, daily] = await Promise.allSettled([
        topDownAnalysis(symbol),
        getDailyData(symbol)
      ]);

      const td = tdAnalysis.status==="fulfilled" ? tdAnalysis.value : null;
      const d  = daily.status==="fulfilled" ? daily.value : null;

      if (!td || !d) return;

      // Skip exhausted stocks
      if (["EXTREMELY_EXHAUSTED","VERY_EXHAUSTED"].includes(d.exhaustion)) return;

      // Score based on top-down steps completed
      let score = td.overallStep * 25; // 25 points per step, max 100

      // Bonuses
      if (d.news.label === "BULLISH" && td.direction === "CALL") score += 10;
      if (d.news.label === "BEARISH" && td.direction === "PUT") score += 10;
      if (d.exhaustion === "FRESH") score += 8;
      if (market.isBull && td.direction === "CALL") score += 7;
      if (market.isExtreme && d.change < market.spyChange * 0.3) score += 15;
      if (td.readyToTrade) score += 20; // Big bonus for all 4 steps confirmed

      // Penalties
      if (td.biasDirection === "NEUTRAL") score -= 10;
      if (d.news.label === "BEARISH" && td.direction === "CALL") score -= 15;

      // Find best affordable option
      const isCall = td.direction === "CALL";
      const bestOption = d.options.find(o =>
        (isCall ? o.strike > d.price : o.strike < d.price) &&
        o.ask <= 0.15 && o.spreadPct <= 30 && o.openInterest >= 50
      ) || d.options.find(o =>
        (isCall ? o.strike > d.price : o.strike <= d.price) && o.ask <= 0.30
      );

      results.push({
        symbol,
        score: Math.max(0, Math.min(100, Math.round(score))),
        topDown: td,
        smc: { // Keep smc format for backwards compat
          step: td.overallStep,
          plain: td.plain,
          entrySignal: td.readyToTrade ? "ENTER_NOW" : td.overallStep >= 3 ? "WAIT_CANDLE" : null,
          fvgZone: td.entry5m?.fvgZone || td.confirmation15m?.fvgZone || null,
          direction: td.direction,
          bos: td.indication1H ? { type: td.biasDirection, level: td.indication1H.level } : null,
          fvg: td.confirmation15m?.fvg || null
        },
        daily: d,
        bestOption,
        learnedWR: learn.bestStocks[symbol]?.trades >= 2
          ? Math.round(learn.bestStocks[symbol].wins / learn.bestStocks[symbol].trades * 100)
          : null
      });

      console.log(`[TopDown] ${symbol}: Step ${td.overallStep}/4 Score ${score} — ${td.plain?.substring(0,60)}`);

    } catch(e) { console.error(`[TopDown] Error ${symbol}:`, e.message); }
  }));

  results.sort((a,b) => b.score - a.score);
  return results;
}

// ─── MAIN ANALYSIS ENDPOINT ───────────────────────────────────────────────────
app.get("/api/analyze", async (req, res) => {
  try {
    const data = loadData();
    const learn = loadLearning();
    const tw = getTradingWindow();

    // Get market status and daily bias
    const market = await getMarketStatus();
    const dailyBias = await getDailyBias().catch(() => ({ bias:"NEUTRAL", reason:"Bias unavailable" }));

    // Find best SMC setups
    const setups = await findBestSMCSetup(market);
    const best = setups[0];

    // Build compact prompt for AI
    const learnInsights = learn.insights.length > 0
      ? learn.insights.join(". ")
      : "No trades yet — building your personal pattern library.";

    const prompt = `You are an SMC/ICT trading AI. Respond ONLY with valid JSON.

THE STRATEGY (ICT/SMC): FVG + Liquidity + Break of Structure + Green candle confirmation
EXTRA ICT CONCEPTS TO APPLY:
- Kill Zone: 10-11 AM and 1:30-2 PM ET are best entry times
- Daily Bias: Only take CALL trades on bullish days, PUT trades on bearish days
- Order Block: Last bearish candle before a big bullish move — price returns here
- Inducement: Fake move that sweeps stops before real move
- Only trade WITH the daily bias direction
Step 1: Fair Value Gap found
Step 2: Liquidity levels identified  
Step 3: Break of Structure confirmed
Step 4: Price pulls back into FVG zone
Step 5: Green/Red confirmation candle = ENTER NOW

TODAY: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()} ET
SPY: ${market.spyChange}% ${market.isExtreme?"EXTREME DAY — laggards with own catalyst only":""}
Time: ${tw.window} — ${tw.msg} ${tw.killZone?"🎯 KILL ZONE ACTIVE":""}
Daily Bias: ${dailyBias.bias} — ${dailyBias.reason}
Only recommend ${dailyBias.bias==="BEARISH"?"PUT":"CALL"} options today unless bias is NEUTRAL

BEST SETUP FOUND:
Stock: ${best?.symbol||"NONE"}
SMC Step: ${best?.smc?.step||0}/5 — ${best?.smc?.plain||"No setup found"}
Score: ${best?.score||0}/100
Price: $${best?.daily?.price||0} (${best?.daily?.change||0}% today)
Exhaustion: ${best?.daily?.exhaustion||"UNKNOWN"}
News: ${best?.daily?.news?.label||"NEUTRAL"}
Direction: ${best?.smc?.direction||"CALL"}
FVG Zone: ${best?.smc?.fvg?`$${best.smc.fvg.bottom.toFixed(2)}-$${best.smc.fvg.top.toFixed(2)}`:"None"}
BOS Level: ${best?.smc?.bos?`$${best.smc.bos.level.toFixed(2)} (${best.smc.bos.type})`:"Not confirmed yet"}
Best Option: ${best?.bestOption?`$${best.bestOption.strike} Call Ask $${best.bestOption.ask} ($${best.bestOption.totalCost} total) exp ${best.bestOption.expiration}`:"Check Robinhood"}

OTHER SETUPS:
${setups.slice(1,4).map(s=>`${s.symbol}: step ${s.smc?.step||0}/5 score ${s.score}`).join(", ")}

WHAT THE SYSTEM HAS LEARNED:
${learnInsights}

USER: $${data.balance} balance | max risk $${(data.balance*0.15).toFixed(2)} | ${data.trades.length} trades logged

RULES:
- Only recommend if SMC step >= 3
- If step 5 — ENTER NOW
- If step 4 — READY (watching for confirmation candle)  
- If step 1-3 — WAIT with specific next step
- Never recommend exhausted stocks
- Extreme days: laggard stocks with own catalyst only
- Keep response SHORT and CLEAR

Respond with this JSON:
{
  "shouldTrade": true or false,
  "marketStatus": "one sentence about today",
  "timeStatus": "${tw.msg}",
  "canTrade": ${tw.canTrade},
  "symbol": "${best?.symbol||"NONE"}",
  "step": ${best?.smc?.step||0},
  "stepPlain": "Which step of the 5-step SMC strategy are we on right now",
  "entrySignal": "ENTER NOW or WAIT — CANDLE CONFIRMATION or WAIT — PRICE NEEDS TO REACH FVG or WAIT — NEED BOS or WAIT — NO SETUP",
  "entryTrigger": "The exact thing that needs to happen to enter — 1 sentence",
  "fvgZone": "${best?.smc?.fvg?`$${best.smc.fvg.bottom.toFixed(2)}-$${best.smc.fvg.top.toFixed(2)}`:"Not found yet"}",
  "bosLevel": "${best?.smc?.bos?`$${best.smc.bos.level.toFixed(2)}`:"Not confirmed"}",
  "direction": "${best?.smc?.direction||"CALL"}",
  "smcExplanation": "Explain in plain English exactly what the 5-minute chart is showing right now for ${best?.symbol||"this stock"} — which step are we on and what needs to happen next",
  "strike": ${best?.bestOption?.strike||0},
  "expiration": "${best?.bestOption?.expiration||"5-10 days out"}",
  "askPrice": ${best?.bestOption?.ask||0},
  "totalCost": ${best?.bestOption?.totalCost||0},
  "stopLoss": ${best?.daily?.price?parseFloat((best.daily.price - (best.daily.atr||best.daily.price*0.02)).toFixed(2)):0},
  "target": ${best?.daily?.price?parseFloat((best.daily.price + (best.daily.atr||best.daily.price*0.02)*1.5).toFixed(2)):0},
  "news": "${best?.daily?.news?.label||"NEUTRAL"}",
  "newsHeadline": "${best?.daily?.news?.headlines?.[0]||""}",
  "exhaustion": "${best?.daily?.exhaustion||"UNKNOWN"}",
  "learnedInsight": "${learn.totalTrades >= 3 ? learnInsights.split(".")[0] : "Keep trading to unlock your personal insights"}",
  "otherStocks": ${JSON.stringify(setups.slice(1,4).map(s=>({symbol:s.symbol,step:s.smc?.step||0,score:s.score,plain:s.smc?.plain||""})))}
}`;

    const ai = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      messages: [{ role:"user", content:prompt }]
    });

    const raw = ai.content[0]?.text || "";
    console.log("[Analysis] Response:", raw.length, "chars");

    let analysis;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON found");
      analysis = JSON.parse(match[0]);
    } catch(e) {
      console.error("[Parse error]", e.message, "Raw:", raw.substring(0,200));
      throw new Error("Analysis failed — please try again");
    }

    // Add computed data
    // Add topDown data to response for frontend
    if (best?.topDown) {
      analysis.topDown = best.topDown;
      analysis.biasDirection = best.topDown.biasDirection;
      analysis.biasReason = best.topDown.biasReason;
      analysis.killZone = tw.killZone;
      analysis.orderBlock = best.topDown.entry5m?.fvgZone ? { 
        top: 0, bottom: 0, 
        plain: best.topDown.plain 
      } : null;
    }
    analysis._balance   = data.balance;
    analysis._trades    = data.trades.length;
    analysis._milestones = data.milestones || [];
    analysis._learning  = {
      totalTrades: learn.totalTrades,
      wins: learn.wins,
      losses: learn.losses,
      winRate: learn.totalTrades > 0 ? Math.round(learn.wins/learn.totalTrades*100) : 0,
      insights: learn.insights,
      bestStock: Object.entries(learn.bestStocks).sort((a,b) => {
        const aWR = a[1].trades>=2?a[1].wins/a[1].trades:0;
        const bWR = b[1].trades>=2?b[1].wins/b[1].trades:0;
        return bWR - aWR;
      })[0]?.[0] || null
    };
    analysis._currentPrice = best?.daily?.price || 0;
    analysis._allSetups = setups.slice(0,6).map(s => ({
      symbol: s.symbol,
      score: s.score,
      step: s.smc?.step || 0,
      plain: s.smc?.plain || "",
      learnedWR: s.learnedWR
    }));

    res.json({ success:true, data:analysis });

  } catch(err) {
    console.error("[Analysis Error]", err.message);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ─── Standard Endpoints ───────────────────────────────────────────────────────
app.get("/api/challenge", (req,res) => { res.json({ success:true, data:loadData() }); });

app.post("/api/balance/update", (req,res) => {
  const { balance } = req.body;
  if (isNaN(balance) || balance < 0) return res.status(400).json({ success:false, error:"Invalid balance" });
  const data = loadData();
  const old = data.balance;
  data.balance = parseFloat(parseFloat(balance).toFixed(2));
  const m = checkMilestone(old, data.balance, data.milestones||[]);
  if (m) (data.milestones=data.milestones||[]).push(m);
  saveData(data);
  res.json({ success:true, balance:data.balance, milestone:m });
});

app.post("/api/reset", (req,res) => {
  const bal = parseFloat(req.body.startingBalance) || 10;
  saveData({ balance:bal, startingBalance:bal, trades:[], milestones:[], createdAt:new Date().toISOString() });
  res.json({ success:true, message:`Reset to $${bal}` });
});

app.post("/api/trade/log", (req,res) => {
  const { symbol, optionType, entryPrice, exitPrice, amount, result, notes, gapPct, spyChange, exhaustion } = req.body;
  const data = loadData();
  const pnl = result==="win" ? parseFloat((exitPrice-amount).toFixed(2)) : result==="skip" ? 0 : parseFloat((-amount).toFixed(2));
  const old = data.balance;
  if (result !== "skip") data.balance = parseFloat(Math.max(0, data.balance+pnl).toFixed(2));
  const m = checkMilestone(old, data.balance, data.milestones||[]);
  if (m) (data.milestones=data.milestones||[]).push(m);
  const trade = {
    id:Date.now(), date:new Date().toISOString(),
    symbol, optionType, entryPrice, exitPrice,
    amountRisked:amount, pnl, result,
    balanceAfter:data.balance, notes:notes||""
  };
  data.trades.unshift(trade);
  saveData(data);

  // Update learning system
  const hour = new Date().getHours();
  const insights = updateLearning({ symbol, result, pnl, hour, gapPct, spyChange, exhaustion });

  res.json({ success:true, trade, newBalance:data.balance, milestone:m, insights });
});

app.post("/api/trade/manual", (req,res) => {
  const { symbol, optionType, amount, exitValue, result, date, notes } = req.body;
  const data = loadData();
  const pnl = result==="win" ? parseFloat((exitValue-amount).toFixed(2)) : result==="loss" ? parseFloat((-amount).toFixed(2)) : 0;
  const trade = {
    id:Date.now(), date:date?new Date(date).toISOString():new Date().toISOString(),
    symbol, optionType, entryPrice:amount, exitPrice:exitValue,
    amountRisked:amount, pnl, result, balanceAfter:data.balance,
    notes:notes||"", manualEntry:true
  };
  data.trades.push(trade);
  saveData(data);
  res.json({ success:true, trade });
});

app.get("/api/learning", (req,res) => { res.json({ success:true, data:loadLearning() }); });

app.get("/api/export", (req,res) => {
  res.setHeader("Content-Disposition", "attachment; filename=smc-backup-"+new Date().toISOString().split("T")[0]+".json");
  res.json({ exportedAt:new Date().toISOString(), challenge:loadData(), learning:loadLearning() });
});

app.post("/api/import", (req,res) => {
  try {
    const { challenge, learning } = req.body;
    if (challenge) saveData(challenge);
    if (learning) saveLearning(learning);
    res.json({ success:true, message:"Data restored!" });
  } catch(e) { res.status(500).json({ success:false, error:e.message }); }
});

app.get("/api/price/:symbol", async (req,res) => {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${req.params.symbol}?interval=1m&range=1d`, { headers:{"User-Agent":"Mozilla/5.0"} });
    const d = await r.json();
    const price = d.chart?.result?.[0]?.meta?.regularMarketPrice;
    res.json(price ? { success:true, price } : { success:false });
  } catch(e) { res.json({ success:false }); }
});

// Monitor
app.post("/api/monitor/start", async (req,res) => {
  const { email, symbol, stopLoss, profitTarget } = req.body;
  const id = `${symbol}_${Date.now()}`;
  activeMonitors[id] = { email, symbol, stopLoss, profitTarget, active:true };
  const interval = setInterval(async () => {
    if (!activeMonitors[id]?.active) { clearInterval(interval); return; }
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`, { headers:{"User-Agent":"Mozilla/5.0"} });
      const d = await r.json();
      const cp = d.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (!cp) return;
      if (cp >= profitTarget || cp <= stopLoss) {
        clearInterval(interval);
        activeMonitors[id].active = false;
        const win = cp >= profitTarget;
        await sendEmail(email, win?"🟢 TAKE PROFIT!":"🔴 STOP LOSS!", `<div style="padding:20px;font-family:monospace"><h2>${win?"🟢 PROFIT HIT":"🔴 STOP HIT"} — ${symbol}</h2><p>Price: $${cp}. Open Robinhood NOW and ${win?"sell to lock profit!":"cut the loss!"}</p></div>`);
      }
    } catch(e) {}
  }, 180000);
  activeMonitors[id].intervalId = interval;
  await sendEmail(email, `👁 Watching ${symbol}`, `<div style="padding:20px"><h2>Monitoring ${symbol}</h2><p>Stop: $${stopLoss} | Target: $${profitTarget}</p><p>Checking every 3 minutes.</p></div>`);
  res.json({ success:true, monitorId:id });
});

app.post("/api/monitor/stop", (req,res) => {
  const { monitorId } = req.body;
  if (activeMonitors[monitorId]) { clearInterval(activeMonitors[monitorId].intervalId); activeMonitors[monitorId].active = false; }
  res.json({ success:true });
});

app.get("*", (req,res) => res.sendFile(path.join(__dirname, "public", "index.html")));


// ─── Paper Trading System ─────────────────────────────────────────────────────
// Runs automatically in background — practices the SMC strategy 24/7
const PAPER_FILE = path.join(__dirname, "paper_trades.json");

function loadPaperTrades() {
  if (!fs.existsSync(PAPER_FILE)) {
    const d = { balance:1000, trades:[], openPositions:[], totalTrades:0, wins:0, losses:0 };
    fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2));
    return d;
  }
  try { return JSON.parse(fs.readFileSync(PAPER_FILE,"utf8")); }
  catch(e) { return { balance:1000, trades:[], openPositions:[], totalTrades:0, wins:0, losses:0 }; }
}
function savePaperTrades(d) { fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2)); }

async function runPaperTrading() {
  try {
    const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const h = et.getHours(), m = et.getMinutes(), t = h+m/60, day = et.getDay();
    
    // Run during market hours 9:30am-4pm ET on weekdays
    if (day===0||day===6||t<9.5||t>16) return;
    console.log(`[Paper] Running scan at ${et.toLocaleTimeString()} ET`);

    const paper = loadPaperTrades();
    const learn = loadLearning();
    const market = await getMarketStatus().catch(()=>({spyChange:0,isExtreme:false,isBull:true}));

    // Step 1 — Check open positions for exits
    const stillOpen = [];
    for (const pos of (paper.openPositions||[])) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${pos.symbol}?interval=5m&range=1d`,{headers:{"User-Agent":"Mozilla/5.0"}});
        const d = await r.json();
        const cp = d.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (!cp) { stillOpen.push(pos); continue; }

        const hitTarget = cp >= pos.target;
        const hitStop   = cp <= pos.stopLoss;
        const expired   = new Date() - new Date(pos.entryTime) > 4*60*60*1000; // 4 hour max hold

        if (hitTarget || hitStop || expired) {
          // Close the position
          const result = hitTarget ? "win" : "loss";
          const pnl = hitTarget
            ? parseFloat((pos.contracts * (pos.target - pos.entryPrice) * 100).toFixed(2))
            : parseFloat((-pos.amountRisked).toFixed(2));

          paper.totalTrades++;
          if (result==="win") paper.wins++;
          else paper.losses++;
          paper.balance = parseFloat((paper.balance + pnl).toFixed(2));

          const closedTrade = {
            id: pos.id,
            symbol: pos.symbol,
            entryPrice: pos.entryPrice,
            exitPrice: cp,
            entryTime: pos.entryTime,
            exitTime: new Date().toISOString(),
            result,
            pnl,
            amountRisked: pos.amountRisked,
            smcStep: pos.smcStep,
            fvgZone: pos.fvgZone,
            reason: hitTarget?"Target hit":hitStop?"Stop hit":"Time expired",
            spyChange: pos.spyChange,
            hour: new Date(pos.entryTime).getHours()
          };

          paper.trades.unshift(closedTrade);
          if (paper.trades.length > 200) paper.trades = paper.trades.slice(0,200);

          // Feed into learning system
          updateLearning({
            symbol: pos.symbol,
            result,
            pnl,
            hour: new Date(pos.entryTime).getHours(),
            gapPct: pos.gapPct || 0,
            spyChange: pos.spyChange || 0,
            exhaustion: pos.exhaustion || "UNKNOWN",
            topDownStep: pos.topDownStep || 0,
            biasDirection: pos.biasDirection || "NEUTRAL",
            wasReadyToTrade: pos.readyToTrade || false
          });

          console.log(`[Paper] CLOSED ${pos.symbol} — ${result} $${pnl} (${closedTrade.reason})`);
        } else {
          stillOpen.push(pos);
        }
      } catch(e) { stillOpen.push(pos); }
    }
    paper.openPositions = stillOpen;

    // Step 2 — Look for new SMC ENTER NOW signals
    // Paper trading uses ALL stocks — both cheap and premium
    // Real money uses cheap only. Paper money learns from everything.
    if (paper.openPositions.length < 3) {
      const allStocks = [...CHEAP_WATCHLIST, ...PREMIUM_WATCHLIST];
      const batch = allStocks;

      for (const symbol of batch) {
        // Skip if already in a position
        if (paper.openPositions.find(p=>p.symbol===symbol)) continue;

        try {
          // Use top-down analysis — same system as real trades
          const [td, daily] = await Promise.allSettled([
            topDownAnalysis(symbol),
            getDailyData(symbol)
          ]);

          const topDown = td.status==="fulfilled" ? td.value : null;
          const dailyData = daily.status==="fulfilled" ? daily.value : null;

          if (!topDown || !dailyData) continue;

          // Skip exhausted stocks
          if (["EXTREMELY_EXHAUSTED","VERY_EXHAUSTED"].includes(dailyData.exhaustion)) {
            console.log(`[Paper] ${symbol} skipped — ${dailyData.exhaustion}`);
            continue;
          }

          console.log(`[Paper] ${symbol} top-down step ${topDown.overallStep}/4 — ${topDown.plain?.substring(0,60)}`);

          // Only paper trade when step 3+ complete (pullback forming or ready)
          if (topDown.overallStep < 3) continue;
          const currentPrice = dailyData.price;
          const atr = dailyData.atr || currentPrice * 0.02;
          const stopLoss = parseFloat((currentPrice - atr).toFixed(2));
          const target = parseFloat((currentPrice + atr * 1.5).toFixed(2));
          const amountRisked = 50; // Paper trade $50 per position
          const contracts = Math.floor(amountRisked / (atr * 100)) || 1;

          const position = {
            id: Date.now(),
            symbol,
            entryPrice: currentPrice,
            stopLoss,
            target,
            amountRisked,
            contracts,
            entryTime: new Date().toISOString(),
            topDownStep: topDown.overallStep,
            biasDirection: topDown.biasDirection,
            fvgZone: topDown.confirmation15m?.fvgZone || null,
            gapPct: 0,
            spyChange: market.spyChange,
            exhaustion: dailyData.exhaustion,
            direction: topDown.direction,
            readyToTrade: topDown.readyToTrade
          };

          paper.openPositions.push(position);
          console.log(`[Paper] ENTERED ${symbol} at $${currentPrice} — Stop $${stopLoss} Target $${target} (Top-Down step ${topDown.overallStep}/4 ${topDown.readyToTrade?"ENTER NOW":"WATCHING"})`);

          // Max 3 positions for paper trading (1 cheap, 1 mid, 1 premium)
          if (paper.openPositions.length >= 3) break;

        } catch(e) { console.error(`[Paper] Error scanning ${symbol}:`, e.message); }

        // Small delay between stocks
        await new Promise(r=>setTimeout(r,300));
      }

      if (paper.openPositions.length === 0) {
        console.log(`[Paper] No ENTER NOW signals found this scan — waiting for next scan`);
      }
    }

    savePaperTrades(paper);

    // Log summary every 10 trades
    if (paper.totalTrades > 0 && paper.totalTrades % 10 === 0) {
      const wr = Math.round(paper.wins/paper.totalTrades*100);
      console.log(`[Paper] Summary: ${paper.totalTrades} trades | ${wr}% win rate | Balance: $${paper.balance}`);
    }

  } catch(e) { console.error("[Paper Trading]", e.message); }
}

// Paper trading endpoint
app.get("/api/paper", (req,res) => {
  const paper = loadPaperTrades();
  const wr = paper.totalTrades > 0 ? Math.round(paper.wins/paper.totalTrades*100) : 0;
  res.json({
    success: true,
    data: {
      balance: paper.balance,
      startingBalance: 1000,
      totalTrades: paper.totalTrades,
      wins: paper.wins,
      losses: paper.losses,
      winRate: wr,
      openPositions: paper.openPositions || [],
      recentTrades: paper.trades.slice(0,20),
      pnl: parseFloat((paper.balance - 1000).toFixed(2))
    }
  });
});


// ─── Scanner ──────────────────────────────────────────────────────────────────
async function runScanner() {
  try {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
    const h = et.getHours(), day = et.getDay();
    if (day===0||day===6||h<9||h>=16) return;

    // Check for SMC entries on watchlist
    const market = await getMarketStatus().catch(() => ({ spyChange:0, isExtreme:false, isBull:true }));
    const alerts = [];

    // Quick BTC check for MARA/RIOT
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true", { headers:{"User-Agent":"Mozilla/5.0"} });
      const d = await r.json();
      const ch = parseFloat((d.bitcoin?.usd_24h_change||0).toFixed(2));
      if (Math.abs(ch) > 3) alerts.push({ type:"CRYPTO", symbol:ch>0?"MARA":"RIOT", message:`Bitcoin ${ch>0?"UP":"DOWN"} ${Math.abs(ch).toFixed(1)}% — ${ch>0?"MARA/RIOT calls likely":"avoid MARA/RIOT"}`, urgency:"HIGH" });
    } catch(e) {}

    // Check top 3 stocks for SMC ENTER NOW signals
    const quickBatch = ["SOUN","MARA","SOFI"];
    for (const sym of quickBatch) {
      try {
        const c = await get5MinCandles(sym);
        if (!c) continue;
        const smc = detectSMCSetup(c.closes, c.highs, c.lows, c.opens, c.volumes);
        if (smc.entrySignal === "ENTER_NOW") {
          alerts.push({ type:"SMC_ENTRY", symbol:sym, message:`🟢 SMC ENTER NOW — ${sym}: ${smc.plain}`, urgency:"HIGH" });
        }
      } catch(e) {}
    }

    if (alerts.length > 0) {
      fs.writeFileSync(path.join(__dirname, "latest_alerts.json"), JSON.stringify({ alerts, timestamp:new Date().toISOString() }, null, 2));
    }
  } catch(e) { console.error("[Scanner]", e.message); }
}

app.get("/api/alerts/latest", (req,res) => {
  const f = path.join(__dirname, "latest_alerts.json");
  try {
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f,"utf8"));
      if (new Date(d.timestamp) > new Date(Date.now()-30*60*1000)) return res.json({ success:true, ...d });
    }
  } catch(e) {}
  res.json({ success:true, alerts:[], timestamp:new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SMC Trading AI v5 on port ${PORT}`);
  setTimeout(() => {
    // Background scanner — checks for alerts
    setInterval(() => runScanner().catch(e => console.error("[Scanner]", e.message)), 90000);
    console.log("[Scanner] Started");
    
    // Paper trading — practices SMC strategy 24/7
    setInterval(() => runPaperTrading().catch(e => console.error("[Paper]", e.message)), 120000); // Every 2 minutes
    console.log("[Paper Trading] Started — practicing SMC strategy automatically");
  }, 15000);
});
