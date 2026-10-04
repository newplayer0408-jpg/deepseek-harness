/** @vitest-environment jsdom */
/**
 * The document half of the diagnostics boundary: what the shell's own diagnostics page shows.
 *
 * The document is deliberately dumb — it formats a presentation the main process built and reads
 * nothing else — so these tests drive it exactly as the shell would: hand it one presentation and
 * assert what a person would see. The window that produces those presentations, and the packaging
 * that ships this document and its preload, are covered in `community-diagnostics-window.spec.ts`,
 * which runs outside jsdom because the packaging modules read the filesystem through Node's own URL.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL as FileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { findUiI18nViolations } from '../../../scripts/verify-client-ui-i18n.ts'
import type { CommunityDiagnosticsWindowView } from '../src/community-diagnostics-ipc.ts'
import { COMMUNITY_DIAGNOSTIC_IDS } from '../src/community-diagnostics.ts'

/** Node's own URL class: the jsdom environment replaces the global one, which Node's fs cannot read. */
const RENDERER = fileURLToPath(new FileURL('../renderer/', import.meta.url))
const HTML = readFileSync(join(RENDERER, 'community-diagnostics.html'), 'utf8')
const SCRIPT = readFileSync(join(RENDERER, 'community-diagnostics.js'), 'utf8')

/** The presentation the shell would build, with every string already resolved by the main process. */
function presentation(overrides: Partial<CommunityDiagnosticsWindowView> = {}): CommunityDiagnosticsWindowView {
  return {
    revision: 1,
    locale: 'en',
    title: 'Community Diagnostics',
    refreshLabel: 'Refresh',
    copyReportLabel: 'Copy report',
    copiedLabel: 'Copied',
    summaryLabels: { pass: 'pass', warn: 'warning', fail: 'failure', info: 'info' },
    unavailable: '',
    rows: COMMUNITY_DIAGNOSTIC_IDS.map((id, index) => ({
      id, label: `Label of ${id}`, state: index === 5 ? 'FAIL' : 'PASS', value: `Value of ${id}`,
      code: index === 5 ? 'E-BACKEND-RPC' : '',
    })),
    summary: { pass: 10, warn: 0, fail: 1, info: 0 },
    ...overrides,
  }
}

interface Mounted {
  readonly status: ReturnType<typeof vi.fn>
  readonly refresh: ReturnType<typeof vi.fn>
  readonly copyReport: ReturnType<typeof vi.fn>
  /** Push a presentation the way the main process does. */
  push(view: CommunityDiagnosticsWindowView): void
}

interface MountOptions {
  /**
   * What the document's first `status()` answers.
   *
   * The shell can publish a presentation before the document has subscribed to `changed`, so this
   * is how a test stands up a document that opens onto an already-collected view.
   */
  status?: () => Promise<CommunityDiagnosticsWindowView | null>
}

afterEach(() => {
  Reflect.deleteProperty(window, 'dshCommunityDiagnostics')
})

/** Load the real document and its real script, with a fake bridge standing in for the preload. */
function mount(options: MountOptions = {}): Mounted {
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/u.exec(HTML)![1]!
  document.body.innerHTML = /<body[^>]*>([\s\S]*?)<\/body>/u.exec(HTML)![1]!
  let listener: ((view: CommunityDiagnosticsWindowView) => void) | undefined
  const status = vi.fn(options.status ?? (() => Promise.resolve(null)))
  const refresh = vi.fn(() => Promise.resolve(null))
  const copyReport = vi.fn(() => Promise.resolve(true))
  const subscribe = vi.fn((next: (view: CommunityDiagnosticsWindowView) => void) => {
    listener = next
    return () => { listener = undefined }
  })
  const bridge = { status, refresh, copyReport, subscribe }
  // The document reads its bridge off `window`; standing one up here is what the preload would do.
  Object.assign(window, { dshCommunityDiagnostics: bridge })
  runInThisContext(`(function () {\n${SCRIPT}\n})()`, { filename: 'community-diagnostics.js' })
  return { status, refresh, copyReport, push: (view) => { listener?.(view) } }
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Let the promise continuations a click starts run. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

function node(id: string): HTMLElement {
  return document.getElementById(id)!
}

function press(id: string): void {
  node(id).click()
}

it('shows nothing until the main process supplies a presentation, then shows the whole panel', async () => {
  const h = mount()
  await settled()
  expect(node('diagnostics').hidden).toBe(true)
  const view = presentation()
  h.push(view)
  expect(node('diagnostics').hidden).toBe(false)
  expect(node('diagnostics-title').textContent).toBe(view.title)
  expect(document.querySelectorAll('#rows li')).toHaveLength(COMMUNITY_DIAGNOSTIC_IDS.length)
})

it('hydrates from status() when the first presentation was published before the document subscribed', async () => {
  // The shell opens the window and collects immediately, so a document can reach `subscribe` after
  // the `changed` event that carried the first view has already gone out. `status()` is what closes
  // that gap: without hydration the panel would stay hidden until someone pressed Refresh.
  const h = mount({ status: () => Promise.resolve(presentation({ revision: 4, title: 'Published early' })) })
  expect(node('diagnostics').hidden).toBe(true)
  await settled()
  expect(h.status).toHaveBeenCalledOnce()
  expect(node('diagnostics').hidden).toBe(false)
  expect(node('diagnostics-title').textContent).toBe('Published early')
  expect(document.querySelectorAll('#rows li')).toHaveLength(COMMUNITY_DIAGNOSTIC_IDS.length)
  expect(node('summary').textContent).toBe('10 pass · 0 warning · 1 failure · 0 info')
  // Hydration is a starting point rather than a freeze: a later push still takes over.
  h.push(presentation({ revision: 5, title: 'Refreshed later' }))
  expect(node('diagnostics-title').textContent).toBe('Refreshed later')
})

it('keeps a pushed presentation when a status() reply lands after it', async () => {
  const pending = deferred<CommunityDiagnosticsWindowView | null>()
  const h = mount({ status: () => pending.promise })
  h.push(presentation({ revision: 9, title: 'Pushed first' }))
  pending.resolve(presentation({ revision: 1, title: 'Stale reply' }))
  await settled()
  // The reply is older than what the panel already shows, so it is ignored rather than allowed to
  // replace a newer presentation — which is what makes hydrating on every open safe.
  expect(node('diagnostics-title').textContent).toBe('Pushed first')
})

it('renders every check as text, so an HTML-like value can never become markup', () => {
  const hostile = '<img src=x onerror=alert(1)>'
  mount().push(presentation({
    rows: [{ id: 'packaged-files', label: 'Packaged files', state: 'FAIL', value: hostile, code: 'E-PACKAGED-FILE-MISSING' }],
    summary: { pass: 0, warn: 0, fail: 1, info: 0 },
  }))
  const item = document.querySelector('#rows li')!
  expect(item.textContent).toContain(hostile)
  expect(document.querySelector('img')).toBeNull()
  // The value survived as escaped text, which is what a text node means: nothing was parsed.
  expect(node('rows').innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(item.querySelector('.row-label')!.textContent).toBe('Packaged files')
  expect(item.querySelector('.row-value')!.textContent).toBe(hostile)
  expect(item.querySelector('.row-code')!.textContent).toBe('E-PACKAGED-FILE-MISSING')
})

it('carries a glyph, a state class, and localized state text for each of the four states', () => {
  mount().push(presentation({
    rows: [
      { id: 'community-edition', label: 'Edition', state: 'PASS', value: 'community', code: '' },
      { id: 'backend', label: 'Backend', state: 'WARN', value: 'starting', code: 'E-BACKEND-NOT-READY' },
      { id: 'packaged-files', label: 'Files', state: 'FAIL', value: 'missing', code: 'E-PACKAGED-FILE-MISSING' },
      { id: 'system', label: 'System', state: 'INFO', value: 'win32 x64', code: '' },
    ],
    summary: { pass: 1, warn: 1, fail: 1, info: 1 },
  }))
  const items = [...document.querySelectorAll('#rows li')]
  expect(items.map(item => item.querySelector('.state')!.textContent)).toEqual(['✓', '!', '×', '–'])
  expect(items.map(item => item.querySelector('.state')!.className)).toEqual([
    'state state-PASS', 'state state-WARN', 'state state-FAIL', 'state state-INFO',
  ])
  expect(items.map(item => (item.querySelector('.state')! as HTMLElement).getAttribute('aria-hidden'))).toEqual([
    'true', 'true', 'true', 'true',
  ])
  // The glyph is hidden from assistive technology, so each row carries its state as text as well:
  // the word comes from the shell's own summary copy, so no English is written into this document,
  // and it sits between the decorative glyph and the label — the order a screen reader announces.
  expect(items.map(item => item.querySelector('.state-word')!.textContent))
    .toEqual(['pass', 'warning', 'failure', 'info'])
  expect(items.map(item => item.querySelector('.state-word')!.getAttribute('aria-hidden')))
    .toEqual([null, null, null, null])
  expect(items.map(item => (item.querySelector('.state-word')! as HTMLElement).classList.contains('visually-hidden')))
    .toEqual([true, true, true, true])
  expect([...items[0]!.children].map(child => child.className)).toEqual([
    'state state-PASS', 'state-word visually-hidden', 'row-label', 'row-value', 'row-code',
  ])
  // A passing check shows no code, so the column only carries a fault.
  expect((items[0]!.querySelector('.row-code')! as HTMLElement).hidden).toBe(true)
  expect((items[2]!.querySelector('.row-code')! as HTMLElement).hidden).toBe(false)
})

it('builds the summary from the counts and the nouns the main process supplied', () => {
  mount().push(presentation({
    rows: [{ id: 'system', label: 'System', state: 'INFO', value: 'win32 x64', code: '' }],
    summary: { pass: 8, warn: 1, fail: 1, info: 2 },
  }))
  expect(node('summary').textContent).toBe('8 pass · 1 warning · 1 failure · 2 info')
  expect(node('summary').hidden).toBe(false)
})

it('follows the presentation language, title, and labels without inventing any of its own', () => {
  mount().push(presentation({
    locale: 'zh-CN', title: '社区诊断', refreshLabel: '刷新', copyReportLabel: '复制诊断报告', copiedLabel: '已复制',
    summaryLabels: { pass: '通过', warn: '警告', fail: '失败', info: '信息' },
    rows: [{ id: 'telemetry', label: '遥测', state: 'INFO', value: '默认关闭', code: '' }],
  }))
  expect(document.documentElement.lang).toBe('zh-CN')
  expect(document.title).toBe('社区诊断')
  expect(node('refresh').textContent).toBe('刷新')
  expect(node('copy-report').textContent).toBe('复制诊断报告')
  expect(document.querySelector('.row-label')!.textContent).toBe('遥测')
  expect(document.querySelector('.row-value')!.textContent).toBe('默认关闭')
  // The accessible state word tracks the shell copy too, which is what makes it localized rather
  // than an English word the document chose for itself.
  expect(document.querySelector('.state-word')!.textContent).toBe('信息')
})

it('asks the main process to refresh, and to copy the revision it is actually showing', async () => {
  const h = mount()
  h.push(presentation({ revision: 7 }))
  press('refresh')
  expect(h.refresh).toHaveBeenCalledOnce()
  press('copy-report')
  expect(h.copyReport).toHaveBeenCalledWith(7)
  expect(node('copied').textContent).toBe('')
  await settled()
  expect(node('copied').textContent).toBe('Copied')
  // A refused copy acknowledges nothing rather than claiming success.
  h.copyReport.mockImplementation(() => Promise.resolve(false))
  press('copy-report')
  await settled()
  expect(node('copied').textContent).toBe('')
})

it('ignores a presentation older than the one it already shows', () => {
  const h = mount()
  h.push(presentation({ revision: 5, title: 'Fifth' }))
  h.push(presentation({ revision: 5, title: 'Still fifth' }))
  h.push(presentation({ revision: 4, title: 'Fourth' }))
  expect(node('diagnostics-title').textContent).toBe('Fifth')
  h.push(presentation({ revision: 6, title: 'Sixth' }))
  expect(node('diagnostics-title').textContent).toBe('Sixth')
})

it('replaces the checks with the shell notice when collection failed, and offers no counts', () => {
  mount().push(presentation({
    revision: 2,
    unavailable: 'Diagnostics could not be collected.',
    rows: [],
    summary: { pass: 0, warn: 0, fail: 0, info: 0 },
  }))
  expect(node('unavailable').hidden).toBe(false)
  expect(node('unavailable').textContent).toBe('Diagnostics could not be collected.')
  expect(node('rows').hidden).toBe(true)
  expect(node('summary').hidden).toBe(true)
  expect(document.querySelectorAll('#rows li')).toHaveLength(0)
  expect(node('copy-report').textContent).toBe('Copy report')
})

it('keeps every user-visible string out of the document, so the shell locale owns all of them', () => {
  expect(findUiI18nViolations('apps/desktop/renderer/community-diagnostics.js', SCRIPT)).toEqual([])
  // The document holds no copy of its own either: every text-bearing element starts empty.
  const body = /<body[^>]*>([\s\S]*?)<\/body>/u.exec(HTML)![1]!
  for (const tag of ['h1', 'p', 'button', 'span']) {
    for (const match of body.matchAll(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`, 'gu'))) {
      expect(match[1]!.trim()).toBe('')
    }
  }
})

it('reaches the document only through text, never through markup or the network', () => {
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    expect(SCRIPT).not.toContain(forbidden)
  }
  expect(SCRIPT).not.toMatch(/\b(?:require|import)\s*\(/u)
  expect(SCRIPT).not.toMatch(/\bfetch\s*\(/u)
  expect(SCRIPT).not.toContain('process.env')
  expect(SCRIPT).not.toContain('node:')
  // The page itself may load nothing but its own two assets.
  expect(HTML).toContain("default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'")
  expect([...HTML.matchAll(/(?:src|href)="([^"]+)"/gu)].map(match => match[1])).toEqual(
    ['community-diagnostics.css', 'community-diagnostics.js'],
  )
})
