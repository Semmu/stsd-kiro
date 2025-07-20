# Spotify Web API Limitations: Generated Playlist Access Research

## Background & Motivation

This document details extensive research conducted in July 2025 to understand why **Spotify's generated playlists** (Discover Weekly, Daily Mix, Release Radar, etc.) cannot be accessed through standard API methods, and the implications for building background music services.

### The Problem
We were building **STSD (Spotify True Shuffle Daemon)** - a background service that implements true shuffle for Spotify playlists by tracking play counts and prioritizing least-played tracks. While the service worked perfectly with user-created playlists, it consistently failed to access Spotify's generated playlists with **404 "Resource not found"** errors.

### Why This Matters
Generated playlists are among Spotify's most popular features:
- **Discover Weekly**: Personalized weekly music discovery
- **Daily Mix 1-6**: Genre-based mixes of user's music
- **Release Radar**: New releases from followed artists
- **Song Radio**: Algorithmic playlists based on a specific song
- **Artist Radio**: Algorithmic playlists based on a specific artist
- **Made for You playlists**: Various algorithmic recommendations

For a true shuffle service to be useful, it needs to work with these playlists that users interact with most frequently.

## Research Methodology

We systematically tested **every available Spotify OAuth flow** to understand:
1. **Authentication requirements** and user intervention needed
2. **API access permissions** for different content types
3. **Token lifecycle** (expiration, refresh capabilities)
4. **Inconsistencies** in API responses for identical endpoints

### Test Setup
- **Target playlists**: Various generated playlists (Discover Weekly, Daily Mix, Song/Artist Radio, etc.)
- **API endpoints tested**: 
  - `GET /v1/playlists/{id}` (playlist info)
  - `GET /v1/playlists/{id}/tracks` (playlist tracks)
  - `GET /v1/me/playlists` (user's playlists)
  - `GET /v1/users/{user_id}/playlists` (specific user's playlists)
- **Consistent test methodology**: Same endpoints, same playlists, different auth tokens

## Authentication Methods Tested

### 1. Authorization Code Flow (Standard Server-Side)

**How it works:**
- User redirected to Spotify for authorization
- Server exchanges authorization code for tokens
- Provides both access token and refresh token
- Intended for long-running server applications

**Implementation:**
```javascript
// Standard OAuth flow with client secret
const response = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: 'grant_type=authorization_code&code=...'
});
```

**Results:**
- ✅ **User intervention**: One-time authorization
- ✅ **Refresh tokens**: Yes (long-lived operation)
- ✅ **Regular playlists**: Full access
- ❌ **Generated playlists**: 404 "Resource not found"

**Use case**: Perfect for background services, but blocked from generated content.

---

### 2. Client Credentials Flow (App-Only)

**How it works:**
- Server-to-server authentication using only client credentials
- No user authorization required
- No refresh token needed (app-level access)
- Intended for accessing public data

**Implementation:**
```javascript
const response = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: 'grant_type=client_credentials'
});
```

**Results:**
- ✅ **User intervention**: None required
- ❌ **Refresh tokens**: Not applicable (app-level)
- ❌ **Regular playlists**: Limited access (public only)
- ❌ **Generated playlists**: 404 "Resource not found"

**Use case**: Accessing public catalog data, not suitable for user-specific content.

---

### 3. Implicit Grant Flow (Client-Side, Deprecated)

**How it works:**
- Client-side JavaScript authentication
- Token returned directly in URL fragment
- No client secret required
- **Deprecated by Spotify** but still functional

**Implementation:**
```javascript
// Client-side redirect to:
// https://accounts.spotify.com/authorize?response_type=token&client_id=...
// Token extracted from URL fragment: #access_token=...
```

**Results:**
- ✅ **User intervention**: One-time authorization per session
- ❌ **Refresh tokens**: None (tokens expire in ~1 hour)
- ✅ **Regular playlists**: Full access
- ✅ **Generated playlists**: **FULL ACCESS** ⭐

**Use case**: The ONLY method that can access generated playlists, but requires frequent re-authorization.

---

### 4. Authorization Code with PKCE Flow (Modern Client-Side)

**How it works:**
- Modern replacement for Implicit Grant
- Uses code verifier/challenge for security
- Suitable for client-side apps without client secret
- Provides refresh tokens

**Implementation:**
```javascript
// Generate PKCE challenge
const codeVerifier = base64url(crypto.randomBytes(32));
const codeChallenge = base64url(sha256(codeVerifier));

// Authorization with PKCE
const response = await fetch('https://accounts.spotify.com/api/token', {
  method: 'POST',
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: authCode,
    code_verifier: codeVerifier,
    client_id: clientId
  })
});
```

**Results:**
- ✅ **User intervention**: One-time authorization
- ✅ **Refresh tokens**: Yes (modern, secure)
- ✅ **Regular playlists**: Full access
- ❌ **Generated playlists**: 404 "Resource not found"

**Use case**: Modern secure client-side auth, but same limitations as Authorization Code.

## Key Findings & Inconsistencies

### 1. Identical Endpoints, Different Results

The same API endpoints return completely different responses based on authentication method:

| Endpoint | Auth Code | Client Creds | Implicit | PKCE |
|----------|-----------|--------------|----------|------|
| `GET /playlists/{generated_id}` | 404 | 404 | **200** | 404 |
| `GET /playlists/{generated_id}/tracks` | 404 | 404 | **200** | 404 |
| `GET /playlists/{regular_id}` | 200 | 403 | 200 | 200 |
| `GET /playlists/{regular_id}/tracks` | 200 | 403 | 200 | 200 |

### 2. Generated Playlists Appear "Public" But Aren't

When accessed via Implicit Grant, generated playlists show:
```json
{
  "name": "Discover Weekly",
  "owner": { "id": "spotify" },
  "public": true,
  "tracks": { "total": 30 }
}
```

Despite appearing "public" and owned by "spotify", they're inaccessible via:
- Client Credentials (which should access public content)
- Authorization Code (which has full user permissions)

### 3. The Refresh Token Paradox

**Critical limitation discovered:**
- **Only Implicit Grant** can access generated playlists
- **Implicit Grant is the ONLY flow** that doesn't provide refresh tokens
- **All flows with refresh tokens** are blocked from generated content

This creates an impossible situation for background services:
- Need generated playlist access → Must use Implicit Grant
- Need background operation → Must have refresh tokens
- **Cannot have both simultaneously**

### 4. Scope Irrelevance

We tested comprehensive scopes including:
- `playlist-read-private`
- `playlist-read-collaborative`
- `user-library-read`
- `user-follow-read`
- All available user and playlist scopes

**Result**: Scopes made no difference. The limitation is at the authentication flow level, not scope level.

## Alternative Approaches Tested

### 1. "Spotify User" Approach
Based on Stack Overflow suggestions to use `/users/spotify/playlists/{id}`:
- **Result**: Same 404 errors across all auth methods
- **Conclusion**: Outdated workaround, no longer functional

### 2. User Playlists Enumeration
Checking if generated playlists appear in `/me/playlists`:
- **Result**: Generated playlists never appear in user's playlist list
- **Even when "followed"**: Still not accessible via standard endpoints

### 3. Server-Side Implicit Grant Simulation
Attempting to use Implicit Grant tokens in server-side Node.js:
- **Result**: ✅ **SUCCESS** - Implicit tokens work server-side with proper headers
- **Limitation**: Still requires client-side token acquisition

## Real-World Evidence

### Exportify Success
**Exportify** (https://github.com/watsonbox/exportify) successfully exports generated playlists:
- Uses **Implicit Grant Flow** exclusively
- Runs entirely client-side in browser
- Still functional as of July 2025
- Confirms our findings about Implicit Grant permissions

### Other Tools
Multiple GitHub repositories attempt generated playlist access:
- All successful tools use client-side Implicit Grant
- All server-side tools fail with same 404 errors we encountered
- Consistent pattern across different implementations

## Technical Implications

### 1. Intentional API Design
The limitations appear **intentional**, not accidental:
- Consistent 404s across multiple auth methods
- Only client-side flow works (harder to automate)
- No refresh tokens for working flow (prevents background operation)
- Recent API restrictions (November 2024) further limit developer access

### 2. Anti-Automation Measures
Spotify seems to actively prevent:
- **Background services** accessing generated content
- **Automated tools** working with algorithmic playlists
- **Long-running applications** that don't require user interaction

### 3. Data Protection Strategy
Likely motivations for these restrictions:
- **Prevent AI training** on recommendation algorithms
- **Protect proprietary data** in generated playlists
- **Maintain user engagement** within Spotify's ecosystem
- **Prevent competitive analysis** of recommendation systems

## Conclusions

### For STSD Development
1. **Generated playlist support requires compromise**:
   - Either frequent user re-authorization (Implicit Grant)
   - Or focus on regular playlists only (Authorization Code)

2. **No perfect solution exists** for background services wanting generated playlist access

3. **Hybrid approach possible** but complex:
   - Use Authorization Code for main functionality
   - Add optional Implicit Grant for generated playlists
   - Require users to refresh tokens manually

### For the Broader Developer Community

1. **Spotify is actively limiting developer access** to generated content
2. **Background services cannot reliably work** with Spotify's most popular playlists
3. **Client-side tools have privileged access** that server-side tools lack
4. **The API landscape is becoming more restrictive**, not more open

### Recommendations

**For developers building Spotify tools:**
- Plan around generated playlist limitations from the start
- Consider client-side architectures if generated content is essential
- Implement clear user communication about what's possible vs. impossible
- Document API limitations prominently to manage user expectations

**For users of Spotify tools:**
- Understand that many limitations are imposed by Spotify, not tool developers
- Consider manually copying generated playlists to regular playlists as workaround
- Be prepared for frequent re-authorization if tools support generated content

## Final Thoughts

This research reveals a fundamental tension between **developer needs** and **platform control**. Spotify's generated playlists represent significant value to users, but the company has made them deliberately difficult to access programmatically.

The result is a fragmented ecosystem where:
- **Simple tools work** (client-side, manual operation)
- **Sophisticated tools struggle** (server-side, automated operation)
- **Users suffer** from reduced functionality and frequent re-authorization

This represents a broader trend in platform APIs becoming more restrictive over time, prioritizing platform control over developer innovation.

---

*Research conducted July 2025 for STSD (Spotify True Shuffle Daemon) project*
*All findings verified through systematic testing and cross-referenced with community tools*