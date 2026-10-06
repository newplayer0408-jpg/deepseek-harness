/** Formats the main-owned update presentation; every displayed string arrives in the view. */
const api = window.dshCommunityUpdate
let view
const root = document.getElementById('update')
const titleNode = document.getElementById('update-title')
const statusNode = document.getElementById('update-status')
const detailNode = document.getElementById('update-detail')
const progressNode = document.getElementById('update-progress')
const progressFill = document.getElementById('update-progress-fill')
const progressText = document.getElementById('update-progress-text')
const rowsNode = document.getElementById('update-rows')
const codeNode = document.getElementById('update-code')
const checkNode = document.getElementById('check')
const downloadNode = document.getElementById('download')
const openNode = document.getElementById('open-location')
const notesNode = document.getElementById('view-notes')
const closeNode = document.getElementById('close')

/**
 * Phases in which the shell is working on the user's behalf.
 *
 * The document does not decide what may happen — it only avoids offering a second request while the
 * first is still running, which is the same rule the main process enforces by sharing an in-flight
 * operation with every caller.
 */
const WORKING_PHASES = ['checking', 'downloading', 'verifying']

/** An action whose label is empty does not apply to the phase being shown. */
function applyAction(node, label) {
  node.textContent = label
  node.hidden = label === ''
}

function renderRows(rows) {
  rowsNode.replaceChildren(...rows.flatMap(row => {
    const term = document.createElement('dt')
    term.textContent = row.label
    const value = document.createElement('dd')
    value.textContent = row.value
    return [term, value]
  }))
}

function renderProgress(progress) {
  progressNode.hidden = progress === undefined
  if (progress === undefined) return
  progressText.textContent = progress.text
  const percent = progress.percent
  progressFill.style.width = (percent === undefined ? 0 : percent) + '%'
  const track = progressFill.parentElement
  if (percent === undefined) track.removeAttribute('aria-valuenow')
  else track.setAttribute('aria-valuenow', String(percent))
}

function render(state) {
  if (state === null || (view !== undefined && state.revision <= view.revision)) return
  view = state
  document.documentElement.lang = state.locale
  document.title = state.title
  titleNode.textContent = state.title
  statusNode.textContent = state.status
  detailNode.textContent = state.detail
  detailNode.hidden = state.detail === ''
  renderProgress(state.progress)
  renderRows(state.rows)
  codeNode.textContent = state.code
  codeNode.hidden = state.code === ''
  applyAction(checkNode, state.actions.check)
  applyAction(downloadNode, state.actions.download)
  applyAction(openNode, state.actions.openLocation)
  applyAction(notesNode, state.actions.viewNotes)
  closeNode.textContent = state.actions.close
  const working = WORKING_PHASES.includes(state.phase)
  checkNode.disabled = working
  downloadNode.disabled = working
  root.hidden = false
}

/** Ask for one of the two operations the shell performs on the user's behalf. */
function request(operation) {
  void operation().catch(() => {})
}

/** Ask for the release page of the presentation currently displayed. */
function requestNotes(operation) {
  if (view === undefined) return
  const revision = view.revision
  void operation(revision).catch(() => {})
}

checkNode.addEventListener('click', () => { request(() => api.check()) })
downloadNode.addEventListener('click', () => { request(() => api.download()) })
openNode.addEventListener('click', () => { requestNotes(revision => api.openLocation(revision)) })
notesNode.addEventListener('click', () => { requestNotes(revision => api.openNotes(revision)) })
closeNode.addEventListener('click', () => { window.close() })
let received = false
const unsubscribe = api.subscribe(state => { received = true; render(state) })
window.addEventListener('pagehide', unsubscribe, { once: true })
void api.status().then(state => { if (!received) render(state) })
