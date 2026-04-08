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
process.on("unhandledRejection", (reason) => { console.error("[REJECTION PREVENTED]", reason?.message||reason); });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Data files
const DATA_FILE = path.join(__dirname, "challenge_data.json");
const STRATEGY_FILE = path.join(__dirname, "strategy_memory.json");
const PENDING_FILE = path.join(__dirname, "pending_setups.json");

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const d = { balance:10, startingBalance:10, goal:10000, trades:[], milestones:[], createdAt:new Date().toISOString(), consecutiveWins:0, consecutiveLosses:0 };
    fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); return d;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE,"utf8")); }
  catch(e) { return { balance:10, startingBalance:10, goal:10000, trades:[], milestones:[] }; }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }
function loadSM() {
  if (!fs.existsSync(STRATEGY_FILE)) { const d={patterns:[],strategyPerformance:{},lastAdaptation:null}; fs.writeFileSync(STRATEGY_FILE,JSON.stringify(d,null,2)); return d; }
  try { return JSON.parse(fs.readFileSync(STRATEGY_FILE,"utf8")); } catch(e) { return {patterns:[],strategyPerformance:{}}; }
}
function saveSM(d) { fs.writeFileSync(STRATEGY_FILE, JSON.stringify(d,null,2)); }
function loadPending() { try { return fs.existsSync(PENDING_FILE)?JSON.parse(fs.readFileSync(PENDING_FILE,"utf8")):[];} catch(e){return[];} }
function savePending(d) { fs.writeFileSync(PENDING_FILE, JSON.stringify(d,null,2)); }

const MILESTONES = [25,50,100,250,500,1000,2500,5000,10000];
function checkMilestone(old, nw, existing) { for(const m of MILESTONES){if(old<m&&nw>=m&&!(existing||[]).includes(m))return m;} return null; }

const CHEAP = ["SOUN","SOFI","MARA","RIOT","PLTR","HOOD","AAL","VALE","CLSK","NIO","XPEV","PLUG","BBAI","SAVE","SPCE"];
const MID = ["TSLA","AMD","NVDA","AAPL","AMZN","META","COIN","RBLX"];
const HIGH = ["TSLA","NVDA","AAPL","AMZN","META","MSFT","GOOGL","SPY","QQQ"];
function getWatchlist(bal) { if(bal>=2000)return HIGH; if(bal>=500)return[...CHEAP.slice(0,8),...MID.slice(0,4)]; if(bal>=100)return[...CHEAP.slice(0,10),...MID.slice(0,2)]; return CHEAP; }

const activeMonitors = {};
async function sendEmail(to, subject, html) {
  if (!process.env.ALERT_EMAIL||!process.env.ALERT_EMAIL_PASSWORD) return false;
  try { const t=nodemailer.createTransport({service:"gmail",auth:{user:process.env.ALERT_EMAIL,pass:process.env.ALERT_EMAIL_PASSWORD}}); await t.sendMail({from:process.env.ALERT_EMAIL,to,subject,html}); return true; }
  catch(e) { console.error("Email:",e.message); return false; }
}

// Technical indicators
function calcRSI(c,p=14) { if(!c||c.length<p+1)return null; let g=0,l=0; for(let i=1;i<=p;i++){const d=c[i]-c[i-1];if(d>=0)g+=d;else l+=Math.abs(d);} let ag=g/p,al=l/p; for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1];ag=(ag*(p-1)+(d>0?d:0))/p;al=(al*(p-1)+(d<0?Math.abs(d):0))/p;} return al===0?100:parseFloat((100-100/(1+ag/al)).toFixed(2)); }
function calcEMA(c,p) { if(!c||c.length<p)return null; const k=2/(p+1); let e=c.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<c.length;i++)e=c[i]*k+e*(1-k); return parseFloat(e.toFixed(2)); }
function calcMACD(c) { const e12=calcEMA(c,12),e26=calcEMA(c,26); if(!e12||!e26)return null; return{macdLine:parseFloat((e12-e26).toFixed(2)),bullish:e12>e26}; }
function calcATR(h,l,c,p=14) { if(!h||h.length<p+1)return null; const t=[]; for(let i=1;i<h.length;i++)t.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return parseFloat((t.slice(-p).reduce((a,b)=>a+b,0)/p).toFixed(2)); }
function calcStoch(h,l,c,p=14) { if(!c||c.length<p)return null; const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p)),cur=c[c.length-1]; return hh===ll?50:parseFloat(((cur-ll)/(hh-ll)*100).toFixed(2)); }
function calcWR(h,l,c,p=14) { if(!c||c.length<p)return null; const hh=Math.max(...h.slice(-p)),ll=Math.min(...l.slice(-p)),cur=c[c.length-1]; return hh===ll?-50:parseFloat(((hh-cur)/(hh-ll)*-100).toFixed(2)); }
function calcOBV(c,v) { let o=0; const vals=[0]; for(let i=1;i<c.length;i++){if(c[i]>c[i-1])o+=v[i];else if(c[i]<c[i-1])o-=v[i];vals.push(o);} const r=vals.slice(-10); return{trend:r[r.length-1]>r[0]?"RISING":"FALLING"}; }
function volAnalysis(v) { if(!v||!v.length)return{trend:"AVERAGE",ratio:1}; const avg=v.slice(-20).reduce((a,b)=>a+b,0)/Math.min(v.length,20),today=v[v.length-1],ratio=avg>0?parseFloat((today/avg).toFixed(2)):1; return{today,avg20:Math.round(avg),ratio,trend:ratio>1.2?"HIGH":ratio<0.8?"LOW":"AVERAGE"}; }
function findSR(h,l,c,price) { if(!h||h.length<10)return{supports:[],resistances:[]}; const rh=h.slice(-60),rl=l.slice(-60),sup=[],res=[]; for(let i=2;i<rl.length-2;i++){if(rl[i]<rl[i-1]&&rl[i]<rl[i-2]&&rl[i]<rl[i+1]&&rl[i]<rl[i+2])sup.push(parseFloat(rl[i].toFixed(2)));if(rh[i]>rh[i-1]&&rh[i]>rh[i-2]&&rh[i]>rh[i+1]&&rh[i]>rh[i+2])res.push(parseFloat(rh[i].toFixed(2)));} return{supports:[...new Set(sup)].filter(s=>s<price).sort((a,b)=>b-a).slice(0,3),resistances:[...new Set(res)].filter(r=>r>price).sort((a,b)=>a-b).slice(0,3)}; }

function detectSMC(closes,highs,lows,opens) {
  if(!closes||closes.length<10)return null;
  const fvgs=[];
  for(let i=2;i<Math.min(closes.length,30);i++){
    const c1H=highs[i-2],c3L=lows[i],c1L=lows[i-2],c3H=highs[i];
    if(c3L>c1H){const g=parseFloat((c3L-c1H).toFixed(3));if(g/c1H*100>0.1)fvgs.push({type:"BULLISH",top:c3L,bottom:c1H});}
    if(c3H<c1L){const g=parseFloat((c1L-c3H).toFixed(3));if(g/c1L*100>0.1)fvgs.push({type:"BEARISH",top:c1L,bottom:c3H});}
  }
  const cp=closes[closes.length-1];
  const lo=opens?opens[opens.length-1]:cp;
  const isGreen=cp>lo;
  const sH=[],sL=[];
  for(let i=2;i<highs.length-2;i++){
    if(highs[i]>highs[i-1]&&highs[i]>highs[i-2]&&highs[i]>highs[i+1]&&highs[i]>highs[i+2])sH.push(highs[i]);
    if(lows[i]<lows[i-1]&&lows[i]<lows[i-2]&&lows[i]<lows[i+1]&&lows[i]<lows[i+2])sL.push(lows[i]);
  }
  let bos=null;
  if(sH.length>=1&&cp>sH[sH.length-1])bos={type:"BULLISH",level:parseFloat(sH[sH.length-1].toFixed(2))};
  else if(sL.length>=1&&cp<sL[sL.length-1])bos={type:"BEARISH",level:parseFloat(sL[sL.length-1].toFixed(2))};
  let entrySignal=null,plain="No SMC setup.";
  const lFVG=fvgs[fvgs.length-1];
  if(lFVG&&bos){
    const inFVG=cp>=lFVG.bottom&&cp<=lFVG.top;
    if(inFVG&&bos.type==="BULLISH"&&isGreen){entrySignal="ENTER_NOW";plain=`ENTER NOW: Green candle inside FVG $${lFVG.bottom.toFixed(2)}-$${lFVG.top.toFixed(2)} after BOS at $${bos.level}. This is your entry.`;}
    else if(bos.type==="BULLISH"&&cp>lFVG.top){entrySignal="WAIT_PULLBACK";plain=`WAIT: BOS confirmed at $${bos.level}. Wait for pullback to FVG $${lFVG.bottom.toFixed(2)}-$${lFVG.top.toFixed(2)} then green candle.`;}
    else{plain=`FVG at $${lFVG.bottom.toFixed(2)}-$${lFVG.top.toFixed(2)}. BOS at $${bos?.level||0}. Setup building.`;}
  } else if(lFVG){plain=`FVG at $${lFVG.bottom.toFixed(2)}-$${lFVG.top.toFixed(2)}. Waiting for Break of Structure.`;}
  return{fairValueGaps:fvgs.slice(-3),breakOfStructure:bos,entrySignal,plainEnglish:plain,fvgZone:lFVG?`$${lFVG.bottom.toFixed(2)}-$${lFVG.top.toFixed(2)}`:null};
}

function detectDivergence(closes,highs,lows) {
  if(!closes||closes.length<20)return null;
  const rc=closes.slice(-20),rsiVals=[];
  for(let i=10;i<rc.length;i++){const rsi=calcRSI(rc.slice(0,i+1));if(rsi)rsiVals.push(rsi);}
  if(rsiVals.length<5)return null;
  const pN=rc[rc.length-1],pP=rc[rc.length-6],rN=rsiVals[rsiVals.length-1],rP=rsiVals[rsiVals.length-6];
  const pH=pN>pP,rH=rN>rP;
  if(pH&&!rH&&rN>50)return{type:"BEARISH_DIVERGENCE",signal:"BEARISH",plain:"Price rising but momentum weakening — reversal possible."};
  if(!pH&&rH&&rN<50)return{type:"BULLISH_DIVERGENCE",signal:"BULLISH",plain:"Price falling but momentum recovering — bounce likely."};
  if(pH&&rH)return{type:"CONFIRMED_BULLISH",signal:"BULLISH",plain:"Price AND momentum rising — strong buy signal."};
  return null;
}

async function fetchMarketData(symbol) {
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1y`,{headers:{"User-Agent":"Mozilla/5.0"}});
    if(!r.ok)return null;
    const d=await r.json();
    const result=d.chart?.result?.[0];
    if(!result)return null;
    const meta=result.meta,q=result.indicators?.quote?.[0]||{};
    const closes=(q.close||[]).filter(Boolean);
    const highs=(q.high||[]).filter(Boolean);
    const lows=(q.low||[]).filter(Boolean);
    const opens=(q.open||[]).filter(Boolean);
    const volumes=(q.volume||[]).filter(Boolean);
    const price=parseFloat((meta.regularMarketPrice||0).toFixed(2));
    const prev=parseFloat((meta.chartPreviousClose||price).toFixed(2));
    const change=parseFloat(((price-prev)/prev*100).toFixed(2));
    const atr=calcATR(highs,lows,closes)||price*0.02;
    const avgMove=parseFloat((atr/price*100).toFixed(2));
    const moveRatio=avgMove>0?parseFloat((Math.abs(change)/avgMove).toFixed(1)):0;
    const exhaust=moveRatio>=5?"EXTREMELY_EXHAUSTED":moveRatio>=3?"VERY_EXHAUSTED":moveRatio>=2?"EXHAUSTED":moveRatio>=1.5?"EXTENDED":"FRESH";
    let affordableStrikes=[];
    try {
      const or=await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}`,{headers:{"User-Agent":"Mozilla/5.0"}});
      if(or.ok){const od=await or.json();const calls=od.optionChain?.result?.[0]?.options?.[0]?.calls||[];affordableStrikes=calls.filter(c=>c.ask>0&&c.openInterest>=50&&(c.ask-c.bid)<=0.06).map(c=>({strike:c.strike,ask:parseFloat((c.ask||0).toFixed(2)),bid:parseFloat((c.bid||0).toFixed(2)),spread:parseFloat(((c.ask-c.bid)).toFixed(3)),openInterest:c.openInterest||0,expiration:new Date((c.expiration||0)*1000).toLocaleDateString(),totalCost:parseFloat(((c.ask||0)*100).toFixed(2))}));}
    }catch(e){}
    const rsi=calcRSI(closes),macd=calcMACD(closes),ema20=calcEMA(closes,20),ema50=calcEMA(closes,50),ema200=calcEMA(closes,200);
    const stoch=calcStoch(highs,lows,closes),wr=calcWR(highs,lows,closes),obv=calcOBV(closes,volumes);
    const vol=volAnalysis(volumes),sr=findSR(highs,lows,closes,price);
    const smc=detectSMC(closes,highs,lows,opens),div=detectDivergence(closes,highs,lows);
    return{symbol,price,priceData:{current:price,prev,change,high52:parseFloat((meta.fiftyTwoWeekHigh||0).toFixed(2)),low52:parseFloat((meta.fiftyTwoWeekLow||0).toFixed(2))},volume:vol,momentum:{exhaustionLevel:exhaust,moveRatio,avgDailyMove:avgMove,isTradeable:["FRESH","EXTENDED"].includes(exhaust)},indicators:{rsi,macd,ema20,ema50,ema200,stochastic:stoch,williamsR:wr,obv},levels:sr,smcAnalysis:smc,divergence:div,options:{affordableStrikes},rawData:{closes:closes.slice(-30),highs:highs.slice(-30),lows:lows.slice(-30),opens:opens.slice(-30),volumes:volumes.slice(-30)}};
  }catch(e){console.error(`fetchMarketData ${symbol}:`,e.message);return null;}
}

async function getIntraday(symbol) {
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=2m&range=1d`,{headers:{"User-Agent":"Mozilla/5.0"}});
    if(!r.ok)return null;
    const d=await r.json();
    const result=d.chart?.result?.[0];
    if(!result)return null;
    const ts=result.timestamp||[],q=result.indicators?.quote?.[0]||{};
    const bars=ts.map((t,i)=>({t,c:q.close?.[i],h:q.high?.[i],l:q.low?.[i],v:q.volume?.[i]||0})).filter(b=>b.c);
    if(bars.length<5)return null;
    const fc=bars.map(b=>b.c),fh=bars.map(b=>b.h),fl=bars.map(b=>b.l),fv=bars.map(b=>b.v);
    const cp=fc[fc.length-1];
    const fhour=bars.filter(b=>new Date(b.t*1000).getHours()<10);
    const orH=fhour.length?Math.max(...fhour.map(b=>b.h)):null;
    const orL=fhour.length?Math.min(...fhour.map(b=>b.l)):null;
    const orbSignal=orH&&orL?(cp>orH?"BULLISH_BREAKOUT":cp<orL?"BEARISH_BREAKDOWN":"INSIDE"):null;
    const tv=fv.reduce((a,b)=>a+b,0);
    const vwap=tv>0?parseFloat((bars.reduce((s,b,i)=>s+((b.h+b.l+b.c)/3)*fv[i],0)/tv).toFixed(2)):null;
    const recent=fc.slice(-6),rH=fh.slice(-6),rL=fl.slice(-6);
    let hh=0,hl=0,lh=0,ll=0;
    for(let i=1;i<recent.length;i++){if(rH[i]>rH[i-1])hh++;else lh++;if(rL[i]>rL[i-1])hl++;else ll++;}
    const trend=hh>=4&&hl>=4?"UPTREND":lh>=4&&ll>=4?"DOWNTREND":"SIDEWAYS";
    const m30=fc.length>=15?parseFloat(((cp-fc[fc.length-15])/fc[fc.length-15]*100).toFixed(2)):0;
    return{openPrice:fc[0],currentPrice:cp,orHigh:orH,orLow:orL,orbSignal,vwap,aboveVWAP:vwap?cp>vwap:null,realtimeTrend:trend,isMoving:Math.abs(m30)>0.3,moveIn30:m30};
  }catch(e){return null;}
}

async function getNews(symbol) {
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${symbol}&newsCount=5&enableFuzzyQuery=false`,{headers:{"User-Agent":"Mozilla/5.0"}});
    const d=await r.json();
    const news=(d.news||[]).filter(n=>Date.now()-n.providerPublishTime*1000<24*60*60*1000);
    const bw=["surge","jump","gain","rise","rally","buy","upgrade","beat","profit","growth","strong","positive"],bW=["drop","fall","loss","down","sell","downgrade","miss","decline","weak","negative","cut"];
    let bu=0,be=0;
    news.forEach(n=>{const t=(n.title||"").toLowerCase();bw.forEach(w=>{if(t.includes(w))bu++;});bW.forEach(w=>{if(t.includes(w))be++;});});
    const tot=bu+be,sc=tot>0?Math.round(bu/tot*100):50;
    return{headlines:news.slice(0,3).map(n=>n.title),sentimentScore:sc,label:sc>60?"BULLISH":sc<40?"BEARISH":"NEUTRAL"};
  }catch(e){return{headlines:[],sentimentScore:50,label:"NEUTRAL"};}
}

async function getUnusualOptions(symbol) {
  try {
    const r=await fetch(`https://query1.finance.yahoo.com/v7/finance/options/${symbol}`,{headers:{"User-Agent":"Mozilla/5.0"}});
    if(!r.ok)return null;
    const d=await r.json();
    const opts=d.optionChain?.result?.[0]?.options?.[0];
    if(!opts)return null;
    const calls=opts.calls||[],puts=opts.puts||[];
    const cv=calls.reduce((s,c)=>s+(c.volume||0),0),pv=puts.reduce((s,p)=>s+(p.volume||0),0);
    const ratio=cv>0?parseFloat((pv/cv).toFixed(2)):1;
    return{callVolume:cv,putVolume:pv,putCallRatio:ratio,bigMoney:ratio<0.5?"BULLISH":ratio>2?"BEARISH":"NEUTRAL"};
  }catch(e){return null;}
}

async function getMarketOverview() {
  const [fgR,vixR,btcR,trendR]=await Promise.allSettled([
    fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata",{headers:{"User-Agent":"Mozilla/5.0"}}).then(r=>r.json()).then(d=>({score:Math.round(d.fear_and_greed?.score||50),rating:d.fear_and_greed?.rating||"Neutral"})),
    fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=5d",{headers:{"User-Agent":"Mozilla/5.0"}}).then(r=>r.json()).then(d=>{const v=parseFloat((d.chart?.result?.[0]?.meta?.regularMarketPrice||20).toFixed(2));return{value:v,level:v>30?"HIGH_FEAR":v>20?"ELEVATED":"NORMAL"};}),
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",{headers:{"User-Agent":"Mozilla/5.0"}}).then(r=>r.json()).then(d=>{const ch=parseFloat((d.bitcoin?.usd_24h_change||0).toFixed(2));return{change:ch,impact:ch>3?`Bitcoin up ${ch}% — MARA/RIOT calls likely`:ch<-3?`Bitcoin down ${Math.abs(ch)}% — avoid MARA/RIOT`:`Bitcoin flat`};}),
    fetch("https://query1.finance.yahoo.com/v1/finance/trending/US",{headers:{"User-Agent":"Mozilla/5.0"}}).then(r=>r.json()).then(d=>(d.finance?.result?.[0]?.quotes||[]).slice(0,5).map(q=>q.symbol))
  ]);
  return{
    fearGreed:fgR.status==="fulfilled"?fgR.value:{score:50,rating:"Neutral"},
    vix:vixR.status==="fulfilled"?vixR.value:{value:20,level:"NORMAL"},
    btc:btcR.status==="fulfilled"?btcR.value:{change:0,impact:"Bitcoin data unavailable"},
    trending:trendR.status==="fulfilled"?trendR.value:[]
  };
}

function getTradingWindow() {
  const now=new Date();
  const et=new Date(now.toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=et.getHours(),m=et.getMinutes(),t=h+m/60,day=et.getDay();
  if(day===0||day===6)return{window:"WEEKEND",canTrade:false,msg:"Market closed weekends."};
  if(t<9.5)return{window:"PRE_MARKET",canTrade:false,msg:"Market opens at 9:30 AM ET."};
  if(t<9.75)return{window:"OPENING_VOLATILE",canTrade:false,msg:"Too early — wait until 9:45 AM."};
  if(t<10.0)return{window:"CAUTION",canTrade:false,msg:"Wait until 10:00 AM for cleaner signals."};
  if(t<11.5)return{window:"BEST_WINDOW",canTrade:true,msg:"Best trading window 10:00-11:30 AM ET."};
  if(t<12.0)return{window:"GOOD",canTrade:true,msg:"Good window. Fresh setups only."};
  if(t<13.0)return{window:"LUNCH_DEAD_ZONE",canTrade:false,msg:"Lunch dead zone — wait until 1 PM."};
  if(t<14.5)return{window:"AFTERNOON",canTrade:true,msg:"Afternoon. High confidence only."};
  if(t<15.5)return{window:"POWER_HOUR",canTrade:true,msg:"Power hour. Exit by 3:45 PM."};
  return{window:"HARD_STOP",canTrade:false,msg:"3:30 PM ET — no new trades."};
}

function getEdLevel(data) { const t=data.trades?.length||0,b=data.balance||10; if(t>=60&&b>=1000)return 4; if(t>=30&&b>=200)return 3; if(t>=10&&b>=50)return 2; return 1; }
const TOPICS={1:["Strike price","Call vs Put","Stop loss","Bid vs Ask","Position sizing","Theta decay","PDT rule","Cash account","Risk reward","What is an option"],2:["Delta explained","MACD crossover","RSI signals","VWAP trading","Opening range breakout","Support resistance","Volume confirmation","Implied volatility","Options chain","Bull flag pattern"],3:["SMC concepts","Fair value gaps","Break of structure","Sector correlation","Unusual options","Greeks overview","Earnings plays","Divergence signals","Backtesting","Risk management"],4:["Iron condors","Straddles","Portfolio hedging","Sector rotation","Dark pools","Order flow","Gamma squeezes","Macro analysis","Position scaling","Advanced Greeks"]};
function getDailyTopic(lvl) { const t=TOPICS[lvl]||TOPICS[1]; return t[new Date().getDate()%t.length]; }

function analyzePerf(data) {
  const trades=(data.trades||[]).filter(t=>t.result!=="skip"&&t.amountRisked>0);
  if(trades.length<3)return{hasInsights:false,summary:"Complete 3+ trades to unlock insights.",insights:[]};
  const wins=trades.filter(t=>t.result==="win"),losses=trades.filter(t=>t.result==="loss");
  const wr=Math.round(wins.length/trades.length*100);
  const avgW=wins.length?wins.reduce((s,t)=>s+(t.pnl||0),0)/wins.length:0;
  const avgL=losses.length?Math.abs(losses.reduce((s,t)=>s+(t.pnl||0),0)/losses.length):0;
  return{hasInsights:true,summary:`${trades.length} trades | ${wr}% win rate | Avg win $${avgW.toFixed(2)} | Avg loss $${avgL.toFixed(2)}`,insights:[{positive:wr>=50,icon:wr>=50?"✅":"📊",title:`${wr}% Win Rate`,message:wr>=50?"Above 50% — keep following the system.":"Below 50% — wait for higher confidence setups only."}],avgWin:avgW,avgLoss:avgL};
}

// MAIN ANALYSIS
app.get("/api/analyze", async (req, res) => {
  try {
    const data=loadData();
    const sm=loadSM();
    const watchlist=getWatchlist(data.balance);
    const batch=watchlist.slice(0,8);
    const edLevel=getEdLevel(data);
    const topic=getDailyTopic(edLevel);
    const perf=analyzePerf(data);
    const tw=getTradingWindow();

    // Fetch SPY, QQQ, and market overview
    const [spyR,qqqR,overviewR,...stockResults]=await Promise.allSettled([
      fetchMarketData("SPY"),
      fetchMarketData("QQQ"),
      getMarketOverview(),
      ...batch.map(s=>fetchMarketData(s))
    ]);

    const spyData=spyR.status==="fulfilled"?spyR.value:null;
    const qqqData=qqqR.status==="fulfilled"?qqqR.value:null;
    const overview=overviewR.status==="fulfilled"?overviewR.value:{fearGreed:{score:50,rating:"Neutral"},vix:{value:20,level:"NORMAL"},btc:{change:0,impact:""},trending:[]};

    const spyChange=spyData?.priceData?.change||0;
    const qqqChange=qqqData?.priceData?.change||0;
    const isExtreme=Math.abs(spyChange)>3;
    const regime=Math.abs(spyChange)>2?(spyChange>0?"STRONG_BULL":"STRONG_BEAR"):Math.abs(spyChange)>0.5?(spyChange>0?"BULL":"BEAR"):"CHOPPY";

    // Build market data map
    const mdMap={};
    stockResults.forEach((r,i)=>{ if(r.status==="fulfilled"&&r.value)mdMap[batch[i]]=r.value; });
    const topSyms=Object.keys(mdMap).slice(0,5);

    // Fetch intraday, news, unusual in parallel
    const [intR,newsR,unusR]=await Promise.allSettled([
      Promise.allSettled(topSyms.map(s=>getIntraday(s).then(d=>({s,d})))),
      Promise.allSettled(topSyms.map(s=>getNews(s).then(d=>({s,d})))),
      Promise.allSettled(topSyms.map(s=>getUnusualOptions(s).then(d=>({s,d}))))
    ]);

    const iMap={},nMap={},uMap={};
    if(intR.status==="fulfilled")intR.value.forEach(r=>{if(r.status==="fulfilled"&&r.value?.d)iMap[r.value.s]=r.value.d;});
    if(newsR.status==="fulfilled")newsR.value.forEach(r=>{if(r.status==="fulfilled"&&r.value?.d)nMap[r.value.s]=r.value.d;});
    if(unusR.status==="fulfilled")unusR.value.forEach(r=>{if(r.status==="fulfilled"&&r.value?.d)uMap[r.value.s]=r.value.d;});

    // Build summaries and score
    const summaries=topSyms.map(sym=>{
      const stock=mdMap[sym];
      if(!stock)return null;
      const intra=iMap[sym],news=nMap[sym],unusual=uMap[sym];
      const rsRatio=spyChange!==0?parseFloat((stock.priceData.change/spyChange).toFixed(2)):1;
      const rsLabel=rsRatio>3?"EXTREMELY_EXTENDED":rsRatio>1.5?"OUTPERFORMING":rsRatio<0.3?"LAGGING":"WITH_MARKET";
      const isLaggard=rsRatio<0.3&&Math.abs(spyChange)>2;
      let score=50;const blocks=[];
      if(["EXTREMELY_EXHAUSTED","VERY_EXHAUSTED"].includes(stock.momentum.exhaustionLevel)){blocks.push("Already moved too much");score=Math.min(score,20);}
      if(intra?.realtimeTrend==="SIDEWAYS"){blocks.push("Not moving — sideways");score-=20;}
      if(rsLabel==="EXTREMELY_EXTENDED"){blocks.push("Moved too far vs market");score=Math.min(score,25);}
      if(stock.momentum.exhaustionLevel==="FRESH")score+=15;
      if(intra?.realtimeTrend==="UPTREND"&&spyChange>0)score+=15;
      if(news?.label==="BULLISH")score+=10;
      if(unusual?.bigMoney==="BULLISH")score+=10;
      if(stock.indicators.macd?.bullish)score+=8;
      if(stock.indicators.rsi>=40&&stock.indicators.rsi<=65)score+=8;
      if(stock.volume.trend==="HIGH")score+=8;
      if(isLaggard&&isExtreme)score+=20;
      if(stock.smcAnalysis?.entrySignal==="ENTER_NOW")score+=25;
      if(intra?.orbSignal==="BULLISH_BREAKOUT")score+=10;
      if(intra?.aboveVWAP&&spyChange>0)score+=8;
      return{symbol:sym,score:Math.max(0,Math.min(100,Math.round(score))),blocks,price:stock.price,change:stock.priceData.change,rsi:stock.indicators.rsi,macdBullish:stock.indicators.macd?.bullish,volume:stock.volume.trend,exhaustion:stock.momentum.exhaustionLevel,realtimeTrend:intra?.realtimeTrend,aboveVWAP:intra?.aboveVWAP,vwap:intra?.vwap,orbSignal:intra?.orbSignal,moveIn30:intra?.moveIn30,isMoving:intra?.isMoving,news:news?.label,newsHeadlines:news?.headlines||[],bigMoney:unusual?.bigMoney,relativeStrength:{label:rsLabel,ratio:rsRatio,isLaggard},smcSignal:stock.smcAnalysis?.entrySignal,smcPlain:stock.smcAnalysis?.plainEnglish,fvgZone:stock.smcAnalysis?.fvgZone,divergence:stock.divergence,affordableStrikes:stock.options.affordableStrikes.slice(0,5),indicators:stock.indicators,levels:stock.levels,atr:calcATR(stock.rawData.highs,stock.rawData.lows,stock.rawData.closes)||stock.price*0.02};
    }).filter(Boolean).sort((a,b)=>b.score-a.score);

    // PDT and week checks
    const todayStr=new Date().toDateString();
    const todayTrades=data.trades.filter(t=>new Date(t.date).toDateString()===todayStr&&t.result!=="skip").length;
    const pdtWarn=todayTrades>=2?`You made ${todayTrades} day trades today — be careful`:null;
    const wkStart=new Date();wkStart.setDate(wkStart.getDate()-wkStart.getDay());wkStart.setHours(0,0,0,0);
    const wkPnl=(data.trades||[]).filter(t=>new Date(t.date)>=wkStart&&t.result!=="skip").reduce((s,t)=>s+(t.pnl||0),0);

    const top=summaries[0];
    const stopLoss=top?parseFloat((top.price-top.atr).toFixed(2)):0;
    const target=top?parseFloat((top.price+top.atr*1.5).toFixed(2)):0;

    const prompt=`You are an expert options trading AI. Respond with ONLY valid JSON.

TODAY: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()} ET
SPY:${spyChange}% QQQ:${qqqChange}% VIX:${overview.vix.value} Fear/Greed:${overview.fearGreed.score}
Bitcoin:${overview.btc.change}% — ${overview.btc.impact}
Time:${tw.window} ${tw.canTrade?"OPEN":"BLOCKED"} — ${tw.msg}
${isExtreme?"EXTREME DAY: Focus ONLY on laggard stocks with own news catalyst":""}

STOCKS RANKED:
${summaries.slice(0,5).map((s,i)=>`${i+1}.${s.symbol} score:${s.score} chg:${s.change}% exhaust:${s.exhaustion} trend:${s.realtimeTrend} news:${s.news} bigmoney:${s.bigMoney||"none"} smc:${s.smcSignal||"none"} blocks:${s.blocks.slice(0,2)}`).join("\n")}

TOP STOCK: ${top?.symbol||"none"} at $${top?.price||0}, RSI:${top?.rsi||0}, VWAP:${top?.aboveVWAP?"above":"below"} $${top?.vwap||0}, FVG:${top?.fvgZone||"none"}, Divergence:${top?.divergence?.plain||"none"}

USER: $${data.balance} balance | max risk $${(data.balance*0.20).toFixed(2)} | Level ${edLevel}

Respond with this JSON (fill in ALL real values based on the data above):
{"marketSummary":{"spyChange":${spyChange},"qqqChange":${qqqChange},"marketTrend":"${regime}","fearGreedScore":${overview.fearGreed.score},"fearGreedRating":"${overview.fearGreed.rating}","trendingStocks":${JSON.stringify(overview.trending)},"preferredDirection":"${spyChange<-1.5?"PUT":spyChange>1.5?"CALL":"EITHER"}","marketRegime":"${regime}","dayType":"${isExtreme?"EXTREME_VOLATILE":Math.abs(spyChange)>0.5?"TRENDING":"CHOPPY"}","dayPlainEnglish":"Describe today market in plain English","dayTradingAdvice":"Specific advice for today","isExtremelyVolatile":${isExtreme},"volatileWarning":"${isExtreme?"Market moving "+Math.abs(spyChange).toFixed(1)+"% today":""}","pdtWarning":"${pdtWarn||""}","shouldStopTrading":false,"weekPnl":${wkPnl.toFixed(2)},"todayTradeCount":${todayTrades},"vix":{"value":${overview.vix.value},"level":"${overview.vix.level}","advice":"VIX trading advice","optionCost":"Options are cheap or expensive?"},"crypto":{"btcChange":${overview.btc.change},"mood":"${overview.btc.change>0?"BULLISH":"BEARISH"}","impact":"${overview.btc.impact}"},"trendStrength":{"score":${Math.min(100,Math.round(Math.abs(spyChange)*20))},"label":"${Math.abs(spyChange)>1.5?"STRONG":Math.abs(spyChange)>0.5?"MODERATE":"WEAK"}","plainEnglish":"Trend strength explanation"},"timeWindow":{"window":"${tw.window}","canTrade":${tw.canTrade},"message":"${tw.msg}"},"marketContext":{"weekTrend":"UNKNOWN","weekChange":0,"catalyst":"GENERAL","catalystExplanation":"Market context","moveAlreadyDone":${isExtreme},"contextRecommendation":"What to do today","headlines":[],"plainEnglish":"Why market moving today"},"topPatternStock":"${top?.symbol||""}","topPatternScore":${top?.score||0},"topPatternStep":"${top?.smcSignal==="ENTER_NOW"?"SMC ENTER NOW":top?.smcSignal==="WAIT_PULLBACK"?"SMC WAIT PULLBACK":top?.realtimeTrend||"No pattern"}","topPatternReady":${top?.smcSignal==="ENTER_NOW"||false},"marketComment":"2 sentences about today","beginnerTip":"1 tip for today"},"activeStrategy":{"name":"Best strategy name","key":"MOMENTUM_SCALP","score":70,"description":"Strategy description","whyToday":"Why this strategy fits today","whyNotOthers":"Why others scored lower","shouldAdapt":false,"adaptationAdvice":"No adaptation needed","strategyEducation":"Plain English explanation","allStrategiesRanked":[{"key":"MOMENTUM_SCALP","name":"Momentum Scalp","score":70,"breakdown":{}},{"key":"OVERSOLD_BOUNCE","name":"Oversold Bounce","score":55,"breakdown":{}},{"key":"SMC","name":"SMC Entry","score":${top?.smcSignal==="ENTER_NOW"?90:50},"breakdown":{}},{"key":"VWAP_RECLAIM","name":"VWAP Reclaim","score":50,"breakdown":{}}]},"positionSizing":{"totalBudgetToRisk":"$${(data.balance*0.15).toFixed(2)} maximum","reserveAmount":"$${(data.balance*0.85).toFixed(2)}","reasoning":"Keep position small"},"trades":[{"rank":1,"symbol":"${top?.symbol||"SOUN"}","signal":"${top&&top.score>=50?"BUY":"HOLD"}","entryState":"${top?.smcSignal==="ENTER_NOW"?"ENTER NOW — green candle inside FVG confirmed":top?.smcSignal==="WAIT_PULLBACK"?"WAIT — price needs to pull back to FVG zone then green candle":top?.realtimeTrend==="UPTREND"?"READY — uptrend confirmed wait for pullback entry":"WAIT — setup not complete yet"}","entryTrigger":"${top?.smcSignal==="ENTER_NOW"?"Green candle inside FVG zone — enter now":top?.fvgZone?"Price returns to "+top.fvgZone+" and green candle forms":"Wait for uptrend confirmation and entry signal"}","confidence":"${top&&top.score>=65?"HIGH":top&&top.score>=45?"MEDIUM":"LOW"}","accuracyScore":${top?.score||50},"tooLate":${(top?.blocks?.length||0)>0},"tooLateReason":"${top?.blocks?.[0]||""}","rewardRiskRatio":1.5,"rewardRiskBlocked":false,"spreadPercent":20,"patternStep":"${top?.smcSignal==="ENTER_NOW"?"SMC Step 5/5 — ENTER NOW":top?.smcSignal?"SMC Step 4/5 — waiting":"Analyzing on 5-minute chart"}","timeframe":"5-minute","resolutionTime":"1-4 hours","chartPattern":"Chart pattern explanation based on data","chartPatternAction":"Specific action","smcSetup":"${(top?.smcPlain||"No SMC setup").replace(/"/g,"'")}","smcEntryState":"${top?.smcSignal==="ENTER_NOW"?"ENTER NOW":top?.smcSignal==="WAIT_PULLBACK"?"WAIT FOR PULLBACK TO FVG":"NO SETUP"}","fvgZone":"${top?.fvgZone||"null"}","signalExplanation":"2-3 sentences why this stock and what the chart shows","analysis":"4-5 sentences: pattern timeframe entry trigger why this stock key risks","newsSentiment":"${top?.news||"NEUTRAL"}","newsHeadlines":${JSON.stringify(top?.newsHeadlines?.slice(0,2)||[])},"unusualActivity":"${top?.bigMoney||"None detected"}","earningsRisk":"None","divergence":"${(top?.divergence?.plain||"No divergence").replace(/"/g,"'")}","thetaWarning":"Option loses value daily — act promptly on entry signal","correlationInsight":"Explain sector connections","correlatedLaggards":"Laggard opportunity if any","strategyFit":"How stock fits strategy","currentPrice":${top?.price||0},"priceChange":${top?.change||0},"indicatorConsensus":{"bullish":${top?.macdBullish?1:0}${top?.rsi>=40&&top?.rsi<=65?"+1":"+0"}${top?.realtimeTrend==="UPTREND"?"+1":"+0"}${top?.aboveVWAP?"+1":"+0"}${top?.news==="BULLISH"?"+1":"+0"},"bearish":${top?.realtimeTrend==="DOWNTREND"?1:0}${top?.news==="BEARISH"?"+1":"+0"},"neutral":4},"indicators":[{"name":"RSI","signal":"${(top?.rsi||50)>=40&&(top?.rsi||50)<=65?"BULLISH":"NEUTRAL"}","value":"${top?.rsi||50}","meaning":"RSI ${top?.rsi||50} — ${(top?.rsi||50)>=40&&(top?.rsi||50)<=65?"momentum zone":"outside ideal range"}","color":"${(top?.rsi||50)>=40&&(top?.rsi||50)<=65?"green":"yellow"}"},{"name":"MACD","signal":"${top?.macdBullish?"BULLISH":"BEARISH"}","value":"${top?.macdBullish?"Bullish":"Bearish"}","meaning":"MACD ${top?.macdBullish?"bullish — momentum up":"bearish — momentum down"}","color":"${top?.macdBullish?"green":"red"}"},{"name":"Real-Time Trend","signal":"${top?.realtimeTrend==="UPTREND"?"BULLISH":top?.realtimeTrend==="DOWNTREND"?"BEARISH":"NEUTRAL"}","value":"${top?.realtimeTrend||"UNKNOWN"}","meaning":"${top?.realtimeTrend==="UPTREND"?"Moving up — good for calls":top?.realtimeTrend==="SIDEWAYS"?"Going sideways — options losing value":"Moving down"}","color":"${top?.realtimeTrend==="UPTREND"?"green":top?.realtimeTrend==="DOWNTREND"?"red":"yellow"}"},{"name":"VWAP","signal":"${top?.aboveVWAP?"BULLISH":"BEARISH"}","value":"${top?.aboveVWAP?"Above":"Below"} $${top?.vwap||0}","meaning":"${top?.aboveVWAP?"Above VWAP — bullish":"Below VWAP — bearish"}","color":"${top?.aboveVWAP?"green":"red"}"},{"name":"Volume","signal":"${top?.volume==="HIGH"?"BULLISH":top?.volume==="LOW"?"CAUTION":"NEUTRAL"}","value":"${top?.volume||"AVERAGE"}","meaning":"Volume is ${top?.volume||"average"}","color":"${top?.volume==="HIGH"?"green":top?.volume==="LOW"?"yellow":"yellow"}"},{"name":"Exhaustion","signal":"${top?.exhaustion==="FRESH"?"BULLISH":"CAUTION"}","value":"${top?.exhaustion||"UNKNOWN"}","meaning":"Move is ${top?.exhaustion==="FRESH"?"fresh — room to run":"extended — be careful"}","color":"${top?.exhaustion==="FRESH"?"green":"yellow"}"}],"support":${JSON.stringify((top?mdMap[top.symbol]?.levels?.supports||[]:[]).slice(0,3).map(l=>({level:l,strength:"Strong"})))},"resistance":${JSON.stringify((top?mdMap[top.symbol]?.levels?.resistances||[]:[]).slice(0,3).map(l=>({level:l,strength:"Moderate"})))},"entryPrice":${top?.price||0},"entryNote":"Enter near current price when signal confirms","stopLoss":${stopLoss},"stopNote":"1 ATR below entry — cut loss here","profitTarget":${target},"targetNote":"1.5x ATR target","riskReward":"1:1.5","atrNote":"ATR-based stop and target","probability":{"overallPercent":${top?.score||50},"factors":[{"label":"Pattern","score":${top?.smcSignal==="ENTER_NOW"?90:top?.smcSignal?70:40},"note":"${top?.smcSignal||"No SMC"}"},{"label":"Trend","score":${top?.realtimeTrend==="UPTREND"?75:top?.realtimeTrend==="SIDEWAYS"?25:45},"note":"${top?.realtimeTrend||"Unknown"}"},{"label":"News","score":${top?.news==="BULLISH"?75:top?.news==="BEARISH"?25:50},"note":"${top?.news||"Neutral"}"},{"label":"Volume","score":${top?.volume==="HIGH"?75:top?.volume==="LOW"?30:50},"note":"${top?.volume||"Average"}"}],"verdict":"${top&&top.score>=65?"Good setup":"Moderate setup — wait for better conditions"}"},"scenarios":[{"type":"bull","label":"Bull Case","probability":"25%","target":${top?parseFloat((top.price*1.05).toFixed(2)):0},"result":"+50-80% option gain"},{"type":"base","label":"Base Case","probability":"40%","target":${top?parseFloat((top.price*1.02).toFixed(2)):0},"result":"+20-40% option gain"},{"type":"bear","label":"Bear Case","probability":"25%","target":${top?parseFloat((top.price*0.98).toFixed(2)):0},"result":"-20-40% option loss"},{"type":"worst","label":"Worst Case","probability":"10%","target":${top?parseFloat((top.price*0.95).toFixed(2)):0},"result":"-80% option loss"}],"exitStrategy":{"recommendedHoldTime":"30min-2hrs","latestExitTime":"3:30 PM ET","sellSignals":["Up 50% — take profit now","Down 30% — cut loss","RSI above 75","Trend reverses"],"doNotHoldIf":["Below stop loss","After 3:30 PM","Market reverses hard"],"dayTradingTips":"Take profits fast. 50% gain on $5 = $2.50 real profit."},"budget":{"suggestedOptionType":"CALL","strikePrice":${top?parseFloat((top.price*1.02).toFixed(2)):0},"expiration":"Select 5-10 days out from today","estimatedOptionCost":"Check real Ask Price on Robinhood before buying","amountToRisk":"$${(data.balance*0.15).toFixed(2)} maximum","maxLoss":"$${(data.balance*0.15).toFixed(2)}","estimatedGain":"$${(data.balance*0.15*0.5).toFixed(2)}-$${(data.balance*0.15).toFixed(2)}","robinhoodSteps":"1. Search ${top?.symbol||"SYMBOL"}\\n2. Tap Trade then Trade Options\\n3. Tap BUY (left orange) and CALL (right orange)\\n4. Select expiration 5-10 days out\\n5. IMPORTANT: Check Ask Price — must be under $${(data.balance*0.20).toFixed(2)} total (Ask x 100)\\n6. Set limit price to Ask + $0.01\\n7. Tap Review then Submit\\n8. If queued 3+ min — cancel and retry with updated price"},"volume":"${top?.volume||"AVERAGE"}"}],"stockRankings":${JSON.stringify(summaries.slice(0,6).map(s=>({symbol:s.symbol,score:s.score,reason:s.blocks.length>0?s.blocks.join(", "):`${s.exhaustion} move ${s.realtimeTrend} trend ${s.news} news`,newsSentiment:s.news||"NEUTRAL",unusualActivity:s.bigMoney||"None",relativeStrength:{label:s.relativeStrength.label,description:`${s.change}% vs SPY ${spyChange}%`,isLaggard:s.relativeStrength.isLaggard,isExtended:s.relativeStrength.label==="EXTREMELY_EXTENDED",score:s.relativeStrength.ratio,stockChange:s.change,spyChange}})))},"educationLesson":{"level":${edLevel},"topic":"${topic}","explanation":"Explain ${topic} in 2 sentences","whyItMatters":"Why this matters for trading","actionable":"Watch for this today"},"performanceCoach":{"hasInsights":${perf.hasInsights},"summary":"${perf.summary.replace(/"/g,"'")}","insights":${JSON.stringify(perf.insights||[])}},"challengeContext":"From $${data.balance} to $10000 — keep going!"}`;

    const ai=await anthropic.messages.create({model:"claude-sonnet-4-5",max_tokens:4000,messages:[{role:"user",content:prompt}]});
    const raw=ai.content[0]?.text||"";
    console.log("[Analysis] Response:",raw.length,"chars");
    let analysis;
    try {
      const match=raw.match(/\{[\s\S]*\}/);
      if(!match)throw new Error("No JSON found");
      analysis=JSON.parse(match[0]);
    }catch(e){
      console.error("[Analysis] Parse error:",e.message,"— Raw:",raw.substring(0,200));
      try{
        const start=raw.indexOf("{");
        if(start>=0){let p=raw.substring(start);const o=(p.match(/\{/g)||[]).length,c=(p.match(/\}/g)||[]).length,ao=(p.match(/\[/g)||[]).length,ac=(p.match(/\]/g)||[]).length;for(let i=0;i<ao-ac;i++)p+="]";for(let i=0;i<o-c;i++)p+="}";analysis=JSON.parse(p);analysis._truncated=true;}
        else throw new Error("No JSON");
      }catch(e2){throw new Error("Analysis failed — please try again");}
    }
    analysis._fetchedAt=new Date().toISOString();
    analysis._balance=data.balance;
    analysis._edLevel=edLevel;
    analysis._trades=data.trades.slice(-10);
    analysis._milestones=data.milestones;
    res.json({success:true,data:analysis});
  }catch(err){
    console.error("[Analysis] Error:",err.message);
    res.status(500).json({success:false,error:err.message});
  }
});

// Standard endpoints
app.get("/api/challenge",(req,res)=>{ const data=loadData(); res.json({success:true,data}); });
app.post("/api/balance/update",(req,res)=>{ const{balance}=req.body; if(isNaN(balance)||balance<0)return res.status(400).json({success:false,error:"Invalid"}); const data=loadData(); const old=data.balance; data.balance=parseFloat(balance.toFixed(2)); const m=checkMilestone(old,data.balance,data.milestones||[]); if(m)(data.milestones=data.milestones||[]).push(m); saveData(data); res.json({success:true,balance:data.balance,milestone:m}); });
app.post("/api/reset",(req,res)=>{ const bal=parseFloat(req.body.startingBalance)||10; const fresh={balance:bal,startingBalance:bal,goal:10000,trades:[],milestones:[],createdAt:new Date().toISOString(),consecutiveWins:0,consecutiveLosses:0}; saveData(fresh); saveSM({patterns:[],strategyPerformance:{},lastAdaptation:null}); res.json({success:true,message:`Reset to $${bal}`}); });
app.post("/api/trade/log",(req,res)=>{ const{symbol,optionType,entryPrice,exitPrice,amount,result,notes,strategy,marketRegime}=req.body; const data=loadData(); const sm=loadSM(); const pnl=result==="win"?parseFloat((exitPrice-amount).toFixed(2)):result==="skip"?0:parseFloat((-amount).toFixed(2)); const old=data.balance; if(result!=="skip")data.balance=parseFloat(Math.max(0,data.balance+pnl).toFixed(2)); if(result==="win"){data.consecutiveWins=(data.consecutiveWins||0)+1;data.consecutiveLosses=0;}else if(result==="loss"){data.consecutiveLosses=(data.consecutiveLosses||0)+1;data.consecutiveWins=0;} const m=checkMilestone(old,data.balance,data.milestones||[]); if(m)(data.milestones=data.milestones||[]).push(m); const trade={id:Date.now(),date:new Date().toISOString(),symbol,optionType,entryPrice,exitPrice,amountRisked:amount,pnl,result,balanceAfter:data.balance,notes:notes||"",strategy:strategy||"MOMENTUM_SCALP",marketRegime:marketRegime||"UNKNOWN"}; data.trades.unshift(trade); const strat=strategy||"MOMENTUM_SCALP"; if(!sm.strategyPerformance[strat])sm.strategyPerformance[strat]={wins:0,losses:0,totalPnl:0}; if(result==="win")sm.strategyPerformance[strat].wins++;else if(result==="loss")sm.strategyPerformance[strat].losses++; sm.strategyPerformance[strat].totalPnl=parseFloat((sm.strategyPerformance[strat].totalPnl+pnl).toFixed(2)); sm.patterns=(sm.patterns||[]); sm.patterns.unshift({id:Date.now(),date:new Date().toISOString(),symbol,optionType,strategy:strat,result,pnl}); if(sm.patterns.length>100)sm.patterns=sm.patterns.slice(0,100); saveData(data); saveSM(sm); res.json({success:true,trade,newBalance:data.balance,milestone:m,consecutiveWins:data.consecutiveWins,consecutiveLosses:data.consecutiveLosses}); });
app.post("/api/trade/manual",(req,res)=>{ const{symbol,optionType,amount,exitValue,result,date,notes,strategy}=req.body; const data=loadData(); const sm=loadSM(); const pnl=result==="win"?parseFloat((exitValue-amount).toFixed(2)):result==="loss"?parseFloat((-amount).toFixed(2)):0; const trade={id:Date.now(),date:date?new Date(date).toISOString():new Date().toISOString(),symbol,optionType,entryPrice:amount,exitPrice:exitValue,amountRisked:amount,pnl,result,balanceAfter:data.balance,notes:notes||"",strategy:strategy||"MOMENTUM_SCALP",marketRegime:"UNKNOWN",manualEntry:true}; data.trades.push(trade); const strat=strategy||"MOMENTUM_SCALP"; if(!sm.strategyPerformance[strat])sm.strategyPerformance[strat]={wins:0,losses:0,totalPnl:0}; if(result==="win")sm.strategyPerformance[strat].wins++;else if(result==="loss")sm.strategyPerformance[strat].losses++; sm.strategyPerformance[strat].totalPnl=parseFloat((sm.strategyPerformance[strat].totalPnl+pnl).toFixed(2)); saveData(data); saveSM(sm); res.json({success:true,trade}); });
app.get("/api/performance",(req,res)=>{ res.json({success:true,data:analyzePerf(loadData())}); });
app.get("/api/strategy",(req,res)=>{ const data=loadData(); const sm=loadSM(); const lvl=getEdLevel(data); res.json({success:true,data:{availableStrategies:["MOMENTUM_SCALP","OVERSOLD_BOUNCE","SMC","CONTINUATION","BREAKOUT","VOLUME_SPIKE","VWAP_RECLAIM","GAP_FILL","TREND_FOLLOWING","SUPPORT_BOUNCE"].slice(0,lvl>=3?10:lvl>=2?8:6).map(k=>({key:k,name:k.replace(/_/g," ")})),strategyPerformance:sm.strategyPerformance,educationLevel:lvl}}); });
app.get("/api/price/:symbol",async(req,res)=>{ try{const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${req.params.symbol}?interval=1m&range=1d`,{headers:{"User-Agent":"Mozilla/5.0"}});const d=await r.json();const p=d.chart?.result?.[0]?.meta?.regularMarketPrice;res.json(p?{success:true,price:p}:{success:false});}catch(e){res.json({success:false});} });
app.get("/api/export",(req,res)=>{ const data=loadData();const sm=loadSM(); res.setHeader("Content-Disposition","attachment; filename=backup-"+new Date().toISOString().split("T")[0]+".json"); res.json({exportedAt:new Date().toISOString(),version:"4.0",challenge:data,strategyMemory:sm}); });
app.post("/api/import",(req,res)=>{ try{const{challenge,strategyMemory}=req.body;if(challenge)saveData(challenge);if(strategyMemory)saveSM(strategyMemory);res.json({success:true,message:"Restored!"});}catch(e){res.status(500).json({success:false,error:e.message});} });
app.post("/api/monitor/start",async(req,res)=>{ const{email,symbol,entryPrice,stopLoss,profitTarget,signal,optionType}=req.body; const id=`${symbol}_${Date.now()}`; activeMonitors[id]={email,symbol,stopLoss,profitTarget,active:true}; const interval=setInterval(async()=>{ if(!activeMonitors[id]?.active){clearInterval(interval);return;} try{const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`,{headers:{"User-Agent":"Mozilla/5.0"}});const d=await r.json();const cp=d.chart?.result?.[0]?.meta?.regularMarketPrice;if(!cp)return;const win=cp>=profitTarget,stop=cp<=stopLoss;if(win||stop){clearInterval(interval);activeMonitors[id].active=false;await sendEmail(email,win?"🟢 TAKE PROFIT!":"🔴 STOP LOSS!",`<div style="padding:20px"><h2>${win?"PROFIT HIT":"STOP LOSS HIT"} — ${symbol}</h2><p>Current: $${cp}. Open Robinhood NOW!</p></div>`);}}catch(e){}},180000); activeMonitors[id].intervalId=interval; await sendEmail(email,`Watching ${symbol}`,`<div style="padding:20px"><h2>Monitoring ${symbol}</h2><p>Stop:$${stopLoss} Target:$${profitTarget}</p></div>`); res.json({success:true,monitorId:id}); });
app.post("/api/monitor/stop",(req,res)=>{ const{monitorId}=req.body; if(activeMonitors[monitorId]){clearInterval(activeMonitors[monitorId].intervalId);activeMonitors[monitorId].active=false;} res.json({success:true}); });
app.post("/api/setup/save",(req,res)=>{ const setups=loadPending().filter(s=>s.symbol!==req.body.symbol); setups.push({...req.body,id:Date.now(),createdAt:new Date().toISOString(),status:"WAITING",expiresAt:new Date(Date.now()+4*60*60*1000).toISOString()}); savePending(setups); res.json({success:true}); });
app.get("/api/setup/pending",(req,res)=>{ res.json({success:true,setups:loadPending().filter(s=>s.status==="WAITING")}); });
app.get("/api/alerts/latest",(req,res)=>{ const f=path.join(__dirname,"latest_alerts.json"); try{if(fs.existsSync(f)){const d=JSON.parse(fs.readFileSync(f,"utf8"));if(new Date(d.timestamp)>new Date(Date.now()-30*60*1000))return res.json({success:true,...d});}}catch(e){} res.json({success:true,alerts:[],timestamp:new Date().toISOString()}); });
app.post("/api/scanner/subscribe",(req,res)=>{ res.json({success:true,message:"Subscribed"}); });
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

// Scanner
async function runScanner() {
  try {
    const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const h=et.getHours(),day=et.getDay();
    if(day===0||day===6||h<9||h>=16)return;
    const alerts=[];
    try{const r=await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",{headers:{"User-Agent":"Mozilla/5.0"}});const d=await r.json();const ch=parseFloat((d.bitcoin?.usd_24h_change||0).toFixed(2));if(Math.abs(ch)>3)alerts.push({type:"CRYPTO",symbol:ch>0?"MARA":"RIOT",message:`Bitcoin ${ch>0?"UP":"DOWN"} ${Math.abs(ch).toFixed(1)}% — ${ch>0?"MARA/RIOT calls likely":"avoid MARA/RIOT"}`,urgency:"HIGH"});}catch(e){}
    const setups=loadPending().filter(s=>s.status==="WAITING");
    for(const setup of setups){
      try{
        if(new Date(setup.expiresAt)<new Date()){setup.status="EXPIRED";continue;}
        const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${setup.symbol}?interval=2m&range=1d`,{headers:{"User-Agent":"Mozilla/5.0"}});
        const d=await r.json();const cp=d.chart?.result?.[0]?.meta?.regularMarketPrice;if(!cp)continue;
        if(setup.direction==="CALL"&&cp>=setup.triggerPrice){setup.status="TRIGGERED";alerts.push({type:"ENTRY",symbol:setup.symbol,message:`ENTER NOW — ${setup.symbol} hit $${cp.toFixed(2)}`,urgency:"HIGH"});if(setup.email)await sendEmail(setup.email,`ENTER NOW — ${setup.symbol}`,`<div style="padding:20px"><h2>ENTER NOW — ${setup.symbol}</h2><p>Price: $${cp.toFixed(2)}</p></div>`).catch(()=>{});}
      }catch(e){}
    }
    savePending(setups);
    if(alerts.length>0)fs.writeFileSync(path.join(__dirname,"latest_alerts.json"),JSON.stringify({alerts,timestamp:new Date().toISOString()},null,2));
  }catch(e){console.error("[Scanner]",e.message);}
}

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`Challenge AI v4 on port ${PORT}`);
  setTimeout(()=>{ setInterval(()=>runScanner().catch(e=>console.error("[Scanner]",e.message)),90000); console.log("[Scanner] Started"); },15000);
});
