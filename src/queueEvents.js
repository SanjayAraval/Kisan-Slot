'use strict';

// A single in-process pub/sub bus for "this centre's live queue changed"
// (scan-in, mark-served). Deliberately not Redis or any other external
// broker -- this app runs as one Node process, so an in-memory
// EventEmitter already gives every subscriber (the WebSocket layer, see
// wsServer.js) an immediate, reliable notification with nothing extra to
// run or configure. Emitting with zero listeners attached (e.g. every
// test, which never loads wsServer.js) is a normal, harmless no-op.
const { EventEmitter } = require('events');

module.exports = new EventEmitter();
