const fs = require('fs');

function parseEnvFile(file) {
  const values = {};

  if (!file || !fs.existsSync(file)) return values;

  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();

    if (!line || line.startsWith('#')) continue;

    const index = line.indexOf('=');
    if (index < 1) continue;

    values[line.slice(0, index).trim()] = line.slice(index + 1);
  }

  return values;
}

function createRuntimeClient() {
  const baseUrl = String(
    process.env.JPV_COMPUTE_RUNTIME_URL ||
    'http://127.0.0.1:8787'
  ).replace(/\/+$/, '');

  const timeoutMs = Number(
    process.env.JPV_COMPUTE_RUNTIME_TIMEOUT_MS || 5000
  );

  const envFile =
    process.env.JPV_RUNTIME_ENV_FILE ||
    'C:\\ProgramData\\JPV\\Compute\\Runtime\\runtime.env';

  function token() {
    if (process.env.JPV_RUNTIME_EXECUTOR_TOKEN) {
      return String(process.env.JPV_RUNTIME_EXECUTOR_TOKEN).trim();
    }

    const runtimeEnv = parseEnvFile(envFile);

    const tokenFile =
      process.env.JPV_RUNTIME_EXECUTOR_TOKEN_FILE ||
      runtimeEnv.JPV_RUNTIME_EXECUTOR_TOKEN_FILE;

    if (!tokenFile) {
      throw new Error('JPV_RUNTIME_EXECUTOR_TOKEN_FILE_REQUIRED');
    }

    if (!fs.existsSync(tokenFile)) {
      throw new Error('JPV_RUNTIME_EXECUTOR_TOKEN_FILE_MISSING');
    }

    const value = fs.readFileSync(tokenFile, 'utf8').trim();

    if (!value) {
      throw new Error('JPV_RUNTIME_EXECUTOR_TOKEN_EMPTY');
    }

    return value;
  }

  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        accept: 'application/json',
        authorization: `Bearer ${token()}`,
        ...(options.headers || {})
      };

      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
        signal: controller.signal
      });

      const text = await response.text();

      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {
          error: 'JPV_RUNTIME_INVALID_JSON_RESPONSE'
        };
      }

      return {
        status: response.status,
        ok: response.ok,
        body
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        return {
          status: 504,
          ok: false,
          body: {
            error: 'JPV_RUNTIME_TIMEOUT'
          }
        };
      }

      return {
        status: 502,
        ok: false,
        body: {
          error: 'JPV_RUNTIME_UNREACHABLE'
        }
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async health() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/health`, {
          signal: controller.signal
        });

        const text = await response.text();

        let body;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = {};
        }

        return {
          status: response.status,
          ok: response.ok,
          body
        };
      } catch {
        return {
          status: 502,
          ok: false,
          body: {
            error: 'JPV_RUNTIME_UNREACHABLE'
          }
        };
      } finally {
        clearTimeout(timer);
      }
    },

    deploy(payload) {
      return request('/v1/runtime/deploy', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload || {})
      });
    },

    readback(executionId) {
      return request(
        `/v1/runtime/deploy/${encodeURIComponent(executionId)}`,
        { method: 'GET' }
      );
    }
  };
}

module.exports = {
  createRuntimeClient
};
