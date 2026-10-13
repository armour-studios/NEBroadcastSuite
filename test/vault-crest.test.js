// A crest change must reach EVERY copy of a team's crest, or the stale copy puts the old one back.
// Producers saw logos "revert": a vault edit left the library holding the old crest, and the next
// save_team (even a favourite toggle) wrote it back into the vault and re-pinned it.
// Drives the REAL propagateVaultCrest out of server.js (pulled out by source, so the test can't
// drift from the shipped function) and the REAL team-db module against a throwaway data dir.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const teamDb = require('../backend/team-db.js');

const src = require('./lib/server-source').serverSource();
const start = src.indexOf('function propagateVaultCrest');
assert.ok(start > 0, 'propagateVaultCrest not found in server.js');
const end = src.indexOf('\n}', start) + 2;
// Split-out code reads some values as ctx.<name> (live getters): give it a ctx of the same stand-ins.
const make = (savedTeams, state, teamDb) => new Function('savedTeams', 'state', 'teamDb', 'ctx', src.slice(start, end) + ' return propagateVaultCrest;')(savedTeams, state, teamDb, { savedTeams, state });

const OLD = 'data:image/png;base64,OLD', NEW = 'data:image/png;base64,NEW';

function world() {
  const savedTeams = [
    { name: 'Agency', logo: OLD, vaultId: 'tm1' },
    { name: 'Agency Esports', logo: OLD },            // an old name, known to the vault as an alias
    { name: 'Tarnished', logo: 'data:image/png;base64,TARN' },
  ];
  const state = {
    startgg: {
      eventTeams: [{ name: 'Agency', logo: OLD, vaultId: 'tm1' }, { name: 'Tarnished', logo: 'data:image/png;base64,TARN' }],
      logoMap: { agency: OLD, tarnished: 'data:image/png;base64,TARN' },
    },
    teams: { blue: { name: 'AGENCY', logo: OLD }, orange: { name: 'TARNISHED', logo: 'data:image/png;base64,TARN' } },
  };
  return { savedTeams, state, propagate: make(savedTeams, state, teamDb) };
}
const rec = (logo) => ({ id: 'tm1', name: 'Agency', logo, aliases: [teamDb.norm('Agency Esports')] });

// 1. A new crest reaches the library (by vault id AND by alias), event teams, logo map, and air.
{
  const w = world();
  assert.strictEqual(w.propagate(rec(NEW)), true, 'library changed, so the caller must saveTeams()');
  assert.strictEqual(w.savedTeams[0].logo, NEW, 'library row linked by vaultId');
  assert.strictEqual(w.savedTeams[1].logo, NEW, 'library row under an old name the vault aliases');
  assert.strictEqual(w.savedTeams[1].vaultId, 'tm1', 'alias row is linked so the next edit finds it by id');
  assert.strictEqual(w.state.startgg.eventTeams[0].logo, NEW, 'event-teams snapshot - the push path reads this first');
  assert.strictEqual(w.state.startgg.logoMap.agency, NEW, 'queue/bracket name->logo map');
  assert.strictEqual(w.state.teams.blue.logo, NEW, 'the side on air (names are uppercased there)');
  assert.strictEqual(w.savedTeams[2].logo, 'data:image/png;base64,TARN', 'an unrelated team is untouched');
  assert.strictEqual(w.state.teams.orange.logo, 'data:image/png;base64,TARN', 'the other side is untouched');
}

// 2. A REMOVED crest is mirrored too - a leftover copy anywhere would bring it back.
{
  const w = world();
  w.propagate(rec(null));
  assert.strictEqual(w.savedTeams[0].logo, null);
  assert.strictEqual(w.state.startgg.eventTeams[0].logo, null);
  assert.ok(!('agency' in w.state.startgg.logoMap), 'map entry dropped, not left pointing at the old crest');
  assert.strictEqual(w.state.teams.blue.logo, null);
}

// 3. Nothing to change reports no library write.
{
  const w = world();
  w.propagate(rec(NEW));
  assert.strictEqual(w.propagate(rec(NEW)), false, 'second identical propagate is a no-op');
}

// 4. The vault side of the revert: a save that did not change the crest must not overwrite it.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-crest-'));
  teamDb.init(dir);
  const players = [{ name: 'Morris', platform: 'startgg', platformId: 'p1' }];
  const r = teamDb.upsertFromLibrary({ name: 'Agency', logo: OLD, players }, { source: 'library' });
  teamDb.update(r.id, { logo: NEW });                                            // edited in the Vault card
  // save_team now passes logo: undefined when THIS save didn't change it (a favourite toggle).
  teamDb.upsertFromLibrary({ name: 'Agency', logo: undefined, players, favorite: true }, { source: 'library' });
  assert.strictEqual(teamDb.get(r.id).logo, NEW, 'an unchanged save leaves the newer vault crest alone');
  assert.strictEqual(teamDb.get(r.id).pins.logo, true, 'and it stays pinned against start.gg');
  // A genuine removal still gets through, and the old crest stays recoverable.
  teamDb.upsertFromLibrary({ name: 'Agency', logo: null, players }, { source: 'library', clearLogo: true });
  assert.strictEqual(teamDb.get(r.id).logo, null);
  assert.strictEqual(teamDb.get(r.id).pins.logo, false);
  assert.ok((teamDb.get(r.id).brandHistory || []).some((h) => h.logo === NEW), 'removed crest kept in brand history');
  teamDb.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('vault-crest: all assertions passed');
