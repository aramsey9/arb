// ArbEdge Background Scanner — BookMaker.eu (SGO) edition
// Scans the SAME engine as the in-app Offshore tab: BookMaker.eu locked as
// one leg, hedged against domestic books from the SportsGameOdds feed.
// Fires Pushover. Honors the in-app scheduler-config.json (enabled, sports,
// minEdge, intervalMinutes). Dedups so you're pinged at most twice per bet.

const https = require('https');
const fs = require('fs');

const SGO_API_KEY = process.env.SGO_API_KEY;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER = process.env.PUSHOVER_USER;

if (!SGO_API_KEY || !PUSHOVER_TOKEN || !PUSHOVER_USER) {
  console.log('Missing env vars — need SGO_API_KEY, PUSHOVER_TOKEN, PUSHOVER_USER in GitHub Secrets');
  process.exit(1);
}

// ── Config knobs (sensible defaults; override via scheduler-config.json) ──
const SGO_BOOKMAKER = 'bookmakereu';
const SGO_DOMESTIC = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'fanatics', 'bet365', 'thescorebet'];
const SGO_NAMES = { bookmakereu: 'BookMaker.eu', draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', caesars: 'Caesars', fanatics: 'Fanatics', bet365: 'Bet365', thescorebet: 'theScore' };
// Map the app's sport keys -> SGO league IDs. Soccer/golf/boxing/tennis are
// skipped (3-way or not on SGO). MMA uses UFC.
const SPORT_TO_SGO = {
  baseball_mlb: 'MLB', basketball_nba: 'NBA', basketball_wnba: 'WNBA',
  americanfootball_nfl: 'NFL', americanfootball_ncaaf: 'NCAAF',
  icehockey_nhl: 'NHL', mma_mixed_martial_arts: 'UFC'
};
const STALE_OUTLIER = 1.05;  // domestic line 5%+ longer than peers = likely stale -> skip
const EDGE_CEILING = 15;     // edges above this are near-certainly data errors -> skip
const DEFAULT_STAKE = 100;   // domestic leg $ used to express profit

// ── Persistent state (GitHub Actions cache) ──────────────────────
const STATE_FILE = './notif-state.json';
const NOTIFY_CAP = 2;
const PRUNE_MS = 36 * 60 * 60 * 1000;
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { lastRun: 0, seen: {} }; } }
function saveState(st) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(st)); } catch (e) { console.log('State save error:', e.message); } }
function arbSig(x) { return [x.game, x.bmLeg.book, x.bmLeg.name, x.domLeg.book, x.domLeg.name].join(' | '); }

// ── Helpers ──────────────────────────────────────────────────────
function amDec(o) { o = parseFloat(o); if (!o) return null; return o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1; }
function amFmt(o) { o = parseFloat(o); return o > 0 ? '+' + o : '' + o; }
function sgoName(b) { return SGO_NAMES[b] || b; }

function fetchJson(url) {
  return new Promise(function (resolve) {
    var u = new URL(url);
    var req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'x-api-key': SGO_API_KEY, 'Accept': 'application/json' } }, function (res) {
      var data = ''; res.on('data', function (d) { data += d; });
      res.on('end', function () { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    });
    req.on('error', function () { resolve(null); });
    req.end();
  });
}

function isActiveHour() {
  var et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var h = et.getHours(); return h >= 6 && h < 22;
}

async function loadConfig() {
  var obj = await fetchJson('https://raw.githubusercontent.com/aramsey9/arb/main/scheduler-config.json?t=' + Date.now());
  return obj || null;
}

async function sendPushover(title, message, priority) {
  var payload = JSON.stringify({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title: title, message: message, priority: priority || 0, sound: 'cashregister' });
  return new Promise(function (resolve) {
    var req = https.request({ hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, function (res) {
      var data = ''; res.on('data', function (d) { data += d; });
      res.on('end', function () { try { var j = JSON.parse(data); console.log('Pushover:', j.status === 1 ? 'sent' : 'failed', data); resolve(j.status === 1); } catch (e) { resolve(false); } });
    });
    req.on('error', function (e) { console.log('Pushover error:', e.message); resolve(false); });
    req.write(payload); req.end();
  });
}

// ── BookMaker-vs-domestic arb engine (ported from the Offshore tab) ──
function bestDomestic(node) {
  if (!node || !node.byBookmaker) return null;
  var best = null, decs = [];
  SGO_DOMESTIC.forEach(function (bk) {
    var bb = node.byBookmaker[bk]; if (!bb || bb.available === false || bb.odds == null) return;
    var d = amDec(bb.odds); if (!d || d <= 1) return;
    decs.push(d);
    if (!best || d > best.dec) best = { book: bk, am: bb.odds, dec: d, line: (bb.overUnder != null ? bb.overUnder : bb.spread) };
  });
  if (best) {
    decs.sort(function (a, b) { return b - a; });
    best.nBooks = decs.length;
    best.second = decs.length > 1 ? decs[1] : null;
    best.outlier = best.second ? (best.dec >= best.second * STALE_OUTLIER) : false;
    best.outlierPct = best.second ? ((best.dec / best.second - 1) * 100) : 0;
  }
  return best;
}
function bookmakerSide(node) {
  if (!node || !node.byBookmaker) return null;
  var bb = node.byBookmaker[SGO_BOOKMAKER]; if (!bb || bb.available === false || bb.odds == null) return null;
  var d = amDec(bb.odds); if (!d || d <= 1) return null;
  return { book: SGO_BOOKMAKER, am: bb.odds, dec: d, line: (bb.overUnder != null ? bb.overUnder : bb.spread) };
}

function scanEvents(events, minEdge, out, inclProps, inclGameProps) {
  events.forEach(function (ev) {
    var odds = ev.odds || {}; if (!odds) return;
    var live = ev.status && (ev.status.started === true || ev.status.live === true);
    var ended = ev.status && (ev.status.ended === true || ev.status.completed === true);
    if (ended || live) return; // upcoming only
    function tn(t) { if (!t) return ''; if (typeof t === 'string') return t; return (t.names && (t.names.short || t.names.long)) || t.name || t.shortName || ''; }
    var homeName = tn(ev.teams && ev.teams.home) || 'Home', awayName = tn(ev.teams && ev.teams.away) || 'Away';
    var leagueName = ev.leagueID || ev.sportID || '';
    var gl = awayName + ' @ ' + homeName;

    Object.keys(odds).forEach(function (oddID) {
      var od = odds[oddID]; if (!od) return;
      var bt = od.betTypeID, side = od.sideID;
      var primarySides = { ml: 'home', sp: 'home', ou: 'over', yn: 'yes' };
      var isProp = !!od.playerID;
      var isGameProp = !isProp && od.periodID && od.periodID !== 'game';
      if (isProp && !inclProps) return;
      if (isGameProp && !inclGameProps) return;
      if (['ml', 'sp', 'ou', 'yn'].indexOf(bt) < 0) return;
      if (side !== primarySides[bt]) return;

      var oppID = od.opposingOddID; if (!oppID) return;
      var opp = odds[oppID]; if (!opp) return;

      var bmHere = bookmakerSide(od), domOpp = bestDomestic(opp);
      var domHere = bestDomestic(od), bmOpp = bookmakerSide(opp);

      function sideName(which) {
        if (bt === 'ou') return which === 'primary' ? 'Over' : 'Under';
        if (bt === 'yn') return which === 'primary' ? 'Yes' : 'No';
        return which === 'primary' ? homeName : awayName;
      }
      function withLine(nm, leg) { if (leg && leg.line != null && (bt === 'ou' || bt === 'sp')) return nm + ' ' + (parseFloat(leg.line) > 0 && bt === 'sp' ? '+' : '') + leg.line; return nm; }

      function consider(legBM, legDOM, bmIsSideA, nameA, nameB) {
        if (!legBM || !legDOM) return;
        var inv = (1 / legBM.dec) + (1 / legDOM.dec);
        var edge = (1 - inv) * 100;
        if (inv >= 1 || edge < minEdge) return;
        if (edge > EDGE_CEILING) return;                 // data-error guard
        if (legDOM.outlier) return;                      // stale domestic line -> skip
        if (bt === 'ou' && legBM.line != null && legDOM.line != null) {
          var overLine = bmIsSideA ? legBM.line : legDOM.line;
          var underLine = bmIsSideA ? legDOM.line : legBM.line;
          if (parseFloat(underLine) < parseFloat(overLine)) return;
        }
        if (bt === 'sp' && legBM.line != null && legDOM.line != null) {
          if ((parseFloat(legBM.line) + parseFloat(legDOM.line)) < 0) return;
        }
        var sDOM = DEFAULT_STAKE;
        var sBM = sDOM * legDOM.dec / legBM.dec;
        var payout = sDOM * legDOM.dec;
        var total = sDOM + sBM;
        var profit = payout - total;
        var mLabel = od.marketName || (od.statID ? od.statID.replace(/_/g, ' ') : bt.toUpperCase());
        if (isGameProp && od.periodID) mLabel = od.periodID.toUpperCase() + ' ' + mLabel;
        var kind = isProp ? 'PROP' : (isGameProp ? 'GAME PROP' : 'MAIN');
        out.push({
          game: gl, league: leagueName, edge: edge, profit: profit, roi: (profit / total) * 100, label: mLabel, kind: kind,
          bmLeg: { book: legBM.book, am: legBM.am, name: nameA },
          domLeg: { book: legDOM.book, am: legDOM.am, name: nameB }
        });
      }
      consider(bmHere, domOpp, true, withLine(sideName('primary'), bmHere), withLine(sideName('opp'), domOpp));
      consider(bmOpp, domHere, false, withLine(sideName('opp'), bmOpp), withLine(sideName('primary'), domHere));
    });
  });
}

async function fetchLeague(sgoLeague, maxGames) {
  var base = 'https://api.sportsgameodds.com/v2/events';
  var books = [SGO_BOOKMAKER].concat(SGO_DOMESTIC);
  var collected = [], cursor = null, pages = 0;
  do {
    var url = base + '?apiKey=' + encodeURIComponent(SGO_API_KEY) + '&leagueID=' + encodeURIComponent(sgoLeague)
      + '&oddsAvailable=true&bookmakerID=' + encodeURIComponent(books.join(',')) + '&limit=' + Math.min(maxGames, 50);
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    var resp = await fetchJson(url);
    if (!resp || typeof resp !== 'object') { console.log(sgoLeague + ': no response'); break; }
    if (resp.success === false) {
      var em = (resp.error || '') + '';
      var m = em.match(/bookmakerID\s+(\S+)\s+is unavailable/i);
      if (m && books.indexOf(m[1]) > -1 && m[1] !== SGO_BOOKMAKER) {
        books = books.filter(function (b) { return b !== m[1]; });
        console.log(sgoLeague + ': dropped gated book ' + m[1] + ', retrying');
        continue;
      }
      console.log(sgoLeague + ' SGO error: ' + em); break;
    }
    var batch = Array.isArray(resp.data) ? resp.data : [];
    collected = collected.concat(batch);
    cursor = resp.nextCursor || null; pages++;
  } while (cursor && collected.length < maxGames && pages < 6);
  console.log(sgoLeague + ': ' + collected.length + ' events');
  return collected.slice(0, maxGames);
}

async function main() {
  console.log('ArbEdge (BookMaker) scanner starting at', new Date().toISOString());

  if (!isActiveHour()) { console.log('Outside active hours (6am-10pm ET) — skipping'); process.exit(0); }

  var config = await loadConfig();
  if (!config) { console.log('No config — skipping'); process.exit(0); }
  if (!config.enabled) { console.log('Scanner disabled in config — skipping'); process.exit(0); }

  var state = loadState();
  var now = Date.now();

  var intervalMin = Number(config.intervalMinutes) || 10;
  if (intervalMin < 5) intervalMin = 5;
  var elapsed = now - (state.lastRun || 0);
  if (elapsed < intervalMin * 60 * 1000 - 90 * 1000) {
    console.log('Throttled: ' + Math.round(elapsed / 60000) + 'm since last run, interval ' + intervalMin + 'm — skipping');
    process.exit(0);
  }
  state.lastRun = now;

  var minEdge = config.minEdge || 0.5;
  var inclProps = config.includeProps !== false;        // default ON
  var inclGameProps = config.includeGameProps !== false; // default ON
  var sportKeys = config.sports || ['baseball_mlb', 'basketball_nba', 'americanfootball_nfl'];
  var leagues = sportKeys.map(function (s) { return SPORT_TO_SGO[s]; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  if (!leagues.length) { console.log('No SGO-supported leagues selected — skipping'); saveState(state); process.exit(0); }
  console.log('Leagues:', leagues.join(', '), '· min edge', minEdge + '% · interval', intervalMin + 'm · props', inclProps, '· gameProps', inclGameProps);

  var allArbs = [];
  for (var i = 0; i < leagues.length; i++) {
    var events = await fetchLeague(leagues[i], 50);
    scanEvents(events, minEdge, allArbs, inclProps, inclGameProps);
    await new Promise(function (r) { setTimeout(r, 300); });
  }
  allArbs.sort(function (a, b) { return b.edge - a.edge; });
  console.log('Found', allArbs.length, 'BookMaker arbs (after stale + sanity filters)');

  // ── Dedup: refresh live arbs, keep only those notified < cap ──
  if (!state.seen) state.seen = {};
  allArbs.forEach(function (x) { var s = arbSig(x); if (!state.seen[s]) state.seen[s] = { n: 0, t: now }; state.seen[s].t = now; });
  var eligible = allArbs.filter(function (x) { return (state.seen[arbSig(x)].n || 0) < NOTIFY_CAP; });
  Object.keys(state.seen).forEach(function (s) { if (now - (state.seen[s].t || 0) > PRUNE_MS) delete state.seen[s]; });

  if (!eligible.length) {
    console.log(allArbs.length + ' arbs present, all already notified ' + NOTIFY_CAP + 'x — staying quiet');
    saveState(state); process.exit(0);
  }

  var top = eligible.slice(0, 3);
  top.forEach(function (x) { state.seen[arbSig(x)].n = (state.seen[arbSig(x)].n || 0) + 1; });
  var lines = top.map(function (x) {
    var tag = x.kind === 'PROP' ? '🎯 ' : (x.kind === 'GAME PROP' ? '⏱ ' : '');
    return '+' + x.edge.toFixed(2) + '% | ' + tag + x.game + ' (' + x.league + ')\n' + x.label + '\n🌊 BookMaker ' + amFmt(x.bmLeg.am) + ' ' + x.bmLeg.name + '  vs  ' + sgoName(x.domLeg.book) + ' ' + amFmt(x.domLeg.am) + ' ' + x.domLeg.name + '  | $' + x.profit.toFixed(2) + ' / $100';
  });
  var more = eligible.length - top.length;
  var msg = lines.join('\n\n') + (more > 0 ? '\n...and ' + more + ' more new' : '') + '\n\n⚠️ Place BookMaker first — sharp side moves fastest.';
  var title = '🌊 ' + eligible.length + ' BookMaker Arb' + (eligible.length > 1 ? 's' : '') + ' — ArbEdge';
  var priority = eligible[0].edge >= 1 ? 1 : 0;

  await sendPushover(title, msg, priority);
  saveState(state);
  console.log('Done — notified ' + top.length + ', tracking ' + Object.keys(state.seen).length + ' sigs');
}

main().catch(function (e) { console.error('Fatal error:', e); process.exit(1); });
