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

    // Fetch context data to get the original name
    const contextData = await spotifyClient.getContextTracks(contextUri);
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

        // Increment play count since we're queuing it
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



// Background playlist management - runs every 15 seconds
const playlistManagementInterval = setInterval(async () => {
  if (!shuffleState.isActive || !spotifyClient.isUserAuthenticated()) {
    return;
  }

  try {
    const currentPlayback = await spotifyClient.getCurrentPlayback();

    // Only manage if we're playing from our STSD playlist
    if (!currentPlayback?.context?.uri?.includes('stsd-shuffle')) {
      return;
    }

    console.log('Managing STSD playlist...');

    // Get current STSD playlist
    const stsdPlaylistId = shuffleState.getStsdPlaylistId();
    if (!stsdPlaylistId) {
      console.log('No STSD playlist ID stored, skipping management');
      return;
    }

    // Get current playlist tracks
    const playlistTracks = await spotifyClient.getPlaylistTracks(stsdPlaylistId);
    console.log(`Current STSD playlist has ${playlistTracks.length} tracks`);

    // Check if current track has been played/skipped
    const currentTrackUri = currentPlayback?.item?.uri;
    const currentTrackIndex = playlistTracks.findIndex(track => track.uri === currentTrackUri);

    // Remove tracks that have been played (tracks before current position)
    const tracksToRemove = [];
    for (let i = 0; i < currentTrackIndex; i++) {
      tracksToRemove.push(playlistTracks[i]);
    }

    if (tracksToRemove.length > 0) {
      console.log(`Removing ${tracksToRemove.length} played/skipped tracks from STSD playlist`);

      // Remove tracks from playlist
      const trackUrisToRemove = tracksToRemove.map(track => ({ uri: track.uri }));
      await spotifyClient.removeFromPlaylist(stsdPlaylistId, trackUrisToRemove);

      await new Promise(resolve => setTimeout(resolve, 2000)); // Safety delay after removal

      // Update play counts in database
      for (const track of tracksToRemove) {
        await database.incrementPlayCount(shuffleState.currentContext, track.uri);
        console.log(`Updated play count for: ${track.name} by ${track.artists}`);
      }
    }

    // Get updated playlist length after removals
    await new Promise(resolve => setTimeout(resolve, 1000)); // Safety delay before querying updated state
    const updatedPlaylistTracks = await spotifyClient.getPlaylistTracks(stsdPlaylistId);
    const remainingTracks = updatedPlaylistTracks.length;
    console.log(`STSD playlist now has ${remainingTracks} tracks`);

    // Add new tracks if we have fewer than target size
    if (remainingTracks < PLAYLIST_TARGET_SIZE) {
      const tracksNeeded = PLAYLIST_TARGET_SIZE - remainingTracks;
      console.log(`Need to add ${tracksNeeded} more tracks to maintain ${PLAYLIST_TARGET_SIZE} tracks`);

      // Add tracks atomically (one at a time for true least-played selection)
      let addedCount = 0;

      for (let i = 0; i < tracksNeeded; i++) {
        const result = await addOneLeastPlayedTrack(shuffleState.currentContext, shuffleState.getAllTracks());

        if (result.success) {
          addedCount++;
        } else {
          console.log(`Failed to add track ${i + 1} during continuous management`);
          break;
        }

        // Small delay between additions
        if (i < tracksNeeded - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      console.log(`Continuous management: added ${addedCount}/${tracksNeeded} tracks to maintain playlist`);
    }

  } catch (error) {
    console.error('Error during playlist management:', error);
  }
}, 15000);

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