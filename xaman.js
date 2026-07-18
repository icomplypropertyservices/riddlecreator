// Xaman (XUMM) payload integration — users sign payments in their own wallet.
// Requires XUMM_API_KEY + XUMM_API_SECRET from https://apps.xumm.dev
const { XummSdk } = require('xumm-sdk');

let sdk = null;
if (process.env.XUMM_API_KEY && process.env.XUMM_API_SECRET) {
  sdk = new XummSdk(process.env.XUMM_API_KEY, process.env.XUMM_API_SECRET);
}

const enabled = () => !!sdk;

// Create a sign request for a Payment; returns { uuid, qrPng, deeplink }
async function createPaymentPayload({ destination, destinationTag, amount, memo }) {
  if (!sdk) throw new Error('Xaman not configured on this server');
  const txjson = { TransactionType: 'Payment', Destination: destination, Amount: amount };
  if (destinationTag != null) txjson.DestinationTag = destinationTag;
  if (memo) txjson.Memos = [{ Memo: { MemoData: Buffer.from(memo, 'utf8').toString('hex').toUpperCase() } }];
  const payload = await sdk.payload.create({ txjson });
  return { uuid: payload.uuid, qrPng: payload.refs.qr_png, deeplink: payload.next.always };
}

// Poll a payload; returns { resolved, signed, txid, account }
async function getPayloadResult(uuid) {
  if (!sdk) throw new Error('Xaman not configured on this server');
  const p = await sdk.payload.get(uuid);
  return {
    resolved: p.meta.resolved,
    signed: p.meta.signed,
    txid: p.response?.txid || null,
    account: p.response?.account || null,
  };
}

module.exports = { enabled, createPaymentPayload, getPayloadResult };
