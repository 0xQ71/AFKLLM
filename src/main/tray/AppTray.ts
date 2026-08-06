import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import type { UiLanguage } from '../../shared/i18n'
import { loadTrayIcon, resolveAppIconPath } from '../appIcon'

export type TrayCallbacks = {
  show: () => void
  /** Ask renderer to quit (may show generation warning). */
  requestQuit: () => void
}

type TrayCopy = {
  tooltip: string
  show: string
  quit: string
  balloonTitle: string
  balloonBody: string
}

const TRAY_I18N: Record<UiLanguage, TrayCopy> = {
  en: {
    tooltip: 'AFKLLM',
    show: 'Show AFKLLM',
    quit: 'Quit',
    balloonTitle: 'Notifications',
    balloonBody: 'AFKLLM is still running in the tray. Click the icon to restore.'
  },
  ru: {
    tooltip: 'AFKLLM',
    show: 'Показать AFKLLM',
    quit: 'Выход',
    balloonTitle: 'Уведомления',
    balloonBody: 'AFKLLM продолжает работать в трее. Нажмите на иконку, чтобы открыть.'
  }
}

let tray: Tray | null = null
let trayCb: TrayCallbacks | null = null
let trayLang: UiLanguage = 'en'
let balloonShown = false

function copyFor(lang: UiLanguage): TrayCopy {
  return TRAY_I18N[lang] ?? TRAY_I18N.en
}

function applyTrayMenu(): void {
  if (!tray || !trayCb) return
  const c = copyFor(trayLang)
  tray.setToolTip(c.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: c.show,
        click: () => trayCb?.show()
      },
      { type: 'separator' },
      {
        label: c.quit,
        click: () => trayCb?.requestQuit()
      }
    ])
  )
}

export function createAppTray(cb: TrayCallbacks, lang: UiLanguage = 'en'): Tray {
  destroyAppTray()
  trayCb = cb
  trayLang = lang
  balloonShown = false
  const icon = loadTrayIcon()
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  applyTrayMenu()
  tray.on('click', () => cb.show())
  tray.on('double-click', () => cb.show())
  return tray
}

/** Refresh tray labels when UI language changes. */
export function setTrayLanguage(lang: UiLanguage): void {
  if (trayLang === lang) return
  trayLang = lang
  applyTrayMenu()
}

export function destroyAppTray(): void {
  try {
    tray?.destroy()
  } catch {
    /* ignore */
  }
  tray = null
  trayCb = null
}

export function showMainWindow(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  win.setSkipTaskbar(false)
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export function hideMainWindowToTray(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  win.setSkipTaskbar(true)
  win.hide()
  if (!balloonShown && tray) {
    balloonShown = true
    const c = copyFor(trayLang)
    try {
      const balloonIcon = resolveAppIconPath()
      tray.displayBalloon({
        title: c.balloonTitle,
        content: c.balloonBody,
        ...(balloonIcon ? { icon: balloonIcon } : {})
      })
    } catch {
      /* balloon unsupported on some platforms */
    }
  }
}
