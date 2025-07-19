const express = require('express');
const spotifyClient = require('./spotify');
const database = require('./database');
const shuffleState = require('./shuffleState');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const PLAYLIST_TARGET_SIZE = parseInt(process.env.PLAYLIST_TARGET_SIZE) || 5;

// Atomic function to add one least-played track to STSD playlist
async function addOneLeastPlayedTrack(contextUri, allTracks, playlistId = null) {
  try {
    // Get current least-played tracks from database
    const playCountData = await database.getContextPlayCounts(contextUri);

    if (playCountData.length === 0) {
      console.log('No tracks available to add');
      return false;
    }

    // Get the absolute least-played track (first in sorted list)
    const leastPlayedTrack = playCountData[0];

    // Find the full track info
    const fullTrackInfo = allTracks.find(track => track.uri === leastPlayedTrack.track_id);
    if (!fullTrackInfo) {
      console.log(`Could not find full track info for ${leastPlayedTrack.track_id}`);
      return false;
    }

    // Get STSD playlist ID (from parameter or shuffle state)
    const stsdPlaylistId = playlistId || shuffleState.getStsdPlaylistId();
    if (!stsdPlaylistId) {
      console.log('No STSD playlist ID available');
      return { success: false };
    }

    // Add the track to the playlist
    await spotifyClient.addToPlaylist(stsdPlaylistId, [leastPlayedTrack.track_id]);

    await new Promise(resolve => setTimeout(resolve, 500)); // Safety delay after playlist addition

    // Increment play count immediately so next query won't select the same track
    await database.incrementPlayCount(contextUri, leastPlayedTrack.track_id);

    console.log(`Added least-played track: ${fullTrackInfo.name} by ${fullTrackInfo.artists} (played ${leastPlayedTrack.play_count} times, now ${leastPlayedTrack.play_count + 1})`);

    return {
      success: true,
      trackUri: leastPlayedTrack.track_id,
      trackInfo: fullTrackInfo
    };
  } catch (error) {
    console.error('Error adding least-played track:', error);
    return { success: false };
  }
}

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

// Shuffle control endpoint - takes over whatever is currently playing
app.get('/api/shuffle/start', async (req, res) => {
  try {
    if (!spotifyClient.isUserAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    // Get current playback to determine what context to shuffle
    console.log('Getting current playback to determine context...');
    const currentPlayback = await spotifyClient.getCurrentPlayback();

    if (!currentPlayback || !currentPlayback.context) {
      return res.status(400).json({
        error: 'No active playback context found. Please start playing a playlist or album in Spotify first.'
      });
    }

    const contextUri = currentPlayback.context.uri;
    console.log(`Starting shuffle for current context: ${contextUri}`);

    // Check if we're already managing this exact context (idempotency)
    if (shuffleState.isManagingContext(contextUri)) {
      console.log(`Already managing shuffle for context ${contextUri}`);
      return res.json({
        message: 'Already shuffling this context',
        context: {
          uri: contextUri,
          alreadyActive: true
        }
      });
    }

    // Fetch context data to get the original name
    let contextData;
    try {
      contextData = await spotifyClient.getContextTracks(contextUri);
    } catch (error) {
      // Check if this is a 404 error for a Spotify-generated playlist
      if (error.message.includes('404') && contextUri.includes('playlist')) {
        return res.status(400).json({
          error: 'Cannot shuffle this playlist',
          details: 'This appears to be a Spotify-generated playlist (like Daily Mix, Discover Weekly, etc.) that cannot be accessed. Please try with a regular user-created playlist or album.',
          contextUri: contextUri
        });
      }
      throw error; // Re-throw other errors
    }
    console.log(`Fetched context: ${contextData.type} - ${contextData.id}`);

    // Sync tracks with database (add new tracks, preserve existing play counts)
    await database.syncContextTracks(contextUri, contextData.tracks);

    // Create a fresh STSD playlist for this shuffle session
    const originalContextName = `${contextData.type} ${contextData.id}`;
    const stsdPlaylistId = await spotifyClient.createFreshSTSDPlaylist(originalContextName);

    // Add one single least-played track to the fresh playlist
    console.log('Adding one least-played track to fresh playlist...');
    const trackResult = await addOneLeastPlayedTrack(contextUri, contextData.tracks, stsdPlaylistId);

    if (!trackResult.success) {
      console.error('Failed to add track to fresh playlist');
      return res.status(500).json({ error: 'Failed to add track to fresh playlist' });
    }

    console.log(`Added track: ${trackResult.trackInfo.name} by ${trackResult.trackInfo.artists}`);

    // Wait for API consistency
    console.log('Waiting for playlist to sync...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Start playing the fresh playlist
    const stsdPlaylistUri = `spotify:playlist:${stsdPlaylistId}`;
    console.log('Starting playback of fresh STSD playlist...');
    const playbackStarted = await spotifyClient.startPlaybackWithShuffle(stsdPlaylistUri, null, false);

    if (!playbackStarted) {
      console.error('Failed to start fresh playlist playback');
      return res.status(500).json({ error: 'Failed to start fresh playlist playback' });
    }

    console.log('Fresh playlist playback started successfully!');

    // Add remaining tracks to queue
    const remainingTracks = PLAYLIST_TARGET_SIZE - 1;
    console.log(`Adding ${remainingTracks} additional tracks to queue...`);

    for (let i = 0; i < remainingTracks; i++) {
      // Add delay before each queue addition
      await new Promise(resolve => setTimeout(resolve, 1500));

      try {
        // Get current least-played tracks from database
        const playCountData = await database.getContextPlayCounts(contextUri);

        if (playCountData.length === 0) {
          console.log('No more tracks available for queue');
          break;
        }

        // Get the absolute least-played track (first in sorted list)
        const leastPlayedTrack = playCountData[0];

        // Find the full track info
        const fullTrackInfo = contextData.tracks.find(track => track.uri === leastPlayedTrack.track_id);
        if (!fullTrackInfo) {
          console.log(`Could not find full track info for ${leastPlayedTrack.track_id}`);
          continue;
        }

        // Add to queue
        await spotifyClient.addToQueue(leastPlayedTrack.track_id);

        // Increment play count since we're queuing it (this marks it as recently added)
        await database.incrementPlayCount(contextUri, leastPlayedTrack.track_id);

        console.log(`Added to queue (${i + 2}/${PLAYLIST_TARGET_SIZE}): ${fullTrackInfo.name} by ${fullTrackInfo.artists} (played ${leastPlayedTrack.play_count} times, now ${leastPlayedTrack.play_count + 1})`);

      } catch (error) {
        console.error(`Failed to add track ${i + 2} to queue:`, error);
        break;
      }
    }

    console.log('Queue population complete!');

    // Start managing this context
    shuffleState.startShuffle(contextUri, contextData.tracks);
    shuffleState.setStsdPlaylistId(stsdPlaylistId);

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

// Stop shuffle endpoint
app.get('/api/shuffle/stop', async (req, res) => {
  try {
    if (shuffleState.isActive) {
      shuffleState.stopShuffle();
      res.json({ message: 'Shuffle stopped successfully' });
    } else {
      res.json({ message: 'No active shuffle to stop' });
    }
  } catch (error) {
    console.error('Failed to stop shuffle:', error);
    res.status(500).json({ error: 'Failed to stop shuffle', details: error.message });
  }
});

// Debug endpoint to check current playback
app.get('/api/debug/current-playback', async (req, res) => {
  try {
    if (!spotifyClient.isUserAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    const currentPlayback = await spotifyClient.getCurrentPlayback();
    res.json({
      currentPlayback: currentPlayback,
      hasContext: !!currentPlayback?.context,
      contextUri: currentPlayback?.context?.uri || null
    });
  } catch (error) {
    console.error('Failed to get current playback:', error);
    res.status(500).json({ error: 'Failed to get current playback', details: error.message });
  }
});

// Background queue monitoring - runs every 20 seconds
const queueMonitoringInterval = setInterval(async () => {
  console.log('=== Queue monitoring check started ===');

  if (!shuffleState.isActive) {
    console.log('Queue monitoring: Shuffle state not active, skipping');
    return;
  }

  if (!spotifyClient.isUserAuthenticated()) {
    console.log('Queue monitoring: Not authenticated, skipping');
    return;
  }

  try {
    console.log('Queue monitoring: Getting current playback...');
    const currentPlayback = await spotifyClient.getCurrentPlayback();

    if (!currentPlayback) {
      console.log('Queue monitoring: No current playback, skipping');
      return;
    }

    console.log(`Queue monitoring: Current context: ${currentPlayback?.context?.uri}`);
    console.log(`Queue monitoring: Managed context: ${shuffleState.currentContext}`);

    // Only manage if we're playing from our STSD playlist
    const isPlayingSTSDPlaylist = currentPlayback?.context?.uri?.includes(shuffleState.getStsdPlaylistId());
    const isPlayingOurContext = isPlayingSTSDPlaylist;

    console.log(`Queue monitoring: Is playing our context: ${isPlayingOurContext}`);

    if (!isPlayingOurContext) {
      console.log('Queue monitoring: Not playing our context, skipping');
      return;
    }

    console.log('=== Queue monitoring: ACTIVE - checking queue state ===');

    // Get current queue from Spotify
    const queueData = await spotifyClient.getQueue();
    if (!queueData) {
      console.log('Could not retrieve queue data');
      return;
    }

    // Extract track URIs from the queue
    const currentQueueUris = queueData.queue.map(item => item.uri);

    // Get recently added tracks from database (these are likely our managed tracks)
    const recentlyAdded = await database.getRecentlyAddedTracks(shuffleState.currentContext, 10);
    const recentlyAddedUris = recentlyAdded.map(track => track.track_id);

    console.log(`Current queue has ${currentQueueUris.length} tracks, recently added ${recentlyAddedUris.length} tracks`);

    // Check which of our recently added tracks are still in the queue
    const stillInQueue = recentlyAddedUris.filter(uri => currentQueueUris.includes(uri));

    console.log(`${stillInQueue.length}/${recentlyAddedUris.length} recently added tracks still in queue`);

    // Add more tracks if we have fewer than target in queue
    const targetQueueSize = PLAYLIST_TARGET_SIZE; // Keep full target size in queue (playlist track is static)
    const tracksNeeded = targetQueueSize - stillInQueue.length;

    if (tracksNeeded > 0) {
      console.log(`Adding ${tracksNeeded} tracks to maintain queue depth`);

      for (let i = 0; i < tracksNeeded; i++) {
        try {
          // Get current least-played tracks from database
          const playCountData = await database.getContextPlayCounts(shuffleState.currentContext);

          if (playCountData.length === 0) {
            console.log('No more tracks available for queue');
            break;
          }

          // Get the absolute least-played track
          const leastPlayedTrack = playCountData[0];

          // Find the full track info
          const fullTrackInfo = shuffleState.getAllTracks().find(track => track.uri === leastPlayedTrack.track_id);
          if (!fullTrackInfo) {
            console.log(`Could not find full track info for ${leastPlayedTrack.track_id}`);
            continue;
          }

          // Add to queue
          await spotifyClient.addToQueue(leastPlayedTrack.track_id);

          // Increment play count (this marks it as recently added)
          await database.incrementPlayCount(shuffleState.currentContext, leastPlayedTrack.track_id);

          console.log(`Added to queue: ${fullTrackInfo.name} by ${fullTrackInfo.artists} (played ${leastPlayedTrack.play_count} times, now ${leastPlayedTrack.play_count + 1})`);

          // Delay between additions
          if (i < tracksNeeded - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

        } catch (error) {
          console.error(`Failed to add track ${i + 1} during monitoring:`, error);
          break;
        }
      }
    }

  } catch (error) {
    console.error('Error during queue monitoring:', error);
  }
}, 20000);

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