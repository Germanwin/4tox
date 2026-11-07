/* Local-only helper called before the new host starts its Node server.
   Arguments contain paths and numeric player id only, never token values. */
'use strict';
const fs = require('fs');
const migration = require('./migration-bundle');
let stage = 'arguments';
(async () => {
  const [file, root, id] = process.argv.slice(2);
  if (!file || !root || !/^\d+$/.test(id || '')) throw new Error('invalid_arguments');
  stage = 'read';
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof payload.data !== 'string' || typeof payload.sha256 !== 'string') throw new Error('invalid_payload');
  stage = 'decode';
  const bundle = migration.decode(Buffer.from(payload.data, 'base64'), payload.sha256, payload.codec);
  stage = 'restore';
  await migration.importBundle(root, bundle, Number(id));
})().catch((e) => {
  const reason = String(e && e.message || 'error');
  const safe = /^migration_[a-z_]+$/.test(reason) ? reason : (/^E[A-Z]+$/.test(String(e && e.code || '')) ? e.code : (e instanceof TypeError ? 'type_error' : 'import_failed'));
  process.stderr.write(stage + ':' + safe + '\n');
  process.exitCode = 1;
});
