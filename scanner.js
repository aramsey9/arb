// ArbEdge Background Scanner â OFFSHORE (BookMaker.eu locked, SportsGameOdds feed)
// Runs via GitHub Actions, reads scheduler-config.json, scans for BookMaker.eu arbs,
// fires Pushover. Mirrors the Offshore tab logic from index.html.

const https = require('https');

const SGO_API_KEY = process.env.SGO_API_KEY;
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER = process.env.PUSHOVER_USER;

if (!SGO_API_KEY || !PUSHOVER_TOKEN || !PUSHOVER_USER) {
  console.log('Missing env vars â need SGO_API_KEY, PUSHOVER_TOKEN, PUSHOVER_USER (check GitHub Secrets)');
  process.exit(1);
}

// ââ BookMaker + hedge books (same IDs as Offshore tab) âââââ
var SGO_BOOKMAKER = 'bookmakereu';
var SGO_DOMESTIC = ['draftkings', 'fanduel', 'betmgm', 'caesars', 'espnbet', 'thescorebet', 'kalshi', 'polymarket'];
var SGO_NAMES = { bookmakereu: 'BookMaker.eu', draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', caesars: 'Caesars', espnbet: 'ESPN Bet', thescorebet: 'theScore', kalshi: 'Kalshi', polymarket: 'Polymarket' };
function sgoName(b) { return SGO_NAMES[b] || b; }

// Notify-tab sport keys (Odds API style) â SGO leagueIDs. Unmappable ones (golf, boxing) drop out.
var SPORT_TO_LEAGUE = {
  baseball_mlb: ['MLB'], basketball_nba: ['NBA'], americanfootball_nfl: ['NFL'],
  americanfootball_ncaaf: ['NCAAF'], icehockey_nhl: ['NHL'], soccer_usa_mls: ['MLS'],
  tennis_atp_french_open: ['ATP', 'WTA'], mma_mixed_martial_arts: ['UFC'],
  basketball_wnba: ['WNBA'], soccer_epl: ['EPL']
  // golf, boxing_boxing: no 2-way SGO arb path â intentionally omitted
};
var DEFAULT_LEAGUES = ['MLB', 'NBA', 'NFL', 'NHL', 'WNBA', 'UFC'];

// ââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââ
function amDec(o) { o = parseFloat(o); if (!o) return null; return o > 0 ? o / 100 + 1 : 100 / Math.abs(o) + 1; }
function amFmt(o) { o = parseFloat(o); return o > 0 ? '+' + o : '' + o; }

function fetch(url, opts) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var options = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: (opts && opts.method) || 'GET',
      headers: (opts && opts.headers) || {}
    };
    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (d) { data += d; });
      res.on('end', function () {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, json: function () { return JSON.parse(data); }, text: function () { return data; }, status: res.statusCode });
      });
    });
    req.on('error', reject);
    if (opts && opts.body) req.write(opts.body);
    req.end();
  });
}

// ââ Time check (6amâ10pm Eastern) â unchanged âââââââââââââ
function isActiveHour() {
  var now = new Date();
  var et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var h = et.getHours();
  return h >= 6 && h < 22;
}

// ââ Load config from repo (same file the Notify tab writes) â
async function loadConfig() {
  try {
    var res = await fetch('https://raw.githubusercontent.com/aramsey9/arb/main/scheduler-config.json?t=' + Date.now());
    if (!res.ok) { console.log('No config file found'); return null; }
    return res.json();
  } catch (e) { console.log('Config error:', e.message); return null; }
}

// Translate the Notify tab's sport toggles into SGO leagueIDs.
function leaguesFromConfig(config) {
  // Explicit override wins if present.
  if (Array.isArray(config.offshoreLeagues) && config.offshoreLeagues.length) return config.offshoreLeagues;
  var out = {};
  (config.sports || []).forEach(function (s) {
    (SPORT_TO_LEAGUE[s] || []).forEach(function (lg) { out[lg] = true; });
  });
  var list = Object.keys(out);
  return list.length ? list : DEFAULT_LEAGUES;
}

// ââ Pushover âââââââââââââââââââââââââââââââââââââââââââââââ
async function sendPushover(title, message, priority) {
  var payload = JSON.stringify({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title: title, message: message, priority: priority || 0, sound: 'cashregister' });
  try {
    var res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      body: payload
    });
    var data = res.json();
    console.log('Pushover:', data.status === 1 ? 'sent' : 'failed', data);
    return data.status === 1;
  } catch (e) { console.log('Pushover error:', e.message); return false; }
}

// ââ SGO odds-node readers (BookMaker locked vs best domestic) â
function bestDomestic(node) {
  if (!node || !node.byBookmaker) return null;
  var best = null;
  SGO_DOMESTIC.forEach(function (bk) {
    var bb = node.byBookmaker[bk]; if (!bb || bb.available === false || bb.odds == null) return;
    var d = amDec(bb.odds); if (!d || d <= 1) return;
    if (!best || d > best.dec) best = { book: bk, am: bb.odds, dec: d, line: (bb.overUnder != null ? bb.overUnder : bb.spread) };
  });
  return best;
}
function bookmakerSide(node) {
  if (!node || !node.byBookmaker) return null;
  var bb = node.byBookmaker[SGO_BOOKMAKER]; if (!bb || bb.available === false || bb.odds == null) return null;
  var d = amDec(bb.odds); if (!d || d <= 1) return null;
  return { book: SGO_BOOKMAKER, am: bb.odds, dec: d, line: (bb.overUnder != null ? bb.overUnder : bb.spread) };
}

// ââ Per-event arb extraction (port of scanOffshore) ââââââââ
function scanEvent(ev, allArbs, min, wantM) {
  var odds = ev.odds || {}; if (!odds) return;
  var live = ev.status && (ev.status.started === true || ev.status.live === true);
  var ended = ev.status && (ev.status.ended === true || ev.status.completed === true);
  if (ended) return;
  if (live) return; // background = UPCOMING ONLY (live game props are stale-data prone)

  var home = ev.teams && ev.teams.home, away = ev.teams && ev.teams.away;
  function tn(t) { if (!t) return ''; if (typeof t === 'string') return t; return (t.names && (t.names.short || t.names.long)) || t.name || t.shortName || ''; }
  var homeName = tn(home) || 'Home', awayName = tn(away) || 'Away';
  var leagueName = ev.leagueID || (ev.league && (ev.league.name || ev.league.shortName)) || ev.sportID || '';
  var gl = awayName + ' @ ' + homeName;

  Object.keys(odds).forEach(function (oddID) {
    var od = odds[oddID]; if (!od) return;
    var bt = od.betTypeID, side = od.sideID;
    var primarySides = { ml: 'home', sp: 'home', ou: 'over', yn: 'yes' };
    var isProp = !!od.playerID;
    var isGameProp = !isProp && od.periodID && od.periodID !== 'game';
    // market gating
    if (isProp) { if (wantM.indexOf('props') < 0) return; }
    else if (isGameProp) { if (wantM.indexOf('gameprops') < 0) return; }
    else {
      if (bt === 'ml' && wantM.indexOf('ml') < 0) return;
      if (bt === 'sp' && wantM.indexOf('sp') < 0) return;
      if (bt === 'ou' && wantM.indexOf('ou') < 0) return;
    }
    if (['ml', 'sp', 'ou', 'yn'].indexOf(bt) < 0) return;
    if (side !== primarySides[bt]) return;

    var oppID = od.opposingOddID; if (!oppID) return;
    var opp = odds[oppID]; if (!opp) return;

    var bmHere = bookmakerSide(od), domOpp = bestDomestic(opp);
    var domHere = bestDomestic(od), bmOpp = bookmakerSide(opp);

    function sideName(which) {
      if (bt === 'ml' || bt === 'sp') return which === 'primary' ? homeName : awayName;
      if (bt === 'ou') return which === 'primary' ? 'Over' : 'Under';
      if (bt === 'yn') return which === 'primary' ? 'Yes' : 'No';
      return which;
    }
    function withLine(nm, leg) { if (leg && leg.line != null && (bt === 'ou' || bt === 'sp')) return nm + ' ' + (parseFloat(leg.line) > 0 && bt === 'sp' ? '+' : '') + leg.line; return nm; }

    function consider(legBM, legDOM, bmIsSideA, nameA, nameB) {
      if (!legBM || !legDOM) return;
      var inv = (1 / legBM.dec) + (1 / legDOM.dec);
      var edge = (1 - inv) * 100;
      if (inv >= 1 || edge < min) return;
      // line sanity (no arbing mismatched totals/spreads)
      if (bt === 'ou' && legBM.line != null && legDOM.line != null) {
        var overLine = bmIsSideA ? legBM.line : legDOM.line;
        var underLine = bmIsSideA ? legDOM.line : legBM.line;
        if (parseFloat(underLine) < parseFloat(overLine)) return;
      }
      if (bt === 'sp' && legBM.line != null && legDOM.line != null) {
        if ((parseFloat(legBM.line) + parseFloat(legDOM.line)) < 0) return;
      }
      // Notification stake math: $1000 total, equal-payout split (matches old alert format)
      var p1 = 1 / legBM.dec, p2 = 1 / legDOM.dec, tot = p1 + p2;
      var s1 = 1000 * p1 / tot, s2 = 1000 * p2 / tot;
      var profit = (1000 / tot) - 1000;
      var roi = profit / 10;
      var mLabel = od.marketName || (od.statID ? od.statID.replace(/_/g, ' ') : bt.toUpperCase());
      if (isGameProp && od.periodID) mLabel = od.periodID.toUpperCase() + ' ' + mLabel;
      allArbs.push({
        game: gl, league: leagueName, label: mLabel, edge: edge, roi: roi, profit: profit,
        isProp: isProp, isGameProp: isGameProp,
        bmName: nameA, bmAm: legBM.am, domBook: legDOM.book, domName: nameB, domAm: legDOM.am
      });
    }

    var nmP = sideName('primary'), nmO = sideName('opp');
    consider(bmHere, domOpp, true, withLine(nmP, bmHere), withLine(nmO, domOpp));
    consider(bmOpp, domHere, false, withLine(nmO, bmOpp), withLine(nmP, domHere));
  });
}

// ââ Fetch + scan a league set (with self-healing book drop) â
async function scanLeagues(leagues, allArbs, min, wantM, maxGames) {
  var books = [SGO_BOOKMAKER].concat(SGO_DOMESTIC);
  var collected = [], cursor = null, pages = 0, droppedBooks = [];
  var base = 'https://api.sportsgameodds.com/v2/events';
  do {
    var url = base + '?apiKey=' + encodeURIComponent(SGO_API_KEY)
      + '&leagueID=' + encodeURIComponent(leagues.join(','))
      + '&oddsAvailable=true&bookmakerID=' + encodeURIComponent(books.join(','))
      + '&limit=' + Math.min(maxGames, 50) + '&includeAltLines=true';
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);

    var res;
    try { res = await fetch(url); } catch (e) { console.log('SGO fetch error:', e.message); return droppedBooks; }
    var resp;
    try { resp = res.json(); } catch (e) { console.log('SGO parse error:', e.message); return droppedBooks; }
    if (!resp || typeof resp !== 'object') { console.log('SGO: no/!object response'); return droppedBooks; }

    if (resp.success === false) {
      var em = (resp.error || '') + '';
      var m = em.match(/bookmakerID\s+(\S+)\s+is unavailable/i);
      if (m && books.indexOf(m[1]) > -1 && m[1] !== SGO_BOOKMAKER) {
        droppedBooks.push(m[1]);
        books = books.filter(function (b) { return b !== m[1]; });
        console.log('Dropped tier-gated book:', m[1], 'â retrying');
        continue; // retry same cursor with reduced book list
      }
      console.log('SGO error:', em);
      return droppedBooks;
    }
    var batch = Array.isArray(resp.data) ? resp.data : [];
    collected = collected.concat(batch);
    cursor = resp.nextCursor || null; pages++;
  } while (cursor && collected.length < maxGames && pages < 8);

  var events = collected.slice(0, maxGames);
  console.log(leagues.join(',') + ': ' + events.length + ' events with odds');
  events.forEach(function (ev) { scanEvent(ev, allArbs, min, wantM); });
  return droppedBooks;
}

async function main() {
  console.log('ArbEdge OFFSHORE scanner starting at', new Date().toISOString());

  if (!isActiveHour()) { console.log('Outside active hours (6am-10pm ET) â skipping'); process.exit(0); }

  var config = await loadConfig();
  if (!config) { console.log('No config â skipping'); process.exit(0); }
  if (!config.enabled) { console.log('Scanner disabled in config â skipping'); process.exit(0); }

  var leagues = leaguesFromConfig(config);
  var minEdge = config.minEdge || 0.5;
  var wantM = Array.isArray(config.offshoreMarkets) && config.offshoreMarkets.length
    ? config.offshoreMarkets
    : ['ml', 'sp', 'ou', 'props', 'gameprops']; // mirrors Offshore tab defaults (alt always on via includeAltLines)
  var maxGames = parseInt(config.maxGames, 10) || 25;
  // Stale-data guard: BookMaker arbs cluster ~0.5â2%. Flag (don't hide) anything far above.
  var staleFlag = parseFloat(config.staleFlagEdge) || 8;

  console.log('Leagues:', leagues.join(', '));
  console.log('Min edge:', minEdge + '%  | markets:', wantM.join(','), '| maxGames:', maxGames);

  var allArbs = [];
  // One request per league keeps quota predictable and isolates a bad league.
  for (var i = 0; i < leagues.length; i++) {
    await scanLeagues([leagues[i]], allArbs, minEdge, wantM, maxGames);
    await new Promise(function (r) { setTimeout(r, 300); });
  }

  // dedupe + sort (highest edge first)
  var seen = {};
  allArbs = allArbs.filter(function (a) {
    var k = a.game + '|' + a.label + '|' + a.bmAm + '|' + a.domBook;
    if (seen[k]) return false; seen[k] = 1; return true;
  });
  allArbs.sort(function (a, b) { return b.edge - a.edge; });

  console.log('Found', allArbs.length, 'BookMaker arbs');
  if (!allArbs.length) { console.log('No arbs found'); process.exit(0); }

  var top = allArbs.slice(0, 3);
  var lines = top.map(function (x) {
    var flag = x.edge >= staleFlag ? ' â ï¸ verify (likely stale)' : '';
    var mkt = (x.league ? x.league + ' Â· ' : '') + x.label;
    return '+' + x.roi.toFixed(2) + '% | ' + x.game + flag + '\n' +
      mkt + '\n' +
      'ð BookMaker.eu ' + amFmt(x.bmAm) + ' (' + x.bmName + ') vs ' +
      sgoName(x.domBook) + ' ' + amFmt(x.domAm) + ' (' + x.domName + ') | $' + x.profit.toFixed(2) + ' / $1k';
  });
  var extra = allArbs.length > 3 ? '\n...and ' + (allArbs.length - 3) + ' more' : '';
  var msg = lines.join('\n\n') + extra;
  var title = 'ð ' + allArbs.length + ' BookMaker Arb' + (allArbs.length > 1 ? 's' : '') + ' â ArbEdge';
  var priority = (allArbs[0].edge >= 1 && allArbs[0].edge < staleFlag) ? 1 : 0;

  await sendPushover(title, msg, priority);
  console.log('Done');
}

main().catch(function (e) { console.error('Fatal error:', e); process.exit(1); });
