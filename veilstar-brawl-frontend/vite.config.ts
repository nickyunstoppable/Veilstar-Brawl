import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  // Load .env files from the parent directory (repo root)
  envDir: '..',
  define: {
    global: 'globalThis',
    process: 'globalThis.process'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      buffer: path.resolve(__dirname, './node_modules/buffer/'),
      'node:buffer': path.resolve(__dirname, './node_modules/buffer/'),
      assert: path.resolve(__dirname, './node_modules/assert/'),
      'node:assert': path.resolve(__dirname, './node_modules/assert/'),
      events: path.resolve(__dirname, './node_modules/events/'),
      'node:events': path.resolve(__dirname, './node_modules/events/'),
      util: path.resolve(__dirname, './node_modules/util/'),
      'node:util': path.resolve(__dirname, './node_modules/util/'),
      process: path.resolve(__dirname, './node_modules/process/browser.js'),
      'node:process': path.resolve(__dirname, './node_modules/process/browser.js')
    },
    dedupe: ['@stellar/stellar-sdk']
  },
  optimizeDeps: {
    include: ['@stellar/stellar-sdk', '@stellar/stellar-sdk/contract', '@stellar/stellar-sdk/rpc', 'buffer', 'assert', 'events', 'util', 'process'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
        process: 'globalThis.process',
        'process.env': '{}'
      }
    }
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    }
  },
  worker: {
    format: 'es'
  },
  server: {
    host: 'localhost',
    port: 3000,
    strictPort: true,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
