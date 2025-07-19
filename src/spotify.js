const { SpotifyApi, SpotifyClientCredentials } = require('@spotify/web-api-ts-sdk');
const fs = require('fs').promises;
const path = require('path');

class SpotifyClient {
    constructor() {
        this.api = null;
        this.isAuthenticated = false;
        this.tokensFile = path.join(__dirname, '..', '.tokens.json');

        // Try to load existing tokens on startup
        this.loadTokens();
    }

    // Load tokens from file
    async loadTokens() {
        try {
            const data = await fs.readFile(this.tokensFile, 'utf8');
            const tokens = JSON.parse(data);

            if (tokens.access_token && tokens.refresh_token) {
                this.accessToken = tokens.access_token;
                this.refreshToken = tokens.refresh_token;
                this.expiresAt = tokens.expires_at;

                // Initialize API with stored tokens (even if expired - will refresh automatically)
                this.api = SpotifyApi.withAccessToken(process.env.SPOTIFY_CLIENT_ID, {
                    access_token: this.accessToken,
                    refresh_token: this.refreshToken,
                    expires_in: this.expiresAt ? Math.max(0, Math.floor((this.expiresAt - Date.now()) / 1000)) : 0
                });
                this.isAuthenticated = true;

                const now = Date.now();
                if (this.expiresAt && now < (this.expiresAt - 300000)) {
                    console.log('Loaded existing Spotify tokens (valid)');
                } else {
                    console.log('Loaded existing Spotify tokens (expired - will refresh automatically)');
                }


            }
        } catch (error) {
            console.log('No existing tokens found, authentication required');
        }
    }

    // Save tokens to file
    async saveTokens() {
        try {
            const tokens = {
                access_token: this.accessToken,
                refresh_token: this.refreshToken,
                expires_at: this.expiresAt,
                saved_at: Date.now()
            };

            await fs.writeFile(this.tokensFile, JSON.stringify(tokens, null, 2));
            console.log('Spotify tokens saved');
        } catch (error) {
            console.error('Failed to save tokens:', error);
        }
    }

    // Check if token needs refresh and refresh if necessary
    async ensureValidToken() {
        if (!this.refreshToken) {
            throw new Error('No refresh token available, re-authentication required');
        }

        const now = Date.now();
        const bufferTime = 300000; // 5 minutes buffer

        // Check if token is expired or will expire soon
        if (!this.expiresAt || now >= (this.expiresAt - bufferTime)) {
            console.log('Token expired or expiring soon, refreshing...');

            try {
                const response = await fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
                    },
                    body: new URLSearchParams({
                        grant_type: 'refresh_token',
                        refresh_token: this.refreshToken
                    })
                });

                const data = await response.json();

                if (data.access_token) {
                    // Update tokens
                    this.accessToken = data.access_token;
                    if (data.refresh_token) {
                        this.refreshToken = data.refresh_token;
                    }
                    this.expiresAt = Date.now() + (data.expires_in * 1000);

                    // Save updated tokens
                    await this.saveTokens();

                    // Reinitialize API with new token
                    this.api = SpotifyApi.withAccessToken(process.env.SPOTIFY_CLIENT_ID, {
                        access_token: this.accessToken,
                        refresh_token: this.refreshToken,
                        expires_in: data.expires_in
                    });

                    console.log('Token refreshed successfully');
                    return true;
                } else {
                    console.error('Token refresh failed:', data);
                    throw new Error('Failed to refresh token: ' + (data.error_description || data.error || 'Unknown error'));
                }
            } catch (error) {
                console.error('Token refresh failed:', error);
                this.isAuthenticated = false;
                throw new Error('Token refresh failed, re-authentication required: ' + error.message);
            }
        }

        return true;
    }



    // Initialize with client credentials (for basic API access)
    async initializeClientCredentials() {
        try {
            this.api = SpotifyApi.withClientCredentials(
                process.env.SPOTIFY_CLIENT_ID,
                process.env.SPOTIFY_CLIENT_SECRET
            );
            console.log('Spotify client credentials initialized');
            return true;
        } catch (error) {
            console.error('Failed to initialize Spotify client:', error);
            return false;
        }
    }

    // Get authorization URL for user login
    getAuthUrl() {
        const scopes = [
            // Playback control
            'user-read-playback-state',
            'user-modify-playback-state',
            'user-read-currently-playing',
            'streaming',
            
            // Playlist access
            'playlist-read-private',
            'playlist-read-collaborative',
            'playlist-modify-private',
            'playlist-modify-public',
            
            // User library and follows
            'user-library-read',
            'user-library-modify',
            'user-follow-read',
            'user-follow-modify',
            
            // User data
            'user-read-private',
            'user-read-email',
            'user-top-read',
            'user-read-recently-played'
        ];

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: process.env.SPOTIFY_CLIENT_ID,
            scope: scopes.join(' '),
            redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
            state: Math.random().toString(36).substring(7) // Simple state for security
        });

        return `https://accounts.spotify.com/authorize?${params.toString()}`;
    }

    // Exchange authorization code for access token
    async handleCallback(code) {
        try {
            const response = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: process.env.SPOTIFY_REDIRECT_URI
                })
            });

            const data = await response.json();

            if (data.access_token) {
                // Store tokens and calculate expiration
                this.accessToken = data.access_token;
                this.refreshToken = data.refresh_token;
                this.expiresAt = Date.now() + (data.expires_in * 1000);
                this.isAuthenticated = true;

                // Save tokens to file
                await this.saveTokens();

                // Initialize API with user token
                this.api = SpotifyApi.withAccessToken(process.env.SPOTIFY_CLIENT_ID, {
                    access_token: data.access_token,
                    refresh_token: data.refresh_token,
                    expires_in: data.expires_in
                });

                console.log('Spotify user authentication successful');



                return true;
            }

            return false;
        } catch (error) {
            console.error('Failed to handle Spotify callback:', error);
            return false;
        }
    }

    // Get current playback state
    async getCurrentPlayback() {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();
            return await this.api.player.getCurrentlyPlayingTrack();
        } catch (error) {
            console.error('Failed to get current playback:', error);
            return null;
        }
    }

    // Get current user info
    async getCurrentUser() {
        if (!this.isAuthenticated || !this.api) {
            return null;
        }

        try {
            await this.ensureValidToken();
            const user = await this.api.currentUser.profile();
            return {
                id: user.id,
                display_name: user.display_name,
                email: user.email,
                country: user.country,
                followers: user.followers?.total || 0
            };
        } catch (error) {
            console.error('Failed to get current user:', error);
            return null;
        }
    }

    // Get all tracks from a context (playlist, album, etc.)
    async getContextTracks(contextUri) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();
            // Parse context URI to determine type
            const [, type, id] = contextUri.split(':');

            let tracks = [];

            if (type === 'playlist') {
                // Get playlist tracks
                let offset = 0;
                const limit = 50;

                while (true) {
                    const response = await this.api.playlists.getPlaylistItems(id, 'US', undefined, limit, offset);

                    // Filter out non-track items (episodes, etc.) and null tracks
                    const validTracks = response.items
                        .filter(item => item.track && item.track.type === 'track')
                        .map(item => ({
                            id: item.track.id,
                            uri: item.track.uri,
                            name: item.track.name,
                            artists: item.track.artists.map(a => a.name).join(', '),
                            duration_ms: item.track.duration_ms
                        }));

                    tracks.push(...validTracks);

                    if (response.items.length < limit) break;
                    offset += limit;
                }

            } else if (type === 'album') {
                // Get album tracks
                let offset = 0;
                const limit = 50;

                while (true) {
                    const response = await this.api.albums.getAlbumTracks(id, 'US', limit, offset);

                    const albumTracks = response.items.map(track => ({
                        id: track.id,
                        uri: track.uri,
                        name: track.name,
                        artists: track.artists.map(a => a.name).join(', '),
                        duration_ms: track.duration_ms
                    }));

                    tracks.push(...albumTracks);

                    if (response.items.length < limit) break;
                    offset += limit;
                }

            } else {
                throw new Error(`Unsupported context type: ${type}`);
            }

            return {
                contextUri,
                type,
                id,
                totalTracks: tracks.length,
                tracks
            };

        } catch (error) {
            console.error('Failed to get context tracks:', error);
            throw error;
        }
    }

    // Start playback with a context (playlist/album)
    async startPlayback(contextUri, deviceId = null) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();
            // Check if we have available devices first
            const devices = await this.getDevices();
            console.log(`Available devices: ${devices.length}`);

            if (devices.length === 0) {
                console.log('No active devices found - user needs to open Spotify on a device');
                return false;
            }

            // Use active device if no specific device provided
            if (!deviceId) {
                const activeDevice = devices.find(d => d.is_active);
                if (activeDevice) {
                    deviceId = activeDevice.id;
                    console.log(`Using active device: ${activeDevice.name}`);
                } else {
                    console.log('No active device found, trying first available device');
                    deviceId = devices[0].id;
                }
            }

            // Use SDK with correct parameter structure based on API docs
            const playbackOptions = {
                context_uri: contextUri
            };

            console.log(`Attempting to start playback with device: ${deviceId}, context: ${contextUri}`);

            // SDK has issues with startResumePlayback, use direct API call as workaround
            const url = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(playbackOptions)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            console.log(`Started playback for context: ${contextUri}`);
            return true;
        } catch (error) {
            console.error('Failed to start playback:', error);
            // For now, let's not throw the error to see if the rest works
            console.log('Continuing without starting playback...');
            return false;
        }
    }

    // Add track to queue
    async addToQueue(trackUri, deviceId = null) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            // Use direct HTTP API call instead of SDK due to JSON parsing issues
            const url = new URL('https://api.spotify.com/v1/me/player/queue');
            url.searchParams.append('uri', trackUri);
            if (deviceId) {
                url.searchParams.append('device_id', deviceId);
            }

            const response = await fetch(url.toString(), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (response.ok || response.status === 204) {
                console.log(`Added to queue: ${trackUri}`);
                return true;
            } else {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
        } catch (error) {
            console.error('Failed to add track to queue:', error);
            throw error;
        }
    }

    // Get available devices
    async getDevices() {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();
            const devices = await this.api.player.getAvailableDevices();
            return devices.devices;
        } catch (error) {
            console.error('Failed to get devices:', error);
            return [];
        }
    }

    // Force context switch by starting new context with offset (should clear queue)
    async forceContextSwitch(contextUri, deviceId = null) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            console.log('Forcing context switch with offset to clear queue...');

            // Get devices first
            const devices = await this.getDevices();
            if (devices.length === 0) {
                console.log('No active devices found');
                return false;
            }

            // Use active device if no specific device provided
            if (!deviceId) {
                const activeDevice = devices.find(d => d.is_active);
                if (activeDevice) {
                    deviceId = activeDevice.id;
                } else {
                    deviceId = devices[0].id;
                }
            }

            // Use direct HTTP API with offset to force context switch and clear queue
            const url = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;

            const playbackOptions = {
                context_uri: contextUri,
                offset: { position: 0 } // Start from first track - this should clear queue
            };

            console.log(`Force switching to context: ${contextUri} with offset`);

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(playbackOptions)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            console.log('Context switch with offset successful');
            return true;

        } catch (error) {
            console.error('Failed to force context switch:', error);
            throw error;
        }
    }



    // Start playback with shuffle control and optional track offset
    async startPlaybackWithShuffle(contextUri, deviceId = null, shuffle = false, trackUri = null) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            // Get devices first
            const devices = await this.getDevices();
            if (devices.length === 0) {
                console.log('No active devices found');
                return false;
            }

            // Use active device if no specific device provided
            if (!deviceId) {
                const activeDevice = devices.find(d => d.is_active);
                if (activeDevice) {
                    deviceId = activeDevice.id;
                } else {
                    deviceId = devices[0].id;
                }
            }

            // Start playback with shuffle setting
            const url = `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`;

            const playbackOptions = {
                context_uri: contextUri,
                offset: trackUri ? { uri: trackUri } : { position: 0 }
            };

            console.log(`Starting playback: ${contextUri}, shuffle: ${shuffle}`);

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(playbackOptions)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            // Set shuffle state after starting playback
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for playback to start

            const shuffleUrl = `https://api.spotify.com/v1/me/player/shuffle?state=${shuffle}&device_id=${deviceId}`;

            const shuffleResponse = await fetch(shuffleUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (!shuffleResponse.ok) {
                console.warn('Failed to set shuffle state, but playback started successfully');
            } else {
                console.log(`Shuffle set to: ${shuffle}`);
            }

            return true;

        } catch (error) {
            console.error('Failed to start playback with shuffle:', error);
            throw error;
        }
    }

    // Pause current playback
    async pausePlayback(deviceId = null) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            // Use direct HTTP API to avoid SDK JSON parsing issues
            const url = deviceId
                ? `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`
                : 'https://api.spotify.com/v1/me/player/pause';

            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (response.ok || response.status === 204) {
                console.log('Playback paused');
                return true;
            } else {
                console.log('Pause request sent (may not have been playing)');
                return true; // Don't treat as error
            }
        } catch (error) {
            console.error('Failed to pause playback:', error);
            // Don't throw error - pausing might fail if nothing is playing
            return false;
        }
    }

    // Get tracks from a specific playlist
    async getPlaylistTracks(playlistId) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            let tracks = [];
            let offset = 0;
            const limit = 50;

            while (true) {
                const response = await this.api.playlists.getPlaylistItems(playlistId, 'US', undefined, limit, offset);

                // Filter out non-track items and null tracks
                const validTracks = response.items
                    .filter(item => item.track && item.track.type === 'track')
                    .map(item => ({
                        id: item.track.id,
                        uri: item.track.uri,
                        name: item.track.name,
                        artists: item.track.artists.map(a => a.name).join(', '),
                        duration_ms: item.track.duration_ms
                    }));

                tracks.push(...validTracks);

                if (response.items.length < limit) break;
                offset += limit;
            }

            return tracks;
        } catch (error) {
            console.error('Failed to get playlist tracks:', error);
            throw error;
        }
    }

    // Remove tracks from a playlist
    async removeFromPlaylist(playlistId, trackUris) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            await this.api.playlists.removeItemsFromPlaylist(playlistId, {
                tracks: trackUris
            });

            console.log(`Removed ${trackUris.length} tracks from playlist ${playlistId}`);
            return true;
        } catch (error) {
            console.error('Failed to remove tracks from playlist:', error);
            throw error;
        }
    }

    // Add tracks to a playlist
    async addToPlaylist(playlistId, trackUris) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            await this.api.playlists.addItemsToPlaylist(playlistId, trackUris);

            console.log(`Added ${trackUris.length} tracks to playlist ${playlistId}`);
            return true;
        } catch (error) {
            console.error('Failed to add tracks to playlist:', error);
            throw error;
        }
    }

    // Remove all existing [STSD] playlists
    async removeAllSTSDPlaylists() {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            // Get current user
            const user = await this.api.currentUser.profile();

            // Get all user playlists
            let allPlaylists = [];
            let offset = 0;
            const limit = 50;

            while (true) {
                const response = await this.api.playlists.getUsersPlaylists(user.id, limit, offset);
                allPlaylists.push(...response.items);

                if (response.items.length < limit) break;
                offset += limit;
            }

            // Find playlists that start with [STSD]
            const stsdPlaylists = allPlaylists.filter(playlist =>
                playlist.name.startsWith('[STSD]') && playlist.owner.id === user.id
            );

            console.log(`Found ${stsdPlaylists.length} existing [STSD] playlists to remove`);

            // Remove each STSD playlist
            for (const playlist of stsdPlaylists) {
                try {
                    // For owned playlists, we need to unfollow them (which effectively deletes them for the owner)
                    const url = `https://api.spotify.com/v1/playlists/${playlist.id}/followers`;
                    const response = await fetch(url, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${this.accessToken}`
                        }
                    });

                    if (response.ok || response.status === 200) {
                        console.log(`Removed [STSD] playlist: ${playlist.name} (${playlist.id})`);
                    } else {
                        console.error(`Failed to remove playlist ${playlist.id}: HTTP ${response.status}`);
                    }
                } catch (error) {
                    console.error(`Failed to remove playlist ${playlist.id}:`, error);
                }
            }

            return stsdPlaylists.length;

        } catch (error) {
            console.error('Failed to remove [STSD] playlists:', error);
            throw error;
        }
    }

    // Create a new fresh STSD playlist for each shuffle session
    async createFreshSTSDPlaylist(originalContextName) {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            // First, remove all existing [STSD] playlists
            await this.removeAllSTSDPlaylists();

            // Create playlist name with original context
            const playlistName = `[STSD] ${originalContextName}`;
            const playlistDescription = 'Managed by Spotify True Shuffle Daemon - Auto-generated playlist';

            // Get current user to create playlist
            const user = await this.api.currentUser.profile();

            console.log(`Creating fresh STSD playlist: ${playlistName}`);
            const newPlaylist = await this.api.playlists.createPlaylist(user.id, {
                name: playlistName,
                description: playlistDescription,
                public: false
            });

            console.log(`Created fresh STSD playlist: ${newPlaylist.id}`);
            this.stsdPlaylistId = newPlaylist.id;
            return newPlaylist.id;

        } catch (error) {
            console.error('Failed to create fresh STSD playlist:', error);
            throw error;
        }
    }

    // Get current playback queue
    async getQueue() {
        if (!this.isAuthenticated || !this.api) {
            throw new Error('Not authenticated with Spotify');
        }

        try {
            await this.ensureValidToken();

            // Use direct HTTP API call for queue
            const response = await fetch('https://api.spotify.com/v1/me/player/queue', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (response.ok) {
                const queueData = await response.json();
                return queueData;
            } else {
                console.error(`Failed to get queue: HTTP ${response.status}`);
                return null;
            }
        } catch (error) {
            console.error('Failed to get queue:', error);
            return null;
        }
    }

    // Check if user is authenticated
    isUserAuthenticated() {
        return this.isAuthenticated;
    }
}

module.exports = new SpotifyClient();