
// JPV_RUNTIME_ROUTING_V1
const { createRuntimeClient } = require('./runtime-client');
const jpvRuntimeClient = createRuntimeClient();
const express = require('express');

const app = express();
const port = Number(process.env.PORT) || 3001;
const ledgerUrl = process.env.LEDGER_URL;

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
    service: 'bus',
    status: 'ok',
    ledgerUrl: ledgerUrl || null,
    admission: 'persistence-confirmed'
  });
});

app.post('/event', async (req, res) => {
  const event = req.body;

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return res.status(400).json({
      admitted: false,
      error: 'Event must be a JSON object'
    });
  }

  if (!ledgerUrl) {
    return res.status(503).json({
      admitted: false,
      error: 'LEDGER_URL is not configured'
    });
  }

  try {
    const response = await fetch(
      `${ledgerUrl.replace(/\/$/, '')}/event`,
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

    if (!response.ok || !result || result.stored !== true) {
      console.error(
        'BUS admission rejected:',
        response.status,
        JSON.stringify(result)
      );

      return res.status(502).json({
        admitted: false,
        ledgerStatus: response.status,
        ledger: result
      });
    }

    return res.status(response.status === 201 ? 201 : 200).json({
      admitted: true,
      durable: true,
      duplicate: result.duplicate === true,
      id: result.id,
      eventCount: result.eventCount
    });
  } catch (error) {
    console.error('BUS admission failure:', error.message);

    return res.status(502).json({
      admitted: false,
      error: 'Authoritative ledger unavailable'
    });
  }
});


// JPV_RUNTIME_ROUTING_V1_ROUTES
app.get('/runtime/health', async (_req, res) => {
  const result = await jpvRuntimeClient.health();
  return res.status(result.status).json(result.body);
});

app.post('/runtime/deploy', async (req, res) => {
  const result = await jpvRuntimeClient.deploy(req.body);

  return res.status(result.status).json({
    ...result.body,
    jpv_runtime_authority: true,
    provider_authority: false
  });
});

app.get('/runtime/deploy/:executionId', async (req, res) => {
  const result = await jpvRuntimeClient.readback(
    req.params.executionId
  );

  return res.status(result.status).json({
    ...result.body,
    jpv_runtime_authority: true,
    provider_authority: false
  });
});
app.listen(port, '0.0.0.0', () => {
  console.log(
    `BUS listening on 0.0.0.0:${port}; ` +
    'admission=persistence-confirmed'
  );
});
