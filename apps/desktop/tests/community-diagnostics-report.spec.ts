/**
 * The rendered report is the artefact a user pastes into a public issue, so these cases pin its
 * format exactly, prove the text is a pure function of the view, and — the reason the check exists —
 * prove that no secret can reach either the view or the text, even when every seam is hostile.
 *
 * They also pin the two semantics a careless report would get wrong: a probe that failed is never
 * rendered as a benign first run, and a `ready` backend is never rendered as verified on its own
 * word. The renderer itself only formats — it re-derives nothing — so what these cases really test is
 * that the collector never hands it something it should not show.
 */
import { describe, expect, it } from 'vitest'
import { DESKTOP_COMMUNITY_VARIANT } from '../src/desktop-variant.ts'
import {
  collectCommunityDiagnostics,
  COMMUNITY_DIAGNOSTIC_CODES,
  renderCommunityDiagnosticsReport,
  summarizeCommunityDiagnostics,
  type CommunityDiagnosticCheck,
  type CommunityDiagnosticId,
  type CommunityDiagnosticsState,
  type CommunityDiagnosticsView,
} from '../src/community-diagnostics.ts'

/** One check, carrying a code only when the case supplies one. */
function entry(id: CommunityDiagnosticId, state: CommunityDiagnosticsState, value: string, code?: string): CommunityDiagnosticCheck {
  return code === undefined ? { id, state, value } : { id, state, value, code }
}

/** A complete, healthy check set, in report order. */
const CHECKS: readonly CommunityDiagnosticCheck[] = [
  entry('community-edition', 'PASS', 'community appId=com.deepseek.dsh.community'),
  entry('application-version', 'PASS', '0.1.7-rc.2'),
  entry('data-directory', 'PASS', '~/.dsh-community exists writable'),
  entry('packaged-runtime', 'PASS', 'runtime 0.1.7-rc.2 primary present'),
  entry('packaged-files', 'PASS', '12/12 present'),
  entry('backend', 'PASS', 'ready (round-trip answered)'),
  entry('provider-configuration', 'WARN', '1/3 configured'),
  entry('model-configuration', 'PASS', 'present'),
  entry('updates', 'INFO', 'community-managed (no policy service, no update feed)'),
  entry('telemetry', 'PASS', 'disabled by default'),
  entry('system', 'INFO', 'win32 10.0.26100 x64'),
]

/** A collected view, for the cases that exercise the renderer alone. */
function view(overrides: Partial<CommunityDiagnosticsView> = {}): CommunityDiagnosticsView {
  const base: CommunityDiagnosticsView = {
    reportVersion: 2,
    generated: '2026-09-26T02:00:00.000Z',
    variant: DESKTOP_COMMUNITY_VARIANT,
    appVersion: '0.1.7-rc.2',
    bundledDsh: '0.1.7-rc.2',
    platform: 'win32 10.0.26100 (x64)',
    electron: '44.0.0',
    node: '22.21.0',
    locale: 'zh-CN',
    checks: CHECKS,
  }
  return { ...base, ...overrides }
}

/**
 * Plausible secret material, injected into every seam the collector reads — including the fields the
 * report does render.
 */
const SECRETS = [
  'sk-test-THIS-MUST-NOT-LEAK',
  'Bearer super-secret-token',
  'session_cookie=secret-cookie',
  'Authorization: secret',
  'C:\\Users\\secret-user\\private',
  'PATH=C:\\secret\\bin',
] as const

const [KEY, BEARER, COOKIE, AUTH, USER_PATH, PATH_VALUE] = SECRETS

describe('report format', () => {
  it('renders the header fields, one line per check, and the counts, in one fixed order', () => {
    expect(renderCommunityDiagnosticsReport(view())).toBe([
      'DeepSeek Harness — Community Diagnostics',
      'report version: 2',
      'generated: 2026-09-26T02:00:00.000Z',
      'variant: community',
      'app version: 0.1.7-rc.2',
      'bundled dsh: 0.1.7-rc.2',
      'platform: win32 10.0.26100 (x64)',
      'electron: 44.0.0',
      'node: 22.21.0',
      'locale: zh-CN',
      '',
      '[PASS] community-edition community appId=com.deepseek.dsh.community',
      '[PASS] application-version 0.1.7-rc.2',
      '[PASS] data-directory ~/.dsh-community exists writable',
      '[PASS] packaged-runtime runtime 0.1.7-rc.2 primary present',
      '[PASS] packaged-files 12/12 present',
      '[PASS] backend ready (round-trip answered)',
      '[WARN] provider-configuration 1/3 configured',
      '[PASS] model-configuration present',
      '[INFO] updates community-managed (no policy service, no update feed)',
      '[PASS] telemetry disabled by default',
      '[INFO] system win32 10.0.26100 x64',
      '',
      'summary: 8 pass, 1 warn, 0 fail, 2 info',
      '',
    ].join('\n'))
  })

  it('is a pure function of the view, so one installation always renders one text', () => {
    expect(renderCommunityDiagnosticsReport(view())).toBe(renderCommunityDiagnosticsReport(view()))
  })

  it('prints exactly the injected timestamp, and changes with it', () => {
    const first = renderCommunityDiagnosticsReport(view({ generated: '2020-01-02T03:04:05.678Z' }))
    expect(first).toContain('generated: 2020-01-02T03:04:05.678Z\n')
    expect(renderCommunityDiagnosticsReport(view({ generated: '2021-01-02T03:04:05.678Z' }))).not.toBe(first)
  })

  it('keeps the order of the checks it is given rather than imposing one', () => {
    const reversed = [...CHECKS].reverse()
    const lines = renderCommunityDiagnosticsReport(view({ checks: reversed })).split('\n').filter(line => line.startsWith('['))
    expect(lines[0]).toContain('system')
    expect(lines.at(-1)).toContain('community-edition')
  })

  it('counts each state in the summary line', () => {
    const checks = [
      entry('community-edition', 'PASS', 'community'),
      entry('data-directory', 'FAIL', '~/.dsh-community exists but is not a directory', COMMUNITY_DIAGNOSTIC_CODES.homeNotDirectory),
      entry('updates', 'INFO', 'community-managed'),
      entry('telemetry', 'WARN', 'unset'),
      entry('system', 'INFO', 'win32 10.0.26100 x64'),
    ]
    expect(renderCommunityDiagnosticsReport(view({ checks }))).toContain('\nsummary: 1 pass, 1 warn, 1 fail, 2 info\n')
    expect(summarizeCommunityDiagnostics(checks)).toEqual({ pass: 1, warn: 1, fail: 1, info: 2 })
  })

  it('appends a stable code to a non-pass line and adds nothing to a passing one', () => {
    const report = renderCommunityDiagnosticsReport(view({
      checks: [
        entry('packaged-runtime', 'FAIL', 'descriptor missing', COMMUNITY_DIAGNOSTIC_CODES.runtimeDescriptorMissing),
        entry('updates', 'INFO', 'community-managed (no policy service, no update feed)'),
      ],
    }))
    expect(report).toContain('[FAIL] packaged-runtime descriptor missing code=E-RUNTIME-DESCRIPTOR-MISSING\n')
    expect(report).toContain('[INFO] updates community-managed (no policy service, no update feed)\n')
  })

  it('renders a warning for a backend that nothing independently verified', () => {
    const report = renderCommunityDiagnosticsReport(view({
      checks: [entry('backend', 'WARN', 'ready (not independently verified)', COMMUNITY_DIAGNOSTIC_CODES.backendNotVerified)],
    }))
    expect(report).toContain('[WARN] backend ready (not independently verified) code=E-BACKEND-NOT-VERIFIED\n')
  })

  it('renders the home symbolically and never as an absolute path', () => {
    const report = renderCommunityDiagnosticsReport(view())
    expect(report).toContain('~/.dsh-community')
    expect(report).not.toMatch(/[A-Za-z]:[\\/]/u)
  })
})

describe('a report of a broken installation', () => {
  it('carries a stable code instead of the exception that produced it', async () => {
    const collected = await collectCommunityDiagnostics({
      variant: DESKTOP_COMMUNITY_VARIANT,
      appId: 'com.deepseek.dsh.community',
      appVersion: '0.1.7-rc.2',
      locale: 'zh-CN',
      paths: { home: USER_PATH, homeDisplay: '~/.dsh-community' },
      resources: {
        runtime: {
          descriptor: `${PATH_VALUE}\\desktop-runtime.json`,
          primary: `${PATH_VALUE}\\runtime\\primary-runtime`,
          read: () => Promise.reject(new Error("ENOENT: no such file or directory, open 'C:\\Temp\\out.log'")),
        },
        files: [{ label: 'runtime-bin', path: `${PATH_VALUE}\\runtime\\bin`, kind: 'directory' }],
      },
      backend: { phase: 'ready', probe: () => Promise.reject(new Error('spawnSync git EBUSY')) },
      rpc: { providers: () => Promise.reject(new Error('rpc exploded at C:\\Temp\\x.ts:12')) },
      updates: { mandatoryPolicy: false, feed: false, enabled: false },
      telemetry: { mode: 'DISABLED', seededByVariant: true },
      platform: { os: 'win32', release: '10.0.26100', arch: 'x64' },
      versions: { electron: '44.0.0', node: '22.21.0' },
      fs: {
        kind: (path) => {
          if (path === USER_PATH) throw new Error('EPERM: operation not permitted')
          return 'absent'
        },
        probeWritableDirectory: () => Promise.reject(new Error('EPERM: operation not permitted')),
      },
      clock: () => new Date('2026-09-26T02:00:00.000Z'),
    })
    const report = renderCommunityDiagnosticsReport(collected)
    expect(report).toContain('[WARN] data-directory ~/.dsh-community unable to inspect code=E-DATA-HOME-PROBE\n')
    expect(report).toContain('[FAIL] packaged-runtime descriptor missing code=E-RUNTIME-DESCRIPTOR-MISSING\n')
    expect(report).toContain('code=E-PACKAGED-FILE-MISSING')
    expect(report).toContain('code=E-BACKEND-RPC')
    // A broken installation reports its own version provenance as unreadable too, which is what tells
    // a reader that the build cannot name the fork release or the upstream base it came from.
    expect(report).toContain('[WARN] community-version unknown code=E-COMMUNITY-VERSION-MISSING\n')
    expect(report).toContain('[WARN] upstream-base unknown code=E-UPSTREAM-BASE-MISSING\n')
    expect(report).toContain('[WARN] upstream-commit unknown code=E-UPSTREAM-COMMIT-MISSING\n')
    expect(report).toContain('summary: 3 pass, 6 warn, 3 fail, 2 info\n')
    for (const message of ['ENOENT', 'EBUSY', 'EPERM', 'rpc exploded', 'Temp', 'not created yet']) {
      expect(report).not.toContain(message)
    }
  })
})

describe('the secret canary', () => {
  it('keeps every injected secret out of both the view and the report', async () => {
    const collected = await collectCommunityDiagnostics({
      variant: DESKTOP_COMMUNITY_VARIANT,
      appId: KEY,
      appVersion: KEY,
      locale: AUTH,
      paths: { home: USER_PATH, homeDisplay: USER_PATH },
      resources: {
        runtime: { descriptor: `${PATH_VALUE}\\desktop-runtime.json`, primary: PATH_VALUE, read: () => Promise.reject(new Error(KEY)) },
        files: [
          { label: KEY, path: `${PATH_VALUE}\\runtime\\bin`, kind: 'directory' },
          { label: 'host-entry', path: `${PATH_VALUE}\\index.js`, kind: 'file' },
        ],
      },
      backend: { phase: 'ready', probe: () => Promise.reject(new Error(AUTH)) },
      rpc: {
        providers: () => Promise.reject(new Error(BEARER)),
        models: () => Promise.reject(new Error(COOKIE)),
      },
      updates: { mandatoryPolicy: true, feed: true, enabled: true },
      telemetry: { mode: KEY, seededByVariant: false },
      platform: { os: KEY, release: KEY, arch: KEY },
      versions: { electron: KEY, node: BEARER },
      fs: {
        kind: () => { throw new Error(PATH_VALUE) },
        probeWritableDirectory: () => Promise.reject(new Error(AUTH)),
      },
      clock: () => new Date('2026-09-26T02:00:00.000Z'),
    })
    const report = renderCommunityDiagnosticsReport(collected)
    const serialized = JSON.stringify(collected)
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret)
      expect(report).not.toContain(secret)
    }
    expect(report).not.toContain('Authorization')
    expect(report).not.toContain('process.env')
    expect(report).not.toMatch(/[A-Za-z]:[\\/]/u)
    expect(serialized).not.toMatch(/[A-Za-z]:[\\/]/u)
  })

  it('refuses a secret a runtime reader resolved successfully, in both the view and the report', async () => {
    const collected = await collectCommunityDiagnostics({
      variant: DESKTOP_COMMUNITY_VARIANT,
      appId: KEY,
      appVersion: KEY,
      locale: AUTH,
      paths: { home: USER_PATH, homeDisplay: USER_PATH },
      resources: {
        runtime: { descriptor: PATH_VALUE, primary: `${PATH_VALUE}\\runtime\\primary-runtime`, read: () => Promise.resolve(KEY) },
        files: [{ label: KEY, path: PATH_VALUE, kind: 'file' }],
      },
      backend: { phase: 'starting' },
      updates: { mandatoryPolicy: false, feed: false, enabled: false },
      telemetry: { mode: KEY, seededByVariant: false },
      platform: { os: KEY, release: KEY, arch: KEY },
      versions: { electron: KEY, node: BEARER },
      fs: { kind: path => (path === PATH_VALUE ? 'file' : 'absent'), probeWritableDirectory: () => Promise.resolve(false) },
      clock: () => new Date('2026-09-26T02:00:00.000Z'),
    })
    const report = renderCommunityDiagnosticsReport(collected)
    expect(collected.bundledDsh).toBe('unknown')
    expect(JSON.stringify(collected)).not.toContain(KEY)
    expect(report).toContain('[FAIL] packaged-runtime descriptor unreadable code=E-RUNTIME-DESCRIPTOR-INVALID\n')
    for (const secret of SECRETS) expect(report).not.toContain(secret)
  })

  it('degrades each gated field to a placeholder instead of dropping the check', async () => {
    const collected = await collectCommunityDiagnostics({
      variant: DESKTOP_COMMUNITY_VARIANT,
      appId: KEY,
      appVersion: KEY,
      locale: AUTH,
      paths: { home: USER_PATH, homeDisplay: USER_PATH },
      resources: {
        runtime: { descriptor: PATH_VALUE, primary: `${PATH_VALUE}\\runtime\\primary-runtime`, read: () => Promise.resolve(KEY) },
        files: [{ label: KEY, path: PATH_VALUE, kind: 'file' }],
      },
      backend: { phase: 'starting' },
      updates: { mandatoryPolicy: false, feed: false, enabled: false },
      telemetry: { mode: KEY, seededByVariant: false },
      platform: { os: KEY, release: KEY, arch: KEY },
      versions: { electron: KEY, node: BEARER },
      fs: { kind: () => 'absent', probeWritableDirectory: () => Promise.resolve(false) },
      clock: () => new Date('2026-09-26T02:00:00.000Z'),
    })
    const report = renderCommunityDiagnosticsReport(collected)
    expect(collected.appVersion).toBe('unknown')
    expect(collected.locale).toBe('unknown')
    expect(collected.platform).toBe('unknown unknown (unknown)')
    expect(collected.bundledDsh).toBe('unknown')
    expect(report).toContain('[PASS] community-edition community\n')
    expect(report).toContain('[WARN] telemetry set to an unrecognized mode by environment code=E-TELEMETRY-OVERRIDDEN\n')
    expect(report).toContain('[FAIL] application-version unknown code=E-APPLICATION-VERSION-MISSING\n')
    for (const secret of SECRETS) expect(report).not.toContain(secret)
  })
})
