import React from 'react'
import ReactDOM from 'react-dom/client'
import { Buffer } from 'buffer'
import process from 'process'
import App from './App'
import './index.css'

const rootGlobal = globalThis as typeof globalThis & {
  Buffer?: typeof Buffer
  process?: typeof process
}

if (!rootGlobal.Buffer) {
  rootGlobal.Buffer = Buffer
}

if (!rootGlobal.process) {
  rootGlobal.process = process
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <App />,
)
