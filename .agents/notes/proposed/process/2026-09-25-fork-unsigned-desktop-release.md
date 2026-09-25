# Agent Note: Unsigned community Desktop release from a fork

Status: proposed

English | [中文](2026-09-25-fork-unsigned-desktop-release.zh.md)

## Problem

This repository builds a Windows Desktop installer only on a developer machine: `package:desktop:win:x64:unsigned` writes a local artifact, and the only publication path that exists is the private upload sequence that pushes to DeepSeek's own download bucket. A fork therefore has no way to hand a user an installer — the user has to clone the repository and install Node.js and pnpm, which is not what "download and run" means.

Publishing a fork build with the release identity is not an acceptable answer, and the reason is already established for the development variant: electron-builder derives the Windows install directory, both shortcut names, and both uninstall registry keys from the application identifier, and Electron derives the user-data directory and single-instance lock from the package name. Two installations that share those values are one installation for every purpose that matters, so installing or uninstalling one would reach the other. A community binary must therefore carry its own identity rather than reuse `com.deepseek.harness`.

A community binary must also not behave like a DeepSeek deployment. A release build bakes a mandatory-update policy origin into its packaged manifest and polls it on startup and roughly every ten minutes, and the shared dsh base mounts a session-log exporter pointed at DeepSeek's collector. Both are correct for a DeepSeek release and wrong for a fork's public binary.

## Proposal

Add a third explicit product variant, `community`, selected by the existing `DSH_DESKTOP_VARIANT` input and driven by the existing variant machinery. Production and dev keep their current behaviour byte for byte.

### Community identity

The variant pins one identity in code instead of deriving it from the release identifier, because the release identifier belongs to DeepSeek's namespace and because deriving it would let a fork configuration mistake recreate the collision the variant exists to prevent.

| Identity input | Community value | Derived from |
|---|---|---|
| Application identifier (`APP_ID`, and the UUID.v5 input for `APP_GUID`) | `io.github.newplayer0408.deepseek-harness` | Pinned constant |
| Product name, install directory, executable, shortcut names | `DeepSeek Harness Community` | Pinned constant |
| Electron package name → user-data directory, Chromium profile, single-instance lock | `@newplayer0408/dsh-desktop-community` | Pinned constant |
| Install and uninstall registry keys | Derived by electron-builder from the application identifier | Application identifier |
| Artifact and output-root marker | `-community` | `desktopVariantSuffix` |
| Harness home | `~/.dsh-community` | `defaultDshCommunityHome` |

Because the identifier is pinned, a community build never calls `resolveDesktopAppId`: a release identifier in the fork's dotenv file has no effect on this variant rather than being silently trusted.

The variant marker is owned by `desktopVariantSuffix`, the helper that already produces `-dev`, so the community artifact name is `deepseek-harness-<version>-win-x64-community-unsigned.exe` and its blockmap follows. The marker sits before `-unsigned`, keeping the product variant and the signing status readable side by side.

### State isolation

`~/.dsh-community` is a sibling of `~/.dsh` and `~/.dsh-dev`, seeded by the same early bootstrap that seeds the development home, before any Harness path is resolved, and still outranked by an explicit `$DSH_HOME`. A sibling rather than a child is what keeps a release or development uninstaller — which removes only the paths its own installation registered — from reaching it by walking in.

### No upstream service contact

Two upstream behaviours are removed for this variant alone.

**Mandatory update.** The shell builds its policy client only when the packaged manifest carries `dshMandatoryUpdatePolicy`; `resolveDesktopPolicyConfig(undefined)` returns `undefined` and `main.ts` then creates no policy instance. A community build therefore omits the field from `extraMetadata` and resolves no policy origin at all. This is the smallest way to switch the behaviour off entirely: no origin is configured, nothing is polled, no request fails periodically, and `download.deepseek.com` is never contacted. Pointing the field at a placeholder or an unreachable host was rejected — both keep a request path alive that exists only to fail.

**Telemetry.** The shared dsh base resolves an unset `DSH_TELEMETRY_MODE` to `FEEDBACK_ONLY`, so an unconfigured community build would upload a session prefix to DeepSeek's collector the first time a user recorded `/feedback`. The variant seeds `DSH_TELEMETRY_MODE=DISABLED` into the process environment during the same early bootstrap, so the Host child — which inherits the shell's environment — loads the composition with the exporter row disabled and contacts no collector. Only an unset value is seeded: an operator who sets the mode explicitly keeps it, matching how `$DSH_HOME` already outranks a variant default, and `DSH_TELEMETRY_DISABLED` remains the harness's own hard opt-out.

Seeding the environment at runtime rather than exporting a CI shell variable is the point. A CI variable describes the build process; only a value the packaged application sets for itself reaches the Host that a user runs, which is why the mechanism lives in the variant bootstrap and is asserted there.

### License and notices

The repository is MIT and requires its copyright and permission notice to travel with copies of the software, but the packaged application bundles neither `LICENSE` nor `THIRD_PARTY_NOTICES.md`. A community build adds both as `licenses/LICENSE` and `licenses/THIRD_PARTY_NOTICES.md` through `extraFiles`, which electron-builder places beside the executable — the same directory that already carries Electron's own `LICENSE.electron.txt` and `LICENSES.chromium.html`, so the notices are visible in the installation rather than buried in the asar. `extraResources` was rejected because it would nest them under `resources/`, a directory whose contents are loaded by the application rather than browsed by a user. Nothing already packaged is replaced, and production keeps its current file set, so this change does not alter a release artifact.

### Release workflow

One `workflow_dispatch`-only Windows x64 workflow builds the community installer with the canonical packaging command on `windows-latest`, runs the packaged-runtime smoke that command already performs, verifies the artifact, and uploads only that `.exe` as an Actions artifact. The build job holds `contents: read` and uses no secret. Version comes from `apps/desktop/package.json` alone, with no version input, and there is no tag trigger, so a dispatch can never create a public version tag by accident.

A second job that creates the GitHub Release — the only holder of `contents: write` — is present but inert: it runs only when the operator sets the `publish` input, which defaults to false. Keeping it in place preserves the reviewed build/publish split for the later publishing step while making the first iterations build-only.

The community variant is not publishable through any upstream path, and this is enforced rather than merely intended. `createDesktopUploadPlan` refuses a non-production variant before it reads a completion record or any artifact, and `createInstalledUpdateBuilderConfig` — the installed-update qualification's entry point — requires the production variant explicitly, alongside the test deployment settings it already demanded. The workflow itself sets no upload, COS, or auto-update setting, and the upstream publication sequence is not reachable from any workflow in this repository.

### Branding

Both READMEs state that the build is an unofficial community build, not published, endorsed, or supported by DeepSeek, and the same statement is part of the release notes the publish job would write. Production identity stays unchanged, so the statement is the honest way to separate the two: the application identifier, product name, and shortcuts cannot both stay release-compatible and announce the fork.

## Alternatives considered

**Publish with the production identity and say so in the README.** Rejected: it recreates the exact shared-installation hazard the development variant was introduced to remove, and a user who installs the community build would have their existing installation replaced or removed.

**Derive the community identity from the release identifier, as `dev` does.** Rejected: the suffix would still sit inside DeepSeek's namespace, and the derivation would let a release identifier configured for local release work leak into a public community binary.

**Require `DSH_DESKTOP_APP_ID` for community builds too, validated against the pinned value.** Rejected: the validation would only restate what pinning already guarantees, and it would turn a harmless release setting in a fork's dotenv file into a build failure.

**Point the mandatory-update policy at a fork-owned origin, or at an unreachable one.** Rejected: the first requires the fork to run a policy service to say "no update", and the second leaves a periodic failing request in the application — a worse user-visible outcome than not polling at all.

**Disable telemetry by exporting `DSH_TELEMETRY_MODE` in the workflow.** Rejected: it would describe the CI process only. The packaged application, not the build, is what contacts a collector.

**Rename the product so the difference is visible in the window title alone.** Rejected as insufficient on its own: a distinct product name is required, and it is present, but the notice users need is a written statement rather than an inference from a window title.

**Add a second packaging implementation that emits a community installer directly.** Rejected: `package-target.ts` already owns preparation, identity, the Office path budget, the packaged-runtime smoke, and the packaging journal. A parallel path would have to re-earn all of it and would drift.

## Acceptance criteria

- `DSH_DESKTOP_VARIANT=community` produces an installer named `deepseek-harness-<version>-win-x64-community-unsigned.exe` in `.dsh-build/win-x64-community/`, with a matching blockmap, and no artifact named like a release or a development build.
- The installed application, its install directory, both shortcuts, both uninstall registry keys, and its Electron user-data directory differ from the release and development values; a community installation can be installed beside both.
- A community install reads and writes `~/.dsh-community` and leaves `~/.dsh` and `~/.dsh-dev` untouched, including on uninstall.
- The community packaged manifest carries no `dshMandatoryUpdatePolicy`; the shell starts no policy client and makes no policy request.
- The community Host runs with `DSH_TELEMETRY_MODE=DISABLED` unless the operator set the mode.
- `LICENSE` and `THIRD_PARTY_NOTICES.md` are readable inside a community installation.
- Production and dev identities, artifact names, output roots, packaged manifest fields, and resolved policy are unchanged.
- The workflow's default dispatch builds and uploads the community `.exe` without creating a tag or a Release and without any upstream credential.

## Risks

The fork must keep `io.github.newplayer0408.deepseek-harness` and `@newplayer0408/dsh-desktop-community` reserved for this variant; changing either is a new identity with a new install and data footprint, not a rename. The version remains `0.1.7-rc.1`, which no upstream user can confuse with a released version, but a fork that starts tracking upstream versions will need a version policy of its own. `DSH_TELEMETRY_MODE=DISABLED` stops session-log export; the DeepSeek session-log contributor is a separate request path that annotates the model requests the user's own credentials make, and it is out of scope here. The pinned LibreOfficeKit engine keeps the community root inside the Windows `--program-directory` budget at the same depth as the development root, which the packaging asserts rather than assumes. The first dispatch on a hosted runner is the first proof that the smoke stage and the path budget hold there; until it runs, both remain verified only locally. The GitHub Release job is inert by default, and an operator who sets `publish` while the tag policy is still undecided creates a release under a fork-specific tag rather than the upstream namespace.
