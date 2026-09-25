/**
 * The Community Diagnostics engine turns injected probes into a fixed, state-tagged view, so every
 * state a user can see is reachable from a unit test without a real Electron process, a real Host, or
 * a real filesystem. These cases pin each state and, just as importantly, the rules the engine exists
 * to uphold: a check degrades instead of throwing, a probe target is never rendered, a probe that
 * failed is never mistaken for a benign absence, and a `ready` backend is unverified until it
 * actually answers.
 */
import { describe, expect, it } from 'vitest'
import { DESKTOP_COMMUNITY_VARIANT, DESKTOP_DEV_VARIANT, DESKTOP_PRODUCTION_VARIANT } from '../src/desktop-variant.ts'
import {
  collectCommunityDiagnostics,
  COMMUNITY_DIAGNOSTIC_CODES,
  COMMUNITY_DIAGNOSTIC_IDS,
  type CommunityDiagnosticCheck,
  type CommunityDiagnosticId,
  type CommunityDiagnosticsFs,
  type CommunityDiagnosticsInput,
  type CommunityDiagnosticsRuntime,
  type CommunityDiagnosticsView,
} from '../src/community-diagnostics.ts'

const HOME = 'C:\\Users\\someone\\.dsh-community'
const DESCRIPTOR = 'C:\\Program Files\\DeepSeek Community\\resources\\app\\dsh\\desktop-runtime.json'
const PRIMARY = 'C:\\Program Files\\DeepSeek Community\\resources\\runtime\\primary-runtime'
const RUNTIME_BIN = 'C:\\Program Files\\DeepSeek Community\\resources\\runtime\\bin'
const HOST_ENTRY = 'C:\\Program Files\\DeepSeek Community\\resources\\app\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'

/** A secret-shaped value, used wherever a seam might answer with something it should not. */
const SECRET = 'sk-test-THIS-MUST-NOT-LEAK'

/** Entry kinds that count as present, as opposed to the `absent` and `unreadable` probe outcomes. */
type PresentKind = 'file' | 'directory' | 'other'

/** How the fake write probe answers. */
type FakeWritability = 'writable' | 'refused' | 'unverified'

/** Probe results of an installation whose every fact is healthy. */
const HEALTHY_ENTRIES: Readonly<Record<string, PresentKind>> = {
  [HOME]: 'directory',
  [DESCRIPTOR]: 'file',
  [PRIMARY]: 'directory',
  [RUNTIME_BIN]: 'directory',
  [HOST_ENTRY]: 'file',
}

/** How one fake filesystem departs from the healthy listing. */
interface FakeFsOptions {
  /** Paths whose entry probe throws, as a probe that cannot reach a verdict would. */
  readonly failing?: readonly string[]
  readonly writability?: FakeWritability
}

/**
 * A filesystem seam backed by a literal listing, so no case touches the machine it runs on.
 *
 * A path the listing does not mention is `absent` — the same value the real seam reports for a
 * missing entry — while a path named in `failing` throws, which is what one probes with.
 */
function fsListing(entries: Readonly<Record<string, PresentKind>>, options: FakeFsOptions = {}): CommunityDiagnosticsFs {
  const failing = new Set(options.failing ?? [])
  const writability = options.writability ?? 'writable'
  return {
    kind: (path) => {
      if (failing.has(path)) throw new Error('probe refused')
      return entries[path] ?? 'absent'
    },
    probeWritableDirectory: () => (writability === 'unverified'
      ? Promise.reject(new Error('write probe refused'))
      : Promise.resolve(writability === 'writable')),
  }
}

/** The healthy listing with one probed path removed or retyped. */
function fsOf(patch: Readonly<Record<string, PresentKind | undefined>> = {}, options: FakeFsOptions = {}): CommunityDiagnosticsFs {
  const merged: Record<string, PresentKind> = {}
  for (const [path, kind] of Object.entries({ ...HEALTHY_ENTRIES, ...patch })) {
    if (kind !== undefined) merged[path] = kind
  }
  return fsListing(merged, options)
}

/** A community installation that passes every check, so a case can break exactly one fact. */
function healthy(overrides: Partial<CommunityDiagnosticsInput> = {}): CommunityDiagnosticsInput {
  const base: CommunityDiagnosticsInput = {
    variant: DESKTOP_COMMUNITY_VARIANT,
    appId: 'com.deepseek.dsh.community',
    appVersion: '0.1.7-rc.2',
    locale: 'zh-CN',
    paths: { home: HOME, homeDisplay: '~/.dsh-community' },
    resources: {
      runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => Promise.resolve('0.1.7-rc.2') },
      files: [
        { label: 'runtime-bin', path: RUNTIME_BIN, kind: 'directory' },
        { label: 'host-entry', path: HOST_ENTRY, kind: 'file' },
      ],
    },
    backend: { phase: 'ready', probe: () => Promise.resolve(true) },
    rpc: {
      providers: () => Promise.resolve({ total: 3, configured: 3 }),
      models: () => Promise.resolve(true),
    },
    updates: { mandatoryPolicy: false, feed: false, enabled: false },
    telemetry: { mode: 'DISABLED', seededByVariant: true },
    platform: { os: 'win32', release: '10.0.26100', arch: 'x64' },
    versions: { electron: '44.0.0', node: '22.21.0' },
    fs: fsOf(),
    clock: () => new Date('2026-09-26T02:00:00.000Z'),
  }
  return { ...base, ...overrides }
}

/** A filesystem seam that refuses every probe, as an installation the process cannot inspect would. */
const refusingFs: CommunityDiagnosticsFs = {
  kind: () => { throw new Error('filesystem seam refused') },
  probeWritableDirectory: () => Promise.reject(new Error('filesystem seam refused')),
}

/** The check carrying one id, or a loud failure rather than a silent undefined. */
function check(view: CommunityDiagnosticsView, id: CommunityDiagnosticId): CommunityDiagnosticCheck {
  const found = view.checks.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the view is missing the ${id} check`)
  return found
}

/** Collect the healthy installation, or one broken fact of it. */
function collect(overrides: Partial<CommunityDiagnosticsInput> = {}): Promise<CommunityDiagnosticsView> {
  return collectCommunityDiagnostics(healthy(overrides))
}

describe('community edition', () => {
  it('passes for a community installation and names the bundle identifier', async () => {
    const found = check(await collect(), 'community-edition')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('community appId=com.deepseek.dsh.community')
    expect(found.code).toBeUndefined()
  })

  it('warns for any build that does not declare the community variant', async () => {
    for (const variant of [DESKTOP_PRODUCTION_VARIANT, DESKTOP_DEV_VARIANT] as const) {
      const found = check(await collect({ variant }), 'community-edition')
      expect(found.state).toBe('WARN')
      expect(found.value).toBe(variant)
      expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.variantNotCommunity)
    }
  })

  it('omits a bundle identifier that is not a reverse-DNS name', async () => {
    const found = check(await collect({ appId: 'com.example/../secret' }), 'community-edition')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('community')
  })
})

describe('application version', () => {
  it('passes with the version the application reported', async () => {
    const found = check(await collect(), 'application-version')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('0.1.7-rc.2')
  })

  it('fails when the application reported no version', async () => {
    const found = check(await collect({ appVersion: '  ' }), 'application-version')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('unknown')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.applicationVersionMissing)
  })
})

describe('data directory', () => {
  it('reports a first run as informational rather than a fault', async () => {
    const found = check(await collect({ fs: fsOf({ [HOME]: undefined }) }), 'data-directory')
    expect(found.state).toBe('INFO')
    expect(found.value).toBe('~/.dsh-community not created yet')
    expect(found.code).toBeUndefined()
  })

  it('passes when the home exists and accepts a write probe', async () => {
    const found = check(await collect(), 'data-directory')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('~/.dsh-community exists writable')
  })

  it('fails when the path exists but is not a directory', async () => {
    const found = check(await collect({ fs: fsOf({ [HOME]: 'file' }) }), 'data-directory')
    expect(found.state).toBe('FAIL')
    expect(found.value).toContain('not a directory')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.homeNotDirectory)
  })

  it('fails when a directory home refuses the write probe', async () => {
    const found = check(await collect({ fs: fsOf({}, { writability: 'refused' }) }), 'data-directory')
    expect(found.state).toBe('FAIL')
    expect(found.value).toContain('refused a write')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.homeNotWritable)
  })

  it('reports a failed existence probe as unverified, never as a first run', async () => {
    const found = check(await collect({ fs: refusingFs }), 'data-directory')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('~/.dsh-community unable to inspect')
    expect(found.value).not.toContain('not created yet')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.homeProbe)
  })

  it('reports a write probe that never answered as unverified rather than as not writable', async () => {
    const found = check(await collect({ fs: fsOf({}, { writability: 'unverified' }) }), 'data-directory')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('~/.dsh-community writability unverified')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.homeWriteProbe)
  })

  it('refuses an absolute display form and falls back to the symbolic one', async () => {
    const found = check(await collect({ paths: { home: HOME, homeDisplay: HOME } }), 'data-directory')
    expect(found.value.startsWith('$DSH_HOME')).toBe(true)
  })
})

describe('packaged runtime', () => {
  it('passes with the bundled version and the primary runtime present', async () => {
    const view = await collect()
    expect(check(view, 'packaged-runtime').value).toBe('runtime 0.1.7-rc.2 primary present')
    expect(view.bundledDsh).toBe('0.1.7-rc.2')
  })

  it('cannot pass a runtime seam that omits the mandatory primary path', async () => {
    const incomplete = { descriptor: DESCRIPTOR, read: () => Promise.resolve('0.1.7-rc.2') }
    const found = check(await collect({
      resources: { runtime: incomplete as unknown as CommunityDiagnosticsRuntime, files: [] },
    }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).not.toContain('primary present')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimePrimaryMissing)
  })

  it('fails on an absent descriptor without reading it', async () => {
    let reads = 0
    const found = check(await collect({
      fs: fsOf({ [DESCRIPTOR]: undefined }),
      resources: {
        runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => { reads += 1; return Promise.resolve('0.1.7-rc.2') } },
        files: [],
      },
    }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('descriptor missing')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorMissing)
    expect(reads).toBe(0)
  })

  it('fails when the descriptor exists but is a directory rather than a file', async () => {
    const found = check(await collect({ fs: fsOf({ [DESCRIPTOR]: 'directory' }) }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('descriptor is not a file')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorInvalid)
  })

  it('fails when the descriptor probe itself cannot answer', async () => {
    const found = check(await collect({ fs: fsListing(HEALTHY_ENTRIES, { failing: [DESCRIPTOR] }) }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('descriptor unreadable')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorInvalid)
  })

  it('fails when the descriptor cannot be read', async () => {
    const found = check(await collect({
      resources: {
        runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => Promise.resolve(undefined) },
        files: [],
      },
    }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorInvalid)
  })

  it('refuses a secret-shaped runtime version instead of rendering it', async () => {
    const view = await collect({
      resources: {
        runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => Promise.resolve(SECRET) },
        files: [],
      },
    })
    const found = check(view, 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('descriptor unreadable')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorInvalid)
    expect(view.bundledDsh).toBe('unknown')
    expect(JSON.stringify(view)).not.toContain(SECRET)
  })

  it('refuses a runtime version that merely embeds a secret', async () => {
    const view = await collect({
      resources: {
        runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => Promise.resolve(`0.1.7\n${SECRET}`) },
        files: [],
      },
    })
    expect(check(view, 'packaged-runtime').state).toBe('FAIL')
    expect(view.bundledDsh).toBe('unknown')
    expect(JSON.stringify(view)).not.toContain(SECRET)
  })

  it('fails when the immutable primary runtime is absent', async () => {
    const found = check(await collect({ fs: fsOf({ [PRIMARY]: undefined }) }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('runtime 0.1.7-rc.2 primary runtime missing')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimePrimaryMissing)
  })

  it('fails when the primary runtime is a file rather than a directory', async () => {
    const found = check(await collect({ fs: fsOf({ [PRIMARY]: 'file' }) }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('runtime 0.1.7-rc.2 primary runtime is not a directory')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimePrimaryInvalid)
  })

  it('reports an unprobeable primary runtime as unverified rather than as missing', async () => {
    const found = check(await collect({ fs: fsListing(HEALTHY_ENTRIES, { failing: [PRIMARY] }) }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('runtime 0.1.7-rc.2 primary runtime unverified')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimePrimaryInvalid)
  })

  it('survives a reader that throws', async () => {
    const found = check(await collect({
      resources: {
        runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => Promise.reject(new Error('descriptor exploded')) },
        files: [],
      },
    }), 'packaged-runtime')
    expect(found.state).toBe('FAIL')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorInvalid)
  })
})

describe('packaged files', () => {
  it('passes when every declared entry is present as the expected kind', async () => {
    const found = check(await collect(), 'packaged-files')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('2/2 present')
  })

  it('fails and names the missing entries by label', async () => {
    const found = check(await collect({ fs: fsOf({ [RUNTIME_BIN]: undefined, [HOST_ENTRY]: undefined }) }), 'packaged-files')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('0/2 present, missing runtime-bin, host-entry')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.packagedFileMissing)
  })

  it('fails when a declared file is present as a directory', async () => {
    const found = check(await collect({ fs: fsOf({ [HOST_ENTRY]: 'directory' }) }), 'packaged-files')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('1/2 present, wrong type host-entry')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.packagedFileKind)
  })

  it('fails when a declared directory is present as a file', async () => {
    const found = check(await collect({ fs: fsOf({ [RUNTIME_BIN]: 'file' }) }), 'packaged-files')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('1/2 present, wrong type runtime-bin')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.packagedFileKind)
  })

  it('reports an entry it could not probe as unverified rather than as missing', async () => {
    const found = check(await collect({ fs: fsListing(HEALTHY_ENTRIES, { failing: [RUNTIME_BIN] }) }), 'packaged-files')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('1/2 present, unverified runtime-bin')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.packagedFileProbe)
  })

  it('reports every fault category and names the most actionable code', async () => {
    const found = check(await collect({
      fs: fsListing({ [HOME]: 'directory', [DESCRIPTOR]: 'file', [PRIMARY]: 'directory' }, { failing: [RUNTIME_BIN] }),
    }), 'packaged-files')
    expect(found.state).toBe('FAIL')
    expect(found.value).toBe('0/2 present, missing host-entry, unverified runtime-bin')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.packagedFileMissing)
  })

  it('reports an empty declaration as informational', async () => {
    const found = check(await collect({
      resources: { runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => Promise.resolve('0.1.7-rc.2') }, files: [] },
    }), 'packaged-files')
    expect(found.state).toBe('INFO')
    expect(found.value).toBe('no packaged files declared')
  })
})

describe('backend', () => {
  it('warns while the backend is still starting instead of throwing', async () => {
    const found = check(await collect({ backend: { phase: 'starting' } }), 'backend')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('starting')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendNotReady)
  })

  it('fails when the backend reported a startup failure', async () => {
    const found = check(await collect({ backend: { phase: 'error' } }), 'backend')
    expect(found.state).toBe('FAIL')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendError)
  })

  it('does not pass a ready backend that supplied no round-trip', async () => {
    const found = check(await collect({ backend: { phase: 'ready' } }), 'backend')
    expect(found.state).not.toBe('PASS')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('ready (not independently verified)')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendNotVerified)
  })

  it('passes when a ready backend answers its round-trip', async () => {
    const found = check(await collect({ backend: { phase: 'ready', probe: () => Promise.resolve(true) } }), 'backend')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('ready (round-trip answered)')
  })

  it('fails when a ready backend answers nothing', async () => {
    const found = check(await collect({ backend: { phase: 'ready', probe: () => Promise.resolve(false) } }), 'backend')
    expect(found.state).toBe('FAIL')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendRpc)
  })

  it('survives a round-trip that throws', async () => {
    const found = check(await collect({ backend: { phase: 'ready', probe: () => Promise.reject(new Error('no answer')) } }), 'backend')
    expect(found.state).toBe('FAIL')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendRpc)
  })
})

describe('provider configuration', () => {
  it('passes when every provider is configured', async () => {
    const found = check(await collect(), 'provider-configuration')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('3/3 configured')
  })

  it('warns when only some providers are configured', async () => {
    const found = check(await collect({ rpc: { providers: () => Promise.resolve({ total: 3, configured: 1 }) } }), 'provider-configuration')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('1/3 configured')
    expect(found.code).toBeUndefined()
  })

  it('warns when no provider holds a configuration', async () => {
    const found = check(await collect({ rpc: { providers: () => Promise.resolve({ total: 3, configured: 0 }) } }), 'provider-configuration')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('0/3 configured')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.providerNoneConfigured)
  })

  it('warns when the runtime offers no configurable provider', async () => {
    const found = check(await collect({ rpc: { providers: () => Promise.resolve({ total: 0, configured: 0 }) } }), 'provider-configuration')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('no configurable providers')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.providerNoneAvailable)
  })

  it('warns when the round-trip returned nothing', async () => {
    const found = check(await collect({ rpc: { providers: () => Promise.resolve(undefined) } }), 'provider-configuration')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('unavailable')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendRpc)
  })

  it('warns when no reader was supplied at all', async () => {
    const found = check(await collect({ rpc: {} }), 'provider-configuration')
    expect(found.state).toBe('WARN')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendRpc)
  })

  it('warns when the reader throws', async () => {
    const found = check(await collect({ rpc: { providers: () => Promise.reject(new Error('rpc exploded')) } }), 'provider-configuration')
    expect(found.state).toBe('WARN')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendRpc)
  })
})

describe('model configuration', () => {
  it('passes when a model configuration is present', async () => {
    const found = check(await collect(), 'model-configuration')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('present')
  })

  it('warns when no model configuration is present', async () => {
    const found = check(await collect({ rpc: { models: () => Promise.resolve(false) } }), 'model-configuration')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('not configured')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.modelNotConfigured)
  })

  it('warns when the round-trip failed', async () => {
    const found = check(await collect({ rpc: { models: () => Promise.resolve(undefined) } }), 'model-configuration')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('unavailable')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.backendRpc)
  })
})

describe('updates', () => {
  it('reports the community-managed state as informational', async () => {
    const found = check(await collect(), 'updates')
    expect(found.state).toBe('INFO')
    expect(found.value).toBe('community-managed (no policy service, no update feed)')
    expect(found.code).toBeUndefined()
  })

  it('warns when an official update mechanism is present', async () => {
    const found = check(await collect({ updates: { mandatoryPolicy: true, feed: false, enabled: true } }), 'updates')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('community-managed expected, found policy service, update coordinator')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.updatesNotCommunityManaged)
  })
})

describe('telemetry', () => {
  it('passes when the community variant seeded the disabled default', async () => {
    const found = check(await collect(), 'telemetry')
    expect(found.state).toBe('PASS')
    expect(found.value).toBe('disabled by default')
    expect(found.code).toBeUndefined()
  })

  it('reports an operator-supplied disabled mode as informational, never as the default', async () => {
    const found = check(await collect({ telemetry: { mode: 'DISABLED', seededByVariant: false } }), 'telemetry')
    expect(found.state).toBe('INFO')
    expect(found.value).toBe('disabled (set by environment)')
  })

  it('warns when an operator set another mode', async () => {
    const found = check(await collect({ telemetry: { mode: 'FEEDBACK_ONLY', seededByVariant: false } }), 'telemetry')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('set to FEEDBACK_ONLY by environment')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.telemetryOverridden)
  })

  it('warns when no mode is set at all', async () => {
    const found = check(await collect({ telemetry: { mode: undefined, seededByVariant: false } }), 'telemetry')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('unset')
    expect(found.code).toBe(COMMUNITY_DIAGNOSTIC_CODES.telemetryUnknown)
  })

  it('classifies an unrecognized mode instead of printing it', async () => {
    const found = check(await collect({ telemetry: { mode: 'QUIET', seededByVariant: false } }), 'telemetry')
    expect(found.state).toBe('WARN')
    expect(found.value).toBe('set to an unrecognized mode by environment')
  })
})

describe('the collected view', () => {
  it('reports every check, in the fixed order, with a state each', async () => {
    const view = await collect()
    expect(view.checks.map(entry => entry.id)).toEqual([...COMMUNITY_DIAGNOSTIC_IDS])
    expect(view.checks.every(entry => entry.value !== '')).toBe(true)
    expect(view.checks.every(entry => entry.state === 'PASS' || entry.state === 'INFO')).toBe(true)
    expect(view.reportVersion).toBe(1)
    expect(view.generated).toBe('2026-09-26T02:00:00.000Z')
    expect(view.bundledDsh).toBe('0.1.7-rc.2')
    expect(view.platform).toBe('win32 10.0.26100 (x64)')
    expect(view.locale).toBe('zh-CN')
  })

  it('collects a full view when every seam throws', async () => {
    const view = await collect({
      fs: refusingFs,
      backend: { phase: 'ready', probe: () => Promise.reject(new Error('no child')) },
      rpc: {
        providers: () => Promise.reject(new Error('no child')),
        models: () => Promise.reject(new Error('no child')),
      },
      resources: {
        runtime: { descriptor: DESCRIPTOR, primary: PRIMARY, read: () => Promise.reject(new Error('no descriptor')) },
        files: [{ label: 'runtime-bin', path: RUNTIME_BIN, kind: 'directory' }],
      },
      clock: () => { throw new Error('no clock') },
    })
    expect(view.checks.map(entry => entry.id)).toEqual([...COMMUNITY_DIAGNOSTIC_IDS])
    expect(view.generated).toBe('unknown')
    expect(view.bundledDsh).toBe('unknown')
    expect(check(view, 'data-directory').state).toBe('WARN')
    expect(check(view, 'data-directory').code).toBe(COMMUNITY_DIAGNOSTIC_CODES.homeProbe)
    expect(check(view, 'packaged-runtime').state).toBe('FAIL')
    expect(check(view, 'packaged-files').state).toBe('FAIL')
    expect(check(view, 'packaged-files').code).toBe(COMMUNITY_DIAGNOSTIC_CODES.packagedFileProbe)
    expect(check(view, 'backend').state).toBe('FAIL')
    expect(check(view, 'provider-configuration').state).toBe('WARN')
  })

  it('renders an unusable locale as unknown rather than as its raw value', async () => {
    const view = await collect({ locale: 'not a locale' })
    expect(view.locale).toBe('unknown')
  })
})
