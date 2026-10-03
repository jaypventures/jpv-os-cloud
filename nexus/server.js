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
