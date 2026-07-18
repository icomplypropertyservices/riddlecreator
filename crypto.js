// AES-256-GCM encryption for wallet seeds at rest.
// MASTER_KEY must be a 64-char hex string (32 bytes). Generate once:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const crypto = require('crypto');

const KEY_HEX = process.env.MASTER_KEY;
if (!KEY_HEX || KEY_HEX.length !== 64) {
  throw new Error('MASTER_KEY env var required (64 hex chars). Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}
const KEY = Buffer.from(KEY_HEX, 'hex');

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${enc.toString('hex')}`;
}

function decrypt(blob) {
  const [ivH, tagH, dataH] = blob.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivH, 'hex'));
  decipher.setAuthTag(Buffer.from(tagH, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataH, 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
