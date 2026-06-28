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
  res.status(200).json({ service: 'nexus', status: 'ok', busUrl: busUrl || null });
});

app.post('/command', async (req, res) => {
  const event = req.body;

  if (!event || typeof event !== 'object' || !('type' in event) || !('payload' in event)) {
    return res.status(400).json({ error: 'Invalid event: expected object with type and payload' });
  }

  if (!busUrl) {
    return res.status(500).json({ error: 'BUS_URL is not configured' });
  }

  try {
    const response = await fetch(`${busUrl.replace(/\/$/, '')}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });

    if (!response.ok) {
      return res.status(502).json({
        error: 'Failed to forward event to bus',
        status: response.status
      });
    }

    res.status(202).json({ status: 'accepted' });
  } catch (error) {
    res.status(502).json({ error: 'Bus unavailable', details: error.message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`NEXUS listening on 0.0.0.0:${port}`);
});
