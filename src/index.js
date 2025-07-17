const express = require('express');
const spotifyClient = require('./spotify');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
app.get('/api/status', async (req, res) => {
  const status = {
    message: 'STSD (Spotify True Shuffle Daemon) is running',
    version: '1.0.0',
    authenticated: spotifyClient.isUserAuthenticated()
  };

  if (spotifyClient.isUserAuthenticated()) {
    try {
      const user = await spotifyClient.getCurrentUser();
      if (user) {
        status.user = user;
      }
    } catch (error) {
      console.error('Failed to get user info for status:', error);
    }
  }

  res.json(status);
});

// Auth routes
app.get('/auth/login', (req, res) => {
  const authUrl = spotifyClient.getAuthUrl();
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code missing' });
  }

  const success = await spotifyClient.handleCallback(code);

  if (success) {
    res.json({ message: 'Authentication successful! STSD is now connected to your Spotify account.' });
  } else {
    res.status(500).json({ error: 'Authentication failed' });
  }
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