// RiddleCreator — bonding curve engine (pump.fun style, XRP units)
// Constant product with virtual reserves: (vXrp + realXrp) * tokenReserve = k

const CONFIG = {
  TOTAL_SUPPLY: 1_000_000_000,        // tokens minted per launch
  CURVE_SUPPLY: 800_000_000,          // sold on the curve
  AMM_SUPPLY: 200_000_000,            // reserved for AMM at graduation
  VIRTUAL_XRP: 1_800,                 // virtual XRP reserve (sets starting price)
  GRADUATION_XRP: 5_000,              // real XRP raised to graduate
  PLATFORM_FEE_BPS: 100,              // 1.00% platform fee per trade
  CREATOR_FEE_BPS: 100,               // 1.00% creator fee per trade
};

function newCurveState() {
  return {
    realXrp: 0,                          // XRP actually in the curve
    tokenReserve: CONFIG.CURVE_SUPPLY,   // tokens left on the curve
    k: CONFIG.VIRTUAL_XRP * CONFIG.CURVE_SUPPLY,
    graduated: false,
    creatorFeesXrp: 0,
    platformFeesXrp: 0,
  };
}

function price(state) {
  // marginal price in XRP per token
  const x = CONFIG.VIRTUAL_XRP + state.realXrp;
  return (x * x) / state.k;
}

function marketCapXrp(state) {
  return price(state) * CONFIG.TOTAL_SUPPLY;
}

function fees(amountXrp) {
  const platform = (amountXrp * CONFIG.PLATFORM_FEE_BPS) / 10_000;
  const creator = (amountXrp * CONFIG.CREATOR_FEE_BPS) / 10_000;
  return { platform, creator, net: amountXrp - platform - creator };
}

// Buy: spend xrpIn (gross), receive tokens
function quoteBuy(state, xrpIn) {
  if (state.graduated) throw new Error('Token has graduated — trade on the AMM');
  const f = fees(xrpIn);
  const x0 = CONFIG.VIRTUAL_XRP + state.realXrp;
  const x1 = x0 + f.net;
  const newTokenReserve = state.k / x1;
  let tokensOut = state.tokenReserve - newTokenReserve;
  if (tokensOut > state.tokenReserve) tokensOut = state.tokenReserve;
  return { tokensOut, ...f };
}

function applyBuy(state, xrpIn) {
  const q = quoteBuy(state, xrpIn);
  state.realXrp += q.net;
  state.tokenReserve -= q.tokensOut;
  state.creatorFeesXrp += q.creator;
  state.platformFeesXrp += q.platform;
  if (state.realXrp >= CONFIG.GRADUATION_XRP || state.tokenReserve <= 0) {
    state.graduated = true;
  }
  return q;
}

// Sell: send tokensIn, receive XRP (fees taken from XRP proceeds)
function quoteSell(state, tokensIn) {
  if (state.graduated) throw new Error('Token has graduated — trade on the AMM');
  const t1 = state.tokenReserve + tokensIn;
  const x1 = state.k / t1;
  const xrpGross = (CONFIG.VIRTUAL_XRP + state.realXrp) - x1;
  if (xrpGross > state.realXrp) throw new Error('Insufficient curve liquidity');
  const f = fees(xrpGross);
  return { xrpOut: f.net, xrpGross, platform: f.platform, creator: f.creator };
}

function applySell(state, tokensIn) {
  const q = quoteSell(state, tokensIn);
  state.tokenReserve += tokensIn;
  state.realXrp -= q.xrpGross;
  state.creatorFeesXrp += q.creator;
  state.platformFeesXrp += q.platform;
  return q;
}

module.exports = { CONFIG, newCurveState, price, marketCapXrp, quoteBuy, applyBuy, quoteSell, applySell };
