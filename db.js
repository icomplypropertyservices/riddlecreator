// SQLite persistence (better-sqlite3, WAL mode, synchronous & fast)
// On Vercel the only writable path is /tmp (ephemeral per instance — fine for previews;
// for production multi-instance, use a durable host or external DB).
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const defaultPath = process.env.VERCEL
  ? path.join('/tmp', 'riddlecreator.db')
  : path.join(__dirname, 'riddlecreator.db');
const dbPath = process.env.DB_PATH || defaultPath;
try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (_) { /* ok */ }

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, ticker TEXT NOT NULL, description TEXT,
  currency TEXT NOT NULL,
  issuer_address TEXT NOT NULL, issuer_seed_enc TEXT NOT NULL,
  curve_address TEXT NOT NULL, curve_seed_enc TEXT NOT NULL,
  creator_address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  amm_created INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trades (
  hash TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  side TEXT NOT NULL, user_address TEXT NOT NULL,
  xrp REAL NOT NULL, tokens REAL NOT NULL, price REAL NOT NULL,
  settle_hash TEXT, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_id, ts);
CREATE TABLE IF NOT EXISTS launches (
  launch_id TEXT PRIMARY KEY,
  name TEXT, ticker TEXT, description TEXT, creator_address TEXT,
  dest_tag INTEGER NOT NULL,
  fee_xrp REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment', -- awaiting_payment | launching | done | failed
  payment_hash TEXT, token_id TEXT, error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS processed_payments (hash TEXT PRIMARY KEY);
`);

module.exports = {
  insertToken: db.prepare(`INSERT INTO tokens (id,name,ticker,description,currency,issuer_address,issuer_seed_enc,curve_address,curve_seed_enc,creator_address,created_at,state_json)
    VALUES (@id,@name,@ticker,@description,@currency,@issuer_address,@issuer_seed_enc,@curve_address,@curve_seed_enc,@creator_address,@created_at,@state_json)`),
  updateState: db.prepare(`UPDATE tokens SET state_json=@state_json, amm_created=@amm_created WHERE id=@id`),
  getToken: db.prepare(`SELECT * FROM tokens WHERE id=?`),
  allTokens: db.prepare(`SELECT * FROM tokens ORDER BY created_at DESC`),
  insertTrade: db.prepare(`INSERT INTO trades (hash,token_id,side,user_address,xrp,tokens,price,settle_hash,ts)
    VALUES (@hash,@token_id,@side,@user_address,@xrp,@tokens,@price,@settle_hash,@ts)`),
  tokenTrades: db.prepare(`SELECT * FROM trades WHERE token_id=? ORDER BY ts DESC LIMIT 50`),
  tradeExists: db.prepare(`SELECT 1 FROM trades WHERE hash=?`),
  markPayment: db.prepare(`INSERT OR IGNORE INTO processed_payments (hash) VALUES (?)`),
  paymentSeen: db.prepare(`SELECT 1 FROM processed_payments WHERE hash=?`),
  insertLaunch: db.prepare(`INSERT INTO launches (launch_id,name,ticker,description,creator_address,dest_tag,fee_xrp,status,created_at)
    VALUES (@launch_id,@name,@ticker,@description,@creator_address,@dest_tag,@fee_xrp,'awaiting_payment',@created_at)`),
  getLaunch: db.prepare(`SELECT * FROM launches WHERE launch_id=?`),
  updateLaunch: db.prepare(`UPDATE launches SET status=@status, payment_hash=@payment_hash, token_id=@token_id, error=@error WHERE launch_id=@launch_id`),
  maxDestTag: db.prepare(`SELECT MAX(dest_tag) AS m FROM launches`),
  raw: db,
};
