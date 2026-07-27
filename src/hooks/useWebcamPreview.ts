import { useEffect, useRef, useState } from 'react'
import {
  startCameraBackgroundBlur,
  type BackgroundBlurHandle,
} from '../lib/cameraBackgroundBlur'

export type WebcamPreviewStatus = 'starting' | 'ready' | 'error' | 'idle'

/**
 * Asks for camera when enabled and exposes a stream for the circular pre-roll
 * mirror — with the same optional background blur used in recordings.
 */
export function useWebcamPreview(enabled: boolean, blurBackground: boolean) {
  const [status, setStatus] = useState<WebcamPreviewStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [statusNote, setStatusNote] = useState<string | null>(null)

  const rawStreamRef = useRef<MediaStream | null>(null)
  const blurHandleRef = useRef<BackgroundBlurHandle | null>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1
      blurHandleRef.current?.stop()
      blurHandleRef.current = null
      rawStreamRef.current?.getTracks().forEach((track) => track.stop())
      rawStreamRef.current = null
      setPreviewStream(null)
      setStatus('idle')
      setStatusNote(null)
      setError(null)
      return
    }

    const generation = ++generationRef.current
    let cancelled = false

    const isCurrent = () => !cancelled && generation === generationRef.current

    const start = async () => {
      setStatus('starting')
      setError(null)
      setStatusNote('Requesting camera…')

      try {
        let raw = rawStreamRef.current
        const rawAlive = Boolean(raw?.getVideoTracks().some((track) => track.readyState === 'live'))

        if (!raw || !rawAlive) {
          rawStreamRef.current?.getTracks().forEach((track) => track.stop())
          raw = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: 'user',
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            },
            audio: false,
          })
          if (!isCurrent()) {
            raw.getTracks().forEach((track) => track.stop())
            return
          }
          rawStreamRef.current = raw
        }

        blurHandleRef.current?.stop()
        blurHandleRef.current = null

        const cameraTrack = raw.getVideoTracks()[0]
        if (!cameraTrack) {
          throw new Error('No camera track available')
        }

        if (blurBackground) {
          setStatusNote('Loading background blur…')
          try {
            const blurHandle = await startCameraBackgroundBlur(cameraTrack, {
              blurPx: 10,
              onStatus: (message) => {
                if (isCurrent()) setStatusNote(message)
              },
            })
            if (!isCurrent()) {
              blurHandle.stop()
              return
            }
            blurHandleRef.current = blurHandle
            setPreviewStream(new MediaStream([blurHandle.track]))
          } catch (blurError) {
            console.warn('Preview blur unavailable, showing raw camera', blurError)
            if (!isCurrent()) return
            setPreviewStream(new MediaStream([cameraTrack]))
          }
        } else if (isCurrent()) {
          setPreviewStream(new MediaStream([cameraTrack]))
        }

        if (isCurrent()) {
          setStatus('ready')
          setStatusNote(null)
        }
      } catch (err) {
        if (!isCurrent()) return
        setStatus('error')
        setPreviewStream(null)
        setStatusNote(null)
        setError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow the webcam to see your PiP preview.'
            : err instanceof Error
              ? err.message
              : 'Could not access the camera.',
        )
      }
    }

    void start()

    return () => {
      cancelled = true
      blurHandleRef.current?.stop()
      blurHandleRef.current = null
    }
  }, [enabled, blurBackground])

  useEffect(() => {
    return () => {
      generationRef.current += 1
      blurHandleRef.current?.stop()
      blurHandleRef.current = null
      rawStreamRef.current?.getTracks().forEach((track) => track.stop())
      rawStreamRef.current = null
    }
  }, [])

  return {
    status,
    error,
    previewStream,
    statusNote,
  }
}
