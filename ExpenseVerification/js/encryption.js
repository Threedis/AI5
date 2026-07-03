/**
 * encryption.js — AES-256 encryption/decryption wrapper using CryptoJS
 * Employee Expense Verification System
 */

const Encryption = (() => {

  const KEY_SIZE   = 256 / 32;   // 8 words = 256 bits
  const IV_SIZE    = 128 / 32;   // 4 words = 128 bits
  const ITERATIONS = 10000;
  const SALT_LEN   = 16;         // bytes

  /* ── Derive a CryptoJS key from a passphrase + salt ─────── */
  function deriveKey(passphrase, salt) {
    return CryptoJS.PBKDF2(passphrase, salt, {
      keySize:    KEY_SIZE,
      iterations: ITERATIONS,
      hasher:     CryptoJS.algo.SHA256
    });
  }

  /* ── Encrypt a JSON-serializable object ─────────────────── */
  function encrypt(data, passphrase) {
    try {
      const json      = JSON.stringify(data);
      const salt      = CryptoJS.lib.WordArray.random(SALT_LEN);
      const iv        = CryptoJS.lib.WordArray.random(IV_SIZE * 4);
      const key       = deriveKey(passphrase, salt);
      const encrypted = CryptoJS.AES.encrypt(json, key, {
        iv,
        mode:    CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });

      /* Pack: salt(hex) + ":" + iv(hex) + ":" + ciphertext(base64) */
      return [
        salt.toString(CryptoJS.enc.Hex),
        iv.toString(CryptoJS.enc.Hex),
        encrypted.ciphertext.toString(CryptoJS.enc.Base64)
      ].join(':');
    } catch (err) {
      throw new Error(`Encryption failed: ${err.message}`);
    }
  }

  /* ── Decrypt back to original object ────────────────────── */
  function decrypt(ciphertext, passphrase) {
    try {
      const [saltHex, ivHex, ctBase64] = ciphertext.split(':');
      if (!saltHex || !ivHex || !ctBase64) throw new Error('Invalid ciphertext format');

      const salt = CryptoJS.enc.Hex.parse(saltHex);
      const iv   = CryptoJS.enc.Hex.parse(ivHex);
      const key  = deriveKey(passphrase, salt);
      const ct   = CryptoJS.lib.CipherParams.create({
        ciphertext: CryptoJS.enc.Base64.parse(ctBase64)
      });

      const decrypted = CryptoJS.AES.decrypt(ct, key, {
        iv,
        mode:    CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });

      const json = decrypted.toString(CryptoJS.enc.Utf8);
      if (!json) throw new Error('Decryption produced empty result — wrong passphrase?');
      return JSON.parse(json);
    } catch (err) {
      throw new Error(`Decryption failed: ${err.message}`);
    }
  }

  /* ── SHA-256 hash of a string (for integrity check) ─────── */
  function hash(data) {
    return CryptoJS.SHA256(
      typeof data === 'string' ? data : JSON.stringify(data)
    ).toString(CryptoJS.enc.Hex);
  }

  /* ── Verify hash matches ─────────────────────────────────── */
  function verifyHash(data, expectedHash) {
    return hash(data) === expectedHash;
  }

  /* ── Encrypt to a downloadable blob string ───────────────── */
  function encryptToBlob(data, passphrase) {
    const ct = encrypt(data, passphrase);
    return JSON.stringify({
      v:    1,
      alg:  'AES-256-CBC/PBKDF2-SHA256',
      ts:   new Date().toISOString(),
      hash: hash(data),
      ct
    });
  }

  /* ── Decrypt a blob string ───────────────────────────────── */
  function decryptFromBlob(blobStr, passphrase) {
    const blob = JSON.parse(blobStr);
    if (!blob.ct) throw new Error('Invalid backup format');
    const data = decrypt(blob.ct, passphrase);
    if (blob.hash && !verifyHash(data, blob.hash)) {
      throw new Error('Integrity check failed — data may be corrupted');
    }
    return { data, metadata: { ts: blob.ts, alg: blob.alg, hash: blob.hash } };
  }

  /* ── Get/create the app encryption key ──────────────────── */
  async function getAppKey() {
    let key = await Database.getSetting('encryptionKey');
    if (!key) {
      key = CryptoJS.lib.WordArray.random(32).toString(CryptoJS.enc.Hex);
      await Database.setSetting('encryptionKey', key);
    }
    return key;
  }

  /* ── Encrypt data using the stored app key ───────────────── */
  async function encryptWithAppKey(data) {
    const key = await getAppKey();
    return encrypt(data, key);
  }

  /* ── Decrypt data using the stored app key ───────────────── */
  async function decryptWithAppKey(ciphertext) {
    const key = await getAppKey();
    return decrypt(ciphertext, key);
  }

  return {
    encrypt, decrypt,
    hash, verifyHash,
    encryptToBlob, decryptFromBlob,
    getAppKey, encryptWithAppKey, decryptWithAppKey
  };
})();
