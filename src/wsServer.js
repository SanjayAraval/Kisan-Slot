'use strict';

const { WebSocketServer } = require('ws');
const { loadQueue } = require('./queueService');
const queueEvents = require('./queueEvents');

// Live queue push over WebSocket -- a client subscribes to one
// centre/date and gets a fresh snapshot immediately, then again whenever
// queueEvents fires for that centre (a scan or a mark-served, see
// lotRoutes.js). No Redis or any other broker: this server runs as one
// process, so the in-memory queueEvents bus is already enough to reach
// every connected socket -- see queueEvents.js. A client that can't
// establish or keeps losing the WebSocket (a restrictive proxy, e.g.)
// still works via the 3-second poll every page here falls back to; this
// is a genuine enhancement over that, not the only way to get live data.
function attachQueueWebSocket(httpServer, pool) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/queue' });

  // One subscription per open socket -- a client resubscribes (a new
  // 'subscribe' message) if it changes date or centre, which simply
  // overwrites its prior entry here.
  const subscriptions = new Map();

  async function pushTo(ws, centreId, date) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      const queue = await loadQueue(pool, centreId, date);
      if (queue) ws.send(JSON.stringify({ type: 'queue', queue }));
    } catch (err) {
      // A failed push to one client is never allowed to take the process
      // down -- best-effort only, the client's own poll fallback covers it.
    }
  }

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        return; // malformed message from a client -- ignore, never crash the socket
      }
      if (msg && msg.type === 'subscribe' && typeof msg.centreId === 'string' && typeof msg.date === 'string') {
        subscriptions.set(ws, { centreId: msg.centreId, date: msg.date });
        pushTo(ws, msg.centreId, msg.date);
      }
    });
    ws.on('close', () => subscriptions.delete(ws));
    ws.on('error', () => subscriptions.delete(ws));
  });

  queueEvents.on('changed', (centreId) => {
    for (const [ws, sub] of subscriptions) {
      if (sub.centreId === centreId) pushTo(ws, sub.centreId, sub.date);
    }
  });

  return wss;
}

module.exports = { attachQueueWebSocket };
