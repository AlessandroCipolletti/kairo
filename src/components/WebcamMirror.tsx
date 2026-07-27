import { useEffect, useRef } from 'react'

type WebcamMirrorProps = {
  stream: MediaStream | null
  status: 'starting' | 'ready' | 'error' | 'idle'
  statusNote?: string | null
  error?: string | null
}

/** Large circular mirror matching the recording PiP look (mirrored + ring). */
export function WebcamMirror({ stream, status, statusNote, error }: WebcamMirrorProps) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    if (stream) {
      void video.play().catch(() => undefined)
    }
  }, [stream])

  return (
    <div className="webcam-mirror">
      <div className="webcam-mirror-stage">
        <div className="webcam-mirror-ring">
          <video
            ref={videoRef}
            className="webcam-mirror-video"
            autoPlay
            muted
            playsInline
            aria-label="Webcam preview"
          />
          {status !== 'ready' && (
            <div className="webcam-mirror-fallback">
              <p>
                {error ||
                  statusNote ||
                  (status === 'starting' ? 'Starting camera…' : 'Camera preview')}
              </p>
            </div>
          )}
        </div>
      </div>
      {(status === 'error' || status === 'starting') && (
        <p className="webcam-mirror-caption">
          {error || statusNote || 'Starting camera…'}
        </p>
      )}
    </div>
  )
}
