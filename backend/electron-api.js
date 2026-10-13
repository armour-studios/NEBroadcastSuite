'use strict';
// The ONLY way server.js and its modules reach Electron. Same shape in every process:
//   main     (NE_SERVER_IN_MAIN=1, the e2e/test runners): the real APIs via backend/host-services.js
//   utility  (normal app run, server in its own process): answered by the main process over
//            backend/server-link.js; synchronous reads come from values main pushed earlier
//   node     (plain-node unit tests): nothing Electron-backed is available
//
//   dialog.showOpenDialog / showSaveDialog (async) · dialog.showErrorBox
//   shell.openExternal / showItemInFolder / openPath
//   app.getPath / isPackaged / getVersion / quit
//   powerMonitor.getSystemIdleTime
//   secrets.encrypt(plain) -> stored · secrets.decrypt(stored) -> plain
//   renderThumb({ url, width, waitMs }) -> PNG Buffer
//   screenCapture.available() / listDisplays() / captureDisplay(id) / frameToJpegDataUrl(frame)
const mode = process.type === 'browser' ? 'main' : (process.type === 'utility' && process.parentPort) ? 'utility' : 'node';

function forMain() {
  const h = require('./host-services');
  return {
    mode,
    dialog: h.dialog,
    shell: h.shell,
    app: h.app,
    powerMonitor: { getSystemIdleTime: h.idleSeconds },
    secrets: { encrypt: h.encryptSecret, decrypt: h.decryptSecret },
    renderThumb: h.renderThumb,
    screenCapture: { available: () => true, listDisplays: h.listDisplays, captureDisplay: h.captureDisplay, frameToJpegDataUrl: async (f, w, q) => h.frameToJpegDataUrl(f, w, q) }
  };
}

function forUtility() {
  const link = require('./server-link');
  const { aesEncrypt, aesDecrypt } = require('./secret-aes');
  const info = () => link.info || {};

  // ── Secrets ──
  // 'enc:' values (keychain) were decrypted by main before the server loaded (prefetchSecrets);
  // new secrets are written as 'enc2:' straight away, then swapped for keychain ciphertext as
  // soon as main returns it, so the files stay readable by older versions of the app.
  const plainOf = new Map();    // 'enc:...' -> plain
  const storedOf = new Map();   // plain -> 'enc:...'
  const remember = (stored, plain) => { plainOf.set(stored, plain); if (!storedOf.has(plain)) storedOf.set(plain, stored); };
  let key = null;
  const dataKey = () => key || (info().dataKey ? (key = Buffer.from(info().dataKey, 'hex')) : null);
  const converting = new Set();
  let settleTimer = null;
  function toKeychain(plain) {
    if (converting.has(plain)) return;
    converting.add(plain);
    link.rpc('secrets.encrypt', plain).then((stored) => {
      if (stored && String(stored).startsWith('enc:')) {
        remember(stored, plain);
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => link.emit('secrets-settled'), 250);
      }
    }).catch((e) => console.warn('[secrets] keychain encrypt failed:', e.message)).finally(() => converting.delete(plain));
  }
  const secrets = {
    prefetched(map) { for (const [stored, plain] of Object.entries(map || {})) if (plain != null) remember(stored, plain); },
    encrypt(plain) {
      if (!plain) return '';
      plain = String(plain);
      if (!info().keychain) return plain;
      const known = storedOf.get(plain);
      if (known) return known;
      const k = dataKey();
      toKeychain(plain);
      return k ? aesEncrypt(k, plain) : plain;
    },
    decrypt(stored) {
      if (!stored || typeof stored !== 'string') return '';
      if (stored.startsWith('enc:')) {
        if (plainOf.has(stored)) return plainOf.get(stored);
        console.warn('[secrets] a keychain secret arrived after startup and could not be read synchronously');
        return '';
      }
      if (stored.startsWith('enc2:')) {
        const k = dataKey();
        try { return k ? aesDecrypt(k, stored) : ''; } catch (e) { console.warn('[secrets] failed to decrypt a stored secret:', e.message); return ''; }
      }
      return stored;
    }
  };

  return {
    mode,
    link,
    dialog: {
      showOpenDialog: (opts) => link.rpc('dialog.showOpenDialog', opts),
      showSaveDialog: (opts) => link.rpc('dialog.showSaveDialog', opts),
      showMessageBox: (opts) => link.rpc('dialog.showMessageBox', opts),
      showErrorBox: (title, content) => link.fire('dialog.showErrorBox', title, content)
    },
    shell: {
      // Callers fire and forget (steam:// with no Steam installed rejects): log, never reject.
      openExternal: (url) => link.rpc('shell.openExternal', url).catch((e) => { console.warn('[shell] openExternal:', e.message); }),
      openPath: (p) => link.rpc('shell.openPath', p),
      showItemInFolder: (p) => link.fire('shell.showItemInFolder', p)
    },
    app: {
      get isPackaged() { return !!info().isPackaged; },
      getVersion: () => info().version || '',
      getName: () => info().name || '',
      getAppPath: () => info().appPath || '',
      getPath(name) {
        const p = (info().paths || {})[name];
        if (!p) throw new Error('app.getPath: unknown path ' + name);
        return p;
      },
      isReady: () => true,
      quit: () => link.fire('app.quit')
    },
    powerMonitor: { getSystemIdleTime: () => Number(link.cache.idle) || 0 },
    secrets,
    renderThumb: (opts) => link.rpc('renderThumb', opts),
    screenCapture: {
      available: () => true,
      listDisplays: () => link.cache.displays || [],
      captureDisplay: (id, crop) => link.rpc('captureDisplay', id, crop),
      frameToJpegDataUrl: (frame, w, q) => link.rpc('frameToJpegDataUrl', frame, w, q)
    }
  };
}

function forNode() {
  const noHost = () => Promise.reject(new Error('needs the app (not available in plain node)'));
  return {
    mode,
    dialog: undefined, shell: undefined, app: undefined, powerMonitor: undefined,
    secrets: {
      encrypt: (plain) => (plain ? String(plain) : ''),
      decrypt: (stored) => (!stored || typeof stored !== 'string' || /^enc2?:/.test(stored)) ? '' : stored
    },
    renderThumb: noHost,
    screenCapture: { available: () => false, listDisplays: () => [], captureDisplay: noHost, frameToJpegDataUrl: async () => '' }
  };
}

module.exports = mode === 'main' ? forMain() : mode === 'utility' ? forUtility() : forNode();
