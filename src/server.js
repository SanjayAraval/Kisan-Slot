'use strict';

const { createApp } = require('./app');
const { createPool } = require('./db');

const pool = createPool();
const app = createApp(pool);
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Kisan Slot API listening on :${port}`);
});
