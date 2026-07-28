import { useEffect, useMemo, useRef, useState } from 'react'
import { WebcamMirror } from './components/WebcamMirror'
import { useRecorder } from './hooks/useRecorder'
import { useWebcamPreview } from './hooks/useWebcamPreview'
import {
  buildResolutionPresets,
  defaultResolutionId,
  detectMaxCaptureSize,
  type CaptureQuality,
} from './lib/capturePresets'
import { downloadBlob, formatRecordingFilename } from './lib/download'
import {
  convertWebmToMp4,
  isFfmpegLoaded,
  type ConvertPhase,
} from './lib/ffmpegConvert'
import './App.css'

type ProgressStep = {
  id: ConvertPhase
  title: string
  progress: number
  detail: string
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const {
    status,
    error,
    elapsedMs,
    recordingBlob,
    reviewUrl,
    captureInfo,
    startRecording,
    stopRecording,
    discardRecording,
  } = useRecorder(canvasRef)

  const resolutionPresets = useMemo(() => buildResolutionPresets(detectMaxCaptureSize()), [])
  const [resolutionId, setResolutionId] = useState(() => defaultResolutionId(resolutionPresets))
  const [quality, setQuality] = useState<CaptureQuality>('high')
  const [convertState, setConvertState] = useState<'idle' | 'loading' | 'converting'>('idle')
  const [convertSteps, setConvertSteps] = useState<ProgressStep[]>([])
  const [convertError, setConvertError] = useState<string | null>(null)
  const [blurBackground, setBlurBackground] = useState(true)
  const [recordingDurationMs, setRecordingDurationMs] = useState(0)

  const selectedResolution = useMemo(
    () => resolutionPresets.find((preset) => preset.id === resolutionId) ?? resolutionPresets[0],
    [resolutionId, resolutionPresets],
  )

  const busy = status === 'requesting' || convertState !== 'idle'
  const canEditOptions = status === 'idle' || status === 'review'
  const showWebcamPreview = status === 'idle'
  const {
    status: webcamStatus,
    error: webcamError,
    previewStream,
    statusNote: webcamNote,
  } = useWebcamPreview(showWebcamPreview, blurBackground)

  const statusLabel = useMemo(() => {
    if (status === 'requesting') return 'Starting…'
    if (status === 'recording') {
      return captureInfo
        ? `${formatElapsed(elapsedMs)} · ${captureInfo}`
        : formatElapsed(elapsedMs)
    }
    if (status === 'review') return 'Review'
    if (webcamStatus === 'starting') return webcamNote || 'Camera…'
    if (webcamStatus === 'error') return 'Camera unavailable'
    return null
  }, [captureInfo, elapsedMs, status, webcamNote, webcamStatus])

  const handleDownloadWebm = () => {
    if (!recordingBlob) return
    downloadBlob(recordingBlob, formatRecordingFilename('webm'))
  }

  useEffect(() => {
    if (status === 'review' && elapsedMs > 0) {
      setRecordingDurationMs(elapsedMs)
    }
  }, [elapsedMs, status])

  const upsertConvertStep = (phase: ConvertPhase, progress: number, detail: string) => {
    const title = phase === 'loading' ? 'Download FFmpeg library' : 'Convert to MP4'
    const clamped = Math.max(0, Math.min(1, progress))

    setConvertSteps((previous) => {
      const byId = new Map(previous.map((step) => [step.id, step]))

      const existing = byId.get(phase)
      // Keep the newest detail text even when % is still 0 (e.g. "Encoding…").
      byId.set(phase, {
        id: phase,
        title,
        progress: existing ? Math.max(existing.progress, clamped) : clamped,
        detail,
      })

      // Once conversion reports, keep the download row visible at 100%.
      if (phase === 'converting' && byId.has('loading')) {
        const download = byId.get('loading')!
        byId.set('loading', {
          ...download,
          progress: 1,
          detail: download.progress >= 1 ? download.detail : 'FFmpeg ready',
        })
      }

      const ordered: ProgressStep[] = []
      const download = byId.get('loading')
      const convert = byId.get('converting')
      if (download) ordered.push(download)
      if (convert) ordered.push(convert)
      return ordered
    })
  }

  const handleConvertMp4 = async () => {
    if (!recordingBlob || convertState !== 'idle') return
    setConvertError(null)
    setConvertSteps([])
    const durationMs = recordingDurationMs > 0 ? recordingDurationMs : elapsedMs
    const alreadyLoaded = isFfmpegLoaded()
    setConvertState(alreadyLoaded ? 'converting' : 'loading')
    if (!alreadyLoaded) {
      upsertConvertStep('loading', 0, 'Starting download…')
    } else {
      const totalSec =
        durationMs > 0 ? (durationMs / 1000).toFixed(1) : null
      upsertConvertStep(
        'converting',
        0,
        totalSec
          ? `Converting to MP4… 0% · 0.0s / ${totalSec}s`
          : 'Converting to MP4… 0%',
      )
    }

    try {
      const blob = await convertWebmToMp4(recordingBlob, {
        durationMs,
        onProgress: ({ phase, progress, label }) => {
          setConvertState(phase)
          upsertConvertStep(phase, progress, label)
        },
      })
      downloadBlob(blob, formatRecordingFilename('mp4'))
    } catch (err) {
      setConvertError(
        err instanceof Error
          ? err.message
          : 'MP4 conversion failed. You can still download the WebM.',
      )
    } finally {
      setConvertState('idle')
    }
  }

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden="true" />

      <header className="hero">
        <img
          className="brand-mark"
          src={`${import.meta.env.BASE_URL}kairo-mark.svg`}
          alt=""
          width={44}
          height={44}
        />
        <h1>Kairo - Demo video recorder</h1>
      </header>

      <main className="stage">
        <div className={`preview-shell ${status}`}>
          {status === 'review' && reviewUrl ? (
            <video className="review-player" src={reviewUrl} controls playsInline />
          ) : status === 'recording' || status === 'requesting' ? (
            <div className="recording-panel" aria-live="polite">
              <span className="rec-badge rec-badge-inline">REC</span>
              <p className="recording-timer">{formatElapsed(elapsedMs)}</p>
              {status === 'requesting' && (
                <p className="recording-copy">
                  {captureInfo && /blur|Loading/i.test(captureInfo)
                    ? captureInfo
                    : 'Allow screen & mic…'}
                </p>
              )}
              {captureInfo && status === 'recording' && (
                <p className="recording-meta">{captureInfo}</p>
              )}
            </div>
          ) : (
            <WebcamMirror
              stream={previewStream}
              status={webcamStatus}
              statusNote={webcamNote}
              error={webcamError}
            />
          )}

          <canvas ref={canvasRef} className="compose-canvas" width={1920} height={1080} aria-hidden />
        </div>

        {canEditOptions && (
          <div className="capture-controls">
            <label className="field">
              <span className="field-label">Resolution</span>
              <span className="select-wrap">
                <select
                  value={selectedResolution?.id ?? 'max'}
                  onChange={(event) => setResolutionId(event.target.value)}
                >
                  {resolutionPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </span>
            </label>

            <label className="field">
              <span className="field-label">Quality</span>
              <span className="select-wrap">
                <select
                  value={quality}
                  onChange={(event) => setQuality(event.target.value as CaptureQuality)}
                >
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                </select>
              </span>
            </label>
          </div>
        )}

        <div className="panel">
          {statusLabel && (
            <p className="status-line" role="status">
              {statusLabel}
            </p>
          )}

          {canEditOptions && (
            <label className="option">
              <input
                type="checkbox"
                checked={blurBackground}
                onChange={(event) => setBlurBackground(event.target.checked)}
              />
              <span>Blur webcam background</span>
            </label>
          )}

          <div className="actions">
            {status === 'recording' ? (
              <button type="button" className="btn danger" onClick={stopRecording}>
                Stop
              </button>
            ) : status === 'review' ? (
              <>
                <button
                  type="button"
                  className="btn primary"
                  onClick={handleDownloadWebm}
                  disabled={!recordingBlob || busy}
                >
                  Download WebM
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={handleConvertMp4}
                  disabled={!recordingBlob || busy}
                >
                  Convert to MP4
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    setConvertSteps([])
                    setRecordingDurationMs(0)
                    discardRecording()
                  }}
                  disabled={busy}
                >
                  Record again
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  startRecording({
                    blurBackground,
                    quality,
                    resolution: selectedResolution
                      ? {
                          width: selectedResolution.width,
                          height: selectedResolution.height,
                        }
                      : undefined,
                  })
                }
                disabled={busy || !selectedResolution}
              >
                {status === 'requesting' ? 'Starting…' : 'Start recording'}
              </button>
            )}
          </div>

          {convertSteps.length > 0 && (
            <div className="progress-stack" aria-live="polite">
              {convertSteps.map((step) => {
                const percent = Math.round(step.progress * 100)
                return (
                  <div
                    key={step.id}
                    className="progress-block"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={step.title}
                  >
                    <div className="progress-meta">
                      <span>
                        <strong className="progress-title">{step.title}</strong>
                        <span className="progress-detail">{step.detail}</span>
                      </span>
                      <strong>{percent}%</strong>
                    </div>
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {(error || convertError || (showWebcamPreview && webcamError)) && (
            <p className="error" role="alert">
              {error || convertError || webcamError}
            </p>
          )}
        </div>
      </main>
    </div>
  )
}
