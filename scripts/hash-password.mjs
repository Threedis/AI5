#!/usr/bin/env node
/**
 * hash-password.mjs — generate a password_hash / password_salt pair for the
 * profiles table, and print the SQL to apply it.
 *
 * The hashing is not reimplemented here: this imports hashPassword() from
 * functions/api/_lib/auth.js, the same module the Worker runs, so the two can
 * never drift. That module only needs Web Crypto, TextEncoder and console,
 * all of which Node has as globals — no Workers runtime required.
 *
 * Usage:
 *   node scripts/hash-password.mjs                     # generate a random password
 *   node scripts/hash-password.mjs --stdin             # read the password from stdin
 *   node scripts/hash-password.mjs 'My Password'       # use the given password
 *   node scripts/hash-password.mjs --user ravi --stdin # target a specific username
 *
 * Prefer --stdin over the positional form: an argument is visible in your
 * shell history and to anything reading the process list.
 *
 *   node scripts/hash-password.mjs --stdin <<< 'My Password'
 *
 * Applying the result (evs-db is the D1 `database_name`, not the Pages
 * project name — drop --remote to hit the local dev database instead):
 *
 *   npx wrangler d1 execute evs-db --remote --command="<the printed SQL>"
 */
import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from '../ExpenseVerification/functions/api/_lib/auth.js';

/* The pair documented in seed.sql (admin / Admin@1234). Verifying it on every
   run is a live check that this script and the login endpoint still agree — if
   auth.js changes its iteration count, digest or encoding, this fails loudly
   here instead of silently minting hashes that can't log in. */
const SEED_PASSWORD = 'Admin@1234';
const SEED_HASH = '8ea78d166a2cd3b897f4ecb503f8d84504a4b8b21b2b714e78630f88c504150c';
const SEED_SALT = 'e13d627b9c975d7048939b49d158d0e1';

/* Ambiguous glyphs (0/O, 1/l/I) dropped so a generated password survives being
   read off a screen and retyped. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generatePassword(groups = 4, size = 4) {
  const bytes = crypto.randomFillSync(new Uint32Array(groups * size));
  const chars = [...bytes].map(v => ALPHABET[v % ALPHABET.length]);
  return Array.from({ length: groups }, (_, i) => chars.slice(i * size, (i + 1) * size).join('')).join('-');
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  // Trailing newline only — leading/inner whitespace could be deliberate.
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function parseArgs(argv) {
  const opts = { user: null, stdin: false, password: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stdin') opts.stdin = true;
    else if (arg === '--user') opts.user = argv[++i] ?? null;
    else if (arg.startsWith('--user=')) opts.user = arg.slice(7);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else opts.password = arg;
  }
  return opts;
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(`Usage: node scripts/hash-password.mjs [password] [--stdin] [--user <username>]

  (no args)          generate a random password
  --stdin            read the password from stdin (keeps it out of shell history)
  --user <username>  target this username in the printed SQL (default: admin)
  password           use this password (visible in shell history — prefer --stdin)`);
    return 0;
  }

  if (!(await verifyPassword(SEED_PASSWORD, SEED_HASH, SEED_SALT))) {
    console.error('FAILED: auth.js no longer reproduces the known seed.sql hash.');
    console.error('Hashes from this script would not authenticate. Fix auth.js or update');
    console.error('SEED_HASH/SEED_SALT here if the scheme was changed deliberately.');
    return 1;
  }

  let password = opts.password;
  let generated = false;

  if (opts.stdin) {
    if (password !== null) throw new Error('Pass a password as an argument or via --stdin, not both.');
    password = await readStdin();
    if (!password) throw new Error('No password received on stdin.');
  } else if (password === null) {
    password = generatePassword();
    generated = true;
  }

  const { hash, salt } = await hashPassword(password);

  // Cheap insurance that what we print actually authenticates.
  if (!(await verifyPassword(password, hash, salt))) {
    console.error('FAILED: generated hash does not verify against its own password.');
    return 1;
  }

  const username = opts.user || 'admin';
  const sql = `update profiles set password_hash = ${sqlQuote(hash)}, password_salt = ${sqlQuote(salt)} where username = ${sqlQuote(username)};`;

  console.log(`\n  username : ${username}`);
  console.log(`  password : ${generated ? password : '(as supplied)'}`);
  console.log(`  hash     : ${hash}`);
  console.log(`  salt     : ${salt}`);
  console.log('\nSQL:\n');
  console.log(sql);
  console.log('\nApply with:\n');
  console.log(`  npx wrangler d1 execute evs-db --remote --command="${sql.replace(/"/g, '\\"')}"`);
  console.log('\nThe update affects nothing if that username does not exist — check with:\n');
  console.log('  npx wrangler d1 execute evs-db --remote --command="select username, role, status from profiles"');
  console.log('\nExisting sessions stay valid; revoke them with:\n');
  console.log('  npx wrangler d1 execute evs-db --remote --command="delete from sessions"\n');
  return 0;
}

main()
  .then(code => process.exit(code))
  .catch(err => { console.error(`Error: ${err.message}`); process.exit(1); });
