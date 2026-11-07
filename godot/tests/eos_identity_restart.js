'use strict';
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const binary = process.env.GODOT || '/Applications/Godot.app/Contents/MacOS/Godot';
const root = path.resolve(__dirname, '..');
const salt = crypto.randomBytes(32).toString('hex');
function run() {
  return new Promise((resolve, reject) => {
    const p = spawn(binary, ['--headless', '--log-file', '/dev/null', '--path', root, '-s', 'res://tests/eos_identity_digest.gd', '--', salt]);
    let out = ''; p.stdout.on('data', x => out += x); p.stderr.on('data', x => out += x);
    const timer = setTimeout(() => p.kill('SIGKILL'), 25000);
    p.on('error', reject); p.on('exit', status => { clearTimeout(timer); const m = out.match(/IDENTITY_CHECK:([a-f0-9]{64})/); resolve(status === 0 && m ? m[1] : null); });
  });
}
(async () => {
  const first = await run(), second = await run();
  if (!first || !second) { console.error('EOS identity restart: unavailable'); process.exitCode = 2; }
  else if (first !== second) { console.error('EOS identity restart: changed'); process.exitCode = 1; }
  else console.log('EOS identity restart: PASS on this macOS user profile');
})().catch(() => { console.error('EOS identity restart: error'); process.exitCode = 1; });
