class ShuffleState {
  constructor() {
    this.isActive = false;
    this.currentContext = null;
    this.currentTracks = [];
    this.lastManagedTrack = null;
    this.lastCheckTime = null;
  }

  // Start managing a context
  startShuffle(contextUri, tracks) {
    this.isActive = true;
    this.currentContext = contextUri;
    this.currentTracks = tracks;
    this.lastManagedTrack = null;
    this.lastCheckTime = Date.now();
    
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
}

module.exports = new ShuffleState();