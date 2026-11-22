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

// sauvegarde quotidienne, 30 jours conservés (data/backups/db-AAAA-MM-JJ.json)
function backup() {
  if (!state) load();
  const dir = path.join(path.dirname(DB_FILE), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `db-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(state));
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('db-')).sort();
  while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
}

module.exports = { load, save, flush, backup, DB_FILE };
