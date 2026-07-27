export type CaptureQuality = 'high' | 'normal'

export type ResolutionPreset = {
  id: string
  label: string
  width: number
  height: number
}

/** Physical screen pixels the page can target (CSS size × devicePixelRatio). */
export function detectMaxCaptureSize(): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1
  return {
    width: Math.round(window.screen.width * dpr),
    height: Math.round(window.screen.height * dpr),
  }
}

function friendlyTier(width: number, height: number): string {
  const long = Math.max(width, height)
  if (long >= 5000) return '5K'
  if (long >= 3500) return '3.5K'
  if (long >= 3000) return '3K'
  if (long >= 2400) return '2.5K'
  if (long >= 2200) return '1440p'
  if (long >= 1600) return '1080p'
  if (long >= 1100) return '720p'
  return `${width}×${height}`
}

function nearlySame(
  a: { width: number; height: number },
  b: { width: number; height: number },
  tolerance = 40,
): boolean {
  return Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}

/**
 * Builds resolution choices up to the detected screen max.
 * Always includes native max; adds half-res and common lower tiers when they fit.
 */
export function buildResolutionPresets(
  max: { width: number; height: number } = detectMaxCaptureSize(),
): ResolutionPreset[] {
  const aspect = max.width / Math.max(1, max.height)
  const presets: ResolutionPreset[] = []

  const pushUnique = (id: string, width: number, height: number, tierOverride?: string) => {
    width = Math.round(width)
    height = Math.round(height)
    if (width < 640 || height < 360) return
    if (width > max.width + 2 || height > max.height + 2) return
    if (presets.some((p) => nearlySame(p, { width, height }))) return
    const tier = tierOverride ?? friendlyTier(width, height)
    presets.push({
      id,
      label: `${tier} (${width}×${height})`,
      width,
      height,
    })
  }

  pushUnique('max', max.width, max.height)
  pushUnique('half', max.width / 2, max.height / 2)

  for (const { id, name, height } of [
    { id: '1440', name: '1440p', height: 1440 },
    { id: '1080', name: '1080p', height: 1080 },
    { id: '720', name: '720p', height: 720 },
  ]) {
    const width = Math.round(height * aspect)
    pushUnique(id, width, height, name)
  }

  return presets
}

export function bitrateForCapture(
  width: number,
  height: number,
  frameRate = 30,
  quality: CaptureQuality = 'high',
): number {
  const factor = quality === 'high' ? 0.18 : 0.09
  const minRate = quality === 'high' ? 10_000_000 : 4_000_000
  const maxRate = quality === 'high' ? 50_000_000 : 22_000_000
  const estimate = Math.round(width * height * frameRate * factor)
  return Math.min(maxRate, Math.max(minRate, estimate))
}
