import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const setup = await readFile(new URL('../setup.sh', import.meta.url), 'utf8');
const selection = setup.slice(setup.indexOf('# Prefer the user'), setup.indexOf('# Install npm deps'));

test('setup selects nvm default from an older shell and pins the absolute executable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athan-setup-test-'));
  try {
    await mkdir(path.join(directory, '.nvm'));
    await writeFile(path.join(directory, '.nvm', 'nvm.sh'), 'nvm() { printf "%s\\n" "$TEST_RUNTIME"; }\n');
    const selected = spawnSync('bash', ['-c', `set -euo pipefail\n${selection}\nprintf 'SELECTED=%s\\n' "$NODE_BIN"`], {
      env: { ...process.env, PATH: '/usr/bin:/bin', RUN_HOME: directory, NODE_BIN: '', TEST_RUNTIME: process.execPath }, encoding: 'utf8'
    });
    assert.equal(selected.status, 0, selected.stderr);
    assert.ok(selected.stdout.includes(`SELECTED=${process.execPath}`));

    const serviceFunction = setup.slice(setup.indexOf('create_node_service_systemd()'), setup.indexOf('install_pm2_and_start()'));
    const service = spawnSync('bash', ['-c', `set -euo pipefail
tee() { cat >&2; }
systemctl() { printf 'systemctl %s\\n' "$*"; }
${serviceFunction}
create_node_service_systemd`], {
      env: { ...process.env, NODE_BIN: process.execPath, SERVICE_NAME: 'athan-test', RUN_USER: 'test', PROJECT_DIR: '/test', PORT: '3000', SUDO_CMD: '' }, encoding: 'utf8'
    });
    assert.equal(service.status, 0, service.stderr);
    assert.ok(service.stderr.includes(`ExecStart="${process.execPath}" server/index.js`));
    assert.ok(service.stdout.includes('systemctl restart athan-test'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('setup rejects outdated timezone data before changing services', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'athan-old-node-test-'));
  try {
    const oldNode = path.join(directory, 'old-node');
    await writeFile(oldNode, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${selection}`], {
      env: { ...process.env, NODE_BIN: oldNode, RUN_HOME: directory }, encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('outdated Vancouver timezone data'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
