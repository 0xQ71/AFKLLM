import { useEffect, useRef, useState } from 'react'
import appIcon from '../assets/app-icon-64.png'
import { useI18n } from '../i18n/I18nProvider'
import type { MessageKey } from '../i18n/messages'

export type TitleBarAction =
  | 'newAgent'
  | 'openFolder'
  | 'newTerminal'
  | 'newBrowser'
  | 'openIde'
  | 'exit'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'changes'
  | 'browser'
  | 'files'
  | 'terminal'
  | 'toggleStatusBar'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'settings'
  | 'commandPalette'
  | 'keyboardShortcuts'
  | 'viewVersion'
  | 'viewDeveloper'
  | 'viewLicense'
  | 'viewThirdParty'

interface TitleBarProps {
  onAction: (action: TitleBarAction) => void
  statusBarVisible?: boolean
  /** From app.getVersion() — shown in Help → Version */
  appVersion?: string
}

type MenuId = 'file' | 'edit' | 'view' | 'help'

type MenuItem =
  | 'sep'
  | {
      action: TitleBarAction
      labelKey: MessageKey
      accel?: string
      checkable?: boolean
    }

interface MenuDef {
  id: MenuId
  labelKey: MessageKey
  items: MenuItem[]
}

const MENUS: MenuDef[] = [
  {
    id: 'file',
    labelKey: 'menu.file',
    items: [
      { action: 'newAgent', labelKey: 'menu.file.newAgent', accel: 'Ctrl+N' },
      { action: 'openFolder', labelKey: 'menu.file.openFolder', accel: 'Ctrl+O' },
      'sep',
      { action: 'newTerminal', labelKey: 'menu.file.newTerminal', accel: 'Ctrl+Shift+`' },
      { action: 'newBrowser', labelKey: 'menu.file.newBrowser' },
      'sep',
      { action: 'openIde', labelKey: 'menu.file.openIde', accel: 'Ctrl+Shift+N' },
      'sep',
      { action: 'exit', labelKey: 'menu.file.exit' }
    ]
  },
  {
    id: 'edit',
    labelKey: 'menu.edit',
    items: [
      { action: 'undo', labelKey: 'menu.edit.undo', accel: 'Ctrl+Z' },
      { action: 'redo', labelKey: 'menu.edit.redo', accel: 'Ctrl+Y' },
      'sep',
      { action: 'cut', labelKey: 'menu.edit.cut', accel: 'Ctrl+X' },
      { action: 'copy', labelKey: 'menu.edit.copy', accel: 'Ctrl+C' },
      { action: 'paste', labelKey: 'menu.edit.paste', accel: 'Ctrl+V' },
      'sep',
      { action: 'selectAll', labelKey: 'menu.edit.selectAll', accel: 'Ctrl+A' }
    ]
  },
  {
    id: 'view',
    labelKey: 'menu.view',
    items: [
      { action: 'changes', labelKey: 'menu.view.changes', accel: 'Ctrl+E' },
      { action: 'browser', labelKey: 'menu.view.browser', accel: 'Ctrl+Shift+B' },
      { action: 'files', labelKey: 'menu.view.files', accel: 'Ctrl+G' },
      { action: 'terminal', labelKey: 'menu.view.terminal', accel: 'Ctrl+J' },
      'sep',
      {
        action: 'toggleStatusBar',
        labelKey: 'menu.view.statusBar',
        checkable: true
      },
      'sep',
      { action: 'zoomIn', labelKey: 'menu.view.zoomIn', accel: 'Ctrl+=' },
      { action: 'zoomOut', labelKey: 'menu.view.zoomOut', accel: 'Ctrl+-' },
      { action: 'zoomReset', labelKey: 'menu.view.zoomReset', accel: 'Ctrl+0' },
      'sep',
      { action: 'settings', labelKey: 'menu.view.settings', accel: 'Ctrl+,' }
    ]
  },
  {
    id: 'help',
    labelKey: 'menu.help',
    items: [
      { action: 'commandPalette', labelKey: 'menu.help.commandPalette', accel: 'Ctrl+K' },
      {
        action: 'keyboardShortcuts',
        labelKey: 'menu.help.keyboardShortcuts',
        accel: 'Ctrl+Shift+/'
      },
      'sep',
      { action: 'viewVersion', labelKey: 'menu.help.viewVersion' },
      { action: 'viewDeveloper', labelKey: 'menu.help.viewDeveloper' },
      'sep',
      { action: 'viewLicense', labelKey: 'menu.help.viewLicense' },
      { action: 'viewThirdParty', labelKey: 'menu.help.viewThirdParty' }
    ]
  }
]

export function TitleBar({
  onAction,
  statusBarVisible = true,
  appVersion = ''
}: TitleBarProps): React.JSX.Element {
  const { t } = useI18n()
  const versionLabel = appVersion.trim() || '…'
  const [open, setOpen] = useState<MenuId | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent): void => {
      const el = e.target
      if (el instanceof Element && rootRef.current?.contains(el)) return
      setOpen(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null)
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      className="titlebar-drag flex h-9 shrink-0 items-center border-b border-ink-line/80 bg-ink-950 pl-2 pr-[140px]"
    >
      <img
        src={appIcon}
        alt=""
        width={18}
        height={18}
        draggable={false}
        className="titlebar-no-drag pointer-events-none mr-1.5 h-[18px] w-[18px] shrink-0 rounded-[4px] object-cover"
      />
      <div className="titlebar-no-drag flex items-center gap-0.5">
        {MENUS.map((menu) => (
          <div key={menu.id} className="relative">
            <button
              type="button"
              onClick={() => setOpen((v) => (v === menu.id ? null : menu.id))}
              onMouseEnter={() => {
                if (open) setOpen(menu.id)
              }}
              className={
                'rounded px-2 py-1 text-[12px] ' +
                (open === menu.id
                  ? 'bg-ink-800 text-ink-bright'
                  : 'text-ink-soft hover:bg-ink-900 hover:text-ink-bright')
              }
            >
              {t(menu.labelKey)}
            </button>
            {open === menu.id && (
              <div className="absolute left-0 top-full z-[200] mt-0.5 min-w-[240px] rounded-md border border-ink-line bg-ink-900 py-1 shadow-xl">
                {menu.items.map((item, i) =>
                  item === 'sep' ? (
                    <div key={`sep-${i}`} className="my-1 border-t border-ink-line/70" />
                  ) : (
                    <button
                      key={item.action}
                      type="button"
                      onClick={() => {
                        setOpen(null)
                        onAction(item.action)
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink-soft hover:bg-ink-800 hover:text-ink-bright"
                    >
                      <span className="w-3 shrink-0 text-center text-[11px] text-signal">
                        {item.checkable && statusBarVisible ? '✓' : ''}
                      </span>
                      <span className="min-w-0 flex-1">
                        {item.action === 'viewVersion'
                          ? t(item.labelKey, { version: versionLabel })
                          : t(item.labelKey)}
                      </span>
                      {item.accel ? (
                        <span className="shrink-0 font-mono text-[10px] text-ink-mute">
                          {item.accel}
                        </span>
                      ) : null}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="titlebar-drag min-w-0 flex-1" />
    </div>
  )
}

export function listMenuShortcuts(): Array<{ labelKey: MessageKey; accel: string }> {
  const out: Array<{ labelKey: MessageKey; accel: string }> = []
  for (const menu of MENUS) {
    for (const item of menu.items) {
      if (item !== 'sep' && item.accel) out.push({ labelKey: item.labelKey, accel: item.accel })
    }
  }
  return out
}
