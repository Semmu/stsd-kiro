# STSD - Spotify True Shuffle Daemon

A self-hosted daemon that implements true shuffle for Spotify playlists, ensuring even distribution of tracks across large playlists.

## Why?

Spotify's built-in shuffle algorithm is notoriously bad - it doesn't truly shuffle your entire playlist and tends to play the same handful of songs repeatedly. This daemon fixes that by implementing a proper shuffle algorithm that tracks play counts per context and ensures even distribution.

## Features

- ✅ True shuffle algorithm with even track distribution
- ✅ Background daemon that runs seamlessly
- ✅ Automatic queue management via Spotify API
- ✅ Detects when user takes control and stops interfering
- ✅ Simple HTTP API for control
- ✅ Self-hosted and open-source


## Prerequisites

1. **Spotify Developer Account**: You need to create your own Spotify app
   - Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   - Create a new app
   - Note your Client ID and Client Secret
   - Add `http://localhost:3000/auth/callback` to your app's redirect URIs

2. **Spotify Premium**: Required for controlling playback via API

## Setup

1. Clone this repository
2. Copy `.env.example` to `.env` and fill in your Spotify app credentials
3. Install dependencies: `npm install`
4. Run the daemon: `npm start`



## API Endpoints

- `GET /health` - Health check
- `GET /api/status` - Daemon status
- `POST /api/shuffle/start` - Start shuffling a context (playlist/album)
- `POST /api/shuffle/stop` - Stop shuffling

## Development

```bash
npm run dev  # Run with nodemon for development
```

## License

MIT - Feel free to use, modify, and distribute as you see fit.