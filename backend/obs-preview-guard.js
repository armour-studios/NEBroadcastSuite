// Keeps sample data out of OBS.
//
// ?preview=1 renders an overlay with fabricated teams/scores so a producer can look at it in a
// browser. The Scenes page opens that URL in the system browser when a thumbnail is clicked, and the
// address bar is then the most natural thing to paste into an OBS Browser Source — so real shows ended
// up with the preview URL on nearly every source: a "PREVIEW — SAMPLE DATA" badge on air, striped CAM
// placeholders painted over the camera holes, and demo rows wherever live data was empty.
//
// A source already saved in OBS cannot be fixed from our side, so the request is: OBS's embedded
// browser identifies itself ("... OBS/31.0.0" in the User-Agent), and for those requests the server
// redirects to the same URL without the preview params. Done here, once, because some twenty overlays
// parse ?preview themselves and never load scene-base.js.
//
// Deliberate sample data inside OBS (positioning a graphic before any data exists) is still
// available by adding &inobs=1.
'use strict';

const STRIP = new Set(['preview', 'thumb']);

function isObsBrowser(userAgent) {
  return /\bOBS\/\d/.test(String(userAgent || ''));
}

/** Returns the URL to redirect to, or null when the request should be served as-is.
    The query string is filtered textually, not re-serialised, so every other param (VDO flags,
    encoded stream names) reaches the overlay byte-for-byte. */
function obsPreviewRedirect(originalUrl, userAgent) {
  if (!isObsBrowser(userAgent)) return null;
  const url = String(originalUrl || '');
  const q = url.indexOf('?');
  if (q < 0) return null;
  const hashAt = url.indexOf('#', q);
  const query = hashAt < 0 ? url.slice(q + 1) : url.slice(q + 1, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const parts = query.split('&').filter(Boolean);
  const key = (p) => p.split('=')[0].toLowerCase();
  if (!parts.some((p) => key(p) === 'preview')) return null;
  if (parts.some((p) => p.toLowerCase() === 'inobs=1')) return null;
  const kept = parts.filter((p) => !STRIP.has(key(p)));
  return url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '') + hash;
}

module.exports = { isObsBrowser, obsPreviewRedirect };
