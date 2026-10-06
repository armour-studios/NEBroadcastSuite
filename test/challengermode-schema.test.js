/*
  Validate our Challengermode GraphQL documents against Challengermode's OWN published schema.

  This is the check that a REST integration doesn't get. A mistyped field in a GraphQL query is not
  a 404 — the server answers HTTP 200 with an `errors` array, and if a caller only looks at the
  status code it reads as "the tournament has no rounds". Validating locally turns that into a
  build-time failure instead of an empty bracket on air.

  The fixture is the real SDL, fetched from the documented endpoint:
      curl https://publicapi.challengermode.com/graphql?sdl -o test/fixtures/challengermode-schema.graphql
  Refresh it when Challengermode ships schema changes. A field they REMOVE will fail here first,
  which is exactly the warning we want.
*/
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSchema, parse, validate } = require('graphql');

const sdlPath = path.join(__dirname, 'fixtures', 'challengermode-schema.graphql');
const schema = buildSchema(fs.readFileSync(sdlPath, 'utf8'));
const cm = require('../backend/challengermode');

let failed = 0;
['TOURNAMENT_QUERY', 'TOURNAMENT_LIVE_QUERY', 'SEARCH_QUERY', 'SPACE_QUERY'].forEach((name) => {
  const doc = cm[name];
  assert.ok(typeof doc === 'string' && doc.trim(), name + ' is missing');
  const errs = validate(schema, parse(doc));
  if (errs.length) {
    failed++;
    console.log('FAIL  ' + name);
    errs.slice(0, 8).forEach((e) => console.log('        ' + e.message));
  } else {
    console.log('PASS  ' + name + ' validates against the published schema');
  }
});

// The fields the mapping actually reads have to exist, not just parse. These are the ones whose
// absence would silently empty a graphic rather than throw.
const q = cm.TOURNAMENT_QUERY;
[
  ['placement { bestPlacement worstPlacement displayPlacement }', 'placement RANGE — the top-8 board prints displayPlacement'],
  ['lineupResults { lineupNumber score placement final }', 'lineupNumber — which side a score belongs to'],
  ['brackets', 'elimination brackets'],
  ['labels', 'TournamentNodeLabel — upper/lower/grand-final'],
  ['gameTitle { id slug title }', 'the game, which drives the overlay switch']
].forEach(([needle, why]) => {
  if (q.indexOf(needle) < 0) { failed++; console.log('FAIL  query no longer asks for: ' + needle + '  (' + why + ')'); }
  else console.log('PASS  query asks for ' + needle.split(' ')[0] + ' — ' + why);
});

assert.strictEqual(failed, 0, failed + ' problem(s)');
console.log('\nall passed');
