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

// Debug endpoint to reset all play counts
app.get('/api/debug/reset-counts', async (req, res) => {
  try {
    const result = await database.resetAllPlayCounts();
    res.json({ 
      message: 'All play counts reset to zero',
      affectedRows: result
    });
  } catch (error) {
    console.error('Failed to reset play counts:', error);
    res.status(500).json({ error: 'Failed to reset play counts', details: error.message });
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

    // Check if we're already managing this exact context (idempotency)
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

    // Pause playback before modifying playlist to prevent auto-play during updates
    console.log('Pausing playback before playlist modification...');
    await spotifyClient.pausePlayback();

    // Clear STSD playlist and populate with random tracks
    console.log('Clearing STSD playlist...');
    await spotifyClient.clearSTSDPlaylist();

    // Select 5 least-played tracks from the context
    const playCountData = await database.getContextPlayCounts(contextUri);
    const leastPlayedTracks = [];

    console.log(`DEBUG: Database returned ${playCountData.length} tracks for context`);
    console.log(`DEBUG: Play count data:`, playCountData.map(t => `${t.track_id.split(':')[2]} (${t.play_count} plays)`));

    if (playCountData.length > 0) {
      // Find tracks with minimum play count
      const minPlayCount = playCountData[0].play_count;
      console.log(`DEBUG: Minimum play count is: ${minPlayCount}`);
      
      const candidateTracks = playCountData.filter(track => track.play_count === minPlayCount);
      console.log(`DEBUG: Found ${candidateTracks.length} tracks with minimum play count of ${minPlayCount}`);

      // Randomly select from least-played tracks (to avoid always picking the same order)
      const tracksToSelect = Math.min(5, candidateTracks.length);
      console.log(`DEBUG: Will select ${tracksToSelect} tracks from ${candidateTracks.length} candidates`);
      
      for (let i = 0; i < tracksToSelect; i++) {
        const randomIndex = Math.floor(Math.random() * candidateTracks.length);
        const selectedTrack = candidateTracks.splice(randomIndex, 1)[0];
        console.log(`DEBUG: Selected track ${i + 1}: ${selectedTrack.track_id} (${selectedTrack.play_count} plays)`);

        // Find the full track info from contextData
        const fullTrackInfo = contextData.tracks.find(track => track.uri === selectedTrack.track_id);
        if (fullTrackInfo) {
          leastPlayedTracks.push({
            uri: selectedTrack.track_id,
            playCount: selectedTrack.play_count,
            name: fullTrackInfo.name,
            artists: fullTrackInfo.artists
          });
          console.log(`Selected least-played track: ${fullTrackInfo.name} by ${fullTrackInfo.artists} (played ${selectedTrack.play_count} times)`);
        } else {
          console.log(`DEBUG: WARNING - Could not find full track info for ${selectedTrack.track_id}`);
        }
      }
    } else {
      // Fallback: if no play count data, select first 5 tracks
      for (let i = 0; i < Math.min(5, contextData.tracks.length); i++) {
        const track = contextData.tracks[i];
        leastPlayedTracks.push({
          uri: track.uri,
          playCount: 0,
          name: track.name,
          artists: track.artists
        });
        console.log(`Selected track (no play data): ${track.name} by ${track.artists}`);
      }
    }

    // Add least-played tracks to STSD playlist with delays and increment play counts
    if (leastPlayedTracks.length > 0) {
      for (let i = 0; i < leastPlayedTracks.length; i++) {
        const track = leastPlayedTracks[i];

        await spotifyClient.addTracksToSTSDPlaylist([track.uri]);
        await database.incrementPlayCount(contextUri, track.uri);

        console.log(`Added track ${i + 1}/${leastPlayedTracks.length} to STSD playlist: ${track.name} (played ${track.playCount} times, now ${track.playCount + 1})`);

        // Add 1 second delay between track additions
        if (i < leastPlayedTracks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    // Wait before starting playback to ensure playlist is fully populated
    console.log('Waiting for playlist to be fully populated...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Start playing the STSD playlist instead of original context
    const stsdPlaylistUri = `spotify:playlist:${spotifyClient.stsdPlaylistId}`;
    console.log('Starting playback of STSD playlist with shuffle disabled...');
    const playbackStarted = await spotifyClient.startPlaybackWithShuffle(stsdPlaylistUri, null, false);

    if (!playbackStarted) {
      console.error('Failed to start STSD playlist playback');
      return res.status(500).json({ error: 'Failed to start STSD playlist playback' });
    }

    // Start managing this context
    shuffleState.startShuffle(contextUri, contextData.tracks);

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
      console.log('Taking control of playback for shuffle management (DISABLED - using playlist approach)');

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

          // await spotifyClient.addToQueue(selectedTrack.track_id); // DISABLED - using playlist approach
          // await database.incrementPlayCount(shuffleState.currentContext, selectedTrack.track_id); // DISABLED
          // console.log(`Queued least-played track: ${selectedTrack.track_id} (played ${selectedTrack.play_count} times, now ${selectedTrack.play_count + 1})`); // DISABLED

          // Add 1 second delay between queue additions to avoid API rate limiting
          if (i < tracksToQueue - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }

        shuffleState.setLastManagedTrack(currentPlayback?.item?.uri || null);
      }

    } else {
      // console.log('Playback under our control, monitoring...'); // DISABLED - too verbose
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