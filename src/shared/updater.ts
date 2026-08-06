/** Manual update flow: notify on launch, download/install only when user asks. */

export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  | 'offline'
  | 'dev'

export interface UpdaterCheckResult {
  ok: boolean
  status: UpdaterStatus
  message: string
  /** Newer version on GitHub, if available */
  version?: string
  /** Currently running app version */
  currentVersion?: string
  /** Release notes / changelog body when known */
  releaseNotes?: string
  /** Direct link to the GitHub release / releases page */
  releaseUrl?: string
  /** Download progress 0–1 while status === downloading */
  progress?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
}

export const UPDATER_GITHUB = {
  owner: '0xQ71',
  repo: 'AFKLLM'
} as const

export function githubReleasesUrl(): string {
  return `https://github.com/${UPDATER_GITHUB.owner}/${UPDATER_GITHUB.repo}/releases`
}

export function githubReleaseTagUrl(version: string): string {
  const tag = version.startsWith('v') ? version : `v${version}`
  return `https://github.com/${UPDATER_GITHUB.owner}/${UPDATER_GITHUB.repo}/releases/tag/${tag}`
}
