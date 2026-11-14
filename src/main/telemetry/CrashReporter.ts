import { crashReporter, app, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  formatTelemetryLogLine,
  normalizeTelemetryEvent,
  rotateLogContent,
  type TelemetryEvent,
  type TelemetryReportResult
} from '../../shared/telemetry'

const LOG_NAME = 'afkllm-errors.log'
const MAX_LOG_BYTES = 1_000_000

let hooksInstalled = false
let collectLogsToFile: () => boolean = () => true

/** Gates local file append only — never uploads. */
export function setCollectLogsToFile(getter: () => boolean): void {
  collectLogsToFile = getter
}

export function getLogsDir(): string {
  return join(app.getPath('userData'), 'logs')
}

export function getErrorLogPath(): string {
  return join(getLogsDir(), LOG_NAME)
}

/** Local crash dumps + optional append-only error log. No network upload. */
export function initCrashReporter(): void {
  try {
    crashReporter.start({
      productName: 'AFKLLM',
      companyName: 'AFKLLM',
      submitURL: '',
      uploadToServer: false,
      compress: true,
      ignoreSystemCrashHandler: false
    })
  } catch (e) {
    console.error('[CrashReporter] start failed', e)
  }

  if (hooksInstalled) return
  hooksInstalled = true

  process.on('uncaughtException', (err) => {
    void reportEvent({
      kind: 'crash',
      message: err?.message || String(err),
      stack: err?.stack,
      source: 'main:uncaughtException'
    })
    console.error('[uncaughtException]', err)
  })

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    void reportEvent({
      kind: 'error',
      message: err.message,
      stack: err.stack,
      source: 'main:unhandledRejection'
    })
    console.error('[unhandledRejection]', reason)
  })
}

/** If the live log was renamed/rotated away (or left empty), copy the newest backup back. */
async function recoverLogFileIfMissing(): Promise<void> {
  const path = getErrorLogPath()
  try {
    const st = await fs.stat(path)
    if (st.size > 0) return
  } catch {
    /* missing */
  }
  try {
    const dir = getLogsDir()
    await fs.mkdir(dir, { recursive: true })
    const names = await fs.readdir(dir)
    const rotated = names
      .filter((n) => /^afkllm-errors\.\d{8}-\d{6}\.log$/i.test(n))
      .sort()
      .reverse()
    if (rotated[0]) {
      await fs.copyFile(join(dir, rotated[0]!), path)
    }
  } catch {
    /* ignore */
  }
}

export async function appendErrorLog(text: string): Promise<string> {
  const dir = getLogsDir()
  const path = getErrorLogPath()
  await fs.mkdir(dir, { recursive: true })
  await recoverLogFileIfMissing()
  await fs.appendFile(path, text, 'utf8')
  try {
    const st = await fs.stat(path)
    if (st.size > MAX_LOG_BYTES) {
      const existing = await fs.readFile(path, 'utf8')
      await fs.writeFile(path, rotateLogContent(existing, MAX_LOG_BYTES), 'utf8')
    }
  } catch {
    /* rotate is best-effort; the new line is already on disk */
  }
  return path
}

export async function reportEvent(
  raw: TelemetryEvent | unknown
): Promise<TelemetryReportResult> {
  const ev = normalizeTelemetryEvent(raw) ?? normalizeTelemetryEvent({
    kind: 'error',
    message: 'invalid telemetry payload',
    source: 'telemetry'
  })
  if (!ev) {
    return { ok: false, logged: false, error: 'invalid event' }
  }
  if (!ev.at) ev.at = new Date().toISOString()
  // Always mirror to stderr; file write is opt-in
  console.error(`[AFKLLM:${ev.kind}]`, ev.message, ev.stack ?? '')
  if (!collectLogsToFile()) {
    return { ok: true, logged: false }
  }
  try {
    const line = formatTelemetryLogLine(ev)
    const path = await appendErrorLog(line)
    return { ok: true, logged: true, path }
  } catch (e) {
    return {
      ok: false,
      logged: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export async function openLogDir(): Promise<{ ok: boolean; path: string; error?: string }> {
  const dir = getLogsDir()
  try {
    await fs.mkdir(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) return { ok: false, path: dir, error: err }
    return { ok: true, path: dir }
  } catch (e) {
    return {
      ok: false,
      path: dir,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** Tail of the local error log for Settings. */
export async function readErrorLog(maxChars = 80_000): Promise<{
  ok: boolean
  path: string
  text: string
  error?: string
}> {
  const path = getErrorLogPath()
  try {
    await fs.mkdir(getLogsDir(), { recursive: true })
    await recoverLogFileIfMissing()
    let text = ''
    try {
      text = await fs.readFile(path, 'utf8')
    } catch {
      return { ok: true, path, text: '' }
    }
    if (text.length > maxChars) text = text.slice(-maxChars)
    return { ok: true, path, text }
  } catch (e) {
    return {
      ok: false,
      path,
      text: '',
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export async function clearErrorLog(): Promise<{ ok: boolean; path: string; error?: string }> {
  const path = getErrorLogPath()
  try {
    await fs.mkdir(getLogsDir(), { recursive: true })
    await fs.writeFile(path, '', 'utf8')
    return { ok: true, path }
  } catch (e) {
    return {
      ok: false,
      path,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
