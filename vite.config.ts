import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base keeps worker/asset URLs working from both domain root and
// FTP subfolders. Override with VITE_BASE=/ for strict absolute paths.
const base = process.env.VITE_BASE || './'

export default defineConfig({
  base,
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  worker: {
    format: 'es',
  },
})
