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
const DATA_FILE  = path.join(__dirname, "challenge_data.json");
const LEARN_FILE = path.join(__dirname, "smc_learning.json");
const PAPER_FILE = path.join(__dirname, "paper_trades.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = { balance:10, startingBalance:10, trades:[], milestones:[] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); return d;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch(e) { return { balance:10, startingBalance:10, trades:[], milestones:[] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }

function loadLearning() {
  if (!fs.existsSync(LEARN_FILE)) {
    const d = { totalTrades:0, wins:0, losses:0, setupData:[], bestStocks:{}, bestTimes:{}, bestPatterns:{}, insights:[] };
    fs.writeFileSync(LEARN_FILE, JSON.stringify(d,null,2)); return d;
  }
  try { return JSON.parse(fs.readFileSync(LEARN_FILE,"utf8")); }
  catch(e) { return { totalTrades:0, wins:0, losses:0, setupData:[], bestStocks:{}, bestTimes:{}, bestPatterns:{}, insights:[] }; }
}
function saveLearning(d) { fs.writeFileSync(LEARN_FILE, JSON.stringify(d,null,2)); }

function loadPaperTrades() {
  if (!fs.existsSync(PAPER_FILE)) {
    const d = { balance:1000, startBalance:1000, trades:[], openPositions:[], totalTrades:0, wins:0, losses:0 };
    fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2));
    console.log("[Paper] New account created — $1000 starting balance");
    return d;
  }
  try {
    const d = JSON.parse(fs.readFileSync(PAPER_FILE,"utf8"));
    if (!d.openPositions) d.openPositions = [];
    if (!d.trades) d.trades = [];
    console.log(`[Paper] Loaded: ${d.totalTrades} trades | $${d.balance} balance | ${d.openPositions.length} open`);
    return d;
  } catch(e) { return { balance:1000, startBalance:1000, trades:[], openPositions:[], totalTrades:0, wins:0, losses:0 }; }
}
function savePaperTrades(d) { fs.writeFileSync(PAPER_FILE, JSON.stringify(d,null,2)); }

const MILESTONES = [25,50,100,250,500,1000,2500,5000,10000];
function checkMilestone(old, nw, existing) {
  for (const m of MILESTONES) { if(old<m&&nw>=m&&!(existing||[]).includes(m)) return m; }
  return null;
}

// ─── Watchlists ───────────────────────────────────────────────────────────────
// Real trading — cheap stocks with affordable options for small balance
const REAL_WATCHLIST = ["SOUN","SOFI","MARA","RIOT","PLTR","HOOD","NIO","PLUG","BBAI","LWM","SAVE","CLSK"];

// Paper trading — quality stocks with clean patterns for learning
const PAPER_WATCHLIST = ["SPY","NVDA","AAPL","PLTR","AMD","IWM","QQQ","BABA"];

// Main watchlist used for real analysis
const WATCHLIST = REAL_WATCHLIST;

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

// ─── Candle Fetcher ───────────────────────────────────────────────────────────
async function getCandles(symbol, interval, range) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
    const r = await fetch(url, { headers:{"User-Agent":"Mozilla/5.0"} });
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
    })).filter(b => b.close != null && b.open != null && b.high != null && b.low != null);
    if (bars.length < 5) return null;
    return {
      bars,
      closes:  bars.map(b => b.close),
      opens:   bars.map(b => b.open),
      highs:   bars.map(b => b.high),
      lows:    bars.map(b => b.low),
      volumes: bars.map(b => b.volume),
      current: bars[bars.length-1].close,
      currentBar: bars[bars.length-1]
    };
  } catch(e) { return null; }
}

// ─── CANDLE PATTERN DETECTION ─────────────────────────────────────────────────
// Pure price action — no indicators needed
function detectCandlePatterns(bars) {
  if (!bars || bars.length < 5) return [];
  const patterns = [];
  const last  = bars[bars.length-1];
  const prev  = bars[bars.length-2];
  const prev2 = bars[bars.length-3];
  const prev3 = bars[bars.length-4];

  // Helper functions
  const bodySize  = b => Math.abs(b.close - b.open);
  const isGreen   = b => b.close > b.open;
  const isRed     = b => b.close < b.open;
  const upperWick = b => b.high - Math.max(b.open, b.close);
  const lowerWick = b => Math.min(b.open, b.close) - b.low;
  const totalSize = b => b.high - b.low;
  const avgBody   = bars.slice(-10).reduce((s,b) => s + bodySize(b), 0) / 10;

  // ─── 1. BULLISH ENGULFING ───────────────────────────────────────────────────
  // Big green candle completely covers the previous red candle
  // Strong buy signal — institutions stepping in
  if (isRed(prev) && isGreen(last) &&
      last.open <= prev.close &&
      last.close >= prev.open &&
      bodySize(last) > bodySize(prev) * 1.1) {
    patterns.push({
      name: "BULLISH ENGULFING",
      direction: "CALL",
      strength: "STRONG",
      entry: "ENTER NOW",
      plain: `Big green candle just swallowed the previous red candle on ${last.time.toLocaleTimeString()}. Buyers took complete control. Enter CALL immediately.`,
      entryPrice: last.close,
      stopBelow: prev.low
    });
  }

  // ─── 2. BEARISH ENGULFING ───────────────────────────────────────────────────
  if (isGreen(prev) && isRed(last) &&
      last.open >= prev.close &&
      last.close <= prev.open &&
      bodySize(last) > bodySize(prev) * 1.1) {
    patterns.push({
      name: "BEARISH ENGULFING",
      direction: "PUT",
      strength: "STRONG",
      entry: "ENTER NOW",
      plain: `Big red candle just swallowed the previous green candle. Sellers took control. Enter PUT immediately.`,
      entryPrice: last.close,
      stopAbove: prev.high
    });
  }

  // ─── 3. BULLISH PIN BAR (Hammer) ────────────────────────────────────────────
  // Long lower wick, small body near top — price rejected the lows hard
  if (lowerWick(last) > bodySize(last) * 2 &&
      lowerWick(last) > upperWick(last) * 2 &&
      bodySize(last) > 0) {
    patterns.push({
      name: "BULLISH PIN BAR",
      direction: "CALL",
      strength: "STRONG",
      entry: "ENTER NOW",
      plain: `Price tried to go lower but got rejected hard — long lower wick shows buyers stepped in aggressively. Enter CALL.`,
      entryPrice: last.close,
      stopBelow: last.low
    });
  }

  // ─── 4. BEARISH PIN BAR (Shooting Star) ─────────────────────────────────────
  if (upperWick(last) > bodySize(last) * 2 &&
      upperWick(last) > lowerWick(last) * 2 &&
      bodySize(last) > 0) {
    patterns.push({
      name: "BEARISH PIN BAR",
      direction: "PUT",
      strength: "STRONG",
      entry: "ENTER NOW",
      plain: `Price tried to go higher but got rejected hard — long upper wick shows sellers stepped in aggressively. Enter PUT.`,
      entryPrice: last.close,
      stopAbove: last.high
    });
  }

  // ─── 5. INSIDE BAR BREAKOUT ──────────────────────────────────────────────────
  // Current candle fits inside previous candle — breakout imminent
  if (last.high <= prev.high && last.low >= prev.low && bodySize(last) < bodySize(prev)) {
    const direction = isGreen(prev) ? "CALL" : "PUT";
    patterns.push({
      name: "INSIDE BAR",
      direction,
      strength: "MEDIUM",
      entry: "READY",
      plain: `Small candle forming inside the previous candle — compression before explosion. Watch for breakout above $${prev.high.toFixed(2)} for CALL or below $${prev.low.toFixed(2)} for PUT.`,
      entryPrice: direction === "CALL" ? prev.high : prev.low,
      stopBelow: prev.low,
      stopAbove: prev.high
    });
  }

  // ─── 6. THREE WHITE SOLDIERS ─────────────────────────────────────────────────
  // Three consecutive green candles — strong momentum confirmed
  if (isGreen(prev2) && isGreen(prev) && isGreen(last) &&
      prev.close > prev2.close && last.close > prev.close &&
      prev.open > prev2.open && last.open > prev.open &&
      bodySize(last) > avgBody * 0.7 &&
      bodySize(prev) > avgBody * 0.7) {
    patterns.push({
      name: "THREE WHITE SOLDIERS",
      direction: "CALL",
      strength: "VERY STRONG",
      entry: "ENTER NOW",
      plain: `Three consecutive strong green candles — powerful bullish momentum confirmed. Institutions are buying. Enter CALL.`,
      entryPrice: last.close,
      stopBelow: prev2.low
    });
  }

  // ─── 7. THREE BLACK CROWS ────────────────────────────────────────────────────
  if (isRed(prev2) && isRed(prev) && isRed(last) &&
      prev.close < prev2.close && last.close < prev.close &&
      bodySize(last) > avgBody * 0.7) {
    patterns.push({
      name: "THREE BLACK CROWS",
      direction: "PUT",
      strength: "VERY STRONG",
      entry: "ENTER NOW",
      plain: `Three consecutive strong red candles — powerful bearish momentum confirmed. Enter PUT.`,
      entryPrice: last.close,
      stopAbove: prev2.high
    });
  }

  // ─── 8. MORNING STAR (3-candle reversal) ─────────────────────────────────────
  // Big red, small doji, big green — reversal from downtrend
  if (isRed(prev2) && bodySize(prev) < avgBody * 0.3 && isGreen(last) &&
      bodySize(prev2) > avgBody * 0.8 && bodySize(last) > avgBody * 0.8 &&
      last.close > (prev2.open + prev2.close) / 2) {
    patterns.push({
      name: "MORNING STAR",
      direction: "CALL",
      strength: "VERY STRONG",
      entry: "ENTER NOW",
      plain: `Classic 3-candle reversal — big red, small pause, big green. Downtrend reversing. Strong CALL signal.`,
      entryPrice: last.close,
      stopBelow: prev.low
    });
  }

  // ─── 9. EVENING STAR ─────────────────────────────────────────────────────────
  if (isGreen(prev2) && bodySize(prev) < avgBody * 0.3 && isRed(last) &&
      bodySize(prev2) > avgBody * 0.8 && bodySize(last) > avgBody * 0.8 &&
      last.close < (prev2.open + prev2.close) / 2) {
    patterns.push({
      name: "EVENING STAR",
      direction: "PUT",
      strength: "VERY STRONG",
      entry: "ENTER NOW",
      plain: `Classic 3-candle reversal — big green, small pause, big red. Uptrend reversing. Strong PUT signal.`,
      entryPrice: last.close,
      stopAbove: prev.high
    });
  }

  // ─── 10. BULLISH MOMENTUM (3+ green with volume) ────────────────────────────
  const last3green = isGreen(prev2) && isGreen(prev) && isGreen(last);
  const vol3 = bars.slice(-3).map(b=>b.volume);
  const avgVol = bars.slice(-20).reduce((s,b)=>s+b.volume,0)/20;
  const volumeSurge = vol3.every(v => v > avgVol * 1.3);

  if (last3green && volumeSurge && bodySize(last) > avgBody * 0.5) {
    patterns.push({
      name: "BULLISH MOMENTUM + VOLUME",
      direction: "CALL",
      strength: "STRONG",
      entry: "ENTER NOW",
      plain: `Three green candles with above-average volume on each — institutions buying. Real momentum. Enter CALL.`,
      entryPrice: last.close,
      stopBelow: prev2.low
    });
  }

  return patterns;
}

// ─── Full stock analysis ──────────────────────────────────────────────────────
async function analyzeStock(symbol) {
  try {
    // Get 5-minute and 15-minute candles
    const [c5m, c15m, daily] = await Promise.allSettled([
      getCandles(symbol, "5m", "2d"),
      getCandles(symbol, "15m", "5d"),
      getCandles(symbol, "1d", "60d")
    ]);

    const bars5m  = c5m.status==="fulfilled"  ? c5m.value  : null;
    const bars15m = c15m.status==="fulfilled" ? c15m.value : null;
    const barsD   = daily.status==="fulfilled" ? daily.value : null;

    if (!bars5m && !bars15m) return null;

    const currentPrice = bars5m?.current || bars15m?.current || 0;

    // Only use today's 5-min bars
    const today = new Date().toDateString();
    const todayBars5m = bars5m?.bars.filter(b => b.time.toDateString() === today) || [];
    const useBars5m = todayBars5m.length >= 5 ? todayBars5m : bars5m?.bars.slice(-30) || [];

    // Detect patterns on both timeframes
    const patterns5m  = detectCandlePatterns(useBars5m);
    const patterns15m = detectCandlePatterns(bars15m?.bars.slice(-20) || []);

    // ATR for stop/target calculation
    const highs = barsD?.highs || [];
    const lows  = barsD?.lows  || [];
    const closes= barsD?.closes|| [];
    let atr = 0;
    if (highs.length >= 14) {
      const trs = [];
      for (let i=1; i<highs.length; i++) {
        trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
      }
      atr = trs.slice(-14).reduce((a,b)=>a+b,0)/14;
    }

    // Today's change
    const dailyChange = barsD && closes.length >= 2
      ? parseFloat(((closes[closes.length-1]-closes[closes.length-2])/closes[closes.length-2]*100).toFixed(2))
      : 0;

    // Exhaustion check
    const avgMove = atr > 0 ? atr/currentPrice*100 : 2;
    const moveRatio = avgMove > 0 ? Math.abs(dailyChange)/avgMove : 0;
    const exhaustion = moveRatio >= 4 ? "EXTREMELY_EXHAUSTED" : moveRatio >= 2.5 ? "VERY_EXHAUSTED" : moveRatio >= 1.5 ? "EXTENDED" : "FRESH";

    // Volume analysis
    const todayVol = useBars5m.reduce((s,b)=>s+b.volume,0);
    const avgDailyVol = barsD?.volumes?.slice(-20).reduce((s,v)=>s+v,0)/20 || 0;
    const volRatio = avgDailyVol > 0 ? parseFloat((todayVol/avgDailyVol).toFixed(2)) : 1;

    // Score the best pattern
    let bestPattern = null;
    let bestScore = 0;

    // 15-min patterns are stronger signals
    const allPatterns = [
      ...patterns15m.map(p => ({...p, timeframe:"15-minute", score: p.strength==="VERY STRONG"?90:p.strength==="STRONG"?75:60})),
      ...patterns5m.map(p => ({...p, timeframe:"5-minute", score: p.strength==="VERY STRONG"?80:p.strength==="STRONG"?65:50}))
    ];

    // Boost score based on conditions
    allPatterns.forEach(p => {
      let score = p.score;
      if (exhaustion === "FRESH") score += 10;
      if (exhaustion === "EXTREMELY_EXHAUSTED") score -= 30;
      if (volRatio > 1.5) score += 10;
      if (p.timeframe === "15-minute") score += 10; // 15-min patterns more reliable
      if (score > bestScore) { bestScore = score; bestPattern = p; }
    });

    // Get options data for real ask prices
    let bestOption = null;
    try {
      const or = await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}`, { headers:{"User-Agent":"Mozilla/5.0"} });
      if (or.ok) {
        const od = await or.json();
        const chain = od.optionChain?.result?.[0]?.options?.[0];
        const options = bestPattern?.direction === "PUT"
          ? (chain?.puts || [])
          : (chain?.calls || []);
        bestOption = options
          .filter(o => o.ask > 0 && o.openInterest >= 100)
          .sort((a,b) => Math.abs(a.strike - currentPrice) - Math.abs(b.strike - currentPrice))
          [0];
        if (bestOption) {
          bestOption = {
            strike: bestOption.strike,
            ask: parseFloat((bestOption.ask||0).toFixed(2)),
            bid: parseFloat((bestOption.bid||0).toFixed(2)),
            totalCost: parseFloat(((bestOption.ask||0)*100).toFixed(2)),
            expiration: new Date((bestOption.expiration||0)*1000).toLocaleDateString(),
            openInterest: bestOption.openInterest || 0
          };
        }
      }
    } catch(e) {}

    return {
      symbol,
      currentPrice,
      dailyChange,
      exhaustion,
      volRatio,
      atr: parseFloat(atr.toFixed(2)),
      patterns5m,
      patterns15m,
      allPatterns,
      bestPattern,
      bestScore: Math.min(100, Math.round(bestScore)),
      bestOption,
      timeframe: bestPattern?.timeframe || null
    };
  } catch(e) {
    console.error(`[Analyze] ${symbol}:`, e.message);
    return null;
  }
}

// ─── Trading Window ───────────────────────────────────────────────────────────
function getTradingWindow() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone:"America/New_York" }));
  const h = et.getHours(), m = et.getMinutes(), t = h+m/60, day = et.getDay();
  if (day===0||day===6) return { canTrade:false, window:"WEEKEND", msg:"Market closed. Come back Monday.", killZone:false };
  if (t < 9.5)  return { canTrade:false, window:"PRE_MARKET", msg:"Market opens 9:30 AM ET.", killZone:false };
  if (t < 10.0) return { canTrade:false, window:"TOO_EARLY", msg:"Wait until 10:00 AM — opening is too volatile.", killZone:false };
  if (t >= 10.0 && t < 11.0) return { canTrade:true, window:"KILL_ZONE", msg:"🎯 10-11 AM Kill Zone — best time for candle patterns.", killZone:true };
  if (t < 11.5) return { canTrade:true, window:"GOOD", msg:"Good window. Strong patterns only.", killZone:false };
  if (t < 12.0) return { canTrade:true, window:"CLOSING", msg:"Window closing soon. High confidence only.", killZone:false };
  if (t < 13.0) return { canTrade:false, window:"LUNCH", msg:"Lunch dead zone 12-1 PM. Volume dries up. Wait.", killZone:false };
  if (t >= 13.3 && t < 14.0) return { canTrade:true, window:"PM_KILL_ZONE", msg:"🎯 1:30-2 PM Kill Zone — second best window.", killZone:true };
  if (t < 15.5) return { canTrade:true, window:"AFTERNOON", msg:"Afternoon window. Strong patterns only.", killZone:false };
  return { canTrade:false, window:"CLOSED", msg:"3:30 PM — no new trades. Close everything.", killZone:false };
}

// ─── Learning System ──────────────────────────────────────────────────────────
function updateLearning(tradeData) {
  const learn = loadLearning();
  const { symbol, result, pnl, hour, pattern, timeframe } = tradeData;

  learn.totalTrades = (learn.totalTrades||0) + 1;
  if (result==="win") learn.wins = (learn.wins||0) + 1;
  else if (result==="loss") learn.losses = (learn.losses||0) + 1;

  learn.setupData = learn.setupData || [];
  learn.setupData.push({ date:new Date().toISOString(), symbol, result, pnl, hour, pattern, timeframe });

  // Per-stock tracking
  if (!learn.bestStocks[symbol]) learn.bestStocks[symbol] = { wins:0, losses:0, trades:0 };
  learn.bestStocks[symbol].trades++;
  if (result==="win") learn.bestStocks[symbol].wins++;
  else if (result==="loss") learn.bestStocks[symbol].losses++;

  // Per-pattern tracking
  if (pattern) {
    if (!learn.bestPatterns[pattern]) learn.bestPatterns[pattern] = { wins:0, losses:0, trades:0 };
    learn.bestPatterns[pattern].trades++;
    if (result==="win") learn.bestPatterns[pattern].wins++;
    else if (result==="loss") learn.bestPatterns[pattern].losses++;
  }

  // Per-hour tracking
  const hourKey = `${hour}:00`;
  if (!learn.bestTimes[hourKey]) learn.bestTimes[hourKey] = { wins:0, losses:0, trades:0 };
  learn.bestTimes[hourKey].trades++;
  if (result==="win") learn.bestTimes[hourKey].wins++;
  else if (result==="loss") learn.bestTimes[hourKey].losses++;

  // Generate insights
  const insights = [];
  if (learn.totalTrades >= 3) {
    const wr = Math.round(learn.wins/learn.totalTrades*100);
    insights.push(`Overall: ${wr}% win rate across ${learn.totalTrades} trades`);

    // Best stock
    const stocks = Object.entries(learn.bestStocks)
      .filter(([,v])=>v.trades>=2)
      .map(([k,v])=>({symbol:k, wr:Math.round(v.wins/v.trades*100), trades:v.trades}))
      .sort((a,b)=>b.wr-a.wr);
    if (stocks.length>0) insights.push(`Best stock: ${stocks[0].symbol} (${stocks[0].wr}% win rate)`);
    if (stocks.length>1 && stocks[stocks.length-1].wr<40) insights.push(`Avoid: ${stocks[stocks.length-1].symbol} (${stocks[stocks.length-1].wr}% win rate)`);

    // Best pattern
    const patterns = Object.entries(learn.bestPatterns)
      .filter(([,v])=>v.trades>=2)
      .map(([k,v])=>({pattern:k, wr:Math.round(v.wins/v.trades*100), trades:v.trades}))
      .sort((a,b)=>b.wr-a.wr);
    if (patterns.length>0) insights.push(`Best pattern: ${patterns[0].pattern} (${patterns[0].wr}% win rate)`);

    // Best time
    const times = Object.entries(learn.bestTimes)
      .filter(([,v])=>v.trades>=2)
      .map(([k,v])=>({hour:k, wr:Math.round(v.wins/v.trades*100), trades:v.trades}))
      .sort((a,b)=>b.wr-a.wr);
    if (times.length>0) insights.push(`Best time: ${times[0].hour} (${times[0].wr}% win rate)`);
  }

  learn.insights = insights;
  saveLearning(learn);
  return insights;
}

// ─── Education ────────────────────────────────────────────────────────────────
function getEdLevel(data) {
  const t = data.trades?.length||0, b = data.balance||10;
  if(t>=60&&b>=1000) return 4;
  if(t>=30&&b>=200) return 3;
  if(t>=10&&b>=50) return 2;
  return 1;
}

// ─── MAIN ANALYSIS ────────────────────────────────────────────────────────────
app.get("/api/analyze", async (req, res) => {
  try {
    const data = loadData();
    const learn = loadLearning();
    const tw = getTradingWindow();

    // Sort watchlist by learned win rate
    const sortedWatchlist = [...WATCHLIST].sort((a,b) => {
      const aWR = learn.bestStocks[a]?.trades>=2 ? learn.bestStocks[a].wins/learn.bestStocks[a].trades : 0.5;
      const bWR = learn.bestStocks[b]?.trades>=2 ? learn.bestStocks[b].wins/learn.bestStocks[b].trades : 0.5;
      return bWR - aWR;
    });

    // Analyze all stocks in parallel
    const results = await Promise.allSettled(sortedWatchlist.map(s => analyzeStock(s)));
    const analyzed = results
      .map((r,i) => r.status==="fulfilled" && r.value ? {...r.value, symbol:sortedWatchlist[i]} : null)
      .filter(Boolean)
      .filter(s => !["EXTREMELY_EXHAUSTED","VERY_EXHAUSTED"].includes(s.exhaustion))
      .sort((a,b) => b.bestScore - a.bestScore);

    const best = analyzed[0];
    const learnInsights = learn.insights?.join(" | ") || "Trade more to unlock insights";

    const prompt = `You are an expert options trading AI. Respond ONLY with valid JSON.

CANDLE PATTERN STRATEGY — Pure price action on 5-min and 15-min charts.
No indicators. Just candles. Enter on confirmed patterns only.

TODAY: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()} ET
Time Window: ${tw.window} ${tw.killZone?"🎯 KILL ZONE — best time":""}— ${tw.msg}
Can Trade: ${tw.canTrade}

TOP STOCK: ${best?.symbol||"NONE"} ($${best?.currentPrice||0}, ${best?.dailyChange||0}% today)
Best Pattern: ${best?.bestPattern?.name||"None"} on ${best?.bestPattern?.timeframe||"?"} chart
Signal: ${best?.bestPattern?.entry||"WAIT"}
Direction: ${best?.bestPattern?.direction||"CALL"}
Pattern Explanation: ${best?.bestPattern?.plain||"No pattern found"}
Score: ${best?.bestScore||0}/100
Exhaustion: ${best?.exhaustion||"UNKNOWN"}
Volume: ${best?.volRatio||1}x average

ALL STOCKS SCANNED:
${analyzed.slice(0,8).map(s=>`${s.symbol}: ${s.bestPattern?.name||"no pattern"} (${s.bestScore}/100) ${s.exhaustion}`).join("\n")}

LEARNED: ${learnInsights}
USER: $${data.balance} balance | max risk $${(data.balance*0.15).toFixed(2)}

RULES:
- Only recommend if pattern score >= 60 and canTrade = true
- ENTER NOW for Engulfing, Pin Bar, Three Soldiers, Morning/Evening Star
- READY for Inside Bar (waiting for breakout)
- WAIT if no clear pattern or score too low
- Never recommend exhausted stocks
- Keep response SHORT and actionable

Return this JSON:
{
  "canTrade": ${tw.canTrade},
  "timeWindow": "${tw.window}",
  "timeMsg": "${tw.msg}",
  "killZone": ${tw.killZone},
  "symbol": "${best?.symbol||"NONE"}",
  "pattern": "${best?.bestPattern?.name||"NONE"}",
  "patternTimeframe": "${best?.bestPattern?.timeframe||"5-minute"}",
  "direction": "${best?.bestPattern?.direction||"CALL"}",
  "signal": "ENTER NOW or READY or WAIT",
  "entryTrigger": "Exact entry in 1 sentence",
  "plain": "Plain English explanation of what the chart is showing right now",
  "confidence": "HIGH or MEDIUM or LOW",
  "score": ${best?.bestScore||0},
  "price": ${best?.currentPrice||0},
  "change": ${best?.dailyChange||0},
  "stopLoss": ${best?.currentPrice&&best?.atr ? parseFloat((best.currentPrice - best.atr).toFixed(2)) : 0},
  "target": ${best?.currentPrice&&best?.atr ? parseFloat((best.currentPrice + best.atr * 1.5).toFixed(2)) : 0},
  "strike": ${best?.bestOption?.strike||0},
  "expiration": "${best?.bestOption?.expiration||"5-10 days out"}",
  "askPrice": ${best?.bestOption?.ask||0},
  "totalCost": ${best?.bestOption?.totalCost||0},
  "allStocks": ${JSON.stringify(analyzed.slice(0,8).map(s=>({symbol:s.symbol,score:s.bestScore,pattern:s.bestPattern?.name||"none",direction:s.bestPattern?.direction||"CALL",signal:s.bestPattern?.entry||"WAIT",timeframe:s.bestPattern?.timeframe||"5-minute"})))},
  "learnedInsight": "${learn.totalTrades>=3?learnInsights.split("|")[0].trim():"Trade more to unlock insights"}"
}`;

    const ai = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      messages: [{ role:"user", content:prompt }]
    });

    const raw = ai.content[0]?.text || "";
    let analysis;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON");
      analysis = JSON.parse(match[0]);
    } catch(e) {
      console.error("[Parse]", e.message);
      throw new Error("Analysis failed — please try again");
    }

    analysis._balance  = data.balance;
    analysis._trades   = data.trades.length;
    analysis._learning = {
      totalTrades: learn.totalTrades||0,
      wins: learn.wins||0,
      losses: learn.losses||0,
      winRate: learn.totalTrades>0 ? Math.round(learn.wins/learn.totalTrades*100) : 0,
      insights: learn.insights||[],
      bestPatterns: learn.bestPatterns||{}
    };

    res.json({ success:true, data:analysis });
  } catch(err) {
    console.error("[Analysis]", err.message);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ─── Paper Trading ────────────────────────────────────────────────────────────
async function runPaperTrading() {
  try {
    const et = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const h = et.getHours(), m = et.getMinutes(), t = h+m/60, day = et.getDay();
    if (day===0||day===6||t<9.5||t>16) return;

    const paper = loadPaperTrades();

    // Close open positions
    const stillOpen = [];
    for (const pos of (paper.openPositions||[])) {
      try {
        const c = await getCandles(pos.symbol, "5m", "1d");
        const cp = c?.current;
        if (!cp) { stillOpen.push(pos); continue; }

        const hitTarget = cp >= pos.target;
        const hitStop   = cp <= pos.stopLoss;
        const endOfDay  = h >= 15 && m >= 30;
        const expired   = new Date()-new Date(pos.entryTime) > 6*60*60*1000;

        if (hitTarget || hitStop || endOfDay || expired) {
          const result = hitTarget ? "win" : "loss";
          const pnl = hitTarget
            ? parseFloat((pos.amountRisked * 0.5).toFixed(2))
            : parseFloat((-pos.amountRisked).toFixed(2));

          paper.totalTrades++;
          if (result==="win") paper.wins++;
          else paper.losses++;
          paper.balance = parseFloat((paper.balance+pnl).toFixed(2));

          paper.trades.unshift({
            symbol:pos.symbol, entryPrice:pos.entryPrice, exitPrice:cp,
            entryTime:pos.entryTime, exitTime:new Date().toISOString(),
            result, pnl, amountRisked:pos.amountRisked,
            pattern:pos.pattern, timeframe:pos.timeframe,
            reason:hitTarget?"Target hit":hitStop?"Stop hit":endOfDay?"End of day":"Expired"
          });
          if (paper.trades.length>200) paper.trades=paper.trades.slice(0,200);

          updateLearning({
            symbol:pos.symbol, result, pnl,
            hour:new Date(pos.entryTime).getHours(),
            pattern:pos.pattern, timeframe:pos.timeframe
          });

          const wr = paper.totalTrades>0?Math.round(paper.wins/paper.totalTrades*100):0;
          console.log(`[Paper] ${result==="win"?"✅":"❌"} CLOSED ${pos.symbol} ${pos.pattern} — ${result} $${pnl} | ${paper.totalTrades} trades ${wr}% WR $${paper.balance}`);
        } else {
          stillOpen.push(pos);
        }
      } catch(e) { stillOpen.push(pos); }
    }
    paper.openPositions = stillOpen;

    // Find new entries — max 3 open positions
    if (paper.openPositions.length < 3 && t >= 10 && t <= 15.5) {
      for (const symbol of PAPER_WATCHLIST) {
        if (paper.openPositions.find(p=>p.symbol===symbol)) continue;

        try {
          const stock = await analyzeStock(symbol);
          if (!stock) continue;
          if (["EXTREMELY_EXHAUSTED","VERY_EXHAUSTED"].includes(stock.exhaustion)) continue;
          if (!stock.bestPattern) continue;
          if (stock.bestScore < 60) continue;
          if (stock.bestPattern.entry !== "ENTER NOW") continue;

          const atr = stock.atr || stock.currentPrice * 0.02;
          paper.openPositions.push({
            symbol, entryPrice:stock.currentPrice,
            stopLoss: parseFloat((stock.currentPrice - atr).toFixed(2)),
            target: parseFloat((stock.currentPrice + atr*1.5).toFixed(2)),
            amountRisked: 50,
            entryTime: new Date().toISOString(),
            pattern: stock.bestPattern.name,
            timeframe: stock.bestPattern.timeframe,
            direction: stock.bestPattern.direction
          });
          console.log(`[Paper] ENTERED ${symbol} — ${stock.bestPattern.name} on ${stock.bestPattern.timeframe} at $${stock.currentPrice}`);
          if (paper.openPositions.length >= 3) break;
        } catch(e) {}
        await new Promise(r=>setTimeout(r,300));
      }
    }

    savePaperTrades(paper);
  } catch(e) { console.error("[Paper]", e.message); }
}

// ─── API Endpoints ────────────────────────────────────────────────────────────
app.get("/api/challenge", (req,res) => res.json({success:true,data:loadData()}));

app.post("/api/balance/update", (req,res) => {
  const {balance} = req.body;
  if (isNaN(balance)||balance<0) return res.status(400).json({success:false,error:"Invalid"});
  const data = loadData();
  const old = data.balance;
  data.balance = parseFloat(parseFloat(balance).toFixed(2));
  const m = checkMilestone(old,data.balance,data.milestones||[]);
  if(m)(data.milestones=data.milestones||[]).push(m);
  saveData(data);
  res.json({success:true,balance:data.balance,milestone:m});
});

app.post("/api/reset", (req,res) => {
  const bal = parseFloat(req.body.startingBalance)||10;
  saveData({balance:bal,startingBalance:bal,trades:[],milestones:[],createdAt:new Date().toISOString()});
  res.json({success:true,message:`Reset to $${bal}`});
});

app.post("/api/trade/log", (req,res) => {
  const {symbol,optionType,entryPrice,exitPrice,amount,result,notes,pattern,timeframe} = req.body;
  const data = loadData();
  const pnl = result==="win"?parseFloat((exitPrice-amount).toFixed(2)):result==="skip"?0:parseFloat((-amount).toFixed(2));
  const old = data.balance;
  if(result!=="skip") data.balance = parseFloat(Math.max(0,data.balance+pnl).toFixed(2));
  const m = checkMilestone(old,data.balance,data.milestones||[]);
  if(m)(data.milestones=data.milestones||[]).push(m);
  data.trades = data.trades||[];
  data.trades.unshift({id:Date.now(),date:new Date().toISOString(),symbol,optionType,entryPrice,exitPrice,amountRisked:amount,pnl,result,balanceAfter:data.balance,notes:notes||"",pattern:pattern||"",timeframe:timeframe||""});
  saveData(data);
  const hour = new Date().getHours();
  const insights = updateLearning({symbol,result,pnl,hour,pattern,timeframe});
  res.json({success:true,newBalance:data.balance,milestone:m,insights});
});

app.post("/api/trade/manual", (req,res) => {
  const {symbol,optionType,amount,exitValue,result,date,notes} = req.body;
  const data = loadData();
  const pnl = result==="win"?parseFloat((exitValue-amount).toFixed(2)):result==="loss"?parseFloat((-amount).toFixed(2)):0;
  data.trades = data.trades||[];
  data.trades.push({id:Date.now(),date:date?new Date(date).toISOString():new Date().toISOString(),symbol,optionType,entryPrice:amount,exitPrice:exitValue,amountRisked:amount,pnl,result,balanceAfter:data.balance,notes:notes||"",manualEntry:true});
  saveData(data);
  res.json({success:true});
});

app.get("/api/paper", (req,res) => {
  const paper = loadPaperTrades();
  const wr = paper.totalTrades>0?Math.round(paper.wins/paper.totalTrades*100):0;
  res.json({success:true,data:{
    balance:paper.balance, startingBalance:paper.startBalance||1000,
    totalTrades:paper.totalTrades, wins:paper.wins, losses:paper.losses,
    winRate:wr, openPositions:paper.openPositions||[],
    recentTrades:(paper.trades||[]).slice(0,20),
    pnl:parseFloat((paper.balance-(paper.startBalance||1000)).toFixed(2))
  }});
});

app.get("/api/learning", (req,res) => res.json({success:true,data:loadLearning()}));

app.get("/api/export", (req,res) => {
  res.setHeader("Content-Disposition","attachment; filename=backup-"+new Date().toISOString().split("T")[0]+".json");
  res.json({exportedAt:new Date().toISOString(),challenge:loadData(),learning:loadLearning(),paper:loadPaperTrades()});
});

app.post("/api/import", (req,res) => {
  try {
    const {challenge,learning,paper} = req.body;
    if(challenge) saveData(challenge);
    if(learning) saveLearning(learning);
    if(paper) savePaperTrades(paper);
    res.json({success:true,message:"Restored!"});
  } catch(e) { res.status(500).json({success:false,error:e.message}); }
});

app.get("/api/price/:symbol", async (req,res) => {
  try {
    const c = await getCandles(req.params.symbol,"1m","1d");
    res.json(c?{success:true,price:c.current}:{success:false});
  } catch(e) { res.json({success:false}); }
});

app.post("/api/monitor/start", async (req,res) => {
  const {email,symbol,stopLoss,profitTarget} = req.body;
  const id = `${symbol}_${Date.now()}`;
  activeMonitors[id] = {email,symbol,stopLoss,profitTarget,active:true};
  const interval = setInterval(async()=>{
    if(!activeMonitors[id]?.active){clearInterval(interval);return;}
    try {
      const c = await getCandles(symbol,"1m","1d");
      const cp = c?.current;
      if(!cp)return;
      if(cp>=profitTarget||cp<=stopLoss){
        clearInterval(interval);activeMonitors[id].active=false;
        const win=cp>=profitTarget;
        await sendEmail(email,win?"🟢 TAKE PROFIT!":"🔴 STOP LOSS!",`<div style="padding:20px"><h2>${win?"PROFIT HIT":"STOP HIT"} — ${symbol}</h2><p>Price: $${cp}. Open Robinhood NOW!</p></div>`);
      }
    }catch(e){}
  },180000);
  activeMonitors[id].intervalId=interval;
  await sendEmail(email,`👁 Watching ${symbol}`,`<div style="padding:20px"><h2>Monitoring ${symbol}</h2><p>Stop:$${stopLoss} Target:$${profitTarget}</p></div>`);
  res.json({success:true,monitorId:id});
});

app.post("/api/monitor/stop",(req,res)=>{
  const{monitorId}=req.body;
  if(activeMonitors[monitorId]){clearInterval(activeMonitors[monitorId].intervalId);activeMonitors[monitorId].active=false;}
  res.json({success:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`Candle Pattern Trading AI v6 on port ${PORT}`);
  setTimeout(()=>{
    setInterval(()=>runPaperTrading().catch(e=>console.error("[Paper]",e.message)),120000);
    console.log("[Paper Trading] Started — scanning every 2 minutes");
    if(process.env.RAILWAY_PUBLIC_DOMAIN){
      const url=`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
      setInterval(()=>fetch(`${url}/api/challenge`).catch(()=>{}),4*60*1000);
      console.log("[Ping] Self-ping started");
    }
  },15000);
});
