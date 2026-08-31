'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openPopout:        (page) => ipcRenderer.invoke('open-popout-window', page),
  openDiscordOAuth:  (url)  => ipcRenderer.invoke('open-discord-oauth', url),
  printReport:       (html, mode) => ipcRenderer.invoke('print-report', html, mode),
  // Renderer acceleration (GPU/CPU). Decided before app-ready, so setting it needs a relaunch.
  getRenderMode:     ()     => ipcRenderer.invoke('get-render-mode'),
  setRenderMode:     (mode) => ipcRenderer.invoke('set-render-mode', mode),
});
