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

- `src/index.js` - Main server and API endpoints
- `src/spotify.js` - Spotify API client and OAuth handling
- `src/database.js` - SQLite operations for play count tracking
- `src/shuffleState.js` - Internal state management
- `.env` - Configuration (Spotify API keys, etc.)
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
- `GET /api/shuffle/start/spotify:playlist:ID` - Start managing shuffle for playlist
- `GET /api/shuffle/start/spotify:album:ID` - Start managing shuffle for album

### Status
- `GET /api/status` - Daemon status, user info, current shuffle state
- `GET /health` - Health check

## Core Logic Flow

### Starting Shuffle
1. User calls `/api/shuffle/start/spotify:playlist:ID`
2. Check if already managing this context (idempotent)
3. Fetch all tracks from Spotify API (handles pagination)
4. Sync tracks with database (add new, preserve existing play counts)
5. Start internal state management
6. Return success with track count

### Background Monitoring (every 30 seconds)
1. Check if shuffle is active and user is authenticated
2. Get current Spotify playback state
3. Determine if we should take control:
   - Nothing playing → take control
   - Different context → take control
   - Same context but different track (user skipped) → take control
   - Same track we managed → keep monitoring
4. If taking control: implement queue management (TODO)

### Queue Management (TODO - Next Phase)
1. Query database for least-played tracks in current context
2. Add next few tracks to Spotify queue
3. Update play counts when tracks finish
4. Detect when user intervenes and stop managing

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

## Current Status

### Implemented ✅
- Basic Express server with health checks
- Spotify OAuth flow with token persistence
- SQLite database with play count tracking
- Internal state management
- Context track fetching and database sync
- Background monitoring framework
- User-friendly API endpoints

### TODO - Next Phase
- Queue management logic (add tracks to Spotify queue)
- Play count increment when tracks finish
- Least-played track selection algorithm
- User intervention detection and graceful fallback
- Error handling and recovery


## Configuration

### Required Environment Variables
```bash
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret  
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/auth/callback
PORT=3000
```

### Spotify App Requirements
- Web API access (not Web Playback SDK)
- Redirect URI: `http://127.0.0.1:3000/auth/callback`
- Required scopes:
  - `user-read-playback-state`
  - `user-modify-playback-state`
  - `user-read-currently-playing`
  - `playlist-read-private`
  - `playlist-read-collaborative`

## Development Notes

### Key Insights Discovered
- Spotify no longer allows `localhost` in redirect URIs (must use `127.0.0.1`)
- UPSERT pattern is perfect for play count increment logic
- Internal state management prevents false positives when detecting control
- Dynamic playlist sync ensures we always work with current content

### Testing Approach
- Use GET endpoints for easy manual testing
- Copy Spotify URIs directly from client
- Monitor server logs for debugging
- Check `/api/status` for current state

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