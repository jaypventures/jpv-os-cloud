const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const processes = [];

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function start(script, env) {
  const child = spawn(
    process.execPath,
    [path.join(repo, script)],
    {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });

  child.logs = () => ({ stdout, stderr });
  processes.push(child);

  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;

  child.kill();

  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

async function health(url, child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) {
      const logs = child.logs();
      throw new Error(
        `Service exited (${child.exitCode})\n` +
        `STDOUT:\n${logs.stdout}\nSTDERR:\n${logs.stderr}`
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = await response.json();
        if (body.status === 'ok') return body;
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Health timeout: ${url}`);
}

test.after(async () => {
  for (const child of processes) {
    await stop(child);
  }
});

test(
  'Nexus admission survives Ledger restart without false acknowledgement',
  { timeout: 30000 },
  async () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jpvci-')
    );

    const ledgerPort = await freePort();
    const busPort = await freePort();
    const nexusPort = await freePort();

    let ledger = start('ledger/server.js', {
      PORT: String(ledgerPort),
      JPV_STATE_DIR: stateDir
    });

    const ledgerHealth = await health(
      `http://127.0.0.1:${ledgerPort}/health`,
      ledger
    );

    assert.equal(ledgerHealth.authority, 'durable');

    const bus = start('bus/server.js', {
      PORT: String(busPort),
      LEDGER_URL: `http://127.0.0.1:${ledgerPort}`
    });

    const busHealth = await health(
      `http://127.0.0.1:${busPort}/health`,
      bus
    );

    assert.equal(
      busHealth.admission,
      'persistence-confirmed'
    );

    const nexus = start('nexus/server.js', {
      PORT: String(nexusPort),
      BUS_URL: `http://127.0.0.1:${busPort}`
    });

    const nexusHealth = await health(
      `http://127.0.0.1:${nexusPort}/health`,
      nexus
    );

    assert.equal(
      nexusHealth.execution,
      'authoritative-admission'
    );

    const id = `jpvci-${Date.now()}-${process.pid}`;

    const command = {
      id,
      type: 'jpvci.persistence',
      payload: {
        authority: 'JPV',
        test: 'restart-survival'
      }
    };

    const admitResponse = await fetch(
      `http://127.0.0.1:${nexusPort}/command`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command)
      }
    );

    assert.equal(admitResponse.status, 201);

    const admitted = await admitResponse.json();

    assert.equal(admitted.executed, true);
    assert.equal(admitted.admitted, true);
    assert.equal(admitted.durable, true);
    assert.equal(admitted.duplicate, false);
    assert.equal(admitted.id, id);

    const stateFile = path.join(stateDir, 'ledger.json');

    assert.equal(fs.existsSync(stateFile), true);

    let state = JSON.parse(
      fs.readFileSync(stateFile, 'utf8')
    );

    assert.equal(state.events.length, 1);
    assert.equal(state.events[0].id, id);

    const duplicateResponse = await fetch(
      `http://127.0.0.1:${nexusPort}/command`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command)
      }
    );

    assert.equal(duplicateResponse.status, 200);

    const duplicate = await duplicateResponse.json();

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.id, id);

    state = JSON.parse(
      fs.readFileSync(stateFile, 'utf8')
    );

    assert.equal(state.events.length, 1);

    await stop(ledger);

    const falseAck = await fetch(
      `http://127.0.0.1:${nexusPort}/command`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: `${id}-offline`,
          type: 'jpvci.must-fail',
          payload: {}
        })
      }
    );

    assert.equal(falseAck.ok, false);

    ledger = start('ledger/server.js', {
      PORT: String(ledgerPort),
      JPV_STATE_DIR: stateDir
    });

    const restarted = await health(
      `http://127.0.0.1:${ledgerPort}/health`,
      ledger
    );

    assert.equal(restarted.eventCount, 1);

    const readbackResponse = await fetch(
      `http://127.0.0.1:${ledgerPort}/event/${id}`
    );

    assert.equal(readbackResponse.status, 200);

    const readback = await readbackResponse.json();

    assert.equal(readback.found, true);
    assert.equal(readback.record.id, id);
    assert.equal(
      readback.record.event.type,
      'jpvci.persistence'
    );
    assert.equal(
      readback.record.event.payload.authority,
      'JPV'
    );

    fs.rmSync(stateDir, {
      recursive: true,
      force: true
    });
  }
);
