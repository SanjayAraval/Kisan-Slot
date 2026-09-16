'use strict';

require('dotenv').config();

const http = require('http');
const { createApp } = require('./app');
const { createPool } = require('./db');
const { checkSchema } = require('./schemaCheck');
const { attachQueueWebSocket } = require('./wsServer');

const pool = createPool();
const port = process.env.PORT || 3000;

let server;
let wss;
let shuttingDown = false;

// Fails loudly here, before accepting a single request, if the database
// is missing a table/column the code expects (a pending migration,
// most concretely) -- see schemaCheck.js. Better a crashed boot with a
// clear message than a 500 the first time someone hits the one endpoint
// that touches the missing column.
checkSchema(pool)
  .then(() => {
    const app = createApp(pool);
    // A raw http.Server, not app.listen() directly -- the WebSocket
    // server needs to share the same listening socket (for the
    // Upgrade handshake on /ws/queue) rather than opening its own.
    server = http.createServer(app);
    wss = attachQueueWebSocket(server, pool);
    server.listen(port, () => {
      console.log(`Kisan Slot API listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

// SIGTERM on a platform stop/redeploy, SIGINT on Ctrl+C -- either way,
// stop taking new work before yanking the DB pool out from under
// in-flight queries.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);

  const closeHttp = new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve();
  });

  // wss.close() alone only stops accepting new upgrades -- it waits on
  // already-open sockets, which for this project's clients (polling on
  // reconnect) may never close themselves. Terminate them first so
  // shutdown doesn't hang.
  const closeWs = new Promise((resolve) => {
    if (!wss) return resolve();
    for (const client of wss.clients) client.terminate();
    wss.close(resolve);
  });

  Promise.all([closeHttp, closeWs])
    .then(() => pool.end())
    .then(() => {
      console.log('shutdown complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('error during shutdown', err);
      process.exit(1);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
