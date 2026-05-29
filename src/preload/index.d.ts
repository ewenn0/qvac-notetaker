import type { NotetakerAPI } from './index'

declare global {
  interface Window {
    notetakerAPI: NotetakerAPI
  }
}

export {}
