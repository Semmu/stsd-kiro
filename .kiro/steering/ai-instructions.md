---
inclusion: always
---

# AI Assistant Instructions for STSD Project

## Project Context
This is STSD (Spotify True Shuffle Daemon). Read `DESIGN.md` for full project context, architecture, and current status.

## Development Workflow

### Git Commits
- **ALWAYS commit after atomic changes** - Don't let multiple features accumulate
- Use descriptive commit messages that explain what was implemented
- Remind the user to commit if they forget, or do it automatically

### Implementation Approach
- **Start small and atomic** - Implement one piece at a time
- Test each piece before moving to the next
- Focus on essential functionality, avoid over-engineering
- Make code that can be run immediately by the user
- Prioritize convenience and ease of use

### Testing
- Make testing easy with GET endpoints and browser-friendly URLs
- Accept full Spotify URIs in URL paths (copy-paste friendly)
- Use real Spotify playlists for testing