/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly ELECTRON_RENDERER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*?worker' {
  const workerConstructor: {
    new (): Worker
  }
  export default workerConstructor
}
