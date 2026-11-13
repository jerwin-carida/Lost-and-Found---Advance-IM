import crypto from 'crypto';
import { config } from './config.js';

const KEY = Buffer.from(config.encryptionKey, 'hex');
if (KEY.length !== 32) {
  console.error('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with:\n' +
    "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

// AES-256-CBC. A fresh random IV per value; store ciphertext and IV in separate columns.
export function encrypt(text, key = KEY) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return { encrypted, iv };
}

export function decrypt(encrypted, iv, key = KEY) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function tryDecrypt(encrypted, iv) {
  try { return decrypt(encrypted, iv); } catch { return '(unreadable)'; }
}
