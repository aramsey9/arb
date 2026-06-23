// ArbEdge Background Scanner
// Runs via GitHub Actions, reads scheduler-config.json, scans for arbs, fires Pushover

const https = require('https');

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER = process.env.PUSHOVER_USER;

if (!ODDS_API_KEY || !PUSHOVER_TOKEN || !PUSHOVER_USER) {
  console.log('Missing env vars — check GitHub Secrets');
  process.exit(1);
}

function oP(o) { return o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100); }
function oD(o) { return o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1; }
function fmt(o) { return o > 0 ? '+' + o : '' + o; }
function isTrueArb(o1, o2, min) { var p1=oP(o1),p2=oP(o2),tot=p1+p2; return tot<1.0&&(1-tot)*100>=min; }

function fetch(url, opts) {
  return new Promise(function(resolve, reject) {
    var u = new URL(url);
    var options = { hostname: u.hostname, path: u.pathname + u.search, method: (opts&&opts.method)||'GET', headers: (opts&&opts.headers)||{} };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(d) { data += d; });
      res.on('end', function() { resolve({ ok: res.statusCode>=200&&res.statusCode<300, json: function(){ return JSON.parse(data); }, status: res.statusCode }); });
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

function isActiveHour() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var h = et.getHours();
  return h >= 6 && h < 22;
}

async function loadConfig() {
  try {
    var res = await fetch('https://raw.githubusercontent.com/aramsey9/arb/main/scheduler-config.json?t=' + Date.now());
    if (!res.ok) { console.log('No config file found'); return null; }
    return res.json();
  } catch(e) { console.log('Config error:', e.message); return null; }
}

async function sendPushover(title, message, priority) {
  var payload = JSON.stringify({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title: title, message: message, priority: priority||0, sound: 'cashregister' });
  try {
    var res = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, body: payload });
    var data = res.json();
    console.log('Pushover:', data.status===1?'sent':'failed');
    return data.status === 1;
  } catch(e) { console.log('Pushover error:', e.message); return false; }
}

function processH2H(oc, gl, allArbs, min) {
  var bt={};
  oc.forEach(function(o){ if(!bt[o.name])bt[o.name]=[]; bt[o.name].push({book:o.book,odds:o.price}); });
  var tn=Object.keys(bt); if(tn.length<2)return;
  var b1=bt[tn[0]].reduce(function(a,b){return a.odds>b.odds?a:b}), b2=bt[tn[1]].reduce(function(a,b){return a.odds>b.odds?a:b});
  if(b1.book===b2.book||!isTrueArb(b1.odds,b2.odds,min))return;
  var p1=oP(b1.odds),p2=oP(b2.odds),tot=p1+p2,s1=1000*(p1/tot),s2=1000*(p2/tot),pr=Math.min(s1*oD(b1.odds),s2*oD(b2.odds))-(s1+s2);
  allArbs.push({game:gl,roi:(pr/(s1+s2))*100,profit:pr,edge:(1-tot)*100,book1:b1.book,odds1:b1.odds,side1:tn[0],book2:b2.book,odds2:b2.odds,side2:tn[1]});
}

function processTotals(oc, gl, allArbs, min) {
  var ov=oc.filter(function(o){return o.name==='Over'}), un=oc.filter(function(o){return o.name==='Under'});
  if(!ov.length||!un.length)return;
  var best=null;
  ov.forEach(function(a){un.forEach(function(b){
    if(a.book===b.book||a.point>b.point)return;
    if(!isTrueArb(a.odds,b.odds,min))return;
    var p1=oP(a.odds),p2=oP(b.odds),tot=p1+p2,s1=1000*(p1/tot),s2=1000*(p2/tot),pr=Math.min(s1*oD(a.odds),s2*oD(b.odds))-(s1+s2);
    if(!best||pr>best.profit)best={game:gl,roi:(pr/(s1+s2))*100,profit:pr,edge:(1-tot)*100,book1:a.book,odds1:a.odds,side1:'Over '+a.point,book2:b.book,odds2:b.odds,side2:'Under '+b.point};
  });});
  if(best)allArbs.push(best);
}

function processSpreads(oc, gl, allArbs, min) {
  var teams={};oc.forEach(function(o){teams[o.name]=true});
  var tn=Object.keys(teams);if(tn.length<2)return;
  var t1l=oc.filter(function(o){return o.name===tn[0]}),t2l=oc.filter(function(o){return o.name===tn[1]});
  var best=null;
  t1l.forEach(function(a){t2l.forEach(function(b){
    if(a.book===b.book)return;
    if(!((a.point<0&&b.point>0)||(a.point>0&&b.point<0)))return;
    if(!isTrueArb(a.odds,b.odds,min))return;
    var p1=oP(a.odds),p2=oP(b.odds),tot=p1+p2,s1=1000*(p1/tot),s2=1000*(p2/tot),pr=Math.min(s1*oD(a.odds),s2*oD(b.odds))-(s1+s2);
    if(!best||pr>best.profit)best={game:gl,roi:(pr/(s1+s2))*100,profit:pr,edge:(1-tot)*100,book1:a.book,odds1:a.odds,side1:tn[0]+' '+fmt(a.point),book2:b.book,odds2:b.odds,side2:tn[1]+' '+fmt(b.point)};
  });});
  if(best)allArbs.push(best);
}

async function scanSport(sport, allArbs, min) {
  var BOOKS='fanduel,draftkings,betmgm,williamhill_us,fanatics,thescore,hardrockbet,ballybet';
  try {
    var res=await fetch('https://api.the-odds-api.com/v4/sports/'+sport+'/odds/?apiKey='+ODDS_API_KEY+'&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers='+BOOKS);
    if(!res.ok){console.log('API error for',sport,res.status);return;}
    var games=res.json();
    if(!Array.isArray(games))return;
    console.log(sport+': '+games.length+' games');
    games.forEach(function(game){
      var gl=game.away_team+' @ '+game.home_team;
      var md={h2h:[],spreads:[],totals:[]};
      (game.bookmakers||[]).forEach(function(book){(book.markets||[]).forEach(function(mkt){if(!md[mkt.key])return;(mkt.outcomes||[]).forEach(function(out){md[mkt.key].push({name:out.name,price:out.price,point:out.point,book:book.title});});});});
      if(md.h2h.length)processH2H(md.h2h,gl,allArbs,min);
      if(md.spreads.length)processSpreads(md.spreads,gl,allArbs,min);
      if(md.totals.length)processTotals(md.totals,gl,allArbs,min);
    });
  } catch(e){console.log('Scan error for',sport,e.message);}
}

async function main() {
  console.log('ArbEdge scanner starting at', new Date().toISOString());
  if(!isActiveHour()){console.log('Outside active hours (6am-10pm ET) — skipping');process.exit(0);}
  var config=await loadConfig();
  if(!config){console.log('No config — skipping');process.exit(0);}
  if(!config.enabled){console.log('Scanner disabled — skipping');process.exit(0);}
  var sports=config.sports||['baseball_mlb'];
  var minEdge=config.minEdge||0.5;
  console.log('Scanning:',sports.join(', '),'| Min edge:',minEdge+'%');
  var allArbs=[];
  for(var i=0;i<sports.length;i++){await scanSport(sports[i],allArbs,minEdge);await new Promise(function(r){setTimeout(r,300);});}
  allArbs.sort(function(a,b){return b.edge-a.edge;});
  console.log('Found',allArbs.length,'arbs');
  if(!allArbs.length){process.exit(0);}
  var top=allArbs.slice(0,3);
  var lines=top.map(function(x){return '+'+x.roi.toFixed(2)+'% | '+x.game+'\n'+x.book1+' vs '+x.book2+' | $'+x.profit.toFixed(2)+' profit';});
  var extra=allArbs.length>3?'\n...and '+(allArbs.length-3)+' more':'';
  var msg=lines.join('\n\n')+extra;
  var title='🔔 '+allArbs.length+' Arb'+(allArbs.length>1?'s':'')+' Found — ArbEdge';
  await sendPushover(title,msg,allArbs[0].edge>=1?1:0);
}

main().catch(function(e){console.error('Fatal:',e);process.exit(1);});
