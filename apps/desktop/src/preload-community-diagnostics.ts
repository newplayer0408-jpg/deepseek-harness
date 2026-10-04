/**
 * Isolated bridge for the shell-owned Community Diagnostics window.
 *
 * The preload exposes four narrow capabilities and nothing else: the current presentation, a request
 * for a fresh one, a request to copy the report behind a named presentation, and a subscription to
 * pushed presentations. It never hands the document `ipcRenderer` or a channel of its own choosing,
 * which is what keeps a compromised document from reaching the rest of the shell's IPC.
 *
 * Its only value imports are `electron` and the contract module, and that is a build requirement:
 * a sandboxed preload's `require` polyfill resolves only `electron`, `events`, `timers`, and `url`,
 * and `apps/desktop/scripts/desktop-bundle-imports.mjs` fails the bundle for anything else — which
 * is why the contract module is deliberately dependency-free.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  COMMUNITY_DIAGNOSTICS_IPC,
  COMMUNITY_DIAGNOSTICS_PAGE,
  type CommunityDiagnosticsWindowApi,
  type CommunityDiagnosticsWindowView,
} from './community-diagnostics-ipc.ts'

const api: CommunityDiagnosticsWindowApi = {
  status: () => ipcRenderer.invoke(COMMUNITY_DIAGNOSTICS_IPC.status) as Promise<CommunityDiagnosticsWindowView | null>,
  refresh: () => ipcRenderer.invoke(COMMUNITY_DIAGNOSTICS_IPC.refresh) as Promise<CommunityDiagnosticsWindowView | null>,
  copyReport: revision => ipcRenderer.invoke(COMMUNITY_DIAGNOSTICS_IPC.copyReport, revision) as Promise<boolean>,
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, view: CommunityDiagnosticsWindowView): void => { listener(view) }
    ipcRenderer.on(COMMUNITY_DIAGNOSTICS_IPC.changed, receive)
    return () => { ipcRenderer.removeListener(COMMUNITY_DIAGNOSTICS_IPC.changed, receive) }
  },
}
// The document is the only origin that may hold this bridge, so the exposure is conditional on the
// exact page rather than on the fact that some shell document happened to load this preload.
if (location.href === COMMUNITY_DIAGNOSTICS_PAGE) contextBridge.exposeInMainWorld('dshCommunityDiagnostics', api)
