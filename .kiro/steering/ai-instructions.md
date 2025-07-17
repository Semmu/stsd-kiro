---
inclusion: always
---

# AI Assistant Instructions for STSD Project

## Project Context
This is STSD (Spotify True Shuffle Daemon) - a Node.js daemon that implements true shuffle for Spotify playlists. Read `DESIGN.md` for full project context and architecture.

## Development Workflow

### Git Commits
- **ALWAYS commit after atomic changes** - Don't let multiple features accumulate
- Use descriptive commit messages that explain what was implemented
- Commit frequently to maintain clean history
- Remind the user to commit if they forget, or do it automatically

### Code Style
- Keep dependencies minimal - prefer native Node.js over external packages
- Use CommonJS modules (require/module.exports)
- Write clean, readable code with comments explaining business logic
- Follow existing patterns in the codebase

### Implementation Approach
- **Start small and atomic** - Implement one piece at a time
- Test each piece before moving to the next
- Focus on the essential functionality, avoid over-engineering
- Make code that can be run immediately by the user

### User Context
- The user has limited hand mobility due to a recent accident
- Voice-driven development is preferred
- Make testing easy with GET endpoints and browser-friendly URLs
- Prioritize convenience and ease of use

## Project-Specific Guidelines

### API Design
- Use GET endpoints for control operations (easier to test)
- Accept full Spotify URIs in URL paths (copy-paste friendly)
- Make endpoints idempotent where possible
- Include comprehensive error handling

### Database Operations
- Use SQLite for simplicity and reliability
- Implement proper transactions for data integrity
- Use UPSERT patterns for increment operations
- Always sync context tracks when starting shuffle

### Spotify Integration
- Handle token refresh automatically
- Detect user intervention gracefully
- Use official Spotify SDK (@spotify/web-api-ts-sdk)
- Respect rate limits and handle errors

### State Management
- Maintain internal state separate from Spotify state
- Use background monitoring for seamless operation
- Implement graceful fallback when user takes control
- Log important state changes for debugging

## Current Status
Check `DESIGN.md` for detailed current status and TODO items. The next major piece to implement is queue management logic in the background monitoring function.

## Testing
- Start server with `npm start`
- Test endpoints in browser or with curl
- Check `/api/status` for current state
- Monitor server logs for debugging
- Use real Spotify playlists for testing

## File Structure
- `src/index.js` - Main server and API
- `src/spotify.js` - Spotify API client
- `src/database.js` - SQLite operations
- `src/shuffleState.js` - Internal state management
- `DESIGN.md` - Comprehensive project documentation

Remember: This is a personal daemon for a single user, prioritize simplicity and reliability over scalability.