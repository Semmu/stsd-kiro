const express = require('express');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.get('/api/status', (req, res) => {
  res.json({
    message: 'STSD (Spotify True Shuffle Daemon) is running',
    version: '1.0.0'
  });
});

// Placeholder for shuffle control endpoints
app.post('/api/shuffle/start', (req, res) => {
  // TODO: Implement shuffle start logic
  res.json({ message: 'Shuffle started', contextId: req.body.contextId });
});

app.post('/api/shuffle/stop', (req, res) => {
  // TODO: Implement shuffle stop logic
  res.json({ message: 'Shuffle stopped' });
});

// Background shuffle check - runs every 30 seconds
const shuffleCheckInterval = setInterval(() => {
  console.log('Background shuffle check:', new Date().toISOString());
  // TODO: Implement periodic shuffle logic
}, 30000);

app.listen(PORT, () => {
  console.log(`STSD running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});