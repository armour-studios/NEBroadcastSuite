const net = require('net');

function createRlStatsApiBridge({ host = '127.0.0.1', port = 49123, onEvent, logger }) {
  let socket = null;
  let buffer = '';

  function start() {
    if (socket) return;

    socket = new net.Socket();

    socket.connect(port, host, () => {
      logger.info({ host, port }, 'Connected to Rocket League Stats API');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const chunks = buffer.replace(/\}\s*\{/g, '}\n{').split('\n');
      buffer = chunks.pop();

      chunks.forEach((chunk) => {
        const text = chunk.trim();
        if (!text) return;

        try {
          const payload = JSON.parse(text);
          if (onEvent) onEvent(payload);
        } catch {
          // Intentionally ignore malformed chunks for now.
        }
      });
    });

    socket.on('close', () => {
      logger.warn('Rocket League Stats API disconnected');
      socket = null;
    });

    socket.on('error', (error) => {
      logger.error({ error }, 'Rocket League Stats API bridge error');
      socket = null;
    });
  }

  function stop() {
    if (!socket) return;
    socket.destroy();
    socket = null;
  }

  return {
    start,
    stop
  };
}

module.exports = {
  createRlStatsApiBridge
};
