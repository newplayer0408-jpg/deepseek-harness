/**
 * Isolated bridge for the shell-owned Community Update window.
 *
 * The preload exposes four narrow capabilities and nothing else: the current presentation, a request
 * for a check, a request to download the installer that check offered, and a request to reveal the
 * verified file. It never hands the document `ipcRenderer`, a channel of its own choosing, or a URL,
 * which is what keeps a compromised document from reaching the rest of the shell's IPC and from
 * pointing the main process at a destination of its own.
 *
 * Its only value imports are `electron` and the contract module, and that is a build requirement: a
 * sandboxed preload's `require` polyfill resolves only `electron`, `events`, `timers`, and `url`, and
 * `apps/desktop/scripts/desktop-bundle-imports.mjs` fails the bundle for anything else — which is why
 * the contract module is deliberately dependency-free.
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  COMMUNITY_UPDATE_IPC,
  COMMUNITY_UPDATE_PAGE,
  type CommunityUpdateWindowApi,
  type CommunityUpdateWindowView,
} from './community-update-ipc.ts'

const api: CommunityUpdateWindowApi = {
  status: () => ipcRenderer.invoke(COMMUNITY_UPDATE_IPC.status) as Promise<CommunityUpdateWindowView | null>,
  check: () => ipcRenderer.invoke(COMMUNITY_UPDATE_IPC.check) as Promise<CommunityUpdateWindowView | null>,
  download: () => ipcRenderer.invoke(COMMUNITY_UPDATE_IPC.download) as Promise<CommunityUpdateWindowView | null>,
  openLocation: revision => ipcRenderer.invoke(COMMUNITY_UPDATE_IPC.openLocation, revision) as Promise<boolean>,
  openNotes: revision => ipcRenderer.invoke(COMMUNITY_UPDATE_IPC.openNotes, revision) as Promise<boolean>,
  subscribe: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, view: CommunityUpdateWindowView): void => { listener(view) }
    ipcRenderer.on(COMMUNITY_UPDATE_IPC.changed, receive)
    return () => { ipcRenderer.removeListener(COMMUNITY_UPDATE_IPC.changed, receive) }
  },
}
// The document is the only origin that may hold this bridge, so the exposure is conditional on the
// exact page rather than on the fact that some shell document happened to load this preload.
if (location.href === COMMUNITY_UPDATE_PAGE) contextBridge.exposeInMainWorld('dshCommunityUpdate', api)
