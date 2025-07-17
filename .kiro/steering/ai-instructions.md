---
inclusion: always
---

# AI Assistant Instructions for STSD Project

## Project Context
This is STSD (Spotify True Shuffle Daemon). Read `DESIGN.md` for full project context, architecture, and current status.

## Development Workflow

### Git Commits
- **ALWAYS remind user to commit after atomic changes** - Don't let multiple features accumulate
- Use descriptive commit messages that explain what was implemented
- Remind the user when changes are ready to commit, but don't commit automatically

### Documentation
- **Keep documentation up-to-date** - Update DESIGN.md and steering docs when functionality, architecture, or workflow changes
- Update API documentation when endpoints change
- Reflect design decisions and lessons learned in DESIGN.md

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