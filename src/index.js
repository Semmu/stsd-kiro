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

// Debug endpoint to test new scopes and library access
app.get('/api/debug/library-access', async (req, res) => {
  try {
    if (!spotifyClient.isUserAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    await spotifyClient.ensureValidToken();
    const accessToken = spotifyClient.accessToken;

    const results = {};

    // Test user's saved tracks
    try {
      const savedTracksUrl = `https://api.spotify.com/v1/me/tracks?limit=10`;
      const savedTracksResponse = await fetch(savedTracksUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      results.savedTracks = {
        status: savedTracksResponse.status,
        success: savedTracksResponse.ok,
        count: savedTracksResponse.ok ? (await savedTracksResponse.json()).items.length : 0
      };
    } catch (error) {
      results.savedTracks = { error: error.message };
    }

    // Test user's saved albums
    try {
      const savedAlbumsUrl = `https://api.spotify.com/v1/me/albums?limit=10`;
      const savedAlbumsResponse = await fetch(savedAlbumsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      results.savedAlbums = {
        status: savedAlbumsResponse.status,
        success: savedAlbumsResponse.ok,
        count: savedAlbumsResponse.ok ? (await savedAlbumsResponse.json()).items.length : 0
      };
    } catch (error) {
      results.savedAlbums = { error: error.message };
    }

    // Test followed artists
    try {
      const followedArtistsUrl = `https://api.spotify.com/v1/me/following?type=artist&limit=10`;
      const followedArtistsResponse = await fetch(followedArtistsUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      results.followedArtists = {
        status: followedArtistsResponse.status,
        success: followedArtistsResponse.ok,
        count: followedArtistsResponse.ok ? (await followedArtistsResponse.json()).artists.items.length : 0
      };
    } catch (error) {
      results.followedArtists = { error: error.message };
    }

    // Test recently played
    try {
      const recentlyPlayedUrl = `https://api.spotify.com/v1/me/player/recently-played?limit=10`;
      const recentlyPlayedResponse = await fetch(recentlyPlayedUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      results.recentlyPlayed = {
        status: recentlyPlayedResponse.status,
        success: recentlyPlayedResponse.ok,
        count: recentlyPlayedResponse.ok ? (await recentlyPlayedResponse.json()).items.length : 0
      };
    } catch (error) {
      results.recentlyPlayed = { error: error.message };
    }

    res.json({
      message: 'Testing new scopes access',
      results: results
    });

  } catch (error) {
    console.error('Debug: Failed to test library access:', error);
    res.status(500).json({
      error: 'Failed to test library access',
      details: error.message
    });
  }
});

// Debug endpoint to try getting current context tracks manually
app.get('/api/debug/context-tracks', async (req, res) => {
  try {
    if (!spotifyClient.isUserAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated with Spotify' });
    }

    // Get current playback first
    const currentPlayback = await spotifyClient.getCurrentPlayback();
    if (!currentPlayback || !currentPlayback.context) {
      return res.status(400).json({
        error: 'No active playback context found'
      });
    }

    const contextUri = currentPlayback.context.uri;
    console.log(`Debug: Trying to get tracks for context: ${contextUri}`);

    // Parse context URI to get type and ID
    const [, type, id] = contextUri.split(':');

    if (type !== 'playlist') {
      return res.status(400).json({
        error: 'This debug endpoint only works with playlists',
        contextType: type,
        contextUri: contextUri
      });
    }

    await spotifyClient.ensureValidToken();
    const accessToken = spotifyClient.accessToken;

    // First, try direct playlist access
    console.log(`Debug: Trying direct playlist access...`);
    const directUrl = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=50&offset=0&fields=items(track(id,uri,name,artists(name),duration_ms)),total`;

    const directResponse = await fetch(directUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Debug: Direct access response status: ${directResponse.status}`);

    if (directResponse.ok) {
      // Direct access worked - regular playlist
      const data = await directResponse.json();
      const tracks = data.items
        .filter(item => item.track && item.track.type === 'track')
        .map(item => ({
          id: item.track.id,
          uri: item.track.uri,
          name: item.track.name,
          artists: item.track.artists.map(a => a.name).join(', '),
          duration_ms: item.track.duration_ms
        }));

      return res.json({
        success: true,
        method: 'direct_access',
        contextUri: contextUri,
        playlistId: id,
        totalTracks: data.total,
        tracksRetrieved: tracks.length,
        tracks: tracks
      });
    }

    // Direct access failed - try the "followed playlists" method
    console.log(`Debug: Direct access failed, trying user playlists method...`);

    // Get ALL user's playlists with pagination (this includes followed generated playlists)
    console.log(`Debug: Fetching ALL user playlists with pagination...`);
    let allPlaylists = [];
    let offset = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore) {
      const userPlaylistsUrl = `https://api.spotify.com/v1/me/playlists?limit=${limit}&offset=${offset}`;
      console.log(`Debug: Fetching batch from: ${userPlaylistsUrl}`);

      const userPlaylistsResponse = await fetch(userPlaylistsUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      console.log(`Debug: User playlists batch response status: ${userPlaylistsResponse.status}`);

      if (!userPlaylistsResponse.ok) {
        const errorText = await userPlaylistsResponse.text();
        console.log(`Debug: User playlists error: ${errorText}`);
        return res.json({
          success: false,
          method: 'user_playlists_failed',
          contextUri: contextUri,
          playlistId: id,
          httpStatus: userPlaylistsResponse.status,
          errorText: errorText
        });
      }

      const batchData = await userPlaylistsResponse.json();
      console.log(`Debug: Got ${batchData.items.length} playlists in this batch (offset: ${offset})`);

      allPlaylists.push(...batchData.items);

      // Check if we have more pages
      hasMore = batchData.items.length === limit && batchData.next !== null;
      offset += limit;

      if (hasMore) {
        console.log(`Debug: More playlists available, continuing pagination...`);
      }
    }

    console.log(`Debug: Total playlists fetched: ${allPlaylists.length}`);
    console.log(`Debug: Looking for playlist ID: ${id}`);

    // Print ALL playlists for debugging
    console.log(`Debug: ALL ${allPlaylists.length} playlists:`);
    allPlaylists.forEach((p, index) => {
      console.log(`  ${index + 1}. "${p.name}" (${p.id}) - Owner: ${p.owner?.display_name || 'unknown'}`);
    });

    // Look for any playlists that might be Discover Weekly or similar
    const discoverPlaylists = allPlaylists.filter(p =>
      p.name.toLowerCase().includes('discover') ||
      p.name.toLowerCase().includes('weekly') ||
      p.name.toLowerCase().includes('daily') ||
      p.name.toLowerCase().includes('mix')
    );
    console.log(`Debug: Found ${discoverPlaylists.length} playlists with discover/weekly/daily/mix in name:`);
    discoverPlaylists.forEach(p => console.log(`  - ${p.name} (${p.id}) - Owner: ${p.owner?.display_name}`));

    // Look for our target playlist in ALL user's playlists
    const targetPlaylist = allPlaylists.find(playlist => playlist.id === id);

    if (!targetPlaylist) {
      console.log(`Debug: Target playlist ${id} NOT found in user playlists`);
      return res.json({
        success: false,
        method: 'playlist_not_followed',
        contextUri: contextUri,
        playlistId: id,
        message: 'Generated playlist not found in user playlists. User needs to follow/save this playlist first.',
        totalUserPlaylists: allPlaylists.length,
        userPlaylistIds: allPlaylists.map(p => p.id).slice(0, 10) // First 10 for debugging
      });
    }

    // Found the playlist in user's playlists - now try to get its tracks
    console.log(`Debug: Found playlist in user playlists! Name: "${targetPlaylist.name}"`);
    console.log(`Debug: Playlist owner: ${targetPlaylist.owner?.display_name || 'unknown'}`);
    console.log(`Debug: Getting tracks for followed playlist...`);

    const followedPlaylistUrl = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=50&offset=0&fields=items(track(id,uri,name,artists(name),duration_ms)),total`;
    console.log(`Debug: Fetching tracks from: ${followedPlaylistUrl}`);

    const followedResponse = await fetch(followedPlaylistUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`Debug: Followed playlist tracks response status: ${followedResponse.status}`);

    if (followedResponse.ok) {
      const data = await followedResponse.json();
      const tracks = data.items
        .filter(item => item.track && item.track.type === 'track')
        .map(item => ({
          id: item.track.id,
          uri: item.track.uri,
          name: item.track.name,
          artists: item.track.artists.map(a => a.name).join(', '),
          duration_ms: item.track.duration_ms
        }));

      return res.json({
        success: true,
        method: 'followed_playlist_access',
        contextUri: contextUri,
        playlistId: id,
        playlistName: targetPlaylist.name,
        totalTracks: data.total,
        tracksRetrieved: tracks.length,
        tracks: tracks
      });
    } else {
      const errorText = await followedResponse.text();
      return res.json({
        success: false,
        method: 'followed_playlist_access_failed',
        contextUri: contextUri,
        playlistId: id,
        playlistName: targetPlaylist.name,
        httpStatus: followedResponse.status,
        errorText: errorText
      });
    }

  } catch (error) {
    console.error('Debug: Failed to get context tracks:', error);
    res.status(500).json({
      error: 'Failed to get context tracks',
      details: error.message
    });
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