import { detectMaxCaptureSize } from './capturePresets'

export type CompositorHandle = {
  /** Composed video-only MediaStream (add mic audio on the main thread). */
  stream: MediaStream
  /** Stops worker-owned track clones (required to end Chrome screen-sharing UI). */
  stop: () => Promise<void>
}

function supportsInsertableStreams(): boolean {
  return (
    typeof MediaStreamTrackProcessor === 'function' &&
    typeof MediaStreamTrackGenerator === 'function' &&
    typeof OffscreenCanvas === 'function'
  )
}

function drawPip(
  ctx: CanvasRenderingContext2D,
  cameraVideo: CanvasImageSource,
  width: number,
  height: number,
  camW: number,
  camH: number,
) {
  const size = Math.min(width, height) * 0.2
  const pad = Math.min(width, height) * 0.04
  const cx = width - pad - size / 2
  const cy = height - pad - size / 2
  const radius = size / 2

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.closePath()
  ctx.clip()

  const scale = Math.max(size / camW, size / camH)
  const drawW = camW * scale
  const drawH = camH * scale

  ctx.translate(cx, cy)
  ctx.scale(-1, 1)
  ctx.translate(-cx, -cy)
  ctx.drawImage(cameraVideo, cx - drawW / 2, cy - drawH / 2, drawW, drawH)
  ctx.restore()

  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255, 246, 232, 0.95)'
  ctx.lineWidth = Math.max(3, size * 0.035)
  ctx.stroke()
}

/**
 * Fallback for browsers without Insertable Streams.
 * A worker timer keeps requesting draws when the tab is backgrounded
 * (requestAnimationFrame alone freezes).
 */
function startFallbackCompose(
  canvas: HTMLCanvasElement,
  screenVideo: HTMLVideoElement,
  cameraVideo: HTMLVideoElement,
  frameRate: number,
): CompositorHandle {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable')
  }

  const stream = canvas.captureStream(frameRate)
  let stopped = false

  const tickWorker = new Worker(
    URL.createObjectURL(
      new Blob(
        [
          `let id=0;onmessage=(e)=>{if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage('tick'),${Math.round(1000 / frameRate)});}if(e.data==='stop'){clearInterval(id);}};`,
        ],
        { type: 'application/javascript' },
      ),
    ),
  )

  const draw = () => {
    if (stopped) return
    const width = screenVideo.videoWidth || canvas.width
    const height = screenVideo.videoHeight || canvas.height
    if (!width || !height) return

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    ctx.clearRect(0, 0, width, height)
    if (screenVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      ctx.drawImage(screenVideo, 0, 0, width, height)
    }
    if (cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      drawPip(
        ctx,
        cameraVideo,
        width,
        height,
        cameraVideo.videoWidth || 640,
        cameraVideo.videoHeight || 480,
      )
    }
  }

  tickWorker.onmessage = () => draw()
  tickWorker.postMessage('start')

  let raf = 0
  const rafLoop = () => {
    draw()
    raf = requestAnimationFrame(rafLoop)
  }
  raf = requestAnimationFrame(rafLoop)

  return {
    stream,
    stop: async () => {
      stopped = true
      cancelAnimationFrame(raf)
      tickWorker.postMessage('stop')
      tickWorker.terminate()
    },
  }
}

/**
 * Background-safe compositor (Chromium): reads raw VideoFrames in a worker so
 * capture continues when the Kairo tab is not focused.
 */
async function startWorkerCompose(
  width: number,
  height: number,
  screenTrack: MediaStreamTrack,
  cameraTrack: MediaStreamTrack,
): Promise<CompositorHandle> {
  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const writable = generator.writable

  const worker = new Worker(new URL('./composeWorker.ts', import.meta.url), {
    type: 'module',
  })

  // Transfer the real display-media track (no clone). Clones keep Chrome's
  // "sharing this screen" UI alive until every copy is stopped.
  const cameraClone = cameraTrack.clone()

  const ready = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new Error('Compositor worker timed out'))
    }, 10_000)

    const cleanup = () => {
      window.clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }

    const onMessage = (event: MessageEvent<{ type: string; message?: string }>) => {
      if (event.data.type === 'ready') {
        cleanup()
        resolve()
      } else if (event.data.type === 'error') {
        cleanup()
        reject(new Error(event.data.message || 'Compositor worker error'))
      }
    }

    const onError = () => {
      cleanup()
      reject(new Error('Compositor worker failed to start'))
    }

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
  })

  worker.postMessage(
    {
      type: 'start',
      width,
      height,
      screenTrack,
      cameraTrack: cameraClone,
      writable,
    },
    [screenTrack, cameraClone, writable],
  )

  try {
    await ready
    return {
      stream: new MediaStream([generator]),
      stop: () =>
        new Promise<void>((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            try {
              generator.stop()
            } catch {
              // ignore
            }
            try {
              worker.terminate()
            } catch {
              // ignore
            }
            resolve()
          }

          const onMessage = (event: MessageEvent<{ type?: string }>) => {
            if (event.data?.type === 'stopped') {
              worker.removeEventListener('message', onMessage)
              window.clearTimeout(timeout)
              finish()
            }
          }

          // Never terminate before the worker stops the transferred display track.
          const timeout = window.setTimeout(finish, 1500)
          worker.addEventListener('message', onMessage)

          try {
            worker.postMessage({ type: 'stop' })
          } catch {
            window.clearTimeout(timeout)
            worker.removeEventListener('message', onMessage)
            finish()
          }
        }),
    }
  } catch (error) {
    try {
      worker.postMessage({ type: 'stop' })
    } catch {
      // ignore
    }
    try {
      // If transfer failed before handoff, stop locally.
      screenTrack.stop()
    } catch {
      // ignore
    }
    try {
      cameraClone.stop()
    } catch {
      // ignore
    }
    try {
      generator.stop()
    } catch {
      // ignore
    }
    window.setTimeout(() => worker.terminate(), 300)
    throw error
  }
}

export async function startCompositor(options: {
  canvas: HTMLCanvasElement
  screenVideo: HTMLVideoElement
  cameraVideo: HTMLVideoElement
  screenTrack: MediaStreamTrack
  cameraTrack: MediaStreamTrack
  width: number
  height: number
  frameRate?: number
}): Promise<CompositorHandle> {
  const frameRate = options.frameRate ?? 30

  if (supportsInsertableStreams()) {
    try {
      return await startWorkerCompose(
        options.width,
        options.height,
        options.screenTrack,
        options.cameraTrack,
      )
    } catch (error) {
      console.warn('Worker compositor failed, falling back to canvas loop', error)
    }
  }

  options.canvas.width = options.width
  options.canvas.height = options.height
  return startFallbackCompose(
    options.canvas,
    options.screenVideo,
    options.cameraVideo,
    frameRate,
  )
}

/** Target capture size: physical screen pixels when the browser allows it. */
export function getPreferredCaptureSize(): { width: number; height: number } {
  return detectMaxCaptureSize()
}

export { bitrateForCapture as bitrateForResolution } from './capturePresets'
