// RiddleCreator — pump.fun-style launcher for the XRP Ledger
// Node 18+. Default network: TESTNET. Switch XRPL_WSS to mainnet when ready.
//
// Architecture (no smart contracts exist on XRPL mainnet):
//   - Each launch gets an ISSUER wallet (cold) and a CURVE wallet (hot treasury).
//   - Curve wallet holds the full supply + all XRP raised; the bonding curve
//     is enforced by this server, settlement happens on-ledger.
//   - Buys: user sends XRP -> curve wallet pays tokens out.
//   - Sells: user sends tokens -> curve wallet pays XRP out.
//   - Creator fees paid on-ledger to the creator address per trade.
//   - At graduation the curve wallet calls AMMCreate with raised XRP + reserved
//     tokens, then the issuer is blackholed. Trading continues on the native AMM.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xrpl = require('xrpl');
const curve = require('./curve');

const XRPL_WSS = process.env.XRPL_WSS || 'wss://s.altnet.rippletest.net:51233';
const PLATFORM_ADDRESS = process.env.PLATFORM_ADDRESS || null; // where platform fees go
const DB_FILE = path.join(__dirname, 'db.json');
const PORT = process.env.PORT || 3000;

// ---------- tiny JSON persistence ----------
let db = { tokens: {} };
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ---------- xrpl client ----------
let client;
async function getClient() {
  if (client && client.isConnected()) return client;
  client = new xrpl.Client(XRPL_WSS);
  await client.connect();
  return client;
}

const toCurrency = (ticker) => {
  const t = ticker.toUpperCase();
  if (t.length === 3) return t;
  return Buffer.from(t, 'ascii').toString('hex').toUpperCase().padEnd(40, '0');
};

async function submit(wallet, tx) {
  const c = await getClient();
  const prepared = await c.autofill(tx);
  const signed = wallet.sign(prepared);
  const res = await c.submitAndWait(signed.tx_blob);
  const code = res.result.meta.TransactionResult;
  if (code !== 'tesSUCCESS') throw new Error(`Ledger rejected ${tx.TransactionType}: ${code}`);
  return res.result.hash;
}

function tokenAmount(tok, value) {
  return {
    currency: tok.currency,
    issuer: tok.issuerAddress,
    value: String(Number(value.toFixed ? value.toFixed(6) : value)),
  };
}

// ---------- launch ----------
async function launchToken({ name, ticker, description, creatorAddress }) {
  const c = await getClient();

  // fund two wallets (testnet faucet; on mainnet fund these yourself)
  const { wallet: issuer } = await c.fundWallet();
  const { wallet: curveWallet } = await c.fundWallet();

  const currency = toCurrency(ticker);

  // issuer settings: default ripple so the token flows freely
  await submit(issuer, {
    TransactionType: 'AccountSet',
    Account: issuer.address,
    SetFlag: xrpl.AccountSetAsfFlags.asfDefaultRipple,
  });

  // curve wallet trusts the issuer
  await submit(curveWallet, {
    TransactionType: 'TrustSet',
    Account: curveWallet.address,
    LimitAmount: { currency, issuer: issuer.address, value: String(curve.CONFIG.TOTAL_SUPPLY) },
  });

  // mint full supply to curve wallet
  await submit(issuer, {
    TransactionType: 'Payment',
    Account: issuer.address,
    Destination: curveWallet.address,
    Amount: { currency, issuer: issuer.address, value: String(curve.CONFIG.TOTAL_SUPPLY) },
  });

  const id = `${ticker.toUpperCase()}-${Date.now().toString(36)}`;
  const tok = {
    id, name, ticker: ticker.toUpperCase(), description: description || '',
    currency,
    issuerAddress: issuer.address, issuerSeed: issuer.seed,
    curveAddress: curveWallet.address, curveSeed: curveWallet.seed,
    creatorAddress,
    createdAt: Date.now(),
    state: curve.newCurveState(),
    trades: [],
    ammCreated: false,
  };
  db.tokens[id] = tok;
  save();
  return tok;
}

// ---------- trading ----------
async function ensureTrustline(tok, userAddress) {
  const c = await getClient();
  const lines = await c.request({ command: 'account_lines', account: userAddress, peer: tok.issuerAddress });
  return lines.result.lines.some((l) => l.currency === tok.currency);
}

// BUY: verify the user's XRP payment to the curve wallet, then send tokens + creator fee
async function buy(tok, { userAddress, paymentTxHash }) {
  const c = await getClient();
  const txr = await c.request({ command: 'tx', transaction: paymentTxHash });
  const t = txr.result;
  if (t.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Payment failed on ledger');
  if (t.TransactionType !== 'Payment' || t.Destination !== tok.curveAddress) throw new Error('Not a payment to the curve wallet');
  if (t.Account !== userAddress) throw new Error('Payment sender does not match');
  if (tok.trades.some((tr) => tr.hash === paymentTxHash)) throw new Error('Payment already processed');
  const delivered = t.meta.delivered_amount;
  if (typeof delivered !== 'string') throw new Error('Payment must be XRP');
  const xrpIn = Number(xrpl.dropsToXrp(delivered));

  if (!(await ensureTrustline(tok, userAddress))) {
    throw new Error(`Set a trustline first: currency ${tok.currency}, issuer ${tok.issuerAddress}`);
  }

  const q = curve.applyBuy(tok.state, xrpIn);
  const curveWallet = xrpl.Wallet.fromSeed(tok.curveSeed);

  // send tokens to buyer
  const tokenHash = await submit(curveWallet, {
    TransactionType: 'Payment',
    Account: curveWallet.address,
    Destination: userAddress,
    Amount: tokenAmount(tok, q.tokensOut),
  });

  // pay creator fee on-ledger immediately
  if (q.creator > 0.000001 && tok.creatorAddress) {
    await submit(curveWallet, {
      TransactionType: 'Payment',
      Account: curveWallet.address,
      Destination: tok.creatorAddress,
      Amount: xrpl.xrpToDrops(q.creator.toFixed(6)),
    });
  }
  if (q.platform > 0.000001 && PLATFORM_ADDRESS) {
    await submit(curveWallet, {
      TransactionType: 'Payment',
      Account: curveWallet.address,
      Destination: PLATFORM_ADDRESS,
      Amount: xrpl.xrpToDrops(q.platform.toFixed(6)),
    });
  }

  tok.trades.push({ side: 'buy', user: userAddress, xrp: xrpIn, tokens: q.tokensOut, hash: paymentTxHash, settle: tokenHash, ts: Date.now(), price: curve.price(tok.state) });
  save();

  if (tok.state.graduated && !tok.ammCreated) await graduate(tok);
  return { tokensOut: q.tokensOut, creatorFee: q.creator, platformFee: q.platform, settleTx: tokenHash, graduated: tok.state.graduated };
}

// SELL: verify the user's token payment to the curve wallet, then send XRP back minus fees
async function sell(tok, { userAddress, paymentTxHash }) {
  const c = await getClient();
  const txr = await c.request({ command: 'tx', transaction: paymentTxHash });
  const t = txr.result;
  if (t.meta.TransactionResult !== 'tesSUCCESS') throw new Error('Payment failed on ledger');
  if (t.TransactionType !== 'Payment' || t.Destination !== tok.curveAddress) throw new Error('Not a payment to the curve wallet');
  if (t.Account !== userAddress) throw new Error('Payment sender does not match');
  if (tok.trades.some((tr) => tr.hash === paymentTxHash)) throw new Error('Payment already processed');
  const delivered = t.meta.delivered_amount;
  if (typeof delivered === 'string' || delivered.currency !== tok.currency || delivered.issuer !== tok.issuerAddress) {
    throw new Error('Payment must be this token');
  }
  const tokensIn = Number(delivered.value);

  const q = curve.applySell(tok.state, tokensIn);
  const curveWallet = xrpl.Wallet.fromSeed(tok.curveSeed);

  const xrpHash = await submit(curveWallet, {
    TransactionType: 'Payment',
    Account: curveWallet.address,
    Destination: userAddress,
    Amount: xrpl.xrpToDrops(q.xrpOut.toFixed(6)),
  });

  if (q.creator > 0.000001 && tok.creatorAddress) {
    await submit(curveWallet, {
      TransactionType: 'Payment',
      Account: curveWallet.address,
      Destination: tok.creatorAddress,
      Amount: xrpl.xrpToDrops(q.creator.toFixed(6)),
    });
  }
  if (q.platform > 0.000001 && PLATFORM_ADDRESS) {
    await submit(curveWallet, {
      TransactionType: 'Payment',
      Account: curveWallet.address,
      Destination: PLATFORM_ADDRESS,
      Amount: xrpl.xrpToDrops(q.platform.toFixed(6)),
    });
  }

  tok.trades.push({ side: 'sell', user: userAddress, xrp: q.xrpOut, tokens: tokensIn, hash: paymentTxHash, settle: xrpHash, ts: Date.now(), price: curve.price(tok.state) });
  save();
  return { xrpOut: q.xrpOut, creatorFee: q.creator, platformFee: q.platform, settleTx: xrpHash };
}

// ---------- graduation: create native XRPL AMM, blackhole issuer ----------
async function graduate(tok) {
  const curveWallet = xrpl.Wallet.fromSeed(tok.curveSeed);
  const issuer = xrpl.Wallet.fromSeed(tok.issuerSeed);

  // keep a small reserve for fees; the rest of the raised XRP goes to the pool
  const xrpForPool = Math.max(tok.state.realXrp - 20, 10);

  await submit(curveWallet, {
    TransactionType: 'AMMCreate',
    Account: curveWallet.address,
    Amount: xrpl.xrpToDrops(xrpForPool.toFixed(6)),
    Amount2: tokenAmount(tok, curve.CONFIG.AMM_SUPPLY),
    TradingFee: 500, // 0.5% AMM trading fee
  });

  // blackhole the issuer: no more supply can ever be minted
  await submit(issuer, {
    TransactionType: 'SetRegularKey',
    Account: issuer.address,
    RegularKey: 'rrrrrrrrrrrrrrrrrrrrrhoLvTp',
  });
  await submit(issuer, {
    TransactionType: 'AccountSet',
    Account: issuer.address,
    SetFlag: xrpl.AccountSetAsfFlags.asfDisableMaster,
  });

  tok.ammCreated = true;
  save();
}

// ---------- API ----------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const publicToken = (tok) => ({
  id: tok.id, name: tok.name, ticker: tok.ticker, description: tok.description,
  currency: tok.currency, issuerAddress: tok.issuerAddress, curveAddress: tok.curveAddress,
  creatorAddress: tok.creatorAddress, createdAt: tok.createdAt,
  price: curve.price(tok.state), marketCapXrp: curve.marketCapXrp(tok.state),
  raisedXrp: tok.state.realXrp, tokensRemaining: tok.state.tokenReserve,
  progress: Math.min(100, (tok.state.realXrp / curve.CONFIG.GRADUATION_XRP) * 100),
  graduated: tok.state.graduated, ammCreated: tok.ammCreated,
  creatorFeesXrp: tok.state.creatorFeesXrp,
  trades: tok.trades.slice(-50),
  config: curve.CONFIG,
});

app.get('/api/tokens', (req, res) => {
  res.json(Object.values(db.tokens).map(publicToken).sort((a, b) => b.createdAt - a.createdAt));
});

app.get('/api/tokens/:id', (req, res) => {
  const tok = db.tokens[req.params.id];
  if (!tok) return res.status(404).json({ error: 'Not found' });
  res.json(publicToken(tok));
});

app.post('/api/launch', async (req, res) => {
  try {
    const { name, ticker, description, creatorAddress } = req.body;
    if (!name || !ticker || !creatorAddress) return res.status(400).json({ error: 'name, ticker, creatorAddress required' });
    if (!xrpl.isValidAddress(creatorAddress)) return res.status(400).json({ error: 'Invalid creator address' });
    const tok = await launchToken({ name, ticker, description, creatorAddress });
    res.json(publicToken(tok));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tokens/:id/quote', (req, res) => {
  try {
    const tok = db.tokens[req.params.id];
    if (!tok) return res.status(404).json({ error: 'Not found' });
    const { side, amount } = req.body;
    const s = JSON.parse(JSON.stringify(tok.state)); // quote on a copy
    const q = side === 'buy' ? curve.quoteBuy(s, Number(amount)) : curve.quoteSell(s, Number(amount));
    res.json(q);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/tokens/:id/buy', async (req, res) => {
  try {
    const tok = db.tokens[req.params.id];
    if (!tok) return res.status(404).json({ error: 'Not found' });
    res.json(await buy(tok, req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/tokens/:id/sell', async (req, res) => {
  try {
    const tok = db.tokens[req.params.id];
    if (!tok) return res.status(404).json({ error: 'Not found' });
    res.json(await sell(tok, req.body));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// testnet helper: create + fund a demo user wallet and set trustline, then trade
app.post('/api/testnet/demo-wallet', async (req, res) => {
  try {
    const c = await getClient();
    const { wallet } = await c.fundWallet();
    res.json({ address: wallet.address, seed: wallet.seed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// testnet helper: perform a buy end-to-end from a seed (signs the XRP payment server-side for demo only)
app.post('/api/testnet/demo-trade', async (req, res) => {
  try {
    const tok = db.tokens[req.body.id];
    if (!tok) return res.status(404).json({ error: 'Not found' });
    const user = xrpl.Wallet.fromSeed(req.body.seed);
    const side = req.body.side;

    if (!(await ensureTrustline(tok, user.address))) {
      await submit(user, {
        TransactionType: 'TrustSet',
        Account: user.address,
        LimitAmount: { currency: tok.currency, issuer: tok.issuerAddress, value: String(curve.CONFIG.TOTAL_SUPPLY) },
      });
    }

    const amount = side === 'buy'
      ? xrpl.xrpToDrops(Number(req.body.amount).toFixed(6))
      : tokenAmount(tok, Number(req.body.amount));

    const hash = await submit(user, {
      TransactionType: 'Payment',
      Account: user.address,
      Destination: tok.curveAddress,
      Amount: amount,
    });

    const result = side === 'buy'
      ? await buy(tok, { userAddress: user.address, paymentTxHash: hash })
      : await sell(tok, { userAddress: user.address, paymentTxHash: hash });
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`RiddleCreator running on http://localhost:${PORT} (${XRPL_WSS})`));
