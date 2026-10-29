import { isAbsolute, relative, resolve } from 'node:path'

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** A remote file name made safe to use as one local path segment (no separators, no traversal, no reserved names). */
export function safeLocalName(name: string): string {
  let cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') cleaned = 'file'
  if (WIN_RESERVED.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned.slice(0, 200)
}

/** True when `child` resolves to `root` or somewhere inside it. */
export function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function assertInside(root: string, child: string): string {
  if (!isInside(root, child)) throw new Error('Blocked a download that tried to write outside the chosen folder.')
  return child
}

/** Extensions the OS would execute when "opened". Remote files with these are never auto-opened. */
const EXECUTABLE = new Set([
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'scr', 'pif', 'cpl', 'hta', 'jar', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh',
  'ps1', 'psm1', 'lnk', 'url', 'reg', 'inf', 'dll', 'sys', 'app', 'command', 'sh', 'appimage', 'deb', 'rpm', 'pkg', 'dmg',
  'scf', 'msc', 'gadget', 'application', 'appref-ms', 'settingcontent-ms', 'library-ms', 'xll', 'iso', 'img', 'vhd', 'vhdx'
])

export function isExecutableName(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return name.includes('.') && EXECUTABLE.has(ext)
}

export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

export const ID_RE = /^[0-9a-f-]{8,80}$/i
