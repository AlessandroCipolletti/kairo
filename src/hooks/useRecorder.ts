import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  startCameraBackgroundBlur,
  type BackgroundBlurHandle,
} from '../lib/cameraBackgroundBlur'
import {
  bitrateForCapture,
  type CaptureQuality,
} from '../lib/capturePresets'
import {
  getPreferredCaptureSize,
  startCompositor,
  type CompositorHandle,
} from '../lib/compose'

export type StartRecordingOptions = {
  blurBackground?: boolean
  /** Output resolution for the composed recording (scaled if capture is larger). */
  resolution?: { width: number; height: number }
  quality?: CaptureQuality
}

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'review'

function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type
    }
  }
  return ''
}

async function waitForVideo(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    await video.play().catch(() => undefined)
    return
  }

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      cleanup()
      video.play().then(() => resolve()).catch(() => resolve())
    }
    const onError = () => {
      cleanup()
      reject(new Error('Failed to load media stream'))
    }
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('error', onError)
  })
}

async function applyCaptureResolution(
  track: MediaStreamTrack,
  target: { width: number; height: number },
): Promise<{ width: number; height: number; frameRate: number }> {
  try {
    await track.applyConstraints({
      width: { ideal: target.width },
      height: { ideal: target.height },
      frameRate: { ideal: 30, max: 60 },
    })
  } catch {
    // Browser may reject exact constraints; compositor still scales to target.
  }

  const settings = track.getSettings()
  return {
    width: settings.width || target.width,
    height: settings.height || target.height,
    frameRate: settings.frameRate || 30,
  }
}

export function useRecorder(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null)
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)
  const [captureInfo, setCaptureInfo] = useState<string | null>(null)

  const screenStreamRef = useRef<MediaStream | null>(null)
  const cameraStreamRef = useRef<MediaStream | null>(null)
  const screenVideoRef = useRef<HTMLVideoElement | null>(null)
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null)
  const compositorRef = useRef<CompositorHandle | null>(null)
  const blurHandleRef = useRef<BackgroundBlurHandle | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const composedStreamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)

  /** Stop every capture/compose track so the browser drops screen-sharing UI. */
  const releaseCaptureDevices = useCallback(() => {
    // 1) Stop the original getDisplayMedia tracks immediately (main thread).
    const screenStream = screenStreamRef.current
    screenStreamRef.current = null
    screenStream?.getTracks().forEach((track) => {
      try {
        track.stop()
      } catch {
        // ignore
      }
    })

    if (screenVideoRef.current) {
      screenVideoRef.current.srcObject = null
      screenVideoRef.current = null
    }

    // 2) Stop worker-owned clones (async). Do not leave them alive.
    const compositor = compositorRef.current
    compositorRef.current = null
    void compositor?.stop()

    blurHandleRef.current?.stop()
    blurHandleRef.current = null

    for (const stream of [composedStreamRef.current, cameraStreamRef.current]) {
      stream?.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // ignore
        }
      })
    }
    composedStreamRef.current = null
    cameraStreamRef.current = null

    if (cameraVideoRef.current) {
      cameraVideoRef.current.srcObject = null
      cameraVideoRef.current = null
    }

    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    startedAtRef.current = null
  }, [])

  const revokeReview = useCallback(() => {
    setReviewUrl((current) => {
      if (current) {
        URL.revokeObjectURL(current)
      }
      return null
    })
    setRecordingBlob(null)
  }, [])

  const finalizeRecording = useCallback(
    (blob: Blob | null) => {
      // Idempotent — usually already released in stopRecording.
      releaseCaptureDevices()
      mediaRecorderRef.current = null

      if (!blob || blob.size === 0) {
        setStatus('idle')
        setError((prev) => prev ?? 'Recording produced an empty file. Try again.')
        return
      }

      const url = URL.createObjectURL(blob)
      setRecordingBlob(blob)
      setReviewUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current)
        }
        return url
      })
      setStatus('review')
    },
    [releaseCaptureDevices],
  )

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current

    if (recorder && (recorder.state === 'recording' || recorder.state === 'paused')) {
      try {
        recorder.requestData()
      } catch {
        // ignore
      }
      try {
        recorder.stop()
      } catch {
        // ignore
      }
    }

    // Drop screen capture immediately (original track + worker-owned track).
    releaseCaptureDevices()

    if (!recorder || recorder.state === 'inactive') {
      setStatus((current) => (current === 'review' ? current : 'idle'))
    }
  }, [releaseCaptureDevices])

  const startRecording = useCallback(async (options?: StartRecordingOptions) => {
    const blurBackground = options?.blurBackground ?? true
    const quality: CaptureQuality = options?.quality ?? 'high'
    const maxSize = getPreferredCaptureSize()
    const target = options?.resolution ?? maxSize

    setError(null)
    setCaptureInfo(null)
    revokeReview()
    setElapsedMs(0)
    setStatus('requesting')

    let screenStream: MediaStream | null = null
    let cameraStream: MediaStream | null = null

    try {
      // Ask for the highest useful capture; output size is enforced in the compositor.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: maxSize.width },
          height: { ideal: maxSize.height },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
        preferCurrentTab: false,
      } as DisplayMediaStreamOptions)

      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      })

      const canvas = canvasRef.current
      if (!canvas) {
        throw new Error('Preview canvas is not ready')
      }

      const screenTrack = screenStream.getVideoTracks()[0]
      const cameraTrack = cameraStream.getVideoTracks()[0]
      if (!screenTrack || !cameraTrack) {
        throw new Error('Missing screen or camera track')
      }

      const capture = await applyCaptureResolution(screenTrack, target)
      const outputWidth = target.width
      const outputHeight = target.height
      const frameRate = Math.min(30, Math.round(capture.frameRate) || 30)

      let effectiveCameraTrack = cameraTrack
      if (blurBackground) {
        try {
          const blurHandle = await startCameraBackgroundBlur(cameraTrack, {
            blurPx: 10,
            onStatus: (message) => setCaptureInfo(message),
          })
          blurHandleRef.current = blurHandle
          effectiveCameraTrack = blurHandle.track
        } catch (blurError) {
          console.warn('Webcam background blur unavailable, continuing without it', blurError)
        }
      }

      const screenVideo = document.createElement('video')
      screenVideo.muted = true
      screenVideo.playsInline = true
      screenVideo.srcObject = screenStream

      const cameraVideo = document.createElement('video')
      cameraVideo.muted = true
      cameraVideo.playsInline = true
      cameraVideo.srcObject = new MediaStream([effectiveCameraTrack])

      // Needed for the canvas fallback path; worker path reads tracks directly.
      await Promise.all([waitForVideo(screenVideo), waitForVideo(cameraVideo)])

      screenVideoRef.current = screenVideo
      cameraVideoRef.current = cameraVideo
      screenStreamRef.current = screenStream
      cameraStreamRef.current = cameraStream

      canvas.width = outputWidth
      canvas.height = outputHeight

      const compositor = await startCompositor({
        canvas,
        screenVideo,
        cameraVideo,
        screenTrack,
        cameraTrack: effectiveCameraTrack,
        width: outputWidth,
        height: outputHeight,
        frameRate,
      })
      compositorRef.current = compositor

      const composedStream = new MediaStream(compositor.stream.getVideoTracks())
      for (const track of cameraStream.getAudioTracks()) {
        composedStream.addTrack(track)
      }
      composedStreamRef.current = composedStream

      const blurNote = blurHandleRef.current ? ' · PiP blur' : ''
      const qualityNote = quality === 'high' ? 'high' : 'normal'
      setCaptureInfo(`${outputWidth}×${outputHeight} · ${qualityNote}${blurNote}`)

      const mimeType = pickMimeType()
      const bitsPerSecond = bitrateForCapture(outputWidth, outputHeight, frameRate, quality)
      const recorder = mimeType
        ? new MediaRecorder(composedStream, { mimeType, videoBitsPerSecond: bitsPerSecond })
        : new MediaRecorder(composedStream, { videoBitsPerSecond: bitsPerSecond })

      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data)
        }
      }
      recorder.onerror = () => {
        setError('Recording failed unexpectedly.')
        releaseCaptureDevices()
      }
      recorder.onstop = () => {
        const type = recorder.mimeType || 'video/webm'
        const blob = new Blob(chunksRef.current, { type })
        chunksRef.current = []
        finalizeRecording(blob)
      }

      mediaRecorderRef.current = recorder

      screenTrack.addEventListener(
        'ended',
        () => {
          // User hit "Stop sharing" in the browser UI.
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            try {
              mediaRecorderRef.current.stop()
            } catch {
              // ignore
            }
          }
          releaseCaptureDevices()
        },
        { once: true },
      )

      recorder.start(250)
      startedAtRef.current = Date.now()
      timerRef.current = window.setInterval(() => {
        if (startedAtRef.current !== null) {
          setElapsedMs(Date.now() - startedAtRef.current)
        }
      }, 200)
      setStatus('recording')
    } catch (err) {
      screenStream?.getTracks().forEach((track) => track.stop())
      cameraStream?.getTracks().forEach((track) => track.stop())
      releaseCaptureDevices()

      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Permission denied. Allow screen, camera, and microphone access to record.'
          : err instanceof Error
            ? err.message
            : 'Could not start recording.'
      setError(message)
      setStatus('idle')
    }
  }, [canvasRef, finalizeRecording, releaseCaptureDevices, revokeReview])

  const discardRecording = useCallback(() => {
    revokeReview()
    setElapsedMs(0)
    setError(null)
    setCaptureInfo(null)
    setStatus('idle')
  }, [revokeReview])

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop()
        } catch {
          // ignore
        }
      }
      releaseCaptureDevices()
      setReviewUrl((current) => {
        if (current) {
          URL.revokeObjectURL(current)
        }
        return null
      })
    }
  }, [releaseCaptureDevices])

  return {
    status,
    error,
    elapsedMs,
    recordingBlob,
    reviewUrl,
    captureInfo,
    startRecording,
    stopRecording,
    discardRecording,
    clearError: () => setError(null),
  }
}
