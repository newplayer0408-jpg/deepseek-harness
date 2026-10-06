/**
 * The Community Update preload: what the shell's own update document may reach.
 *
 * A sandboxed preload's `require` polyfill resolves only `electron`, `events`, `timers`, and `url`, so
 * the shape of this module's import graph is a build requirement rather than a style preference: one
 * value import of a module that reads a file would fail the bundle instead of merely enlarging it.
 * The cases read the configuration and the source, and then run the same bundler and import policy the
 * build uses over the real graph — which is what proves it produces a loadable sandboxed preload
 * rather than merely looking clean.
 *
 * The four capabilities are asserted exactly, and the exposure is asserted to be conditional on the
 * page: the bridge is handed to the update document and to nothing else, so a shell document that
 * happened to load this preload gains no access to the main process's update channels.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL as FileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { COMMUNITY_UPDATE_IPC, COMMUNITY_UPDATE_PAGE, COMMUNITY_UPDATE_PRELOAD } from '../src/community-update-ipc.ts'

const DESKTOP = fileURLToPath(new FileURL('..', import.meta.url))

/** Read one file of the desktop package. */
function read(relative: string): string { return readFileSync(join(DESKTOP, relative), 'utf8') }

describe('the preload the update window loads', () => {
  it('is registered as a bundle entry and as a packaged file', async () => {
    const tsdown = read('tsdown.config.ts')
    const preloadEntries = /\(\[([^\]]*'preload-app'[\s\S]*?)\] as const\)/u.exec(tsdown)![1]!
    expect(preloadEntries).toContain("'preload-community-update'")
    // The entry name is what the sandboxed-CJS format maps onto the file the shell loads.
    expect(tsdown).toContain('entry: { [name]: `lib/types/${name}.js` }')
    expect(tsdown).not.toContain('preload-community-update.cjs')

    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const builder = createElectronBuilderConfig({
      DSH_DESKTOP_VARIANT: 'community',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(builder.files).toContain(`lib/${COMMUNITY_UPDATE_PRELOAD}`)
    expect(builder.files).toContain('lib/preload-community-diagnostics.cjs')
    // renderer/**/* already carries the page, its stylesheet, and its script.
    expect(builder.files).toContain('renderer/**/*')
    // The release identity travels with the application, because the shell reads it from the
    // application path at runtime rather than importing it. Its reader gates on the declared variant,
    // so a release carries the file and still reads no Community release repository.
    expect(builder.files).toContain('community-release.json')
    // Cold-loading electron-builder's NSIS target is the cost here, not the assertion.
  }, 60_000)

  it('reaches no bare import but electron, and no Node builtin at all, from the contract module', () => {
    const contract = read('src/community-update-ipc.ts')
    const preload = read('src/preload-community-update.ts')
    expect([...contract.matchAll(/^import(?! type)/gmu)]).toHaveLength(0)
    expect([...preload.matchAll(/from '([^']+)'/gu)].map(match => match[1]))
      .toEqual(['electron', './community-update-ipc.ts'])
    // The contract names the service and the download module as types only, which is why the whole
    // update engine — and through it node:crypto, node:fs, and node:path — never enters this graph.
    expect(contract).toContain("import type { CommunityUpdateState } from './community-update-service.ts'")
  })

  it('bundles the real preload source as sandboxed CommonJS, so only electron survives as a require', async () => {
    const { Rolldown } = await import('tsdown')
    const { packagedImportsPlugin } = await import('../scripts/desktop-bundle-imports.mjs')
    const sandboxedPreload = { packages: new Set(['electron', 'events', 'timers', 'url']), nodeBuiltins: false }
    const bundle = await Rolldown.rolldown({
      input: join(DESKTOP, 'src/preload-community-update.ts'),
      platform: 'node',
      // Only electron and Node builtins stay external, so every relative module is parsed and walked.
      external: (id: string) => id === 'electron' || id.startsWith('node:'),
      logLevel: 'silent',
      plugins: [packagedImportsPlugin(sandboxedPreload)],
    })
    try {
      const output = await bundle.generate({ format: 'cjs' })
      const chunks = output.output.filter(chunk => chunk.type === 'chunk')
      expect(chunks).toHaveLength(1)
      const code = chunks.map(chunk => chunk.code).join('')
      expect([...code.matchAll(/require\((['"])([^'"]+)\1\)/gu)].map(match => match[2])).toEqual(['electron'])
      expect(code).toContain('dshCommunityUpdate')
      // The verified installer is reached through the main process, so the preload holds no digest,
      // no path, and no crypto of its own.
      expect(code).not.toContain('node:fs')
      expect(code).not.toContain('node:crypto')
      expect(code).not.toContain('createHash')
    } finally {
      await bundle.close()
    }
  })

  it('exposes four capabilities behind an exact channel set, and hands over no channel of its own', () => {
    const preload = read('src/preload-community-update.ts')
    // Every channel it invokes is one this feature owns, and none of them accepts a destination.
    const invoked = [...preload.matchAll(/COMMUNITY_UPDATE_IPC\.(\w+)/gu)].map(match => match[1])
    expect([...new Set(invoked)].sort()).toEqual(['changed', 'check', 'download', 'openLocation', 'openNotes', 'status'])
    // The renderer never receives `ipcRenderer`, so it cannot reach a channel this feature did not
    // name — and `invoke` is the only transport, so there is no `send` to a channel of its choosing.
    expect(preload).not.toContain('exposeInMainWorld(\'ipcRenderer\'')
    expect(preload).not.toContain('ipcRenderer.send(')
    expect(preload).not.toContain('webFrame')
    // Both revision-scoped calls take the revision and nothing else.
    expect(preload).toContain('openLocation: revision => ipcRenderer.invoke(COMMUNITY_UPDATE_IPC.openLocation, revision)')
    expect(preload).toContain('openNotes: revision => ipcRenderer.invoke(COMMUNITY_UPDATE_IPC.openNotes, revision)')
  })

  it('exposes the bridge only on the update page, and updates the document as it disposes', () => {
    const preload = read('src/preload-community-update.ts')
    // A shell document that loaded this preload by mistake gains nothing: the exposure is conditional
    // on the exact page rather than on having been loaded at all.
    expect(preload).toContain('if (location.href === COMMUNITY_UPDATE_PAGE) contextBridge.exposeInMainWorld')
    expect(COMMUNITY_UPDATE_PAGE).toBe('dsh-app://shell/community-update.html')
    expect(COMMUNITY_UPDATE_PRELOAD).toBe('preload-community-update.cjs')
    // Subscribing returns its own unsubscribe, and the listener is removed by reference rather than
    // by clearing every listener, so a second subscriber is not silently detached.
    expect(preload).toContain('ipcRenderer.removeListener(COMMUNITY_UPDATE_IPC.changed, receive)')
    expect(preload).not.toContain('removeAllListeners')
  })

  it('names the window channels a shell window may not reach, and no collision with the shell', async () => {
    const shellIpc = read('src/ipc.ts')
    for (const channel of Object.values(COMMUNITY_UPDATE_IPC)) {
      expect(channel.startsWith('dsh-community-update:')).toBe(true)
      // The shell's shared channel table is not touched by this feature.
      expect(shellIpc).not.toContain(channel)
    }
  })
})
