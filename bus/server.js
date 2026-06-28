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
  res.status(200).json({ service: 'bus', status: 'ok', ledgerUrl: ledgerUrl || null });
});

app.post('/event', (req, res) => {
  const event = req.body;

  console.log('BUS received event:', JSON.stringify(event));

  if (!ledgerUrl) {
    return res.status(500).json({ error: 'LEDGER_URL is not configured' });
  }

  setImmediate(async () => {
    try {
      const response = await fetch(`${ledgerUrl.replace(/\/$/, '')}/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });

      if (!response.ok) {
        console.error('BUS failed to forward event:', response.status);
      }
    } catch (error) {
      console.error('BUS forward error:', error.message);
    }
  });

  res.status(202).json({ status: 'queued' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`BUS listening on 0.0.0.0:${port}`);
});
