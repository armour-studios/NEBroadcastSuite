'use strict';
// webContents 'console-message' changed shape in Electron 35: the details moved onto the event and
// the level became a string ('debug' | 'info' | 'warning' | 'error'). Older versions pass them as
// arguments with a numeric level (0 verbose, 1 info, 2 warning, 3 error). This reads either form
// and always returns the numeric level.
const LEVELS = { verbose: 0, debug: 0, info: 1, warning: 2, error: 3 };

function readConsoleMessage(ev, level, message, line, sourceId) {
  const e = ev || {};
  let lv = level;
  if (typeof e.level === 'string') lv = LEVELS[e.level] ?? 1;
  else if (typeof e.level === 'number') lv = e.level;
  return {
    level: Number(lv) || 0,
    message: e.message != null ? e.message : message,
    line: e.lineNumber != null ? e.lineNumber : line,
    sourceId: e.sourceId != null ? e.sourceId : sourceId
  };
}

module.exports = { readConsoleMessage };
