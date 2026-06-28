const express = require('express');

const app = express();
const port = Number(process.env.PORT) || 3002;
const events = [];

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
  res.status(200).json({ service: 'ledger', status: 'ok', eventCount: events.length });
});

app.post('/event', (req, res) => {
  events.push(req.body);
  res.status(201).json({ stored: true, eventCount: events.length });
});

app.get('/replay', (req, res) => {
  res.status(200).json({ events });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`LEDGER listening on 0.0.0.0:${port}`);
});
