'use strict';
// 'enc2:' secrets: AES-256-GCM, iv(12) | tag(16) | ciphertext, base64. The 32-byte data key is
// stored keychain-encrypted in userData/secret-key.bin (see backend/host-services.js).
const crypto = require('crypto');

function aesEncrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return 'enc2:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function aesDecrypt(key, stored) {
  const raw = Buffer.from(String(stored).slice(5), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { aesEncrypt, aesDecrypt };
