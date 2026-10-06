'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openPopout:        (page) => ipcRenderer.invoke('open-popout-window', page),
  openDiscordOAuth:  (url)  => ipcRenderer.invoke('open-discord-oauth', url),
  openTwitchOAuth:   (url)  => ipcRenderer.invoke('open-twitch-oauth', url),
  // Overlay popped out over the game: frameless, transparent, always-on-top, click-through.
  openGameOverlay:   (opts) => ipcRenderer.invoke('game-overlay:open', opts),
  listGameOverlays:  ()     => ipcRenderer.invoke('game-overlay:list'),
  gameOverlayCommand:(key, cmd, arg) => ipcRenderer.invoke('game-overlay:command', key, cmd, arg),
  onGameOverlaysChanged: (fn) => ipcRenderer.on('game-overlays-changed', (_e, list) => fn(list)),
  printReport:       (html, mode) => ipcRenderer.invoke('print-report', html, mode),
  // Renderer acceleration (GPU/CPU). Decided before app-ready, so setting it needs a relaunch.
  getRenderMode:     ()     => ipcRenderer.invoke('get-render-mode'),
  setRenderMode:     (mode) => ipcRenderer.invoke('set-render-mode', mode),
});
