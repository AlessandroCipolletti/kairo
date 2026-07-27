import type { ImageSegmenter } from '@mediapipe/tasks-vision'

export type BackgroundBlurHandle = {
  track: MediaStreamTrack
  stop: () => void
}

const BLUR_PX = 10
const MAX_PROCESS_WIDTH = 640

let segmenterPromise: Promise<ImageSegmenter> | null = null

async function getSegmenter(
  onStatus?: (message: string) => void,
): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      onStatus?.('Loading background blur model…')
      const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm',
      )
      const segmenter = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      })
      onStatus?.('Background blur ready')
      return segmenter
    })().catch((error) => {
      segmenterPromise = null
      throw error
    })
  }
  return segmenterPromise
}

function supportsInsertableStreams(): boolean {
  return (
    typeof MediaStreamTrackProcessor === 'function' &&
    typeof MediaStreamTrackGenerator === 'function'
  )
}

function blendWithMask(
  sharp: ImageData,
  blurred: ImageData,
  mask: Float32Array | Uint8Array,
  maskWidth: number,
  maskHeight: number,
): void {
  const out = sharp.data
  const soft = blurred.data
  const srcW = sharp.width
  const srcH = sharp.height
  const maskIsFloat = mask instanceof Float32Array

  for (let y = 0; y < srcH; y++) {
    const my = Math.min(maskHeight - 1, Math.floor((y / srcH) * maskHeight))
    for (let x = 0; x < srcW; x++) {
      const mx = Math.min(maskWidth - 1, Math.floor((x / srcW) * maskWidth))
      const mi = my * maskWidth + mx
      const raw = mask[mi] ?? 0
      const alpha = maskIsFloat ? Math.min(1, Math.max(0, raw)) : raw / 255
      const i = (y * srcW + x) * 4
      const inv = 1 - alpha
      out[i] = out[i] * alpha + soft[i] * inv
      out[i + 1] = out[i + 1] * alpha + soft[i + 1] * inv
      out[i + 2] = out[i + 2] * alpha + soft[i + 2] * inv
    }
  }
}

function processFrameToCanvas(
  segmenter: ImageSegmenter,
  frame: CanvasImageSource,
  timestampMs: number,
  width: number,
  height: number,
  sharpCanvas: HTMLCanvasElement,
  blurCanvas: HTMLCanvasElement,
  outCanvas: HTMLCanvasElement,
  blurPx: number,
): void {
  if (sharpCanvas.width !== width || sharpCanvas.height !== height) {
    sharpCanvas.width = width
    sharpCanvas.height = height
    blurCanvas.width = width
    blurCanvas.height = height
    outCanvas.width = width
    outCanvas.height = height
  }

  const sharpCtx = sharpCanvas.getContext('2d', { willReadFrequently: true })
  const blurCtx = blurCanvas.getContext('2d', { willReadFrequently: true })
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true })
  if (!sharpCtx || !blurCtx || !outCtx) {
    throw new Error('Canvas 2D context unavailable for background blur')
  }

  sharpCtx.clearRect(0, 0, width, height)
  sharpCtx.drawImage(frame, 0, 0, width, height)

  blurCtx.clearRect(0, 0, width, height)
  blurCtx.filter = `blur(${blurPx}px)`
  blurCtx.drawImage(sharpCanvas, 0, 0)
  blurCtx.filter = 'none'

  const result = segmenter.segmentForVideo(sharpCanvas, timestampMs)
  const confidence = result.confidenceMasks?.[0]
  if (!confidence) {
    outCtx.clearRect(0, 0, width, height)
    outCtx.drawImage(sharpCanvas, 0, 0)
    result.close()
    return
  }

  try {
    const mask = confidence.hasFloat32Array()
      ? confidence.getAsFloat32Array()
      : confidence.getAsUint8Array()
    const sharpData = sharpCtx.getImageData(0, 0, width, height)
    const blurData = blurCtx.getImageData(0, 0, width, height)
    blendWithMask(sharpData, blurData, mask, confidence.width, confidence.height)
    outCtx.putImageData(sharpData, 0, 0)
  } finally {
    confidence.close()
    result.close()
  }
}

function createWorkCanvases(width: number, height: number) {
  const sharpCanvas = document.createElement('canvas')
  const blurCanvas = document.createElement('canvas')
  const outCanvas = document.createElement('canvas')
  sharpCanvas.width = width
  sharpCanvas.height = height
  blurCanvas.width = width
  blurCanvas.height = height
  outCanvas.width = width
  outCanvas.height = height
  return { sharpCanvas, blurCanvas, outCanvas }
}

async function startProcessorBlur(
  inputTrack: MediaStreamTrack,
  blurPx: number,
  onStatus?: (message: string) => void,
): Promise<BackgroundBlurHandle> {
  const segmenter = await getSegmenter(onStatus)
  const settings = inputTrack.getSettings()
  const sourceW = settings.width || 1280
  const sourceH = settings.height || 720
  const scale = Math.min(1, MAX_PROCESS_WIDTH / sourceW)
  const width = Math.max(2, Math.round(sourceW * scale))
  const height = Math.max(2, Math.round(sourceH * scale))

  const cloned = inputTrack.clone()
  const generator = new MediaStreamTrackGenerator({ kind: 'video' })
  const writer = generator.writable.getWriter()
  const processor = new MediaStreamTrackProcessor({ track: cloned })
  const reader = processor.readable.getReader()
  const { sharpCanvas, blurCanvas, outCanvas } = createWorkCanvases(width, height)

  let stopped = false
  let lastTimestamp = -1

  const pump = async () => {
    try {
      while (!stopped) {
        const result = await reader.read()
        if (result.done) break
        const frame = result.value
        try {
          let timestampMs = (frame.timestamp ?? performance.now() * 1000) / 1000
          if (timestampMs <= lastTimestamp) {
            timestampMs = lastTimestamp + 1 / 60
          }
          lastTimestamp = timestampMs

          processFrameToCanvas(
            segmenter,
            frame,
            timestampMs,
            width,
            height,
            sharpCanvas,
            blurCanvas,
            outCanvas,
            blurPx,
          )

          const output = new VideoFrame(outCanvas, {
            timestamp: frame.timestamp ?? Math.round(timestampMs * 1000),
            alpha: 'discard',
          })
          try {
            if (!stopped) {
              await writer.write(output)
            }
          } finally {
            output.close()
          }
        } finally {
          frame.close()
        }
      }
    } catch (error) {
      if (!stopped) {
        console.warn('Background blur pipeline stopped', error)
      }
    } finally {
      try {
        await writer.close()
      } catch {
        // ignore
      }
    }
  }

  void pump()

  return {
    track: generator,
    stop: () => {
      stopped = true
      void reader.cancel()
      cloned.stop()
      generator.stop()
      try {
        writer.releaseLock()
      } catch {
        // ignore
      }
    },
  }
}

async function startCanvasBlur(
  inputTrack: MediaStreamTrack,
  blurPx: number,
  onStatus?: (message: string) => void,
): Promise<BackgroundBlurHandle> {
  const segmenter = await getSegmenter(onStatus)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([inputTrack])
  await video.play().catch(() => undefined)

  const settings = inputTrack.getSettings()
  const sourceW = settings.width || video.videoWidth || 1280
  const sourceH = settings.height || video.videoHeight || 720
  const scale = Math.min(1, MAX_PROCESS_WIDTH / sourceW)
  const width = Math.max(2, Math.round(sourceW * scale))
  const height = Math.max(2, Math.round(sourceH * scale))

  const { sharpCanvas, blurCanvas, outCanvas } = createWorkCanvases(width, height)
  const stream = outCanvas.captureStream(30)
  const outTrack = stream.getVideoTracks()[0]
  if (!outTrack) {
    throw new Error('Could not create blurred camera track')
  }

  let stopped = false
  let lastTimestamp = -1

  const tickWorker = new Worker(
    URL.createObjectURL(
      new Blob(
        [
          `let id=0;onmessage=(e)=>{if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage('tick'),33);}if(e.data==='stop'){clearInterval(id);}};`,
        ],
        { type: 'application/javascript' },
      ),
    ),
  )

  const draw = () => {
    if (stopped || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
    let timestampMs = performance.now()
    if (timestampMs <= lastTimestamp) {
      timestampMs = lastTimestamp + 1
    }
    lastTimestamp = timestampMs
    try {
      processFrameToCanvas(
        segmenter,
        video,
        timestampMs,
        width,
        height,
        sharpCanvas,
        blurCanvas,
        outCanvas,
        blurPx,
      )
    } catch (error) {
      console.warn('Background blur frame failed', error)
    }
  }

  tickWorker.onmessage = () => draw()
  tickWorker.postMessage('start')

  return {
    track: outTrack,
    stop: () => {
      stopped = true
      tickWorker.postMessage('stop')
      tickWorker.terminate()
      video.srcObject = null
      outTrack.stop()
    },
  }
}

/** Person stays sharp; background gets a soft blur (default 10px). */
export async function startCameraBackgroundBlur(
  inputTrack: MediaStreamTrack,
  options?: {
    blurPx?: number
    onStatus?: (message: string) => void
  },
): Promise<BackgroundBlurHandle> {
  const blurPx = options?.blurPx ?? BLUR_PX
  if (supportsInsertableStreams()) {
    try {
      return await startProcessorBlur(inputTrack, blurPx, options?.onStatus)
    } catch (error) {
      console.warn('Insertable-stream blur failed, falling back to canvas', error)
    }
  }
  return startCanvasBlur(inputTrack, blurPx, options?.onStatus)
}
