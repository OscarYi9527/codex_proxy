import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 47922,
    strictPort: true
  },
  preview: {
    host: '127.0.0.1',
    port: 47922,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
