import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { execFileSync } from 'node:child_process'
let revision = 'local'
try {
  revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {}
const build = { revision, at: new Date().toISOString() }
export default defineConfig({
  plugins: [vue()],
  define: { __CONSOLE_BUILD__: JSON.stringify(build) },
  server: {
    proxy: Object.fromEntries(
      ['/api', '/img', '/bl-chat'].map((path) => [path, 'http://127.0.0.1:8787'])
    )
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { manualChunks: { vue: ['vue', 'vue-router'], ui: ['naive-ui'] } } }
  }
})
