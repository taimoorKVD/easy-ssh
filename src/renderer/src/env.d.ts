/// <reference types="vite/client" />

import type { EasySshApi } from '@shared/api'

declare global {
  interface Window {
    easySsh: EasySshApi
  }
}

export {}
