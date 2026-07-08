/* ─── bracket-builder.js — Manual bracket builder domain (bb*: phases, pools, ────
   rounds, round-robin/swiss tables + standings, bracket.html payloads, autosave
   + hydrate). Extracted verbatim from app.js (2026-07). Loads after app.js;
   inbound calls (bbGenerate/bbSendPhases/bbHydrate/_bbHydrated) are all runtime,
   several already typeof-guarded at the call sites. */

// ── Bracket builder (manual; feeds bracket.html) ──────────────────────────
// bbModel rounds: { name, sets: [{ a:{name,score}, b:{name,score} }] }
// Elim uses winners/losers/finals; Round Robin & Swiss use rounds[] + roster[] + auto standings.
// bbModel = the live working copy of the ACTIVE phase. Multi-phase events (Day 1
// double-elim → Day 2 single-elim/swiss) keep one entry per phase in bbPhases.
const bbModel = { type: 'single', size: 8, rosterCount: 8, swissRounds: 5, winners: [], losers: [], finals: [], rounds: [], roster: [] };
const bbIsTable = () => bbModel.type === 'roundrobin' || bbModel.type === 'swiss';
let bbPhases = [];        // [{ id, name, type, size, swissRounds, winners, losers, finals, rounds, roster }]
let bbActiveId = null;
let _bbPhaseSeq = 0;
let _bbHydrated = false;
let _bbSaveTimer = null;

const BB_FIELDS = ['type', 'size', 'swissRounds', 'winners', 'losers', 'finals', 'rounds', 'roster', 'pools'];
function bbNewPhase(name, type) {
  return { id: 'ph' + (++_bbPhaseSeq), name: name || ('Phase ' + (bbPhases.length + 1)), type: type || 'single', size: 8, swissRounds: 5, winners: [], losers: [], finals: [], rounds: [], roster: [], pools: [] };
}
function bbActivePhase() { return bbPhases.find((p) => p.id === bbActiveId) || null; }
function bbEnsurePhase() {
  if (!bbPhases.length) { const p = bbNewPhase('Phase 1', bbModel.type); bbPhases.push(p); bbActiveId = p.id; }
  if (!bbActiveId) bbActiveId = bbPhases[0].id;
}
// Copy bbModel ↔ the active phase object.
function bbCommit() {
  const ph = bbActivePhase(); if (!ph) return;
  bbCommitPool();   // flush the currently-edited pool's roster/rounds into bbModel.pools first
  BB_FIELDS.forEach((k) => { ph[k] = bbModel[k]; });
  ph.activePoolId = bbActivePoolId;
}
function bbLoadPhase(id) {
  bbActiveId = id;
  const ph = bbActivePhase(); if (!ph) return;
  BB_FIELDS.forEach((k) => { bbModel[k] = ph[k] !== undefined ? ph[k] : bbModel[k]; });
  if (Array.isArray(bbModel.pools) && bbModel.pools.length) {
    const wantId = ph.activePoolId && bbModel.pools.some((p) => p.id === ph.activePoolId) ? ph.activePoolId : bbModel.pools[0].id;
    bbLoadPool(wantId);
  } else {
    bbActivePoolId = '';
  }
  // reflect type/size/rounds in the toolbar
  const seg = el('bb-type-seg'); if (seg) seg.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.type === bbModel.type));
  const sz = el('bb-size'); if (sz) sz.value = bbModel.size;
  const rn = el('bb-rounds-num'); if (rn) rn.value = bbModel.swissRounds;
  const pc = el('bb-pool-count'); if (pc) pc.value = Math.max(1, (bbModel.pools || []).length);
  bbSyncTypeUi();
  bbRenderPools();
  bbRender();
}

function bbRoundName(matchCount, section, isLast) {
  if (section === 'finals') return 'Grand Final';
  if (section === 'losers') return isLast ? "Losers' Final" : 'Losers Round';
  if (isLast) return section === 'winners' && bbModel.type === 'double' ? "Winners' Final" : 'Final';
  if (matchCount >= 8) return 'Round of ' + (matchCount * 2);
  if (matchCount === 4) return 'Quarterfinals';
  if (matchCount === 2) return 'Semifinals';
  return 'Final';
}
function bbEmptySet() { return { a: { name: '', score: 0 }, b: { name: '', score: 0 } }; }
function bbMakeRounds(counts, section) {
  return counts.map((cnt, idx) => ({
    name: bbRoundName(cnt, section, idx === counts.length - 1),
    sets: Array.from({ length: cnt }, bbEmptySet)
  }));
}
// Single round-robin schedule (circle method). n must be even.
function bbRoundRobinPairs(n) {
  const idx = [...Array(n).keys()];
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const matches = [];
    for (let i = 0; i < n / 2; i++) matches.push([idx[i], idx[n - 1 - i]]);
    rounds.push(matches);
    idx.splice(1, 0, idx.pop());   // rotate, fixing idx[0]
  }
  return rounds;
}
function bbGenerate() {
  bbEnsurePhase();
  const size = bbModel.size;
  if (bbModel.type === 'single' || bbModel.type === 'double') {
    const p2 = 1 << Math.ceil(Math.log2(size));   // snap to a power of two (byes if needed)
    const winCounts = [];
    for (let m = p2 / 2; m >= 1; m = Math.floor(m / 2)) winCounts.push(m);
    bbModel.winners = bbMakeRounds(winCounts, 'winners');
    if (bbModel.type === 'double') {
      const loseCounts = [];
      for (let m = p2 / 4; m >= 1; m = Math.floor(m / 2)) { loseCounts.push(m); loseCounts.push(m); }
      bbModel.losers = bbMakeRounds(loseCounts, 'losers');
      bbModel.finals = bbMakeRounds([1], 'finals');
    } else { bbModel.losers = []; bbModel.finals = []; }
    bbModel.rounds = [];
  } else {
    // Round Robin / Swiss — build a roster, then a schedule of rounds.
    const n = bbModel.size;
    if (bbModel.roster.length < n) while (bbModel.roster.length < n) bbModel.roster.push('');
    bbModel.roster.length = n;
    bbModel.winners = []; bbModel.losers = []; bbModel.finals = [];
    if (bbModel.type === 'roundrobin') {
      const pairs = bbRoundRobinPairs(n % 2 === 0 ? n : n + 1);
      bbModel.rounds = pairs.map((matches, ri) => ({
        name: 'Round ' + (ri + 1),
        sets: matches.filter(([a, b]) => a < n && b < n).map(([a, b]) => ({
          a: { name: bbModel.roster[a] || '', score: 0 }, b: { name: bbModel.roster[b] || '', score: 0 }
        }))
      }));
    } else {
      const rc = Math.max(1, Math.min(12, bbModel.swissRounds || Math.ceil(Math.log2(n))));
      bbModel.rounds = Array.from({ length: rc }, (_, ri) => ({
        name: 'Round ' + (ri + 1),
        sets: Array.from({ length: Math.floor(n / 2) }, (_, mi) => {
          // Round 1 seeds sequentially from the roster; later rounds are filled by the producer.
          const a = ri === 0 ? bbModel.roster[mi * 2] || '' : '';
          const b = ri === 0 ? bbModel.roster[mi * 2 + 1] || '' : '';
          return { a: { name: a, score: 0 }, b: { name: b, score: 0 } };
        })
      }));
    }
  }
  bbCommitPool();   // this may run mid-split, iterating other pools — keep pool storage in sync immediately
  bbRender();
  bbAutosave();
}
// Auto-compute standings from every played match in the schedule — Wins/Losses plus the
// same Sets Played/Set Wins-Losses/Game Wins-Losses stats Start.gg's own Pool/Swiss
// standings show (server-side buildBracket() computes the identical fields for
// Start.gg-derived pools, so manual and imported brackets render identically).
function bbComputeStandings(rounds, roster) {
  rounds = rounds || bbModel.rounds; roster = roster || bbModel.roster;
  const tally = {};
  const seed = (name) => { if (name && !tally[name]) tally[name] = { name, wins: 0, losses: 0, setsPlayed: 0, setsTotal: 0, gameWins: 0, gameLosses: 0 }; };
  roster.forEach(seed);
  rounds.forEach((round) => round.sets.forEach((set) => {
    seed(set.a.name); seed(set.b.name);
    if (set.a.name) tally[set.a.name].setsTotal++;
    if (set.b.name) tally[set.b.name].setsTotal++;
    const w = bbWinnerOf(set);
    if (!w || !set.a.name || !set.b.name) return;
    const as = Number(set.a.score) || 0, bs = Number(set.b.score) || 0;
    tally[set.a.name].gameWins += as; tally[set.a.name].gameLosses += bs;
    tally[set.b.name].gameWins += bs; tally[set.b.name].gameLosses += as;
    if (w === 'a') { tally[set.a.name].wins++; tally[set.a.name].setsPlayed++; tally[set.b.name].losses++; tally[set.b.name].setsPlayed++; }
    else { tally[set.b.name].wins++; tally[set.b.name].setsPlayed++; tally[set.a.name].losses++; tally[set.a.name].setsPlayed++; }
  }));
  return Object.values(tally)
    .filter((t) => t.name)
    .sort((x, y) => (y.wins - y.losses) - (x.wins - x.losses) || y.wins - x.wins || x.name.localeCompare(y.name))
    .map((t, i) => ({ placement: i + 1, name: t.name, wins: t.wins, losses: t.losses,
      setsPlayed: t.setsPlayed, setsTotal: t.setsTotal, setWins: t.wins, setLosses: t.losses,
      gameWins: t.gameWins, gameLosses: t.gameLosses }));
}
// Head-to-head matrix for a Round Robin group — same { teams, cells } shape the Start.gg
// import path produces, so bracket.html's Head-to-head grid view works for manual pools too.
function bbComputeMatrix(rounds, roster) {
  const names = (roster || []).filter(Boolean);
  if (names.length < 2) return null;
  const ids = {};
  const teams = names.map((name, i) => { const id = 'e' + i; ids[name] = id; return { id, name }; });
  const cells = {};
  (rounds || []).forEach((round) => (round.sets || []).forEach((set) => {
    const an = set.a && set.a.name, bn = set.b && set.b.name;
    if (!an || !bn || !ids[an] || !ids[bn]) return;
    const w = bbWinnerOf(set);
    const aScore = Number(set.a.score) || 0, bScore = Number(set.b.score) || 0;
    cells[ids[an] + '_' + ids[bn]] = { aScore, bScore, winner: w === 'a' ? 'a' : (w === 'b' ? 'b' : null), played: !!w };
    cells[ids[bn] + '_' + ids[an]] = { aScore: bScore, bScore: aScore, winner: w === 'a' ? 'b' : (w === 'b' ? 'a' : null), played: !!w };
  }));
  return { teams, cells };
}

// ── Pools (Round Robin / Swiss phases split into N parallel groups — Start.gg
// "Pool Play") ── bbModel.roster/rounds always hold the ACTIVE pool's own arrays once
// a phase has pools; switching pools swaps those arrays in/out, the exact same pattern
// bbPhases already uses for switching phases — every existing render/generate/standings
// function above keeps working completely unmodified for a single active pool.
let bbActivePoolId = '';
let _bbPoolSeq = 0;
function bbActivePoolObj() { return (bbModel.pools || []).find((p) => p.id === bbActivePoolId) || null; }
function bbCommitPool() {
  const p = bbActivePoolObj();
  if (p) { p.roster = bbModel.roster; p.rounds = bbModel.rounds; }
}
function bbLoadPool(id) {
  const p = (bbModel.pools || []).find((x) => x.id === id); if (!p) return;
  bbActivePoolId = id;
  bbModel.roster = p.roster; bbModel.rounds = p.rounds;
  bbModel.size = p.roster.length || bbModel.size;
  const sz = el('bb-size'); if (sz) sz.value = bbModel.size;
}
function bbPoolName(i) { return 'Pool ' + String.fromCharCode(65 + (i % 26)); }
// Split (or re-split) this phase's roster into N parallel pools. n<=1 collapses any
// existing pools back into a single flat group. Snake-distributes by current roster
// order (== seed order) so pools stay balanced, same idea as start.gg's own seeding.
function bbSplitIntoPools(n) {
  n = Math.max(1, Math.min(16, n || 1));
  bbCommitPool();
  const seen = new Set(); const allNames = [];
  (bbModel.pools && bbModel.pools.length ? bbModel.pools.flatMap((p) => p.roster || []) : bbModel.roster).forEach((nm) => {
    const t = (nm || '').trim(); if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); allNames.push(t); }
  });
  if (n <= 1) {
    bbModel.pools = []; bbActivePoolId = '';
    bbModel.roster = allNames; bbModel.size = allNames.length || bbModel.size;
    bbGenerate();
    bbRenderPools();
    return;
  }
  const buckets = Array.from({ length: n }, () => []);
  allNames.forEach((nm, i) => {
    const lap = Math.floor(i / n), pos = lap % 2 === 0 ? i % n : n - 1 - (i % n);
    buckets[pos].push(nm);
  });
  bbModel.pools = buckets.map((roster, i) => ({ id: 'pool' + (++_bbPoolSeq), name: bbPoolName(i), roster, rounds: [] }));
  bbModel.pools.forEach((p) => {
    bbModel.roster = p.roster; bbModel.rounds = []; bbModel.size = p.roster.length;
    bbGenerate();               // fills bbModel.rounds for this pool (also writes it back via bbCommitPool above)
    p.roster = bbModel.roster; p.rounds = bbModel.rounds;
  });
  bbLoadPool(bbModel.pools[0].id);
  bbRenderPools();
  bbRender();
  bbAutosave();
}
function bbRenderPools() {
  const wrap = el('bb-pools'); if (!wrap) return;
  const pools = bbModel.pools || [];
  if (!bbIsTable() || pools.length < 2) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = pools.map((p) =>
    `<div class="bb-phase-tab${p.id === bbActivePoolId ? ' active' : ''}" data-poolid="${p.id}" title="Double-click to rename">
       <span class="bb-phase-name">${(p.name || 'Pool').replace(/</g, '&lt;')}</span>
     </div>`).join('');
  wrap.querySelectorAll('.bb-phase-tab').forEach((t) => {
    t.addEventListener('click', () => { if (t.dataset.poolid !== bbActivePoolId) bbSelectPool(t.dataset.poolid); });
    t.addEventListener('dblclick', () => bbRenamePool(t.dataset.poolid));
  });
}
function bbSelectPool(id) { bbCommitPool(); bbLoadPool(id); bbRenderPools(); bbRender(); bbAutosave(); }
function bbRenamePool(id) {
  const p = (bbModel.pools || []).find((x) => x.id === id); if (!p) return;
  const name = prompt('Pool name:', p.name); if (name == null) return;
  p.name = name.trim() || p.name; bbRenderPools(); bbAutosave();
}
function bbTeamsDatalist() {
  const dl = el('bb-teams-datalist'); if (!dl) return;
  dl.innerHTML = allMatchTeams().map((t) => `<option value="${(t.name || '').replace(/"/g, '&quot;')}">`).join('');
}
function bbIsBye(name) { return /^bye$/i.test((name || '').trim()); }
function bbWinnerOf(set) {
  // Explicit winner mark (the W toggle) beats score inference — needed for forfeits / 0-0.
  if (set.a.win) return 'a';
  if (set.b.win) return 'b';
  // A BYE slot always loses.
  if (bbIsBye(set.a.name) && set.b.name) return 'b';
  if (bbIsBye(set.b.name) && set.a.name) return 'a';
  const a = Number(set.a.score) || 0, b = Number(set.b.score) || 0;
  if (a === b) return null;
  return a > b ? 'a' : 'b';
}
// Advance the winner of (section, roundIdx, setIdx) into the structurally next slot.
// Double elim also DROPS the loser into the right losers-bracket slot automatically:
//   WB round 1 losers  → LB round 1 (two per match), WB round k≥2 losers → LB round 2k-2
//   (the "minor" round, slot b — slot a belongs to the LB advancer).
function bbAdvance(section, ri, si) {
  const arr = bbModel[section];
  const set = arr[ri] && arr[ri].sets[si]; if (!set) return;
  const w = bbWinnerOf(set); if (!w) { bbStatus('Enter scores (or click W on the winner) first.', false); return; }
  const team = set[w];
  const loser = set[w === 'a' ? 'b' : 'a'];
  let target, slot;
  if (section === 'winners' && ri < arr.length - 1) { target = arr[ri + 1].sets[Math.floor(si / 2)]; slot = si % 2 === 0 ? 'a' : 'b'; }
  else if (section === 'winners' && bbModel.type === 'double') { target = bbModel.finals[0] && bbModel.finals[0].sets[0]; slot = 'a'; }
  else if (section === 'losers' && ri < arr.length - 1) {
    const next = arr[ri + 1];
    if (next.sets.length === arr[ri].sets.length) { target = next.sets[si]; slot = 'a'; }             // major → minor: same count, advancer takes slot a
    else { target = next.sets[Math.floor(si / 2)]; slot = si % 2 === 0 ? 'a' : 'b'; }                  // halving round
  }
  else if (section === 'losers') { target = bbModel.finals[0] && bbModel.finals[0].sets[0]; slot = 'b'; }
  let msg = 'Advanced ' + (team.name || 'winner') + '.';
  if (target) target[slot] = { name: team.name, score: 0 };
  // Auto-drop the WB loser into the losers bracket (double elim only, skip byes).
  if (section === 'winners' && bbModel.type === 'double' && loser && loser.name && !bbIsBye(loser.name)) {
    const lb = bbModel.losers || [];
    const lri = ri === 0 ? 0 : (2 * ri) - 1;
    const lRound = lb[lri];
    if (lRound) {
      let lTarget, lSlot;
      if (ri === 0) { lTarget = lRound.sets[Math.floor(si / 2)]; lSlot = si % 2 === 0 ? 'a' : 'b'; }
      else { lTarget = lRound.sets[si]; lSlot = 'b'; }
      if (lTarget && (!lTarget[lSlot] || !lTarget[lSlot].name)) {
        lTarget[lSlot] = { name: loser.name, score: 0 };
        msg = 'Advanced ' + (team.name || 'winner') + ' — ' + loser.name + ' dropped to ' + (lRound.name || 'losers') + '.';
      }
    }
  }
  if (target) { bbRender(); bbAutosave(); bbStatus(msg, true); }
}
function bbStatus(msg, ok) {
  const s = el('bb-status'); if (!s) return;
  s.textContent = msg || ''; s.style.color = ok === false ? '#f56565' : (ok ? 'var(--good, #48bb78)' : 'var(--muted)');
}
function bbSectionHtml(section, label) {
  const arr = bbModel[section];
  if (!arr || !arr.length) return '';
  const isTable = section === 'rounds';
  const secClass = section === 'losers' ? ' losers' : (section === 'finals' ? ' finals' : '');
  const cols = arr.map((round, ri) => {
    const sets = round.sets.map((set, si) => {
      const w = bbWinnerOf(set);
      const slot = (side) => {
        const bye = bbIsBye(set[side].name);
        return `<div class="bb-slot${w === side ? ' win' : ''}${bye ? ' bb-bye' : ''}">
          <button class="bb-win-btn${set[side].win ? ' on' : ''}" data-sec="${section}" data-r="${ri}" data-s="${si}" data-side="${side}" title="Mark this team as the winner (works for forfeits / no score)">W</button>
          <input class="input-text bb-name" list="bb-teams-datalist" data-sec="${section}" data-r="${ri}" data-s="${si}" data-side="${side}" value="${(set[side].name || '').replace(/"/g, '&quot;')}" placeholder="TBA">
          <input type="number" class="input-text bb-score" min="0" data-sec="${section}" data-r="${ri}" data-s="${si}" data-side="${side}" value="${set[side].score || 0}">
        </div>`;
      };
      return `<div class="bb-match">
        ${slot('a')}${slot('b')}
        <div class="bb-match-actions">
          ${isTable ? '' : `<button class="bb-adv" data-sec="${section}" data-r="${ri}" data-s="${si}" title="Advance the winner into the next round${bbModel.type === 'double' && section === 'winners' ? ' (loser auto-drops to the losers bracket)' : ''}">Advance <span aria-hidden="true">→</span></button>`}
          <button class="bb-live" data-sec="${section}" data-r="${ri}" data-s="${si}" title="Push this matchup live to the overlay (Blue vs Orange)">Go Live</button>
        </div>
      </div>`;
    }).join('');
    return `<div class="bb-round">
      <input class="bb-round-name" data-sec="${section}" data-r="${ri}" value="${(round.name || '').replace(/"/g, '&quot;')}">
      <div class="bb-round-sets">${sets}</div>
    </div>`;
  }).join('');
  return `<div class="bb-section${secClass}"><div class="bb-section-label">${label}</div><div class="bb-cols">${cols}</div></div>`;
}
function bbRenderRoster() {
  const wrap = el('bb-roster'); if (!wrap) return;
  if (!bbIsTable()) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const poolObj = bbActivePoolObj();
  const label = poolObj ? `${poolObj.name || 'Pool'} teams` : 'Tournament teams';
  wrap.innerHTML = '<div class="bb-roster-label">' + label.replace(/</g, '&lt;') + '</div><div class="bb-roster-grid">'
    + bbModel.roster.map((nm, i) => `<input class="input-text bb-roster-name" data-i="${i}" list="bb-teams-datalist" value="${(nm || '').replace(/"/g, '&quot;')}" placeholder="Team ${i + 1}">`).join('')
    + '</div>';
  wrap.querySelectorAll('.bb-roster-name').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel.roster[+inp.dataset.i] = inp.value.trim(); bbAutosave(); bbRenderStandings(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
}
function bbRenderStandings() {
  const wrap = el('bb-standings'); if (!wrap) return;
  if (!bbIsTable()) { wrap.style.display = 'none'; return; }
  const rows = bbComputeStandings();
  wrap.style.display = 'block';
  wrap.innerHTML = '<div class="bb-standings-label">Standings (auto from scores)</div>'
    + '<div class="bb-standings-table"><div class="bb-st-row bb-st-head"><span>#</span><span>Team</span><span>W</span><span>L</span></div>'
    + rows.map((s) => `<div class="bb-st-row"><span>${s.placement}</span><span class="bb-st-name">${(s.name || '').replace(/</g, '&lt;')}</span><span>${s.wins}</span><span>${s.losses}</span></div>`).join('')
    + '</div>';
}
function bbRender() {
  const board = el('bb-board'); if (!board) return;
  bbTeamsDatalist();
  bbRenderPhases();
  bbRenderPools();
  bbRenderRoster();
  const hasElim = bbModel.winners.length || bbModel.losers.length;
  const hasTable = bbModel.rounds.length;
  if (!hasElim && !hasTable) {
    board.innerHTML = '<div class="rp-empty">Pick a size + type and hit Generate to build a bracket.</div>';
    bbRenderStandings();
    return;
  }
  if (bbIsTable()) {
    board.innerHTML = bbSectionHtml('rounds', bbModel.type === 'swiss' ? 'Swiss Rounds' : 'Round-Robin Schedule');
  } else {
    // Double elim: offer a bracket-reset second Grand Final set (LB winner takes GF 1).
    const canReset = bbModel.type === 'double' && bbModel.finals.length === 1;
    board.innerHTML = bbSectionHtml('winners', bbModel.type === 'double' ? 'Winners Bracket' : 'Bracket')
      + bbSectionHtml('losers', 'Losers Bracket')
      + bbSectionHtml('finals', 'Grand Final')
      + (canReset ? '<button class="btn btn-ghost btn-xs" id="bb-gf-reset" title="Add a second Grand Final set for when the losers-bracket team wins the first one" style="margin:4px 0 0 8px;">+ Add reset set</button>' : '');
    if (canReset) board.querySelector('#bb-gf-reset')?.addEventListener('click', () => {
      bbModel.finals.push({ name: 'Grand Final (Reset)', sets: [{ a: { name: '', score: 0 }, b: { name: '', score: 0 } }] });
      bbRender(); bbAutosave();
    });
  }
  board.querySelectorAll('.bb-name').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel[inp.dataset.sec][inp.dataset.r].sets[inp.dataset.s][inp.dataset.side].name = inp.value.trim(); bbAutosave(); if (bbIsTable()) bbRenderStandings(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
  board.querySelectorAll('.bb-score').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel[inp.dataset.sec][inp.dataset.r].sets[inp.dataset.s][inp.dataset.side].score = Number(inp.value) || 0; bbRender(); bbAutosave(); });
  });
  board.querySelectorAll('.bb-round-name').forEach((inp) => {
    inp.addEventListener('change', () => { bbModel[inp.dataset.sec][inp.dataset.r].name = inp.value.trim(); bbAutosave(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
  board.querySelectorAll('.bb-adv').forEach((b) => b.addEventListener('click', () => bbAdvance(b.dataset.sec, +b.dataset.r, +b.dataset.s)));
  board.querySelectorAll('.bb-live').forEach((b) => b.addEventListener('click', () => bbPushMatch(b.dataset.sec, +b.dataset.r, +b.dataset.s)));
  board.querySelectorAll('.bb-win-btn').forEach((b) => b.addEventListener('click', () => {
    const set = bbModel[b.dataset.sec][+b.dataset.r].sets[+b.dataset.s];
    const side = b.dataset.side, other = side === 'a' ? 'b' : 'a';
    set[side].win = !set[side].win;
    if (set[side].win) set[other].win = false;
    bbRender(); bbAutosave();
    if (bbIsTable()) bbRenderStandings();
  }));
  bbRenderStandings();
}
// Push a bracket matchup live: load both teams (name + logo + roster) into Blue/Orange.
// The series only resets when the PAIR actually changes — re-clicking Go Live on the
// match that's already live must never wipe an in-progress series score.
function bbPushMatch(section, ri, si) {
  const set = bbModel[section] && bbModel[section][ri] && bbModel[section][ri].sets[si];
  if (!set) return;
  const a = (set.a.name || '').trim(), b = (set.b.name || '').trim();
  if (!a || !b) { bbStatus('Both slots need a team before going live.', false); return; }
  const ta = findTeam(a), tb = findTeam(b);
  send('set_team', { side: 'blue', name: a, logo: (ta && ta.logo) || null, color: (ta && ta.color) || undefined, players: (ta && ta.players) || [] });
  send('set_team', { side: 'orange', name: b, logo: (tb && tb.logo) || null, color: (tb && tb.color) || undefined, players: (tb && tb.players) || [] });
  const curA = (currentState?.teams?.blue?.name || '').trim().toUpperCase();
  const curB = (currentState?.teams?.orange?.name || '').trim().toUpperCase();
  const samePair = curA === a.toUpperCase() && curB === b.toUpperCase();
  if (!samePair) send('reset_series');
  bbStatus(`${a} vs ${b} pushed to the overlay${samePair ? ' (series score kept)' : ''}.`, true);
}
// Convert one phase → the overlay-ready shape (winners/losers/finals or standings).
function bbPhaseToPayload(ph) {
  const conv = (arr) => (arr || []).map((round, ri) => ({
    name: round.name, round: ri + 1,
    sets: round.sets.map((set) => {
      const w = bbWinnerOf(set);
      return {
        a: { name: set.a.name || 'TBD', score: Number(set.a.score) || 0, winner: w === 'a' },
        b: { name: set.b.name || 'TBD', score: Number(set.b.score) || 0, winner: w === 'b' }
      };
    })
  }));
  const TYPE = { single: 'SINGLE_ELIMINATION', double: 'DOUBLE_ELIMINATION', roundrobin: 'ROUND_ROBIN', swiss: 'SWISS' };
  const table = ph.type === 'roundrobin' || ph.type === 'swiss';
  const base = { id: ph.id, name: ph.name, type: TYPE[ph.type] || 'SINGLE_ELIMINATION' };
  if (table) {
    const matrix = ph.type === 'roundrobin' ? bbComputeMatrix(ph.rounds || [], ph.roster || []) : null;
    Object.assign(base, { winners: [], losers: [], finals: [], standings: bbComputeStandings(ph.rounds || [], ph.roster || []), schedule: ph.rounds || [], roster: ph.roster || [], matrix });
    const pools = Array.isArray(ph.pools) ? ph.pools : [];
    if (pools.length > 1) {
      base.pools = pools.map((p) => ({
        id: p.id, name: p.name, type: TYPE[ph.type] || 'ROUND_ROBIN',
        roster: p.roster || [], schedule: p.rounds || [],
        standings: bbComputeStandings(p.rounds || [], p.roster || []),
        matrix: ph.type === 'roundrobin' ? bbComputeMatrix(p.rounds || [], p.roster || []) : null
      }));
    }
  }
  else Object.assign(base, { winners: conv(ph.winners), losers: conv(ph.losers), finals: conv(ph.finals), standings: [], schedule: [], roster: [] });
  return base;
}
// Commit the live phase, then push ALL phases + the active id to the overlay.
function bbSendPhases(extra) {
  bbEnsurePhase(); bbCommit();
  const teams = allMatchTeams().filter((t) => t.logo).map((t) => ({ name: t.name, logo: t.logo }));
  send('set_bracket_phases', Object.assign({
    phases: bbPhases.map(bbPhaseToPayload),
    activePhaseId: bbActiveId,
    title: (currentState.bracket && currentState.bracket.title) || 'Bracket',
    teams
  }, extra || {}));
}
function bbAutosave() {
  if (!el('bb-autosave') || !el('bb-autosave').checked) return;
  clearTimeout(_bbSaveTimer);
  _bbSaveTimer = setTimeout(() => bbSendPhases(), 500);
}
// ── Phase tabs (Day 1 / Day 2 …) ──────────────────────────────────────────
function bbRenderPhases() {
  const wrap = el('bb-phases'); if (!wrap) return;
  if (!bbPhases.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = bbPhases.map((p) =>
    `<div class="bb-phase-tab${p.id === bbActiveId ? ' active' : ''}" data-pid="${p.id}" title="Double-click to rename">
       <span class="bb-phase-name">${(p.name || 'Phase').replace(/</g, '&lt;')}</span>
       ${bbPhases.length > 1 ? `<button class="bb-phase-del" data-del="${p.id}" title="Delete phase">×</button>` : ''}
     </div>`).join('') + '<button class="bb-phase-add" id="bb-phase-add" title="Add a phase (e.g. Day 2)">+ Phase</button>';
  wrap.querySelectorAll('.bb-phase-tab').forEach((t) => {
    t.addEventListener('click', (e) => { if (e.target.closest('.bb-phase-del')) return; if (t.dataset.pid !== bbActiveId) bbSelectPhase(t.dataset.pid); });
    t.addEventListener('dblclick', () => bbRenamePhase(t.dataset.pid));
  });
  wrap.querySelectorAll('.bb-phase-del').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); bbDeletePhase(b.dataset.del); }));
  el('bb-phase-add')?.addEventListener('click', bbAddPhase);
}
function bbSelectPhase(id) { bbCommit(); bbLoadPhase(id); bbRenderPhases(); bbAutosave(); }
function bbAddPhase() {
  bbCommit();
  const p = bbNewPhase('Phase ' + (bbPhases.length + 1), 'single');
  bbPhases.push(p);
  bbLoadPhase(p.id); bbRenderPhases(); bbSendPhases();
}
function bbRenamePhase(id) {
  const ph = bbPhases.find((x) => x.id === id); if (!ph) return;
  const name = prompt('Phase name:', ph.name); if (name == null) return;
  ph.name = name.trim() || ph.name; bbRenderPhases(); bbSendPhases();
}
async function bbDeletePhase(id) {
  if (bbPhases.length <= 1) return;
  if (!await appConfirm('Delete this phase?', 'Delete')) return;
  bbPhases = bbPhases.filter((x) => x.id !== id);
  if (bbActiveId === id) { bbActiveId = bbPhases[0].id; bbLoadPhase(bbActiveId); }
  bbRenderPhases(); bbSendPhases();
}
function bbSyncTypeUi() {
  document.querySelectorAll('.bb-rounds-field').forEach((e) => { e.style.display = bbModel.type === 'swiss' ? '' : 'none'; });
  document.querySelectorAll('.bb-swiss-only').forEach((e) => { e.style.display = bbModel.type === 'swiss' ? '' : 'none'; });
  document.querySelectorAll('.bb-table-only').forEach((e) => { e.style.display = bbIsTable() ? '' : 'none'; });
}
// Seed empty slots from the saved/seeded team list.
function bbSeedTeams() {
  const names = allMatchTeams().map((t) => t.name).filter(Boolean);
  if (!names.length) { bbStatus('No saved teams to seed from.', false); return; }
  if (bbIsTable()) {
    for (let i = 0; i < bbModel.roster.length; i++) if (!bbModel.roster[i]) bbModel.roster[i] = names[i] || '';
    if (bbModel.type === 'roundrobin') bbGenerate();        // reflow the schedule with seeded names
    else { (bbModel.rounds[0]?.sets || []).forEach((set, mi) => { if (!set.a.name) set.a.name = bbModel.roster[mi * 2] || ''; if (!set.b.name) set.b.name = bbModel.roster[mi * 2 + 1] || ''; }); bbRender(); bbAutosave(); }
  } else if (bbModel.winners[0]) {
    let k = 0;
    bbModel.winners[0].sets.forEach((set) => { if (!set.a.name) set.a.name = names[k++] || ''; if (!set.b.name) set.b.name = names[k++] || ''; });
    bbRender(); bbAutosave();
  }
  bbStatus('Seeded from team list.', true);
}
// Swiss: fill empty matches by pairing teams in current-standings order.
function bbSwissPair() {
  const standings = bbComputeStandings().map((s) => s.name);
  const pool = standings.length ? standings : bbModel.roster.filter(Boolean);
  bbModel.rounds.forEach((round) => {
    const used = new Set();
    round.sets.forEach((set) => { if (set.a.name) used.add(set.a.name); if (set.b.name) used.add(set.b.name); });
    const avail = pool.filter((n) => !used.has(n));
    round.sets.forEach((set) => {
      if (!set.a.name && avail.length) set.a.name = avail.shift();
      if (!set.b.name && avail.length) set.b.name = avail.shift();
    });
  });
  bbRender(); bbAutosave(); bbStatus('Paired empty Swiss matches by standings.', true);
}
el('bb-type-seg') && el('bb-type-seg').querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', function () {
  el('bb-type-seg').querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('active'));
  this.classList.add('active'); bbModel.type = this.dataset.type;
  if (!bbIsTable()) { bbModel.pools = []; bbActivePoolId = ''; }   // pools only apply to Round Robin / Swiss
  bbSyncTypeUi();
  bbRenderPools();
}));
el('bb-size')?.addEventListener('change', function () { bbModel.size = Number(this.value) || 8; });
el('bb-rounds-num')?.addEventListener('change', function () { bbModel.swissRounds = Math.max(1, Math.min(12, Number(this.value) || 5)); });
el('bb-seed')?.addEventListener('click', bbSeedTeams);
el('bb-swiss-pair')?.addEventListener('click', bbSwissPair);
el('bb-generate')?.addEventListener('click', bbGenerate);
el('bb-pool-split')?.addEventListener('click', () => {
  const n = Math.max(1, Math.min(16, Number(el('bb-pool-count')?.value) || 1));
  bbSplitIntoPools(n);
});
el('bb-save')?.addEventListener('click', () => { bbSendPhases(); bbStatus('Bracket saved & pushed.', true); });
el('bb-clear')?.addEventListener('click', async () => {
  if (!await appConfirm('Clear this phase?', 'Clear')) return;
  bbModel.winners = []; bbModel.losers = []; bbModel.finals = []; bbModel.rounds = []; bbModel.roster = []; bbModel.pools = []; bbActivePoolId = '';
  bbRenderPools();
  bbRender(); bbSendPhases({ visible: false });
});

// One overlay phase → a builder phase (editable fields).
function bbPhaseFromOverlay(op) {
  const TYPE = { SINGLE_ELIMINATION: 'single', DOUBLE_ELIMINATION: 'double', ROUND_ROBIN: 'roundrobin', SWISS: 'swiss' };
  const fromOverlay = (arr) => (arr || []).map((round) => ({
    name: round.name || '',
    sets: (round.sets || []).map((s) => {
      const out = {
        a: { name: s.a && s.a.name === 'TBD' ? '' : ((s.a && s.a.name) || ''), score: (s.a && s.a.score) || 0 },
        b: { name: s.b && s.b.name === 'TBD' ? '' : ((s.b && s.b.name) || ''), score: (s.b && s.b.score) || 0 }
      };
      // Preserve an explicit winner mark that score inference couldn't reproduce (forfeit / 0-0).
      const sa = Number(out.a.score) || 0, sb = Number(out.b.score) || 0;
      if (s.a && s.a.winner && !(sa > sb)) out.a.win = true;
      if (s.b && s.b.winner && !(sb > sa)) out.b.win = true;
      return out;
    })
  }));
  const type = TYPE[op.type] || ((op.standings && op.standings.length) ? 'roundrobin' : 'single');
  const ph = bbNewPhase(op.name || 'Bracket', type);
  if (op.id) ph.id = op.id;
  if (type === 'roundrobin' || type === 'swiss') {
    ph.roster = Array.isArray(op.roster) && op.roster.length ? op.roster.slice() : (op.standings || []).map((s) => s.name).filter(Boolean);
    ph.rounds = Array.isArray(op.schedule) ? op.schedule : [];
    ph.size = ph.roster.length || 8;
    if (Array.isArray(op.pools) && op.pools.length > 1) {
      ph.pools = op.pools.map((p, i) => ({
        id: p.id || ('pool' + i),
        name: p.name || bbPoolName(i),
        roster: Array.isArray(p.roster) ? p.roster.slice() : [],
        rounds: Array.isArray(p.schedule) ? p.schedule : []
      }));
      ph.activePoolId = ph.pools[0].id;
    }
  } else {
    ph.winners = fromOverlay(op.winners); ph.losers = fromOverlay(op.losers); ph.finals = fromOverlay(op.finals);
  }
  return ph;
}
// Hydrate the builder from a saved/imported bracket (once). Handles phases + legacy flat.
// IMPORTANT: only hydrate from a MANUAL bracket. If the current bracket was imported
// (start.gg / Challonge / NXGEN), the builder stays empty so an accidental edit can't
// autosave over — and silently disconnect — the live import. To hand-edit an import, the
// producer uses the explicit "Edit as custom" action (which copies it into manual mode).
function bbHydrate(bracket) {
  if (_bbHydrated || !bracket) return;
  if (bracket.mode === 'imported') { _bbHydrated = true; return; }
  const phases = Array.isArray(bracket.phases) ? bracket.phases : [];
  const hasFlat = (bracket.winners && bracket.winners.length) || (bracket.standings && bracket.standings.length);
  if (phases.length) {
    bbPhases = phases.map(bbPhaseFromOverlay);
    _bbPhaseSeq = bbPhases.length;
    bbActiveId = phases.some((p) => p.id === bracket.activePhaseId) ? bracket.activePhaseId : bbPhases[0].id;
    bbLoadPhase(bbActiveId);
    bbRenderPhases();
  } else if (hasFlat) {
    bbPhases = [bbPhaseFromOverlay(bracket)];
    bbActiveId = bbPhases[0].id; _bbPhaseSeq = 1;
    bbLoadPhase(bbActiveId);
    bbRenderPhases();
  }
  _bbHydrated = true;
}

