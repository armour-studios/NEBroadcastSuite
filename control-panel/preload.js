'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openPopout:        (page) => ipcRenderer.invoke('open-popout-window', page),
  openDiscordOAuth:  (url)  => ipcRenderer.invoke('open-discord-oauth', url),
  printReport:       (html, mode) => ipcRenderer.invoke('print-report', html, mode),
});
