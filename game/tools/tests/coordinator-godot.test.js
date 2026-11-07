'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Coordinator, makeServer } = require('../../server/coordinator');

test('Godot communicates with coordinator over loopback HTTP', { timeout: 30000 }, async () => {
  const server = makeServer(new Coordinator());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const root = path.resolve(__dirname, '../../../godot');
    const binary = process.env.GODOT || '/Applications/Godot.app/Contents/MacOS/Godot';
    const child = spawn(binary, ['--headless', '--path', root, '-s', 'res://tests/test_coordinator_client.gd', '--', 'http://127.0.0.1:' + server.address().port]);
    let output = ''; child.stdout.on('data', c => { output += c; if (process.env.MIG_DEBUG) process.stderr.write(c); }); child.stderr.on('data', c => { output += c; if (process.env.MIG_DEBUG) process.stderr.write(c); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(status, 0, output);
    assert.match(output, /PASS coordinator client/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Godot restores Node room after host loss via coordinator and loopback transport', { timeout: 85000 }, async () => {
  const server = makeServer(new Coordinator());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const root = path.resolve(__dirname, '../../../godot');
    const binary = process.env.GODOT || '/Applications/Godot.app/Contents/MacOS/Godot';
    const child = spawn(binary, ['--headless', '--path', root, '-s', 'res://tests/test_coordinator_migration.gd', '--', 'http://127.0.0.1:' + server.address().port]);
    let output = ''; child.stdout.on('data', c => { output += c; if (process.env.MIG_DEBUG) process.stderr.write(c); }); child.stderr.on('data', c => { output += c; if (process.env.MIG_DEBUG) process.stderr.write(c); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 75000);
    const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    clearTimeout(timer);
    assert.equal(status, 0, output);
    assert.match(output, /PASS unexpected host loss/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
for (const [count, phase] of [[3, 'game'], [4, 'game'], [2, 'lobby'], [3, 'lobby-leave'], [3, 'game-failcandidate']]) {
  test(`migration with ${count} clients during ${phase}`, { timeout: 90000 }, async () => {
    const server = makeServer(new Coordinator());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const root = path.resolve(__dirname, '../../../godot');
      const binary = process.env.GODOT || '/Applications/Godot.app/Contents/MacOS/Godot';
      const child = spawn(binary, ['--headless', '--path', root, '-s', 'res://tests/test_coordinator_multi_migration.gd', '--', 'http://127.0.0.1:' + server.address().port, String(count), phase]);
      let output = ''; child.stdout.on('data', c => { output += c; if (process.env.MIG_DEBUG) process.stderr.write(c); }); child.stderr.on('data', c => { output += c; if (process.env.MIG_DEBUG) process.stderr.write(c); });
      const timer = setTimeout(() => child.kill('SIGKILL'), 80000);
      const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      clearTimeout(timer);
      assert.equal(status, 0, output);
      assert.match(output, /PASS migration clients=/);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
}
