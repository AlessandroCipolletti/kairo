import type { FFmpeg } from '@ffmpeg/ffmpeg'

export type ConvertPhase = 'loading' | 'converting'

export type ConvertProgress = {
  phase: ConvertPhase
  /** 0–1 real progress for this phase */
  progress: number
  label: string
}

export type ConvertOptions = {
  /** Recording length in ms — source of truth for convert % (WebM has no duration). */
  durationMs?: number
  onProgress?: (info: ConvertProgress) => void
}

let ffmpegInstance: FFmpeg | null = null
let loadingPromise: Promise<FFmpeg> | null = null
let progressHandlerAttached = false

/** Latest UI callback — updated every convert so progress events stay live. */
let activeProgress: ((info: ConvertProgress) => void) | undefined
/** Known media duration in microseconds from the app recording timer. */
let activeDurationUs = 0

function emit(info: ConvertProgress) {
  activeProgress?.(info)
}

function attachProgressHandler(ffmpeg: FFmpeg) {
  if (progressHandlerAttached) return
  progressHandlerAttached = true

  ffmpeg.on('progress', ({ progress, time }) => {
    const processedUs = Number.isFinite(time) && time > 0 ? time : 0

    // Prefer recorded duration: ffmpeg's own progress is often 0/NaN for WebM.
    let ratio: number
    if (activeDurationUs > 0) {
      ratio = processedUs / activeDurationUs
    } else if (Number.isFinite(progress) && progress >= 0) {
      ratio = progress
    } else {
      ratio = 0
    }

    ratio = Math.max(0, Math.min(1, ratio))
    const percent = Math.round(ratio * 100)

    const processedSec = processedUs / 1_000_000
    const totalSec = activeDurationUs > 0 ? activeDurationUs / 1_000_000 : 0
    const timeNote =
      totalSec > 0
        ? ` · ${processedSec.toFixed(1)}s / ${totalSec.toFixed(1)}s`
        : processedSec > 0
          ? ` · ${processedSec.toFixed(1)}s processed`
          : ''

    emit({
      phase: 'converting',
      progress: ratio,
      label: `Converting to MP4… ${percent}%${timeNote}`,
    })
  })
}

async function fetchWithProgress(
  url: string,
  onFraction: (fraction: number) => void,
): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download converter asset (${response.status})`)
  }

  const total = Number(response.headers.get('Content-Length') || 0)
  if (!response.body || !total) {
    const blob = await response.blob()
    onFraction(1)
    return blob
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.byteLength
      onFraction(Math.min(1, received / total))
    }
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  onFraction(1)
  return new Blob([bytes])
}

async function toBlobURLWithProgress(
  url: string,
  mimeType: string,
  onFraction: (fraction: number) => void,
): Promise<string> {
  const blob = await fetchWithProgress(url, onFraction)
  return URL.createObjectURL(new Blob([blob], { type: mimeType }))
}

async function getFfmpeg(): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) {
    return ffmpegInstance
  }

  if (loadingPromise) {
    return loadingPromise
  }

  loadingPromise = (async () => {
    emit({ phase: 'loading', progress: 0, label: 'Starting download…' })

    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const ffmpeg = new FFmpeg()
    attachProgressHandler(ffmpeg)

    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm'
    const coreURL = await toBlobURLWithProgress(
      `${baseURL}/ffmpeg-core.js`,
      'text/javascript',
      (fraction) => {
        emit({
          phase: 'loading',
          progress: fraction * 0.1,
          label: `Downloading FFmpeg core… ${Math.round(fraction * 10)}%`,
        })
      },
    )
    const wasmURL = await toBlobURLWithProgress(
      `${baseURL}/ffmpeg-core.wasm`,
      'application/wasm',
      (fraction) => {
        const overall = 0.1 + fraction * 0.9
        emit({
          phase: 'loading',
          progress: overall,
          label: `Downloading FFmpeg library… ${Math.round(overall * 100)}%`,
        })
      },
    )

    emit({ phase: 'loading', progress: 0.97, label: 'Initializing FFmpeg…' })
    try {
      // Worker is resolved via Vite (`import.meta.url`). With `base: './'` this
      // works on both root hosts (CloudFront) and FTP subfolders.
      await Promise.race([
        ffmpeg.load({ coreURL, wasmURL }),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            reject(
              new Error(
                'FFmpeg initialization timed out. Ensure the site assets (worker scripts) load correctly and that cdn.jsdelivr.net is reachable.',
              ),
            )
          }, 60_000)
        }),
      ])
    } catch (error) {
      try {
        ffmpeg.terminate()
      } catch {
        // ignore
      }
      throw error
    }

    emit({ phase: 'loading', progress: 1, label: 'FFmpeg ready' })
    ffmpegInstance = ffmpeg
    return ffmpeg
  })().catch((error) => {
    loadingPromise = null
    throw error
  })

  try {
    return await loadingPromise
  } finally {
    loadingPromise = null
  }
}

async function runConversion(ffmpeg: FFmpeg, args: string[]): Promise<void> {
  const code = await ffmpeg.exec(args)
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code}`)
  }
}

export async function convertWebmToMp4(
  webmBlob: Blob,
  options?: ConvertOptions | ((info: ConvertProgress) => void),
): Promise<Blob> {
  const opts: ConvertOptions =
    typeof options === 'function' ? { onProgress: options } : (options ?? {})

  activeProgress = opts.onProgress
  activeDurationUs =
    opts.durationMs && opts.durationMs > 0 ? opts.durationMs * 1000 : 0

  try {
    const ffmpeg = await getFfmpeg()
    attachProgressHandler(ffmpeg)
    const { fetchFile } = await import('@ffmpeg/util')

    const totalSec = activeDurationUs > 0 ? activeDurationUs / 1_000_000 : 0
    const startLabel =
      totalSec > 0
        ? `Converting to MP4… 0% · 0.0s / ${totalSec.toFixed(1)}s`
        : 'Converting to MP4… 0%'
    emit({ phase: 'converting', progress: 0, label: startLabel })

    const inputName = 'input.webm'
    const outputName = 'output.mp4'

    await ffmpeg.writeFile(inputName, await fetchFile(webmBlob))

    try {
      await runConversion(ffmpeg, [
        '-i',
        inputName,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '23',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        outputName,
      ])
    } catch {
      try {
        await ffmpeg.deleteFile(outputName)
      } catch {
        // ignore
      }
      emit({ phase: 'converting', progress: 0, label: startLabel })
      await runConversion(ffmpeg, [
        '-i',
        inputName,
        '-c:v',
        'mpeg4',
        '-q:v',
        '5',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        outputName,
      ])
    }

    const doneLabel =
      totalSec > 0
        ? `Converting to MP4… 100% · ${totalSec.toFixed(1)}s / ${totalSec.toFixed(1)}s`
        : 'Converting to MP4… 100%'
    emit({ phase: 'converting', progress: 1, label: doneLabel })
    const data = await ffmpeg.readFile(outputName)
    await ffmpeg.deleteFile(inputName)
    await ffmpeg.deleteFile(outputName)

    const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data))
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)

    emit({ phase: 'converting', progress: 1, label: 'Conversion complete' })
    return new Blob([copy], { type: 'video/mp4' })
  } finally {
    activeProgress = undefined
    activeDurationUs = 0
  }
}

export function isFfmpegLoaded(): boolean {
  return Boolean(ffmpegInstance?.loaded)
}
