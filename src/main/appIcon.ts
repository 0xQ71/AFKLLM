import { app, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve the app icon on disk.
 * Packaged builds ship `icon.ico` / `icon.png` via electron-builder extraResources
 * (Tray cannot load icons from inside asar on Windows).
 */
export function resolveAppIconPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.ico'),
    join(process.resourcesPath, 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.png'),
    join(process.cwd(), 'build', 'icon.ico'),
    join(process.cwd(), 'build', 'icon.png'),
    join(__dirname, '../../build/icon.ico'),
    join(__dirname, '../../build/icon.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return undefined
}

/** NativeImage sized for the Windows / Linux tray. */
export function loadTrayIcon(): Electron.NativeImage {
  // Prefer PNG — NativeImage + Tray are more reliable with PNG than multi-size .ico.
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(process.resourcesPath, 'icon.ico'),
    join(app.getAppPath(), 'build', 'icon.png'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(process.cwd(), 'build', 'icon.png'),
    join(process.cwd(), 'build', 'icon.ico'),
    join(__dirname, '../../build/icon.png'),
    join(__dirname, '../../build/icon.ico')
  ]
  let img = nativeImage.createEmpty()
  for (const p of candidates) {
    if (!existsSync(p)) continue
    img = nativeImage.createFromPath(p)
    if (!img.isEmpty()) break
  }
  if (img.isEmpty()) return img
  // Notification area is typically 16px @1x (32 @2x); oversized icons look blank.
  const size = process.platform === 'win32' ? 16 : 22
  const { width, height } = img.getSize()
  if (width !== size || height !== size) {
    img = img.resize({ width: size, height: size, quality: 'best' })
  }
  return img
}
