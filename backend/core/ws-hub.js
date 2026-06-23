const WebSocket = require('ws');

function createWsHub() {
  const clients = new Set();

  function attachServer(wss) {
    wss.on('connection', (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  }

  function broadcast(message) {
    const payload = JSON.stringify(message);
    clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    });
  }

  return {
    clients,
    attachServer,
    broadcast
  };
}

module.exports = {
  createWsHub
};
