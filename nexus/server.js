const express = require('express');

const app = express();
const port = Number(process.env.PORT) || 3000;
const busUrl = process.env.BUS_URL;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    service: 'nexus',
    status: 'ok',
    busUrl: busUrl || null,
    execution: 'authoritative-admission'
  });
});


// JPV_RUNTIME_NEXUS_V1
const jpvRuntimeBusUrl = String(
  process.env.JPV_BUS_URL ||
  process.env.BUS_URL ||
  'http://127.0.0.1:3001'
).replace(/\/+$/, '');

const jpvRuntimeBusTimeoutMs = Number(
  process.env.JPV_BUS_TIMEOUT_MS || 5000
);

async function jpvRuntimeBusRequest(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    jpvRuntimeBusTimeoutMs
  );

  try {
    const response = await fetch(
      `${jpvRuntimeBusUrl}${path}`,
      {
        ...options,
        signal: controller.signal
      }
    );

    const text = await response.text();

    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {
        error: 'JPV_BUS_INVALID_JSON_RESPONSE'
      };
    }

    return {
      status: response.status,
      body
    };
  } catch (error) {
    return {
      status: error?.name === 'AbortError' ? 504 : 502,
      body: {
        error:
          error?.name === 'AbortError'
            ? 'JPV_BUS_TIMEOUT'
            : 'JPV_BUS_UNREACHABLE'
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

// Runtime deployment commands are intercepted before the generic
// durable event path because this command has an existing canonical
// execution authority: jpv-native-primary.
app.post('/command', async (req, res, next) => {
  if (req.body?.type !== 'runtime.deploy') {
    return next();
  }

  if (
    !req.body.payload ||
    typeof req.body.payload !== 'object'
  ) {
    return res.status(400).json({
      error: 'RUNTIME_DEPLOY_PAYLOAD_REQUIRED'
    });
  }

  const result = await jpvRuntimeBusRequest(
    '/runtime/deploy',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body.payload)
    }
  );

  return res.status(result.status).json({
    executed: result.status >= 200 && result.status < 300,
    command: 'runtime.deploy',
    ...result.body
  });
});

app.get(
  '/readback/runtime/:executionId',
  async (req, res) => {
    const result = await jpvRuntimeBusRequest(
      `/runtime/deploy/${encodeURIComponent(
        req.params.executionId
      )}`,
      {
        method: 'GET'
      }
    );

    return res.status(result.status).json(result.body);
  }
);

app.get('/runtime/health', async (_req, res) => {
  const result = await jpvRuntimeBusRequest(
    '/runtime/health',
    {
      method: 'GET'
    }
  );

  return res.status(result.status).json(result.body);
});
app.post('/command', async (req, res) => {
  const command = req.body;

  if (
    !command ||
    typeof command !== 'object' ||
    Array.isArray(command) ||
    typeof command.type !== 'string' ||
    !command.type.trim() ||
    !Object.prototype.hasOwnProperty.call(command, 'payload')
  ) {
    return res.status(400).json({
      executed: false,
      error: 'Command requires non-empty type and payload'
    });
  }

  if (!busUrl) {
    return res.status(503).json({
      executed: false,
      error: 'BUS_URL is not configured'
    });
  }

  const event = {
    type: command.type.trim(),
    payload: command.payload
  };

  if (typeof command.id === 'string' && command.id.trim()) {
    event.id = command.id.trim();
  }

  try {
    const response = await fetch(
      `${busUrl.replace(/\/$/, '')}/event`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      }
    );

    let result = null;

    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (
      !response.ok ||
      !result ||
      result.admitted !== true ||
      result.durable !== true ||
      !result.id
    ) {
      console.error(
        'NEXUS authoritative execution rejected:',
        response.status,
        JSON.stringify(result)
      );

      return res.status(502).json({
        executed: false,
        admitted: false,
        busStatus: response.status,
        bus: result
      });
    }

    return res.status(response.status === 201 ? 201 : 200).json({
      executed: true,
      admitted: true,
      durable: true,
      duplicate: result.duplicate === true,
      id: result.id,
      eventCount: result.eventCount
    });
  } catch (error) {
    console.error(
      'NEXUS execution failure:',
      error.message
    );

    return res.status(502).json({
      executed: false,
      admitted: false,
      error: 'Authoritative bus unavailable'
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(
    `NEXUS listening on 0.0.0.0:${port}; ` +
    'execution=authoritative-admission'
  );
});
