const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = Number(process.env.PORT) || 3002;

const stateDir = path.resolve(
  process.env.JPV_STATE_DIR || path.join(__dirname, '..', 'data')
);
const ledgerPath = path.join(stateDir, 'ledger.json');

fs.mkdirSync(stateDir, { recursive: true });

function loadState() {
  if (!fs.existsSync(ledgerPath)) {
    return { version: 1, events: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.events)) {
    throw new Error('Invalid canonical ledger state');
  }

  return parsed;
}

let state = loadState();

function persistState(nextState) {
  const tempPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(nextState, null, 2) + '\n';

  fs.writeFileSync(tempPath, payload, {
    encoding: 'utf8',
    flag: 'wx'
  });

  fs.renameSync(tempPath, ledgerPath);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }

  return value;
}

function eventId(event) {
  if (event && typeof event.id === 'string' && event.id.trim()) {
    return event.id.trim();
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(event)))
    .digest('hex');
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    service: 'ledger',
    status: 'ok',
    authority: 'durable',
    eventCount: state.events.length,
    statePath: ledgerPath
  });
});

app.post('/event', (req, res) => {
  try {
    const incoming = req.body;

    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({
        error: 'Event must be a JSON object'
      });
    }

    const id = eventId(incoming);
    const existing = state.events.find(entry => entry.id === id);

    if (existing) {
      return res.status(200).json({
        stored: true,
        duplicate: true,
        id,
        eventCount: state.events.length
      });
    }

    const record = {
      id,
      admittedAt: new Date().toISOString(),
      event: incoming
    };

    const nextState = {
      version: 1,
      events: [...state.events, record]
    };

    persistState(nextState);
    state = nextState;

    return res.status(201).json({
      stored: true,
      duplicate: false,
      id,
      eventCount: state.events.length
    });
  } catch (error) {
    console.error('LEDGER persistence failure:', error);

    return res.status(500).json({
      stored: false,
      error: 'Canonical persistence failed'
    });
  }
});

app.get('/replay', (req, res) => {
  res.status(200).json({
    version: state.version,
    events: state.events
  });
});

app.get('/event/:id', (req, res) => {
  const record = state.events.find(entry => entry.id === req.params.id);

  if (!record) {
    return res.status(404).json({ found: false });
  }

  res.status(200).json({
    found: true,
    record
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(
    `LEDGER listening on 0.0.0.0:${port}; ` +
    `authority=${ledgerPath}; events=${state.events.length}`
  );
});
