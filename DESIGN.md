# STSD - Spotify True Shuffle Daemon - Design Document

## Project Overview

STSD (Spotify True Shuffle Daemon) is a self-hosted Node.js daemon that implements true shuffle for Spotify playlists. It addresses the fundamental problem with Spotify's built-in shuffle algorithm, which doesn't truly shuffle entire playlists and tends to play the same handful of songs repeatedly.

## The Problem

Spotify's shuffle algorithm is notoriously bad:
- Doesn't shuffle the entire playlist/context
- Plays the same handful of songs over and over
- Doesn't ensure even distribution across large playlists
- Users with large playlists (1000+ tracks) rarely hear many of their songs

## The Solution

STSD implements a true shuffle algorithm that:
- Tracks play counts per track per context (playlist/album)
- Ensures even distribution by prioritizing least-played tracks
- Runs as a background daemon that seamlessly controls Spotify playback
- Detects user intervention and gracefully steps aside
- Maintains play count history across sessions

## Architecture

### Core Components

1. **Express HTTP Server** - REST API for control and status
2. **Spotify OAuth Integration** - Authentication with user's Spotify account
3. **SQLite Database** - Persistent storage for play counts per context
4. **Background Monitor** - Periodic checks and queue management
5. **Internal State Management** - Tracks what we're currently managing

### Key Files

- `src/index.js` - Main server, API endpoints, and queue management logic
- `src/spotify.js` - Spotify API client, OAuth handling, and playlist operations
- `src/database.js` - SQLite operations for play count tracking and least-played selection
- `src/shuffleState.js` - Internal state management and STSD playlist tracking
- `.env` - Configuration (Spotify API keys, target queue size, etc.)
- `shuffle.db` - SQLite database (auto-created)
- `.tokens.json` - Persisted OAuth tokens (auto-created)

## Database Schema

```sql
CREATE TABLE play_counts (
  context_id TEXT NOT NULL,     -- Spotify URI (spotify:playlist:abc123)
  track_id TEXT NOT NULL,       -- Spotify track URI
  play_count INTEGER DEFAULT 0, -- How many times played in this context
  last_played DATETIME,         -- When last played
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (context_id, track_id)
);
```

## API Endpoints

### Authentication
- `GET /auth/login` - Start Spotify OAuth flow
- `GET /auth/callback` - OAuth callback handler

### Control
- `GET /api/shuffle/start` - Start managing shuffle for currently playing context (auto-detects)

### Status
- `GET /api/status` - Daemon status, user info, current shuffle state
- `GET /health` - Health check

### Debug Endpoints
- `GET /api/debug/reset-counts` - Reset all play counts to zero
- `GET /api/debug/current-playback` - Check current Spotify playback state
- `GET /api/debug/library-access` - Test access to user's library
- `GET /api/debug/context-tracks` - Debug context track fetching
- `GET /api/debug/experimental` - Experimental playlist access methods

## Core Logic Flow

### Starting Shuffle
1. User calls `/api/shuffle/start` (no parameters needed)
2. Auto-detect currently playing context from Spotify
3. Check if already managing this context (idempotent)
4. Fetch all tracks from Spotify API (handles pagination)
5. Sync tracks with database (add new, preserve existing play counts)
6. Create fresh STSD playlist for this shuffle session
7. Add one least-played track to the playlist
8. Start playback of the STSD playlist
9. Add remaining tracks to Spotify queue (up to PLAYLIST_TARGET_SIZE)
10. Start internal state management and background monitoring

### Background Monitoring (every 20 seconds)
1. Check if shuffle is active and user is authenticated
2. Get current Spotify playback state
3. Only manage if playing from our STSD playlist
4. Get current queue and filter out duplicates
5. Check how many of our managed tracks are still in queue
6. Add more least-played tracks if queue is running low
7. Maintain target queue size for continuous playback

### Queue Management (Implemented)
1. Query database for tracks with minimum play count
2. Randomly select from least-played tracks to avoid predictability
3. Add selected tracks to Spotify queue with safety delays
4. Increment play counts immediately when tracks are queued
5. Filter out duplicate tracks caused by Spotify API bugs
6. Maintain continuous playback with target queue size

## Design Decisions

### Why SQLite?
- Lightweight, no external dependencies
- Handles 100k+ track-context pairs easily
- ACID transactions for data integrity
- Perfect for single-user daemon

### Why Track Per Context?
- Same track can have different play counts in different playlists
- Enables context-specific shuffle (playlist A vs playlist B)
- Scales to multiple playlists without interference

### Why Background Monitoring?
- Seamless operation without user intervention
- Detects when user takes control and steps aside gracefully
- Handles edge cases (app crashes, network issues, etc.)

### Why GET Endpoints for Control?
- Easy testing in browser or curl
- Can paste Spotify URIs directly into URLs
- Idempotent operations (safe to repeat)

### Why STSD Playlists?
- Creates temporary playlists named "STSD - [Original Context]"
- Avoids conflicts with user's original playlists
- Enables precise queue control through playlist + queue combination
- Automatically cleaned up by creating fresh playlists for each session
- Works around Spotify API limitations with queue management

### Why Auto-Context Detection?
- User just needs to start playing something and call `/api/shuffle/start`
- No need to copy/paste Spotify URIs manually
- Seamless integration with normal Spotify usage
- Handles both playlists and albums automatically

## Current Status

### Implemented ✅
- Basic Express server with health checks
- Spotify OAuth flow with token persistence
- SQLite database with play count tracking
- Internal state management
- Context track fetching and database sync
- Background monitoring framework (every 20 seconds)
- User-friendly API endpoints
- **Queue management logic** - Creates STSD playlists and manages queue
- **Play count increment** - Tracks are marked as played when added to queue
- **Least-played track selection** - Randomly selects from tracks with minimum play count
- **STSD playlist creation** - Creates fresh playlists for each shuffle session
- **Auto-context detection** - Detects currently playing context automatically
- **Queue filtering** - Removes duplicate tracks from Spotify API bugs
- **Comprehensive debug endpoints** - Multiple debugging tools for troubleshooting

### TODO - Future Enhancements
- User intervention detection and graceful fallback
- Better error handling and recovery
- Web UI for easier control
- Multiple device support
- Advanced shuffle algorithms (weighted, mood-based)


## Configuration

### Required Environment Variables
```bash
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret  
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/auth/callback
PORT=3000
PLAYLIST_TARGET_SIZE=5
```

### Spotify App Requirements
- Web API access (not Web Playback SDK)
- Redirect URI: `http://127.0.0.1:3000/auth/callback`
- Required scopes:
  - `user-read-playback-state` - Read current playback state
  - `user-modify-playback-state` - Control playback and queue
  - `user-read-currently-playing` - Get currently playing track
  - `playlist-read-private` - Read user's private playlists
  - `playlist-read-collaborative` - Read collaborative playlists
  - `playlist-modify-public` - Create and modify STSD playlists
  - `playlist-modify-private` - Create and modify private STSD playlists
  - `user-library-read` - Access user's saved tracks/albums (for debugging)

## Development Notes

### Key Insights Discovered
- Spotify no longer allows `localhost` in redirect URIs (must use `127.0.0.1`)
- UPSERT pattern is perfect for play count increment logic
- Internal state management prevents false positives when detecting control
- Dynamic playlist sync ensures we always work with current content
- **STSD playlist approach** works better than direct queue management
- **Random selection from least-played** prevents predictable shuffle patterns
- **Spotify API queue bugs** require filtering duplicate tracks
- **Auto-context detection** makes the UX much smoother
- **Generated playlists** (Discover Weekly, etc.) require special handling

### Testing Approach
- Use GET endpoints for easy manual testing
- Start playing any playlist/album, then call `/api/shuffle/start`
- Monitor server logs for detailed debugging information
- Check `/api/status` for current shuffle state
- Use debug endpoints for troubleshooting specific issues
- Test with both user-created and Spotify-generated playlists

## Future Enhancements

### Potential Features
- Web UI for easier control
- Multiple device support
- Playlist analysis and statistics
- Export/import play count data
- Advanced shuffle algorithms (weighted, mood-based, etc.)
- Integration with Last.fm or other services

### Scalability Considerations
- Current design handles single user perfectly
- Could be extended for multi-user with user isolation
- Database could be upgraded to PostgreSQL for heavy usage
- Could add Redis for caching if needed

## Philosophy

STSD follows the Unix philosophy:
- Do one thing well (true shuffle)
- Be composable (REST API)
- Handle edge cases gracefully
- Fail safely and recover automatically
- Minimize dependencies and complexity

The goal is a "set it and forget it" daemon that just works in the background, giving users the shuffle experience they actually want from their music.