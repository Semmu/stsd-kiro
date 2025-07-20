# STSD - Spotify True Shuffle Daemon

> **⚠️ AI EXPERIMENT WARNING**
> 
> This entire project was created using Kiro, an AI coding assistant. I (the project owner) did not write any code by hand or execute any git commands manually. This is an experiment in AI-driven development to see how far autonomous coding agents can go.
> 
> **Personal context:** I recently broke my left arm, which significantly limits my ability to code effectively. This physical limitation motivated me to explore AI coding assistants as a way to continue building projects while recovering.
> 
> **What this means for you as a developer:**
> - The code architecture and implementation decisions were made by AI
> - All git history reflects AI commits, not human commits
> - Code quality, patterns, and conventions are AI-generated
> - This is not a reflection of human coding standards or practices
> - Use this project as a reference for AI capabilities, not as a coding example
> 
> If you're interested in AI-assisted development or want to see what's possible with modern coding agents, this project serves as a real-world case study. The functionality works, but approach the codebase with the understanding that it's an AI experiment.

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

## ⚠️ Current Limitations

**Only works with user-created playlists and albums** - STSD cannot shuffle Spotify-generated content like:
- Discover Weekly
- Daily Mix playlists
- Song Radio
- Artist Radio
- Spotify's algorithmic playlists
- Release Radar
- Made For You playlists

This is due to Spotify API restrictions on accessing tracks from algorithmically generated playlists. You'll need to start playing a regular user-created playlist or album before calling `/api/shuffle/start`.

**📚 For detailed technical analysis of these limitations, see [SPOTIFY-API-LIMITATIONS.md](SPOTIFY-API-LIMITATIONS.md)** - This document contains comprehensive research into why these restrictions exist, what authentication methods were tested, and the implications for developers building Spotify tools.

## Prerequisites

1. **Spotify Developer Account**: You need to create your own Spotify app
   - Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   - Create a new app
   - Note your Client ID and Client Secret
   - Add `http://127.0.0.1:3000/auth/callback` to your app's redirect URIs
     - **Note**: Use `127.0.0.1` instead of `localhost` - Spotify is migrating away from localhost URLs for security reasons

2. **Spotify Premium**: Required for controlling playback via API

## Setup

1. Clone this repository
2. Copy `.env.example` to `.env` and fill in your Spotify app credentials
3. Install dependencies: `npm install`
4. Run the daemon: `npm start`



## API Endpoints

### Core Endpoints
- `GET /health` - Health check
- `GET /api/status` - Daemon status and current shuffle state
- `GET /api/shuffle/start` - Start shuffling current playing context (auto-detects playlist/album)

### Authentication
- `GET /auth/login` - Start Spotify OAuth flow
- `GET /auth/callback` - OAuth callback handler

### Debug Endpoints
- `GET /api/debug/reset-counts` - Reset all play counts to zero
- `GET /api/debug/current-playback` - Check current Spotify playback state
- `GET /api/debug/library-access` - Test access to user's library
- `GET /api/debug/context-tracks` - Debug context track fetching
- `GET /api/debug/experimental` - Experimental playlist access methods

## Development

```bash
npm run dev  # Run with nodemon for development
```

## License

MIT - Feel free to use, modify, and distribute as you see fit.