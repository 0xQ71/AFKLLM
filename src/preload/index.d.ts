import type { AfkApi } from './index'

declare global {
  interface Window {
    api: AfkApi
  }
}

export {}
