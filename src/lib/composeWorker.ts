/// <reference lib="webworker" />

type StartMessage = {
  type: 'start'
  width: number
  height: number
  screenTrack: MediaStreamTrack
  cameraTrack: MediaStreamTrack
  writable: WritableStream<VideoFrame>
}

type StopMessage = { type: 'stop' }
type InMessage = StartMessage | StopMessage

declare const self: DedicatedWorkerGlobalScope

let running = false
let screenReader: ReadableStreamDefaultReader<VideoFrame> | null = null
let cameraReader: ReadableStreamDefaultReader<VideoFrame> | null = null
let latestCameraFrame: VideoFrame | null = null
let canvas: OffscreenCanvas | null = null
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null
/** Tracks transferred into this worker — must be stopped to end screen sharing. */
let ownedScreenTrack: MediaStreamTrack | null = null
let ownedCameraTrack: MediaStreamTrack | null = null

function closeFrame(frame: VideoFrame | null) {
  if (frame) {
    try {
      frame.close()
    } catch {
      // already closed
    }
  }
}

/** Stop capture tracks immediately (sync) — this dismisses Chrome's sharing UI. */
function stopOwnedTracks() {
  try {
    ownedScreenTrack?.stop()
  } catch {
    // ignore
  }
  try {
    ownedCameraTrack?.stop()
  } catch {
    // ignore
  }
  ownedScreenTrack = null
  ownedCameraTrack = null
}

function drawPip(
  ctx: OffscreenCanvasRenderingContext2D,
  cameraFrame: VideoFrame,
  width: number,
  height: number,
) {
  const size = Math.min(width, height) * 0.2
  const pad = Math.min(width, height) * 0.04
  const cx = width - pad - size / 2
  const cy = height - pad - size / 2
  const radius = size / 2

  const camW = cameraFrame.displayWidth || cameraFrame.codedWidth
  const camH = cameraFrame.displayHeight || cameraFrame.codedHeight
  const scale = Math.max(size / camW, size / camH)
  const drawW = camW * scale
  const drawH = camH * scale

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()

  ctx.translate(cx, cy)
  ctx.scale(-1, 1)
  ctx.translate(-cx, -cy)
  ctx.drawImage(cameraFrame, cx - drawW / 2, cy - drawH / 2, drawW, drawH)
  ctx.restore()

  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255, 246, 232, 0.95)'
  ctx.lineWidth = Math.max(3, size * 0.035)
  ctx.stroke()
}

async function readCameraLoop() {
  while (running && cameraReader) {
    const result = await cameraReader.read()
    if (result.done) break
    closeFrame(latestCameraFrame)
    latestCameraFrame = result.value
  }
}

async function pumpScreenFrames(
  ctx: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
) {
  if (!writer) return

  while (running && screenReader) {
    const result = await screenReader.read()
    if (result.done) break

    const screenFrame = result.value
    try {
      if (canvas && (canvas.width !== width || canvas.height !== height)) {
        canvas.width = width
        canvas.height = height
      }

      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(screenFrame, 0, 0, width, height)

      if (latestCameraFrame) {
        drawPip(ctx, latestCameraFrame, width, height)
      }

      const composed = new VideoFrame(canvas!, {
        timestamp: screenFrame.timestamp ?? 0,
        alpha: 'discard',
      })
      try {
        await writer.write(composed)
      } finally {
        composed.close()
      }
    } finally {
      screenFrame.close()
    }
  }
}

async function cleanupReadersAndWriter() {
  try {
    await screenReader?.cancel()
  } catch {
    // ignore
  }
  try {
    await cameraReader?.cancel()
  } catch {
    // ignore
  }
  screenReader = null
  cameraReader = null
  closeFrame(latestCameraFrame)
  latestCameraFrame = null

  try {
    await writer?.close()
  } catch {
    // ignore
  }
  writer = null
  canvas = null
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const message = event.data

  if (message.type === 'stop') {
    running = false
    // Must be synchronous and happen before any await / terminate race.
    stopOwnedTracks()
    void cleanupReadersAndWriter().finally(() => {
      self.postMessage({ type: 'stopped' })
    })
    return
  }

  if (message.type !== 'start') return

  running = false
  stopOwnedTracks()
  void (async () => {
    await cleanupReadersAndWriter()

    const { width, height, screenTrack, cameraTrack, writable } = message
    ownedScreenTrack = screenTrack
    ownedCameraTrack = cameraTrack
    canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    })
    if (!ctx) {
      stopOwnedTracks()
      self.postMessage({ type: 'error', message: 'OffscreenCanvas 2D context unavailable' })
      return
    }

    const TrackProcessor = (
      self as unknown as { MediaStreamTrackProcessor?: typeof MediaStreamTrackProcessor }
    ).MediaStreamTrackProcessor

    if (!TrackProcessor) {
      stopOwnedTracks()
      self.postMessage({
        type: 'error',
        message: 'Background-safe compositor requires MediaStreamTrackProcessor support',
      })
      return
    }

    const screenProcessor = new TrackProcessor({ track: screenTrack })
    const cameraProcessor = new TrackProcessor({ track: cameraTrack })
    screenReader = screenProcessor.readable.getReader()
    cameraReader = cameraProcessor.readable.getReader()
    writer = writable.getWriter()

    running = true
    void readCameraLoop()

    self.postMessage({ type: 'ready' })

    try {
      await pumpScreenFrames(ctx, width, height)
    } catch (error) {
      self.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Compositor failed',
      })
    }
  })()
}
