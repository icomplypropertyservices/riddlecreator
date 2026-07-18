// RiddleCreator — production server (XRPL MAINNET)
// ------------------------------------------------
// Required env (.env supported):
//   MASTER_KEY        64 hex chars — encrypts wallet seeds at rest
//   PLATFORM_SEED     sFamily seed of the platform wallet (receives launch fees +
//                     platform trade fees, funds new issuer/curve wallets)
// Optional env:
//   XRPL_WSS          default wss://xrplcluster.com (mainnet)
//   XUMM_API_KEY / XUMM_API_SECRET   enables Xaman sign-in-wallet flow
//   LAUNCH_FEE_XRP    default 20
//   FUND_ISSUER_XRP   default 2      FUND_CURVE_XRP default 5
//   PORT              default 3000
//   TESTNET=1         enables faucet demo endpoints (never set in production)

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const xrpl = require('xrpl');

const curve = require('./curve');
const { encrypt, decrypt } = require('./crypto');
const store = require('./db');
const xaman = require('./xaman');

const XRPL_WSS = process.env.XRPL_WSS || 'wss://xrplcluster.com';
const IS_TESTNET = process.env.TESTNET === '1';
const LAUNCH_FEE_XRP = Number(process.env.LAUNCH_FEE_XRP || 20);
const FUND_ISSUER_XRP = Number(process.env.FUND_ISSUER_XRP || 2);
const FUND_CURVE_XRP = Number(process.env.FUND_CURVE_XRP || 5);
const PORT = process.env.PORT || 3000;

if (!process.env.PLATFORM_SEED) throw new Error('PLATFORM_SEED env var required');
const platformWallet = xrpl.Wallet.fromSeed(process.env.PLATFORM_SEED);

// ---------- xrpl client with reconnect ----------
let client;
async function getClient() {
  if (client && client.isConnected()) return client;
  client = new xrpl.Client(XRPL_WSS, { connectionTimeout: 15000 });
  await client.connect();
  client.on('disconnected', () => console.warn('XRPL disconnected'));
  return client;
}

async function submit(wallet, tx) {
  const c = await getClient();
  const prepared = await c.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await c.submitAndWait(signed.tx_blob);
  const code = res.result.meta.TransactionResult;
  if (code !== 'tesSUCCESS') throw new Error(`Ledger rejected ${tx.TransactionType}: ${code}`);
  return res.result.hash;
}

async function getVerifiedPayment(hash) {
  const c = await getClient();
  const txr = await c.request({ command: 'tx', transaction: hash });
  const t = txr.result;
  if (!t.validated) throw new Error('Transaction not yet validated');
  if (t.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Payment failed on ledger');
  if (t.TransactionType !== 'Payment') throw new Error('Not a Payment transaction');
  return t;
}

const toCurrency = (ticker) => {
  const t = ticker.toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(t)) throw new Error('Ticker must be 2-12 alphanumeric characters');
  if (t === 'XRP') throw new Error('Ticker cannot be XRP');
  if (t.length === 3) return t;
  return Buffer.from(t, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
};

const tokenAmount = (tok, value) => ({
  currency: tok.currency, issuer: tok.issuer_address, value: Number(value).toFixed(6),
});

// ---------- per-token mutex (serialize trades, prevent race conditions) ----------
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

// ---------- token helpers ----------
function loadToken(id) {
  const row = store.getToken.get(id);
  if (!row) return null;
  row.state = JSON.parse(row.state_json);
  return row;
}
function saveToken(tok) {
  store.updateState.run({ id: tok.id, state_json: JSON.stringify(tok.state), amm_created: tok.amm_created ? 1 : 0 });
}
function publicToken(tok) {
  return {
    id: tok.id, name: tok.name, ticker: tok.ticker, description: tok.description,
    currency: tok.currency, issuerAddress: tok.issuer_address, curveAddress: tok.curve_address,
    creatorAddress: tok.creator_address, createdAt: tok.created_at,
    price: curve.price(tok.state), marketCapXrp: curve.marketCapXrp(tok.state),
    raisedXrp: tok.state.realXrp, tokensRemaining: tok.state.tokenReserve,
    progress: Math.min(100, (tok.state.realXrp / curve.CONFIG.GRADUATION_XRP) * 100),
    graduated: tok.state.graduated, ammCreated: !!tok.amm_created,
    creatorFeesXrp: tok.state.creatorFeesXrp,
    trades: store.tokenTrades.all(tok.id),
    config: curve.CONFIG,
  };
}

// ---------- launch: invoice -> verify payment -> fund -> mint ----------
function createLaunchInvoice({ name, ticker, description, creatorAddress }) {
  toCurrency(ticker); // validate early
  if (!xrpl.isValidAddress(creatorAddress)) throw new Error('Invalid creator address');
  const destTag = ((store.maxDestTag.get().m || 100000) + 1) % 4294967295;
  const launchId = crypto.randomUUID();
  store.insertLaunch.run({
    launch_id: launchId, name, ticker: ticker.toUpperCase(), description: description || '',
    creator_address: creatorAddress, dest_tag: destTag, fee_xrp: LAUNCH_FEE_XRP, created_at: Date.now(),
  });
  return {
    launchId,
    pay: { address: platformWallet.address, destinationTag: destTag, amountXrp: LAUNCH_FEE_XRP },
    note: `Send exactly ${LAUNCH_FEE_XRP} XRP with destination tag ${destTag}, then confirm.`,
  };
}

async function completeLaunch(launchId, paymentHash) {
  const L = store.getLaunch.get(launchId);
  if (!L) throw new Error('Launch not found');
  if (L.status === 'done') return { tokenId: L.token_id };
  if (L.status === 'launching') throw new Error('Launch already in progress');
  if (store.paymentSeen.get(paymentHash)) throw new Error('Payment already used');

  const t = await getVerifiedPayment(paymentHash);
  if (t.Destination !== platformWallet.address) throw new Error('Payment not sent to platform address');
  if (t.DestinationTag !== L.dest_tag) throw new Error('Wrong destination tag');
  const delivered = t.meta.delivered_amount;
  if (typeof delivered !== 'string') throw new Error('Launch fee must be XRP');
  if (Number(xrpl.dropsToXrp(delivered)) < L.fee_xrp) throw new Error(`Launch fee is ${L.fee_xrp} XRP`);

  store.markPayment.run(paymentHash);
  store.updateLaunch.run({ launch_id: launchId, status: 'launching', payment_hash: paymentHash, token_id: null, error: null });

  try {
    const issuer = xrpl.Wallet.generate();
    const curveW = xrpl.Wallet.generate();
    const currency = toCurrency(L.ticker);

    // fund both accounts from the platform wallet
    await submit(platformWallet, { TransactionType: 'Payment', Account: platformWallet.address, Destination: issuer.address, Amount: xrpl.xrpToDrops(FUND_ISSUER_XRP) });
    await submit(platformWallet, { TransactionType: 'Payment', Account: platformWallet.address, Destination: curveW.address, Amount: xrpl.xrpToDrops(FUND_CURVE_XRP) });

    await submit(issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: xrpl.AccountSetAsfFlags.asfDefaultRipple });
    await submit(curveW, { TransactionType: 'TrustSet', Account: curveW.address, LimitAmount: { currency, issuer: issuer.address, value: String(curve.CONFIG.TOTAL_SUPPLY) } });
    await submit(issuer, { TransactionType: 'Payment', Account: issuer.address, Destination: curveW.address, Amount: { currency, issuer: issuer.address, value: String(curve.CONFIG.TOTAL_SUPPLY) } });

    const id = `${L.ticker}-${Date.now().toString(36)}`;
    store.insertToken.run({
      id, name: L.name, ticker: L.ticker, description: L.description, currency,
      issuer_address: issuer.address, issuer_seed_enc: encrypt(issuer.seed),
      curve_address: curveW.address, curve_seed_enc: encrypt(curveW.seed),
      creator_address: L.creator_address, created_at: Date.now(),
      state_json: JSON.stringify(curve.newCurveState()),
    });
    store.updateLaunch.run({ launch_id: launchId, status: 'done', payment_hash: paymentHash, token_id: id, error: null });
    return { tokenId: id };
  } catch (e) {
    store.updateLaunch.run({ launch_id: launchId, status: 'failed', payment_hash: paymentHash, token_id: null, error: e.message });
    throw e;
  }
}

// ---------- trading ----------
async function hasTrustline(tok, userAddress) {
  const c = await getClient();
  const lines = await c.request({ command: 'account_lines', account: userAddress, peer: tok.issuer_address });
  return lines.result.lines.some((l) => l.currency === tok.currency);
}

async function refund(tok, userAddress, delivered) {
  const curveW = xrpl.Wallet.fromSeed(decrypt(tok.curve_seed_enc));
  const Amount = typeof delivered === 'string' ? delivered : delivered; // same shape back
  try {
    await submit(curveW, { TransactionType: 'Payment', Account: curveW.address, Destination: userAddress, Amount });
  } catch (e) { console.error('REFUND FAILED', tok.id, userAddress, e.message); }
}

async function payFees(curveW, tok, creatorXrp, platformXrp) {
  if (creatorXrp > 0.000001) {
    await submit(curveW, { TransactionType: 'Payment', Account: curveW.address, Destination: tok.creator_address, Amount: xrpl.xrpToDrops(creatorXrp.toFixed(6)) });
  }
  if (platformXrp > 0.000001) {
    await submit(curveW, { TransactionType: 'Payment', Account: curveW.address, Destination: platformWallet.address, Amount: xrpl.xrpToDrops(platformXrp.toFixed(6)) });
  }
}

// Process a verified user payment as a buy or sell. minOut = slippage protection.
async function processTrade(tok, { paymentTxHash, minOut }) {
  if (store.paymentSeen.get(paymentTxHash)) throw new Error('Payment already processed');
  const t = await getVerifiedPayment(paymentTxHash);
  if (t.Destination !== tok.curve_address) throw new Error('Payment not sent to the curve wallet');
  const userAddress = t.Account;
  const delivered = t.meta.delivered_amount;
  store.markPayment.run(paymentTxHash); // claim it before settlement

  const curveW = xrpl.Wallet.fromSeed(decrypt(tok.curve_seed_enc));

  if (typeof delivered === 'string') {
    // ---- BUY ----
    const xrpIn = Number(xrpl.dropsToXrp(delivered));
    if (tok.state.graduated) { await refund(tok, userAddress, delivered); throw new Error('Graduated — trade on the AMM. Payment refunded.'); }
    if (!(await hasTrustline(tok, userAddress))) { await refund(tok, userAddress, delivered); throw new Error(`No trustline set. Payment refunded. Trustline: ${tok.currency} / ${tok.issuer_address}`); }

    const q = curve.quoteBuy(tok.state, xrpIn);
    if (minOut && q.tokensOut < Number(minOut)) { await refund(tok, userAddress, delivered); throw new Error('Slippage exceeded. Payment refunded.'); }

    curve.applyBuy(tok.state, xrpIn);
    saveToken(tok);
    const settle = await submit(curveW, { TransactionType: 'Payment', Account: curveW.address, Destination: userAddress, Amount: tokenAmount(tok, q.tokensOut) });
    await payFees(curveW, tok, q.creator, q.platform);
    store.insertTrade.run({ hash: paymentTxHash, token_id: tok.id, side: 'buy', user_address: userAddress, xrp: xrpIn, tokens: q.tokensOut, price: curve.price(tok.state), settle_hash: settle, ts: Date.now() });

    if (tok.state.graduated && !tok.amm_created) await graduate(tok);
    return { side: 'buy', tokensOut: q.tokensOut, creatorFee: q.creator, platformFee: q.platform, settleTx: settle, graduated: tok.state.graduated };
  }

  // ---- SELL ----
  if (delivered.currency !== tok.currency || delivered.issuer !== tok.issuer_address) {
    throw new Error('Payment is neither XRP nor this token');
  }
  const tokensIn = Number(delivered.value);
  if (tok.state.graduated) { await refund(tok, userAddress, delivered); throw new Error('Graduated — trade on the AMM. Tokens refunded.'); }

  let q;
  try { q = curve.quoteSell(tok.state, tokensIn); }
  catch (e) { await refund(tok, userAddress, delivered); throw new Error(e.message + '. Tokens refunded.'); }
  if (minOut && q.xrpOut < Number(minOut)) { await refund(tok, userAddress, delivered); throw new Error('Slippage exceeded. Tokens refunded.'); }

  curve.applySell(tok.state, tokensIn);
  saveToken(tok);
  const settle = await submit(curveW, { TransactionType: 'Payment', Account: curveW.address, Destination: userAddress, Amount: xrpl.xrpToDrops(q.xrpOut.toFixed(6)) });
  await payFees(curveW, tok, q.creator, q.platform);
  store.insertTrade.run({ hash: paymentTxHash, token_id: tok.id, side: 'sell', user_address: userAddress, xrp: q.xrpOut, tokens: tokensIn, price: curve.price(tok.state), settle_hash: settle, ts: Date.now() });
  return { side: 'sell', xrpOut: q.xrpOut, creatorFee: q.creator, platformFee: q.platform, settleTx: settle };
}

// ---------- graduation ----------
async function graduate(tok) {
  const curveW = xrpl.Wallet.fromSeed(decrypt(tok.curve_seed_enc));
  const issuer = xrpl.Wallet.fromSeed(decrypt(tok.issuer_seed_enc));
  const xrpForPool = Math.max(tok.state.realXrp - 10, 10); // keep buffer for fees/reserves

  await submit(curveW, {
    TransactionType: 'AMMCreate', Account: curveW.address,
    Amount: xrpl.xrpToDrops(xrpForPool.toFixed(6)),
    Amount2: tokenAmount(tok, curve.CONFIG.AMM_SUPPLY),
    TradingFee: 500,
  });
  await submit(issuer, { TransactionType: 'SetRegularKey', Account: issuer.address, RegularKey: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp' });
  await submit(issuer, { TransactionType: 'AccountSet', Account: issuer.address, SetFlag: xrpl.AccountSetAsfFlags.asfDisableMaster });

  tok.amm_created = 1;
  saveToken(tok);
}

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));
const heavyLimit = rateLimit({ windowMs: 60_000, max: 15 });

app.get('/api/meta', (req, res) => res.json({
  network: IS_TESTNET ? 'testnet' : 'mainnet', wss: XRPL_WSS,
  launchFeeXrp: LAUNCH_FEE_XRP, xamanEnabled: xaman.enabled(),
  platformAddress: platformWallet.address, config: curve.CONFIG,
}));

app.get('/api/tokens', (req, res) => {
  res.json(store.allTokens.all().map((r) => { r.state = JSON.parse(r.state_json); return publicToken(r); }));
});
app.get('/api/tokens/:id', (req, res) => {
  const tok = loadToken(req.params.id);
  if (!tok) return res.status(404).json({ error: 'Not found' });
  res.json(publicToken(tok));
});

app.post('/api/tokens/:id/quote', (req, res) => {
  try {
    const tok = loadToken(req.params.id);
    if (!tok) return res.status(404).json({ error: 'Not found' });
    const { side, amount } = req.body;
    const s = JSON.parse(JSON.stringify(tok.state));
    res.json(side === 'buy' ? curve.quoteBuy(s, Number(amount)) : curve.quoteSell(s, Number(amount)));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// -- launch --
app.post('/api/launch/invoice', heavyLimit, (req, res) => {
  try {
    const { name, ticker, description, creatorAddress } = req.body;
    if (!name || !ticker || !creatorAddress) return res.status(400).json({ error: 'name, ticker, creatorAddress required' });
    res.json(createLaunchInvoice({ name: String(name).slice(0, 64), ticker, description: String(description || '').slice(0, 280), creatorAddress }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/launch/:launchId/confirm', heavyLimit, async (req, res) => {
  try {
    const r = await withLock('launch:' + req.params.launchId, () => completeLaunch(req.params.launchId, req.body.paymentTxHash));
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// -- trade: submit a payment hash (works with any wallet) --
app.post('/api/tokens/:id/trade', heavyLimit, async (req, res) => {
  try {
    const tok = loadToken(req.params.id);
    if (!tok) return res.status(404).json({ error: 'Not found' });
    const r = await withLock('tok:' + tok.id, async () => {
      const fresh = loadToken(tok.id); // reload inside the lock
      return processTrade(fresh, { paymentTxHash: req.body.paymentTxHash, minOut: req.body.minOut });
    });
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// -- trade via Xaman: create sign request, then confirm --
app.post('/api/tokens/:id/xaman/payload', heavyLimit, async (req, res) => {
  try {
    const tok = loadToken(req.params.id);
    if (!tok) return res.status(404).json({ error: 'Not found' });
    const { side, amount } = req.body;
    const amt = side === 'buy'
      ? xrpl.xrpToDrops(Number(amount).toFixed(6))
      : tokenAmount(tok, Number(amount));
    const p = await xaman.createPaymentPayload({ destination: tok.curve_address, amount: amt, memo: `riddle:${side}:${tok.id}` });
    res.json(p);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/tokens/:id/xaman/confirm', heavyLimit, async (req, res) => {
  try {
    const tok = loadToken(req.params.id);
    if (!tok) return res.status(404).json({ error: 'Not found' });
    const p = await xaman.getPayloadResult(req.body.uuid);
    if (!p.resolved) return res.json({ pending: true });
    if (!p.signed || !p.txid) return res.json({ pending: false, rejected: true });
    const r = await withLock('tok:' + tok.id, async () => {
      const fresh = loadToken(tok.id);
      return processTrade(fresh, { paymentTxHash: p.txid, minOut: req.body.minOut });
    });
    res.json({ pending: false, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// -- testnet-only demo endpoints --
if (IS_TESTNET) {
  app.post('/api/testnet/demo-wallet', async (req, res) => {
    try { const c = await getClient(); const { wallet } = await c.fundWallet(); res.json({ address: wallet.address, seed: wallet.seed }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/testnet/demo-trade', async (req, res) => {
    try {
      const tok = loadToken(req.body.id);
      if (!tok) return res.status(404).json({ error: 'Not found' });
      const user = xrpl.Wallet.fromSeed(req.body.seed);
      if (!(await hasTrustline(tok, user.address))) {
        await submit(user, { TransactionType: 'TrustSet', Account: user.address, LimitAmount: { currency: tok.currency, issuer: tok.issuer_address, value: String(curve.CONFIG.TOTAL_SUPPLY) } });
      }
      const amt = req.body.side === 'buy' ? xrpl.xrpToDrops(Number(req.body.amount).toFixed(6)) : tokenAmount(tok, Number(req.body.amount));
      const hash = await submit(user, { TransactionType: 'Payment', Account: user.address, Destination: tok.curve_address, Amount: amt });
      const r = await withLock('tok:' + tok.id, async () => processTrade(loadToken(tok.id), { paymentTxHash: hash }));
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
}

// Local / long-running process: listen. On Vercel the app is exported as a serverless handler.
if (require.main === module) {
  app.listen(PORT, () => console.log(`RiddleCreator [${IS_TESTNET ? 'TESTNET' : 'MAINNET'}] on :${PORT} via ${XRPL_WSS} — platform ${platformWallet.address}`));
}

module.exports = app;
