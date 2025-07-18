const express = require('express');
const spotifyClient = require('./spotify');
const database = require('./database');
const shuffleState = require('./shuffleState');
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

  // Add shuffle state info
  status.shuffle = shuffleState.getState();

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

// Shuffle control endpoints
app.get('/api/shuffle/start/spotify::contextType::contextId', async (req, res) => {
  try {
    const { contextType, contextId } = req.params;
    const contextUri = `spotify:${contextType}:${contextId}`;

    if (!spotifyClient.isUserAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    // Validate context type
    if (!['playlist', 'album'].includes(contextType)) {
      return res.status(400).json({ error: 'Invalid context type. Supported: playlist, album' });
    }

    console.log(`Starting shuffle for context: ${contextUri}`);

    // Check if we're already managing this context (idempotency)
    if (shuffleState.isManagingContext(contextUri)) {
      console.log(`Already managing shuffle for context ${contextUri}`);
      return res.json({
        message: 'Already shuffling this context',
        context: {
          uri: contextUri,
          type: contextType,
          id: contextId,
          alreadyActive: true
        }
      });
    }

    // Fetch all tracks from the context
    const contextData = await spotifyClient.getContextTracks(contextUri);

    console.log(`Fetched ${contextData.totalTracks} tracks from ${contextData.type}: ${contextData.id}`);

    // Sync tracks with database (add new tracks, preserve existing play counts)
    await database.syncContextTracks(contextUri, contextData.tracks);

    // Start playback with the context to maintain UI feedback
    await spotifyClient.startPlayback(contextUri);

    // Start managing this context
    shuffleState.startShuffle(contextUri, contextData.tracks);

    // Immediately populate queue with least-played tracks
    const playCountData = await database.getContextPlayCounts(contextUri);

    if (playCountData.length > 0) {
      // Find tracks with minimum play count
      const minPlayCount = playCountData[0].play_count;
      const leastPlayedTracks = playCountData.filter(track => track.play_count === minPlayCount);

      // Randomly select from least-played tracks and add to queue
      const tracksToQueue = Math.min(5, leastPlayedTracks.length); // Queue up to 5 tracks

      for (let i = 0; i < tracksToQueue; i++) {
        const randomIndex = Math.floor(Math.random() * leastPlayedTracks.length);
        const selectedTrack = leastPlayedTracks.splice(randomIndex, 1)[0];

        await spotifyClient.addToQueue(selectedTrack.track_id);
        await database.incrementPlayCount(contextUri, selectedTrack.track_id);
        console.log(`Initially queued least-played track: ${selectedTrack.track_id} (played ${selectedTrack.play_count} times, now ${selectedTrack.play_count + 1})`);

        // Add 1 second delay between queue additions to avoid API rate limiting
        if (i < tracksToQueue - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    res.json({
      message: 'Shuffle started successfully',
      context: {
        uri: contextData.contextUri,
        type: contextData.type,
        id: contextData.id,
        totalTracks: contextData.totalTracks,
        alreadyActive: false
      }
    });

  } catch (error) {
    console.error('Failed to start shuffle:', error);
    res.status(500).json({ error: 'Failed to start shuffle', details: error.message });
  }
});



// Background shuffle check - runs every 30 seconds
const shuffleCheckInterval = setInterval(async () => {
  if (!shuffleState.isActive || !spotifyClient.isUserAuthenticated()) {
    return;
  }

  try {
    const currentPlayback = await spotifyClient.getCurrentPlayback();

    if (shuffleState.shouldTakeControl(currentPlayback)) {
      console.log('Taking control of playback for shuffle management');

      // Get least-played tracks from database
      const playCountData = await database.getContextPlayCounts(shuffleState.currentContext);

      if (playCountData.length > 0) {
        // Find tracks with minimum play count
        const minPlayCount = playCountData[0].play_count;
        const leastPlayedTracks = playCountData.filter(track => track.play_count === minPlayCount);

        // Randomly select from least-played tracks and add to queue
        const tracksToQueue = Math.min(5, leastPlayedTracks.length); // Queue up to 5 tracks

        for (let i = 0; i < tracksToQueue; i++) {
          const randomIndex = Math.floor(Math.random() * leastPlayedTracks.length);
          const selectedTrack = leastPlayedTracks.splice(randomIndex, 1)[0];

          await spotifyClient.addToQueue(selectedTrack.track_id);
          await database.incrementPlayCount(shuffleState.currentContext, selectedTrack.track_id);
          console.log(`Queued least-played track: ${selectedTrack.track_id} (played ${selectedTrack.play_count} times, now ${selectedTrack.play_count + 1})`);

          // Add 1 second delay between queue additions to avoid API rate limiting
          if (i < tracksToQueue - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        shuffleState.setLastManagedTrack(currentPlayback?.item?.uri || null);
      }

    } else {
      console.log('Playback under our control, monitoring...');
    }
  } catch (error) {
    console.error('Error during shuffle check:', error);
  }
}, 30000);

// Initialize database and start server
database.initialize()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`STSD running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });