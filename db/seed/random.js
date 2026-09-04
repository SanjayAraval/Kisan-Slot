'use strict';

// Seeded PRNG so the seed script is reproducible -- same --seed always
// produces the same dataset, which matters for debugging a specific
// generated farmer/booking.
function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRng(seed) {
  const next = mulberry32(seed);

  const rng = {
    next,
    int(min, max) {
      // inclusive of both bounds
      return Math.floor(next() * (max - min + 1)) + min;
    },
    float(min, max) {
      return next() * (max - min) + min;
    },
    bool(pTrue = 0.5) {
      return next() < pTrue;
    },
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    pickWeighted(entries) {
      // entries: [[value, weight], ...]
      const total = entries.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return entries[entries.length - 1][0];
    },
    shuffle(arr) {
      const copy = arr.slice();
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
    normal() {
      // Box-Muller
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    lognormal(targetMean, sigma) {
      const mu = Math.log(targetMean) - (sigma * sigma) / 2;
      return Math.exp(mu + sigma * rng.normal());
    },
  };

  return rng;
}

module.exports = { createRng };
