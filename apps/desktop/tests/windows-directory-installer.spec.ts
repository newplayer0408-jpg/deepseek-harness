/** The pinned builder template keeps its registration flow around staged directory replacement. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { directoryInstallerExits, directoryInstallSection, directoryUninstaller } from '../scripts/windows-directory-installer.mjs'

const require = createRequire(import.meta.url)
const section = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')),
  'templates/nsis/installSection.nsh'), 'utf8')

it('reads the desktop shortcut choice from the page that owns it in every entry path', () => {
  const welcome = readFileSync(new URL('../installer/pages.nsh', import.meta.url), 'utf8')
  const installer = readFileSync(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  // The variable the injected section reads must exist before the section is compiled.
  expect(welcome).toContain('Var InstallerShortcutState')
  expect(welcome.indexOf('Var InstallerShortcutState')).toBeLessThan(directoryInstallSection(section).indexOf('$InstallerShortcutState'))
  // An answered page publishes the checkbox; a silent run keeps the release default instead.
  expect(welcome).toContain('${NSD_GetState} $InstallerShortcut $InstallerShortcutState')
  expect(installer).toContain('StrCpy $InstallerShortcutState 1')
  expect(welcome).toContain('${NSD_CreateCheckbox} 0 0 0 0 "$(INSTALLER_DESKTOP_SHORTCUT)"')
  expect(welcome).toContain('${NSD_Check} $InstallerShortcut')
  // The finish page hides the control: the installation has already acted on the choice.
  expect(welcome).toContain('ShowWindow $InstallerShortcut 5')
  expect(welcome.match(/ShowWindow \$InstallerShortcut 0/gu)).toHaveLength(1)
})

it('keeps data cleanup out of the upstream template while retaining application removal and registration cleanup', () => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/uninstaller.nsh'), 'utf8')
  const adapted = directoryUninstaller(source)
  expect(adapted).not.toContain('--delete-app-data')
  expect(adapted).not.toContain('RMDir /r "$APPDATA')
  expect(adapted).toContain('!insertmacro customUnInstall')
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"')
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"')
  expect(directoryUninstaller(source.replaceAll('\n', '\r\n'))).toBe(adapted)
  expect(adapted).toContain('RMDir /r "\\\\?\\$INSTDIR"')
  expect(() => directoryUninstaller(source.replace('  Var /GLOBAL isDeleteAppData\n', ''))).toThrow('template changed')
  expect(() => directoryUninstaller(source.replace('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', ''))).toThrow('template changed')
})

it.each(['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh'])('cleans staged files before %s exits', (helper) => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include', helper), 'utf8')
  const exits = source.match(/^\s*Quit\s*$/gm) ?? []
  expect(exits.length).toBeGreaterThan(0)
  const adapted = directoryInstallerExits(source)
  expect(adapted.match(/Call dshCleanupDirectories/g)).toHaveLength(exits.length)
  expect(adapted).toContain('!ifndef BUILD_UNINSTALLER')
})

it('stages before stopping the application and promotes before registering the installation', () => {
  const result = directoryInstallSection(section)
  expect(result.indexOf('!insertmacro dshStageApplication')).toBeLessThan(result.indexOf('!insertmacro CHECK_APP_RUNNING'))
  expect(result.indexOf('Call dshPromoteDirectories')).toBeLessThan(result.indexOf('!insertmacro registryAddInstallInfo'))
  expect(result).toContain('!insertmacro addStartMenuLink $keepShortcuts')
  expect(result).toContain('!insertmacro addDesktopLink $keepShortcuts')
  expect(result).toContain('!insertmacro handleUninstallResult HKEY_CURRENT_USER')
  expect(result).not.toContain('!insertmacro installApplicationFiles')
  expect(result).not.toContain('File /oname=uninstallerIcon.ico')
})

it('lets the welcome page decide the desktop shortcut while the Start Menu link stays available', () => {
  const result = directoryInstallSection(section)
  expect(result).toContain('${If} $InstallerShortcutState == "1"\n!insertmacro addDesktopLink $keepShortcuts\n${EndIf}')
  expect(result).toContain('!insertmacro addStartMenuLink $keepShortcuts')
  expect(result).not.toContain('$InstallerShortcutState == "1"\n!insertmacro addStartMenuLink')
  // Upstream still owns the entry point, including its /no-desktop-shortcut flag, keep-shortcuts
  // rename, and shell notification; the patch only adds the page's own veto around it.
  const upstream = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')),
    'templates/nsis/include/installer.nsh'), 'utf8')
  expect(upstream).toContain('${ifNot} ${isNoDesktopShortcut}')
  expect(upstream).toContain('WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"')
})

it.each(['!include installer.nsh', '!insertmacro setLinkVars', '!insertmacro installApplicationFiles',
  '!insertmacro addDesktopLink $keepShortcuts'])(
  'rejects a missing or duplicate upstream insertion point: %s', (point) => {
    expect(() => directoryInstallSection(section.replace(point, ''))).toThrow('Desktop NSIS template changed')
    expect(() => directoryInstallSection(`${section}\n${point}`)).toThrow('Desktop NSIS template changed')
  },
)
