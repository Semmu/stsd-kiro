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
        
        // Check if token is still valid (with 5 min buffer)
        const now = Date.now();
        if (this.expiresAt && now < (this.expiresAt - 300000)) {
          // Token is still valid, initialize API
          this.api = SpotifyApi.withAccessToken(process.env.SPOTIFY_CLIENT_ID, {
            access_token: this.accessToken,
            refresh_token: this.refreshToken,
            expires_in: Math.floor((this.expiresAt - now) / 1000)
          });
          this.isAuthenticated = true;
          console.log('Loaded existing Spotify tokens');
        } else {
          console.log('Stored tokens expired, will need re-authentication');
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
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'playlist-read-private',
      'playlist-read-collaborative'
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

  // Check if user is authenticated
  isUserAuthenticated() {
    return this.isAuthenticated;
  }
}

module.exports = new SpotifyClient();