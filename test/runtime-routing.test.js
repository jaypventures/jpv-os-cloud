const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const repo = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address.port;

      server.close(error => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(url, attempts = 80) {
  let last;

  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }

    await wait(50);
  }

  throw last || new Error(`Timed out waiting for ${url}`);
}

function spawnNode(file, env) {
  const child = spawn(
    process.execPath,
    [file],
    {
      cwd: repo,
      env: {
        ...process.env,
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stderr = '';

  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });

  child._stderr = () => stderr;

  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;

  child.kill();

  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    wait(1500)
  ]);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

test(
  'Nexus routes deployment through Bus to canonical Compute Runtime with authenticated readback',
  async () => {
    const computePort = await freePort();
    const busPort = await freePort();
    const nexusPort = await freePort();

    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jpv-runtime-routing-')
    );

    const tokenFile = path.join(root, 'executor.token');
    fs.writeFileSync(tokenFile, 'test-runtime-token\n');

    const executionId = 'portable-test-execution';

    const compute = http.createServer(
      async (req, res) => {
        const url = new URL(
          req.url || '/',
          'http://localhost'
        );

        function json(status, body) {
          const data = Buffer.from(JSON.stringify(body));

          res.writeHead(status, {
            'content-type': 'application/json',
            'content-length': String(data.length)
          });

          res.end(data);
        }

        if (
          req.method === 'GET' &&
          url.pathname === '/health'
        ) {
          return json(200, {
            status: 'ok',
            runtimeTarget: 'jpv-native-primary',
            authoritativeJpvReadback: true,
            runtimeProviderAuthority: false
          });
        }

        if (
          req.headers.authorization !==
          'Bearer test-runtime-token'
        ) {
          return json(401, {
            error: 'UNAUTHORIZED'
          });
        }

        if (
          req.method === 'POST' &&
          url.pathname === '/v1/runtime/deploy'
        ) {
          const chunks = [];

          for await (const chunk of req) {
            chunks.push(chunk);
          }

          const body = JSON.parse(
            Buffer.concat(chunks).toString('utf8') || '{}'
          );

          if (body.operation_id === 'conflict') {
            return json(409, {
              error: 'RUNTIME_DEPLOY_IDEMPOTENCY_CONFLICT'
            });
          }

          return json(202, {
            execution_id: executionId,
            runtime_target: 'jpv-native-primary',
            activation_scheduled: false,
            idempotent_replay: false
          });
        }

        if (
          req.method === 'GET' &&
          url.pathname ===
            `/v1/runtime/deploy/${executionId}`
        ) {
          return json(200, {
            execution_id: executionId,
            status: 'DEPLOYED_AND_VERIFIED',
            runtime_target: 'jpv-native-primary',
            canonical_boundary: 'JPV',
            exact_revision_match: true,
            health_status: 'ok'
          });
        }

        return json(404, {
          error: 'NOT_FOUND'
        });
      }
    );

    await new Promise((resolve, reject) => {
      compute.once('error', reject);
      compute.listen(
        computePort,
        '127.0.0.1',
        resolve
      );
    });

    const bus = spawnNode(
      path.join(repo, 'bus', 'server.js'),
      {
        PORT: String(busPort),
        JPV_COMPUTE_RUNTIME_URL:
          `http://127.0.0.1:${computePort}`,
        JPV_RUNTIME_EXECUTOR_TOKEN_FILE:
          tokenFile,
        JPV_COMPUTE_RUNTIME_TIMEOUT_MS: '1500',
        LEDGER_URL: 'http://127.0.0.1:1'
      }
    );

    const nexus = spawnNode(
      path.join(repo, 'nexus', 'server.js'),
      {
        PORT: String(nexusPort),
        JPV_BUS_URL:
          `http://127.0.0.1:${busPort}`,
        BUS_URL:
          `http://127.0.0.1:${busPort}`,
        JPV_BUS_TIMEOUT_MS: '1500'
      }
    );

    try {
      await waitFor(
        `http://127.0.0.1:${busPort}/runtime/health`
      );

      await waitFor(
        `http://127.0.0.1:${nexusPort}/runtime/health`
      );

      const deploy = await fetch(
        `http://127.0.0.1:${nexusPort}/command`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            type: 'runtime.deploy',
            payload: {
              operation_id: 'jpv-routing-test',
              candidate_sha:
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              runtime_target: 'jpv-native-primary'
            }
          })
        }
      );

      assert.equal(deploy.status, 202);

      const deployBody = await deploy.json();

      assert.equal(deployBody.executed, true);
      assert.equal(
        deployBody.execution_id,
        executionId
      );
      assert.equal(
        deployBody.jpv_runtime_authority,
        true
      );
      assert.equal(
        deployBody.provider_authority,
        false
      );

      const readback = await fetch(
        `http://127.0.0.1:${nexusPort}` +
        `/readback/runtime/${executionId}`
      );

      assert.equal(readback.status, 200);

      const receipt = await readback.json();

      assert.equal(
        receipt.execution_id,
        executionId
      );
      assert.equal(
        receipt.status,
        'DEPLOYED_AND_VERIFIED'
      );
      assert.equal(
        receipt.exact_revision_match,
        true
      );

      const conflict = await fetch(
        `http://127.0.0.1:${nexusPort}/command`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            type: 'runtime.deploy',
            payload: {
              operation_id: 'conflict',
              candidate_sha:
                'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              runtime_target: 'jpv-native-primary'
            }
          })
        }
      );

      assert.equal(conflict.status, 409);

      const conflictBody = await conflict.json();

      assert.equal(
        conflictBody.executed,
        false
      );

      assert.equal(
        conflictBody.error,
        'RUNTIME_DEPLOY_IDEMPOTENCY_CONFLICT'
      );
    } finally {
      await stop(nexus);
      await stop(bus);

      await new Promise(resolve => {
        compute.close(() => resolve());
      });

      fs.rmSync(root, {
        recursive: true,
        force: true
      });
    }
  }
);
