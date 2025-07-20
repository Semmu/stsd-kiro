class ShuffleState {
  constructor() {
    this.isActive = false;
    this.currentContext = null;
    this.currentTracks = [];
    this.lastManagedTrack = null;
    this.lastCheckTime = null;
    this.stsdPlaylistId = null;
    this.initialTrackUri = null; // Track the initial track we start the playlist with
  }

  // Start managing a context
  startShuffle(contextUri, tracks) {
    this.isActive = true;
    this.currentContext = contextUri;
    this.currentTracks = tracks;
    this.lastManagedTrack = null;
    this.lastCheckTime = Date.now();
    this.initialTrackUri = null; // Reset initial track
    
    console.log(`Started managing shuffle for ${contextUri} with ${tracks.length} tracks`);
  }



  // Check if we're currently managing a specific context
  isManagingContext(contextUri) {
    return this.isActive && this.currentContext === contextUri;
  }

  // Update what track we last managed
  setLastManagedTrack(trackUri) {
    this.lastManagedTrack = trackUri;
    this.lastCheckTime = Date.now();
  }

  // Get current state info
  getState() {
    return {
      isActive: this.isActive,
      currentContext: this.currentContext,
      totalTracks: this.currentTracks.length,
      lastManagedTrack: this.lastManagedTrack,
      lastCheckTime: this.lastCheckTime
    };
  }

  // Check if we should take control based on what's currently playing
  shouldTakeControl(currentPlayback) {
    if (!this.isActive) {
      return false;
    }

    // If nothing is playing, we should take control
    if (!currentPlayback || !currentPlayback.is_playing) {
      return true;
    }

    // If playing different context, we should take control
    if (!currentPlayback.context || currentPlayback.context.uri !== this.currentContext) {
      return true;
    }

    // If playing our context but we haven't managed this track, we should take control
    const currentTrackUri = currentPlayback.item?.uri;
    if (currentTrackUri && currentTrackUri !== this.lastManagedTrack) {
      return true;
    }

    return false;
  }

  // Store STSD playlist ID
  setStsdPlaylistId(playlistId) {
    this.stsdPlaylistId = playlistId;
  }

  // Get STSD playlist ID
  getStsdPlaylistId() {
    return this.stsdPlaylistId;
  }

  // Get all tracks from current context
  getAllTracks() {
    return this.currentTracks;
  }

  // Set the initial track URI that we start the playlist with
  setInitialTrack(trackUri) {
    this.initialTrackUri = trackUri;
    console.log(`Set initial track for queue filtering: ${trackUri}`);
  }

  // Get the initial track URI
  getInitialTrack() {
    return this.initialTrackUri;
  }


}

module.exports = new ShuffleState();