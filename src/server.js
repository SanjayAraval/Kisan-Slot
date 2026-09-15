'use strict';

require('dotenv').config();

const http = require('http');
const { createApp } = require('./app');
const { createPool } = require('./db');
const { checkSchema } = require('./schemaCheck');
const { attachQueueWebSocket } = require('./wsServer');

const pool = createPool();
const port = process.env.PORT || 3000;

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
    const server = http.createServer(app);
    attachQueueWebSocket(server, pool);
    server.listen(port, () => {
      console.log(`Kisan Slot API listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
