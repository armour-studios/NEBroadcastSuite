/* ─── Standalone bracket scene — connects to the WS bridge on :3001 ───────── */

const WS_URL = 'ws://localhost:3001';

let ws;
let _lastBracketSig = '';
let logoByName = {};   // lowercased team name -> logo URL/data, from savedTeams

function el(id) { return document.getElementById(id); }

function buildSlot(slot) {
  const s = slot || { name: 'TBD', score: null, winner: false };
  const known = s.name && s.name !== 'TBD';
  const row = document.createElement('div');
  row.className = 'bracket-slot' + (s.winner ? ' winner' : (known ? ' loser' : ''));

  const logo = known ? logoByName[s.name.toLowerCase()] : null;
  if (logo) {
    const img = document.createElement('img');
    img.className = 'bracket-slot-logo';
    img.src = logo;
    row.appendChild(img);
  }

  const name = document.createElement('div');
  name.className = 'bracket-slot-name';
  name.textContent = s.name || 'TBD';

  const score = document.createElement('div');
  score.className = 'bracket-slot-score';
  score.textContent = (s.score === null || s.score === undefined) ? '–' : s.score;

  row.appendChild(name);
  row.appendChild(score);
  return row;
}

function buildColumn(round) {
  const col = document.createElement('div');
  col.className = 'bracket-round';

  const name = document.createElement('div');
  name.className = 'bracket-round-name';
  name.textContent = round.name || '';
  col.appendChild(name);

  const matches = document.createElement('div');
  matches.className = 'bracket-round-matches';
  (round.sets || []).forEach((set) => {
    const match = document.createElement('div');
    match.className = 'bracket-match';
    match.appendChild(buildSlot(set.a));
    match.appendChild(buildSlot(set.b));
    matches.appendChild(match);
  });
  col.appendChild(matches);
  return col;
}

// A horizontal band of round columns with an optional section label.
function buildSection(label, rounds) {
  const section = document.createElement('div');
  section.className = 'bracket-section';

  if (label) {
    const lbl = document.createElement('div');
    lbl.className = 'bracket-section-label';
    lbl.textContent = label;
    section.appendChild(lbl);
  }

  const row = document.createElement('div');
  row.className = 'bracket-rounds';
  rounds.forEach((r) => row.appendChild(buildColumn(r)));
  section.appendChild(row);
  return section;
}

// Round-robin / swiss standings table.
function buildStandings(standings) {
  const wrap = document.createElement('div');
  wrap.className = 'bracket-standings';

  const head = document.createElement('div');
  head.className = 'standings-row standings-head';
  head.innerHTML = '<div class="st-rank">#</div><div class="st-name">Team</div><div class="st-rec">W</div><div class="st-rec">L</div>';
  wrap.appendChild(head);

  standings.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'standings-row';
    const rank = document.createElement('div'); rank.className = 'st-rank'; rank.textContent = s.placement;
    const name = document.createElement('div'); name.className = 'st-name'; name.textContent = s.name;
    const w = document.createElement('div'); w.className = 'st-rec st-win'; w.textContent = s.wins;
    const l = document.createElement('div'); l.className = 'st-rec st-loss'; l.textContent = s.losses;
    row.appendChild(rank); row.appendChild(name); row.appendChild(w); row.appendChild(l);
    wrap.appendChild(row);
  });
  return wrap;
}

function renderBracket(bracket) {
  const stage   = el('bracket-stage');
  const titleEl = el('bracket-title');
  const bodyEl  = el('bracket-body');
  const emptyEl = el('bracket-empty');
  if (!stage || !bodyEl) return;

  const b = bracket || {};
  const winners = b.winners || [];
  const losers = b.losers || [];
  const finals = b.finals || [];
  const standings = b.standings || [];
  const phases = b.phases || [];
  const activePhaseId = b.activePhaseId || '';
  const visible = !!b.visible;

  // Fade the whole scene (used by the "Show Bracket" toggle)
  stage.classList.toggle('show', visible);

  // Rebuild when bracket data OR the matched logos change
  const sig = JSON.stringify({ t: b.title, ty: b.type, winners, losers, finals, standings, ph: phases.map((p) => p.id + ':' + p.name), ap: activePhaseId, logos: logoByName });
  if (sig === _lastBracketSig) return;
  _lastBracketSig = sig;

  const isElim = winners.length > 0 || losers.length > 0 || finals.length > 0;
  const hasData = isElim || standings.length > 0;

  if (titleEl) {
    titleEl.textContent = (b.title || '').toUpperCase();
    titleEl.classList.toggle('hidden', !hasData);
  }
  if (emptyEl) emptyEl.classList.toggle('hidden', hasData);

  bodyEl.innerHTML = '';
  // Phase strip — only when an event actually has more than one phase.
  if (phases.length > 1) {
    const strip = document.createElement('div');
    strip.className = 'bracket-phases';
    phases.forEach((p) => {
      const tab = document.createElement('div');
      tab.className = 'bracket-phase' + (p.id === activePhaseId ? ' active' : '');
      tab.textContent = p.name || 'Phase';
      strip.appendChild(tab);
    });
    bodyEl.appendChild(strip);
  }
  if (isElim) {
    const isDouble = losers.length > 0;
    // Winners path with the grand final appended so it reads left-to-right.
    const winnerCols = winners.concat(finals);
    bodyEl.appendChild(buildSection(isDouble ? 'Winners Bracket' : '', winnerCols));
    if (isDouble) bodyEl.appendChild(buildSection('Losers Bracket', losers));
  } else if (standings.length) {
    bodyEl.appendChild(buildStandings(standings));
  }
}

function applyFullState(data) {
  if (data.fontFamily) {
    document.documentElement.style.setProperty('--main-font', `'${data.fontFamily}', sans-serif`);
  }
  document.documentElement.dataset.theme = data.theme || 'default';
  // Map team logos by name so bracket cards can show them
  logoByName = {};
  (data.savedTeams || []).forEach((t) => {
    if (t && t.name && t.logo) logoByName[t.name.toLowerCase()] = t.logo;
  });
  renderBracket(data.bracket);
}

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'request_state' }));

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'full_state') applyFullState(msg.data);
  };

  ws.onclose = () => setTimeout(connect, 3000);
}

connect();
