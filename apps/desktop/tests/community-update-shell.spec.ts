/** @vitest-environment jsdom */
/**
 * The document half of the Community Update boundary: what the shell's own update page shows.
 *
 * The document is deliberately dumb — it renders a presentation the main process built and decides
 * nothing — so these cases drive it the way the shell does: hand it one presentation and assert what
 * a person would see. Two consequences are pinned as hard as the rendering itself. An action whose
 * label is empty is hidden rather than drawn, so a phase can never show a button the main process did
 * not offer for it; and the two requests that carry a revision send the one currently displayed, so a
 * click can never act on a presentation the user is not looking at.
 *
 * The packaging cases live in the same file because they are the same question asked of the same
 * three files: the document, its stylesheet, and the script that reaches no module other than its own
 * bridge. The i18n check is included here rather than left to the repository-wide verifier because a
 * hard-coded string is exactly the failure a document-only test would otherwise miss.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL as FileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findUiI18nViolations } from '../../../scripts/verify-client-ui-i18n.ts'
import { COMMUNITY_UPDATE_IPC, type CommunityUpdateWindowView } from '../src/community-update-ipc.ts'

/** Node's own URL class: the jsdom environment replaces the global one, which Node's fs cannot read. */
const RENDERER = fileURLToPath(new FileURL('../renderer/', import.meta.url))
const HTML = readFileSync(join(RENDERER, 'community-update.html'), 'utf8')
const SCRIPT = readFileSync(join(RENDERER, 'community-update.js'), 'utf8')
const STYLE = readFileSync(join(RENDERER, 'community-update.css'), 'utf8')

/** The presentation the shell would build, with every string already resolved by the main process. */
function presentation(overrides: Partial<CommunityUpdateWindowView> = {}): CommunityUpdateWindowView {
  return {
    revision: 1,
    locale: 'en',
    title: 'Community Update',
    phase: 'update-available',
    status: 'Community update available',
    detail: '',
    rows: [
      { label: 'Current version', value: 'v0.2' },
      { label: 'Latest version', value: 'v0.3' },
    ],
    actions: { check: '', download: 'Download update', openLocation: '', viewNotes: 'View release notes', close: 'Close' },
    code: '',
    ...overrides,
  }
}

interface Mounted {
  readonly check: ReturnType<typeof vi.fn>
  readonly download: ReturnType<typeof vi.fn>
  readonly openLocation: ReturnType<typeof vi.fn>
  readonly openNotes: ReturnType<typeof vi.fn>
  /** Push a presentation the way the main process does. */
  push(view: CommunityUpdateWindowView): void
}

afterEach(() => {
  Reflect.deleteProperty(window, 'dshCommunityUpdate')
})

/** Load the real document and its real script, with a fake bridge standing in for the preload. */
function mount(options: { status?: () => Promise<CommunityUpdateWindowView | null> } = {}): Mounted {
  document.head.innerHTML = /<head>([\s\S]*?)<\/head>/u.exec(HTML)![1]!
  document.body.innerHTML = /<body[^>]*>([\s\S]*?)<\/body>/u.exec(HTML)![1]!
  let listener: ((view: CommunityUpdateWindowView) => void) | undefined
  const status = vi.fn(options.status ?? (() => Promise.resolve(null)))
  const check = vi.fn(() => Promise.resolve(null))
  const download = vi.fn(() => Promise.resolve(null))
  const openLocation = vi.fn(() => Promise.resolve(true))
  const openNotes = vi.fn(() => Promise.resolve(true))
  const subscribe = vi.fn((next: (view: CommunityUpdateWindowView) => void) => {
    listener = next
    return () => { listener = undefined }
  })
  Object.assign(window, {
    dshCommunityUpdate: { status, check, download, openLocation, openNotes, subscribe },
  })
  runInThisContext(`(function () {\n${SCRIPT}\n})()`, { filename: 'community-update.js' })
  return { check, download, openLocation, openNotes, push: (view) => { listener?.(view) } }
}

/** Let the promise continuations a click starts run. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

function node(id: string): HTMLElement { return document.getElementById(id)! }

/** One of the document's buttons, whose `disabled` state is what the shell toggles to hold a request. */
function button(id: string): HTMLButtonElement { return node(id) as HTMLButtonElement }

describe('what the update document shows', () => {
  it('shows nothing until the main process supplies a presentation, then shows the whole panel', async () => {
    const h = mount()
    await settled()
    expect(node('update').hidden).toBe(true)
    const view = presentation()
    h.push(view)
    expect(node('update').hidden).toBe(false)
    expect(node('update-title').textContent).toBe(view.title)
    expect(node('update-status').textContent).toBe(view.status)
    expect(document.querySelectorAll('#update-rows dt')).toHaveLength(2)
    expect([...document.querySelectorAll('#update-rows dt')].map(item => item.textContent))
      .toEqual(['Current version', 'Latest version'])
    expect([...document.querySelectorAll('#update-rows dd')].map(item => item.textContent)).toEqual(['v0.2', 'v0.3'])
  })

  it('hydrates from status() when the first presentation went out before the document subscribed', async () => {
    // The shell opens the window and publishes immediately, so a document can reach `subscribe` after
    // the first `changed` event. `status()` is what closes that gap.
    const h = mount({ status: () => Promise.resolve(presentation({ revision: 4, title: 'Published early' })) })
    expect(node('update').hidden).toBe(true)
    await settled()
    expect(node('update').hidden).toBe(false)
    expect(node('update-title').textContent).toBe('Published early')
    // Hydration is a starting point rather than a freeze: a later push still takes over.
    h.push(presentation({ revision: 5, title: 'Refreshed later' }))
    expect(node('update-title').textContent).toBe('Refreshed later')
  })

  it('ignores a presentation older than the one already displayed', () => {
    const h = mount()
    h.push(presentation({ revision: 9, title: 'Newest' }))
    h.push(presentation({ revision: 3, title: 'Stale' }))
    // A superseded answer must not undo what a user is already looking at.
    expect(node('update-title').textContent).toBe('Newest')
    // Nothing else is pushed, and a `null` is deliberately not among them: the shell pushes a
    // presentation, and the only reply that may be null is a status read, which the hydration case
    // above already covers.
  })

  it('draws an action only when the main process supplied a label for it', () => {
    const h = mount()
    h.push(presentation())
    // `check` and `openLocation` are empty in this phase, so they are hidden rather than disabled:
    // the document never invents a button the phase does not permit.
    expect(node('check').hidden).toBe(true)
    expect(node('open-location').hidden).toBe(true)
    expect(node('download').hidden).toBe(false)
    expect(node('view-notes').hidden).toBe(false)
    expect(node('close').hidden).toBe(false)

    h.push(presentation({
      revision: 2,
      phase: 'ready',
      actions: { check: 'Check for updates', download: '', openLocation: 'Open file location', viewNotes: '', close: 'Close' },
    }))
    // The next presentation replaces the previous set rather than adding to it.
    expect(node('check').hidden).toBe(false)
    expect(node('download').hidden).toBe(true)
    expect(node('open-location').hidden).toBe(false)
    expect(node('view-notes').hidden).toBe(true)
  })

  it('shows the detail only when the shell has any, and the code only when one applies', () => {
    const h = mount()
    h.push(presentation({ detail: 'How to continue', code: '' }))
    expect(node('update-detail').hidden).toBe(false)
    expect(node('update-detail').textContent).toBe('How to continue')
    expect(node('update-code').hidden).toBe(true)
    h.push(presentation({ revision: 2, detail: '', code: 'checksum-mismatch' }))
    expect(node('update-detail').hidden).toBe(true)
    expect(node('update-code').hidden).toBe(false)
    expect(node('update-code').textContent).toBe('checksum-mismatch')
  })

  it('renders a transfer with a percentage on the track and without one when the total is unknown', () => {
    const h = mount()
    h.push(presentation({ phase: 'downloading', progress: { percent: 42, text: '120.5 MiB of 287.0 MiB' } }))
    expect(node('update-progress').hidden).toBe(false)
    expect(node('update-progress-text').textContent).toBe('120.5 MiB of 287.0 MiB')
    expect(node('update-progress-fill').style.width).toBe('42%')
    expect(node('update-progress-fill').parentElement!.getAttribute('aria-valuenow')).toBe('42')

    h.push(presentation({ revision: 2, phase: 'downloading', progress: { text: '1.0 MiB so far' } }))
    // No percentage means no bar: an unknown total is not a zero-percent transfer.
    expect(node('update-progress-text').textContent).toBe('1.0 MiB so far')
    expect(node('update-progress-fill').style.width).toBe('0%')
    expect(node('update-progress-fill').parentElement!.hasAttribute('aria-valuenow')).toBe(false)

    h.push(presentation({ revision: 3, phase: 'ready' }))
    expect(node('update-progress').hidden).toBe(true)
  })

  it('disables the two requests while the shell is already working on one', () => {
    const h = mount()
    for (const phase of ['checking', 'downloading', 'verifying'] as const) {
      h.push(presentation({ revision: h.check.mock.calls.length + 100, phase, actions: { ...presentation().actions, check: 'Check', download: 'Download' } }))
      expect(button('check').disabled, phase).toBe(true)
      expect(button('download').disabled, phase).toBe(true)
    }
    h.push(presentation({ revision: 999, phase: 'update-available', actions: { ...presentation().actions, check: 'Check', download: 'Download' } }))
    expect(button('check').disabled).toBe(false)
    expect(button('download').disabled).toBe(false)
  })
})

describe('what the document asks for', () => {
  it('asks for a check or a download through its own bridge, and catches a refusal', async () => {
    const h = mount()
    h.push(presentation({ actions: { ...presentation().actions, check: 'Check', download: 'Download' } }))
    node('check').click()
    node('download').click()
    await settled()
    expect(h.check).toHaveBeenCalledOnce()
    expect(h.download).toHaveBeenCalledOnce()
    // A refused request leaves the last presentation on screen rather than blanking the panel.
    h.check.mockRejectedValueOnce(new Error('rejected'))
    node('check').click()
    await settled()
    expect(node('update').hidden).toBe(false)
  })

  it('sends the revision it is displaying, and nothing else, to the two revision-scoped requests', async () => {
    const h = mount()
    h.push(presentation({ revision: 7, actions: { ...presentation().actions, openLocation: 'Open', viewNotes: 'Notes' } }))
    node('open-location').click()
    node('view-notes').click()
    await settled()
    // The document's only input is the revision, which is what keeps a click from directing the main
    // process at a file or a page of the document's choosing.
    expect(h.openLocation).toHaveBeenCalledWith(7)
    expect(h.openNotes).toHaveBeenCalledWith(7)
    h.push(presentation({ revision: 8, actions: { ...presentation().actions, openLocation: 'Open', viewNotes: 'Notes' } }))
    node('open-location').click()
    await settled()
    expect(h.openLocation).toHaveBeenLastCalledWith(8)
  })

  it('sends nothing at all when no presentation has arrived yet', async () => {
    const h = mount()
    // A click before the first presentation is refused by the document rather than sent as a guess.
    node('open-location').click()
    node('view-notes').click()
    await settled()
    expect(h.openLocation).not.toHaveBeenCalled()
    expect(h.openNotes).not.toHaveBeenCalled()
  })

  it('closes the window rather than asking the main process to', async () => {
    const h = mount()
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    h.push(presentation())
    node('close').click()
    expect(close).toHaveBeenCalledOnce()
    close.mockRestore()
  })
})

describe('what the document can never turn into markup', () => {
  it('renders every value as text, so an HTML-like string stays a string', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    mount().push(presentation({
      status: hostile,
      detail: hostile,
      title: hostile,
      code: hostile,
      rows: [{ label: hostile, value: hostile }],
      actions: { check: hostile, download: hostile, openLocation: hostile, viewNotes: hostile, close: hostile },
    }))
    // Every field went through `textContent`, so no element was created from the values.
    expect(document.querySelectorAll('#update img')).toHaveLength(0)
    expect(node('update-status').textContent).toBe(hostile)
    expect(node('update-rows').innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(node('check').innerHTML).toBe('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('how the document and its assets are packaged', () => {
  it('loads one script and one stylesheet, and reaches the network from nowhere', () => {
    // `connect-src 'none'` is what makes the page unable to fetch anything of its own: every byte of
    // an update comes through the main process, where the origin policy applies.
    expect(HTML).toContain("connect-src 'none'")
    expect(HTML).toContain('script-src \'self\'')
    expect(HTML).toContain('rel="stylesheet" href="community-update.css"')
    expect(HTML).toContain('<script src="community-update.js"></script>')
    // No inline script and no inline style, so the policy needs no 'unsafe-inline' escape hatch.
    expect(HTML).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/u)
    expect(HTML).not.toMatch(/\sstyle="/u)
    expect(HTML).not.toContain('unsafe-inline')
  })

  it('reaches no module other than its own bridge', () => {
    const imports = [...SCRIPT.matchAll(/from (['"])([^'"]+)\1/gu)].map(match => match[2])
    const requires = [...SCRIPT.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])
    expect(imports).toEqual([])
    expect(requires).toEqual([])
    // The bridge is read once, and nothing else on `window` is touched.
    expect(SCRIPT).toContain('window.dshCommunityUpdate')
    expect(SCRIPT).not.toContain('window.dshDesktop')
    expect(SCRIPT).not.toContain('fetch(')
    expect(SCRIPT).not.toContain('XMLHttpRequest')
  })

  it('hard-codes no user-visible string, so every word can be translated', () => {
    // The repository's own verifier is reused here rather than reimplemented: a string this document
    // rendered on its own would be exactly the copy the main process could not translate.
    expect(findUiI18nViolations('apps/desktop/renderer/community-update.js', SCRIPT)).toEqual([])
    expect(findUiI18nViolations('apps/desktop/renderer/community-update.css', STYLE)).toEqual([])
    expect(findUiI18nViolations('apps/desktop/renderer/community-update.html', HTML)).toEqual([])
  })

  it('names the channels this document may reach, and no channel that takes a destination', () => {
    // The set is asserted exactly: adding a channel that accepted a URL would be a one-line change
    // here, and this is the case that would have to be updated for it to pass.
    expect(Object.keys(COMMUNITY_UPDATE_IPC).sort()).toEqual(['changed', 'check', 'download', 'openLocation', 'openNotes', 'status'])
    for (const channel of Object.values(COMMUNITY_UPDATE_IPC)) expect(channel).toMatch(/^dsh-community-update:/u)
  })
})
