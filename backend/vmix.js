// backend/vmix.js — minimal vMix HTTP Web API client (control + state poll).
//
// vMix exposes a local HTTP API (default :8088):
//   • GET /api/                                  → full XML state
//   • GET /api/?Function=X&Input=Y&Value=Z&...   → run a function
// No websocket / SDK needed — plain axios (already a dependency). vMix is the FULL ALTERNATIVE
// to OBS (either/or, never both) — see docs/vmix-integration.md.
const axios = require('axios');

function baseUrl(host, port) {
  const h = (host || '127.0.0.1').toString().trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `http://${h}:${port || 8088}`;
}

// Run a vMix Function. params keys map straight to query params (Input, Value, Duration,
// SelectedName, Mix, ...). Empty/undefined params are dropped. Returns the raw response body.
async function vmixCall(host, port, fn, params = {}) {
  const query = { Function: fn, ...params };
  Object.keys(query).forEach((k) => {
    if (query[k] === undefined || query[k] === null || query[k] === '') delete query[k];
  });
  const res = await axios.get(baseUrl(host, port) + '/api/', { params: query, timeout: 4000, responseType: 'text', transformResponse: [(d) => d] });
  return res.data;
}

function _attr(tag, name) { const m = tag.match(new RegExp(name + '="([^"]*)"')); return m ? m[1] : ''; }
function _tag(xml, name) { const m = xml.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>')); return m ? m[1].trim() : ''; }
function _bool(v) { return String(v).toLowerCase() === 'true'; }
function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// Fetch + parse the vMix XML state into a compact, control-panel-friendly object.
// Throws on connection failure (caller marks disconnected).
async function vmixState(host, port) {
  const res = await axios.get(baseUrl(host, port) + '/api/', { timeout: 4000, responseType: 'text', transformResponse: [(d) => d] });
  const xml = String(res.data || '');

  const inputs = [];
  const inBlock = xml.match(/<inputs>([\s\S]*?)<\/inputs>/);
  if (inBlock) {
    const re = /<input\b([^>]*?)(?:\/>|>([\s\S]*?)<\/input>)/g;
    let m;
    while ((m = re.exec(inBlock[1]))) {
      const attrs = m[1] || '';
      const vol = _attr(attrs, 'volume');
      inputs.push({
        number: _num(_attr(attrs, 'number')),
        key: _attr(attrs, 'key'),
        type: _attr(attrs, 'type'),
        title: _attr(attrs, 'title') || (m[2] || '').trim(),
        state: _attr(attrs, 'state'),
        // Audio (present on inputs with an audio track) — for the mixer + live VU meters.
        volume: vol === '' ? null : Number(vol),   // 0-100
        muted: _bool(_attr(attrs, 'muted')),
        solo: _bool(_attr(attrs, 'solo')),
        meterF1: (() => { const m = _attr(attrs, 'meterF1'); return m === '' ? null : Number(m); })(),   // live level 0-1 (L)
        meterF2: (() => { const m = _attr(attrs, 'meterF2'); return m === '' ? null : Number(m); })(),   // live level 0-1 (R)
        audio: _attr(attrs, 'audiobusses') !== '' || vol !== '',   // has an audio track
      });
    }
  }

  const overlays = [];
  const ovBlock = xml.match(/<overlays>([\s\S]*?)<\/overlays>/);
  if (ovBlock) {
    const re = /<overlay\b([^>]*?)(?:\/>|>([\s\S]*?)<\/overlay>)/g;
    let m;
    while ((m = re.exec(ovBlock[1]))) {
      const input = (m[2] || '').trim();
      overlays.push({ number: _num(_attr(m[1] || '', 'number')), input: input ? _num(input) : null });
    }
  }

  return {
    connected: true,
    version: _tag(xml, 'version'),
    edition: _tag(xml, 'edition'),
    active: _num(_tag(xml, 'active')),      // program input number
    preview: _num(_tag(xml, 'preview')),    // preview input number
    recording: _bool(_tag(xml, 'recording')),
    streaming: _bool(_tag(xml, 'streaming')),
    external: _bool(_tag(xml, 'external')),
    fullscreen: _bool(_tag(xml, 'fullscreen')),
    multiCorder: _bool(_tag(xml, 'multiCorder')),
    inputs,
    overlays,
  };
}

module.exports = { baseUrl, vmixCall, vmixState };
