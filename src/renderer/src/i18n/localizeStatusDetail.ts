import type { MessageKey } from './messages'

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string

/** Map main-process English status / slot / image-gen detail strings for the UI. */
export function localizeStatusDetail(detail: string | null | undefined, t: TFn): string {
  if (!detail?.trim()) return ''
  const d = detail.trim()

  const exact: Record<string, MessageKey> = {
    'Chat + Apply ready (coresident in VRAM)': 'status.detail.chatApplyReady',
    'Chat + Apply + Vision ready (coresident in VRAM)': 'status.detail.chatApplyVisionReady',
    'Chat model ready + Vision ready': 'status.detail.chatVisionReady',
    'Loading apply model into VRAM…': 'status.detail.loadingApplyVram',
    'Loading vision model into VRAM…': 'status.detail.loadingVisionVram',
    'Vision model ready (loaded from disk)': 'status.detail.visionReadyDisk',
    'Model unloaded to disk': 'status.detail.unloadedDisk',
    'Model on disk · VRAM free for image generation': 'status.detail.vramFreeImage',
    'Loading chat model from disk…': 'status.detail.loadingChat',
    'Loading vision model from disk…': 'status.detail.loadingVision',
    'Unloading model to disk · freeing VRAM…': 'status.detail.unloadingVram',
    'Unloading model to disk…': 'status.detail.unloading',
    'Switching model…': 'status.detail.switching',
    'loading model…': 'status.detail.loadingModel',
    'spawning llama-server…': 'status.detail.spawning',
    'MTP flags unsupported · retrying without…': 'status.detail.mtpRetry',
    'mmproj mismatch · loading chat without vision…': 'status.detail.mmprojRetry',
    'loading model weights…': 'status.detail.loadingWeights',
    'offloading to GPU…': 'status.detail.offloadingGpu',
    'Image gen: timed out': 'status.detail.imageTimedOut',
    'Image gen: done': 'status.detail.imageDone',
    'Image gen: loading weights…': 'status.detail.imageLoadingWeights',
    'Image gen: loading weights from RAM → GPU…': 'status.detail.imageLoadingRamGpu',
    'Image gen: decoding / saving…': 'status.detail.imageDecoding',
    'Image gen: sampling done · decoding…': 'status.detail.imageDecoding',
    'Image gen: pass 1–2 (hires)…': 'status.detail.imageHires',
    'Image gen: base pass…': 'status.detail.imageBase',
    'Image gen: hires failed — base fallback…': 'status.detail.imageHiresFallback',
    'Image gen: safe retry (768, RAM offload, VAE CPU)…': 'status.detail.imageSafeRetry'
  }
  if (exact[d]) return t(exact[d])

  let m = /^Image gen: step (\d+)\/(\d+) · (.+)$/i.exec(d)
  if (m) {
    return t('status.detail.imageStep', {
      step: m[1]!,
      total: m[2]!,
      rest: localizeImageRest(m[3]!, t)
    })
  }
  m = /^Image gen: sampling started · (\d+) steps$/i.exec(d)
  if (m) {
    return t('status.detail.imageSamplingStarted', { steps: m[1]! })
  }
  m = /^Image gen: pass (\d+)\/(\d+) · (.+)$/i.exec(d)
  if (m) {
    const rest = localizeStatusDetail(`Image gen: ${m[3]!}`, t).replace(/^Image gen:\s*/i, '')
    return t('status.detail.imagePass', { pass: m[1]!, passes: m[2]!, rest })
  }
  if (/^Image gen:\s*/i.test(d)) {
    const rest = d.replace(/^Image gen:\s*/i, '')
    return t('status.detail.imagePrefix', { rest: localizeImageRest(rest, t) })
  }

  // Translate known English fragments inside longer strings (e.g. "ready · loading…")
  return d
    .replace(/\bloaded from disk\b/gi, () => t('status.phrase.fromDisk'))
    .replace(/\bChat model ready\b/gi, () => t('status.phrase.chatReady'))
    .replace(/\bVision model ready\b/gi, () => t('status.phrase.visionReady'))
    .replace(/\bModel loaded\b/gi, () => t('status.phrase.modelLoaded'))
    .replace(/\bReady\b/g, () => t('status.phrase.ready'))
}

function localizeImageRest(rest: string, t: TFn): string {
  return rest
    .replace(/^finishing…$/i, () => t('status.detail.imageFinishing'))
    .replace(/^(\d+)s left$/i, (_, s) => t('status.detail.imageSecondsLeft', { n: s }))
    .replace(/^(\d+)m (\d+)s left$/i, (_, m, s) =>
      t('status.detail.imageMinutesLeft', { m, s })
    )
}

export function localizeLlmState(state: string | null | undefined, t: TFn): string {
  switch (state) {
    case 'ready':
      return t('status.state.ready')
    case 'starting':
      return t('status.state.starting')
    case 'stopped':
      return t('status.state.stopped')
    case 'error':
      return t('status.state.error')
    default:
      return state?.trim() || '…'
  }
}

/** Localize composer activity verb / suffix fragments shown in the chat feed. */
export function localizeActivityVerb(verb: string, t: TFn): string {
  const map: Record<string, MessageKey> = {
    Reading: 'activity.verb.reading',
    Read: 'activity.verb.read',
    Searching: 'activity.verb.searching',
    Grepped: 'activity.verb.grepped',
    Exploring: 'activity.verb.exploring',
    Explored: 'activity.verb.explored',
    Editing: 'activity.verb.editing',
    Edited: 'activity.verb.edited',
    'Write failed': 'activity.verb.writeFailed',
    Deleting: 'activity.verb.deleting',
    Deleted: 'activity.verb.deleted',
    Creating: 'activity.verb.creating',
    Created: 'activity.verb.created',
    Listing: 'activity.verb.listing',
    Listed: 'activity.verb.listed',
    Running: 'activity.verb.running',
    Ran: 'activity.verb.ran',
    'Generating image': 'activity.verb.generatingImage',
    'Generated image': 'activity.verb.generatedImage',
    'Planning next moves': 'activity.verb.planning',
    'web_search': 'activity.verb.webSearch'
  }
  let out = verb
  // "Edited · failed"
  const failed = / · failed$/i.exec(out)
  if (failed) {
    out = out.slice(0, -failed[0].length)
    const base = map[out] ? t(map[out]) : out
    return t('activity.suffix.failed', { verb: base })
  }
  const partial = / · partial$/i.exec(out)
  if (partial) {
    out = out.slice(0, -partial[0].length)
    const base = map[out] ? t(map[out]) : out
    return t('activity.suffix.partial', { verb: base })
  }
  return map[out] ? t(map[out]) : out
}

export function localizeActivitySuffix(suffix: string | undefined, t: TFn): string | undefined {
  if (!suffix) return undefined
  const map: Record<string, MessageKey> = {
    'no matches': 'activity.suffix.noMatches',
    'searching the web…': 'activity.suffix.searchingWeb',
    'skip (no internet)': 'activity.suffix.skipOffline',
    failed: 'activity.suffix.failedShort',
    '(no path)': 'activity.suffix.noPath'
  }
  if (map[suffix]) return t(map[suffix])
  const sites = /^ok \(internet search\) · (\d+) sites?$/i.exec(suffix)
  if (sites) return t('activity.suffix.okSites', { n: sites[1]! })
  const files = /^(\d+) files?$/i.exec(suffix)
  if (files) {
    return Number(files[1]) === 1
      ? t('activity.suffix.oneFile')
      : t('activity.suffix.nFiles', { n: files[1]! })
  }
  return suffix
}
