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

    // Ensure STSD playlist exists and get its ID
    console.log('Ensuring STSD playlist exists...');
    const stsdPlaylistId = await spotifyClient.ensureSTSDPlaylist();
    shuffleState.setStsdPlaylistId(stsdPlaylistId);
    
    // Clear STSD playlist and populate with random tracks
    console.log('Clearing STSD playlist...');
    await spotifyClient.clearSTSDPlaylist();

    // Select 5 least-played tracks from the context
    const playCountData = await database.getContextPlayCounts(contextUri);
    const leastPlayedTracks = [];

    console.log(`DEBUG: Database returned ${playCountData.length} tracks for context`);
    console.log(`DEBUG: Play count data:`, playCountData.map(t => `${t.track_id.split(':')[2]} (${t.play_count} plays)`));

    if (playCountData.length > 0) {
      // Take the first 5 tracks (already sorted by play count ascending)
      const tracksToSelect = Math.min(5, playCountData.length);
      const selectedTracks = playCountData.slice(0, tracksToSelect);
      
      console.log(`DEBUG: Selected first ${tracksToSelect} tracks from sorted list (play counts: ${selectedTracks.map(t => t.play_count).join(', ')})`);
      
      // Shuffle the selected tracks to avoid predictable order
      for (let i = selectedTracks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [selectedTracks[i], selectedTracks[j]] = [selectedTracks[j], selectedTracks[i]];
      }
      
      // Process the shuffled selection
      for (const selectedTrack of selectedTracks) {
        // Find the full track info from contextData
        const fullTrackInfo = contextData.tracks.find(track => track.uri === selectedTrack.track_id);
        if (fullTrackInfo) {
          leastPlayedTracks.push({
            uri: selectedTrack.track_id,
            playCount: selectedTrack.play_count,
            name: fullTrackInfo.name,
            artists: fullTrackInfo.artists
          });
          console.log(`Selected track: ${fullTrackInfo.name} by ${fullTrackInfo.artists} (played ${selectedTrack.play_count} times)`);
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
      
      // Update play counts in database
      for (const track of tracksToRemove) {
        await database.incrementPlayCount(shuffleState.currentContext, track.uri);
        console.log(`Updated play count for: ${track.name} by ${track.artists}`);
      }
    }

    // Get updated playlist length after removals
    const updatedPlaylistTracks = await spotifyClient.getPlaylistTracks(stsdPlaylistId);
    const remainingTracks = updatedPlaylistTracks.length;
    console.log(`STSD playlist now has ${remainingTracks} tracks`);

    // Add new tracks if we have fewer than 5
    if (remainingTracks < 5) {
      const tracksNeeded = 5 - remainingTracks;
      console.log(`Need to add ${tracksNeeded} more tracks to maintain 5 tracks`);

      // Get least-played tracks from database
      const playCountData = await database.getContextPlayCounts(shuffleState.currentContext);
      
      if (playCountData.length > 0) {
        // Take the first tracks (already sorted by play count ascending)
        const tracksToSelect = Math.min(tracksNeeded, playCountData.length);
        const selectedTracks = playCountData.slice(0, tracksToSelect);
        
        // Shuffle the selected tracks
        for (let i = selectedTracks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [selectedTracks[i], selectedTracks[j]] = [selectedTracks[j], selectedTracks[i]];
        }

        // Add tracks to playlist
        const trackUrisToAdd = selectedTracks.map(track => track.track_id);
        await spotifyClient.addToPlaylist(stsdPlaylistId, trackUrisToAdd);
        
        console.log(`Added ${trackUrisToAdd.length} new tracks to STSD playlist`);
        for (const selectedTrack of selectedTracks) {
          const fullTrackInfo = shuffleState.getAllTracks().find(track => track.uri === selectedTrack.track_id);
          if (fullTrackInfo) {
            console.log(`Added: ${fullTrackInfo.name} by ${fullTrackInfo.artists} (played ${selectedTrack.play_count} times)`);
          }
        }
      }
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