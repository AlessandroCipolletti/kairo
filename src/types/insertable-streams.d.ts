/** Chromium Insertable Streams APIs used for background-safe compositing. */

interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack
}

declare class MediaStreamTrackProcessor {
  constructor(init: MediaStreamTrackProcessorInit)
  readonly readable: ReadableStream<VideoFrame>
}

interface MediaStreamTrackGeneratorInit {
  kind: 'video' | 'audio'
}

declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: MediaStreamTrackGeneratorInit)
  readonly writable: WritableStream<VideoFrame>
}

interface DisplayMediaStreamOptions extends MediaStreamConstraints {
  preferCurrentTab?: boolean
  selfBrowserSurface?: 'include' | 'exclude'
  systemAudio?: 'include' | 'exclude'
  surfaceSwitching?: 'include' | 'exclude'
  monitorTypeSurfaces?: 'include' | 'exclude'
}
