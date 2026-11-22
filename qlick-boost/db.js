// Stockage JSON simple (fichier unique, écriture atomique).
// Suffisant pour un MVP / une démo ; à remplacer par PostgreSQL en production.
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.QLICK_DB || path.join(__dirname, 'data', 'db.json');

const empty = () => ({ users: [], businesses: [], prizes: [], participations: [], reviews: [] });

let state = null;

function load() {
  if (state) return state;
  try {
    state = { ...empty(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    state = empty();
  }
  return state;
}

let writeTimer = null;
function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 50);
}

function flush() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

module.exports = { load, save, flush, DB_FILE };
