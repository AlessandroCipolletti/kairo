export type CaptureQuality = 'high' | 'normal'

export type ResolutionPreset = {
  id: string
  label: string
  width: number
  height: number
}

/** Force even dimensions — safer for MediaRecorder / H.264. */
function even(n: number): number {
  const rounded = Math.round(n)
  return rounded - (rounded % 2)
}

/** Physical screen pixels the page can target (CSS size × devicePixelRatio). */
export function detectMaxCaptureSize(): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1
  return {
    width: even(window.screen.width * dpr),
    height: even(window.screen.height * dpr),
  }
}

function nearlySame(
  a: { width: number; height: number },
  b: { width: number; height: number },
  tolerance = 24,
): boolean {
  return Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}

/** Common output sizes for demo videos (16:9), largest first. */
const STANDARD_16_9 = [
  { id: '2160', name: '4K', width: 3840, height: 2160 },
  { id: '1440', name: '1440p', width: 2560, height: 1440 },
  { id: '1080', name: '1080p', width: 1920, height: 1080 },
  { id: '720', name: '720p', width: 1280, height: 720 },
] as const

/**
 * Builds a short list of useful resolutions:
 * - standard 16:9 sizes that fit the screen (good for sharing)
 * - native screen size (snapped to even pixels)
 */
export function buildResolutionPresets(
  max: { width: number; height: number } = detectMaxCaptureSize(),
): ResolutionPreset[] {
  const maxW = even(max.width)
  const maxH = even(max.height)
  const presets: ResolutionPreset[] = []

  const pushUnique = (id: string, width: number, height: number, label: string) => {
    width = even(width)
    height = even(height)
    if (width < 640 || height < 360) return
    if (width > maxW + 2 || height > maxH + 2) return
    if (presets.some((p) => nearlySame(p, { width, height }))) return
    presets.push({ id, label, width, height })
  }

  pushUnique('native', maxW, maxH, `Screen · ${maxW}×${maxH}`)

  for (const tier of STANDARD_16_9) {
    pushUnique(tier.id, tier.width, tier.height, `${tier.name} · ${tier.width}×${tier.height}`)
  }

  // Screen first, then standard sizes largest → smallest.
  const order = new Map<string, number>([['native', 0]])
  STANDARD_16_9.forEach((t, i) => order.set(t.id, i + 1))
  presets.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))

  return presets
}

/** Prefer 1080p for demos when the screen can deliver it. */
export function defaultResolutionId(presets: ResolutionPreset[]): string {
  return (
    presets.find((p) => p.id === '1080')?.id ??
    presets.find((p) => p.id === '720')?.id ??
    presets[0]?.id ??
    'native'
  )
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
