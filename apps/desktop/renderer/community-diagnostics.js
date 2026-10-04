/** Formats the main-owned diagnostics presentation; every displayed string arrives in the view. */
const api = window.dshCommunityDiagnostics
let view
let copying = false
const root = document.getElementById('diagnostics')
const titleNode = document.getElementById('diagnostics-title')
const refreshNode = document.getElementById('refresh')
const unavailableNode = document.getElementById('unavailable')
const listNode = document.getElementById('rows')
const summaryNode = document.getElementById('summary')
const copyNode = document.getElementById('copy-report')
const copiedNode = document.getElementById('copied')

/** The four states carry a glyph as well as a colour, so a check never depends on colour alone. */
function stateGlyph(state) {
  if (state === 'PASS') return '✓'
  if (state === 'WARN') return '!'
  if (state === 'FAIL') return '×'
  return '–'
}

/**
 * The localized word for one check's state.
 *
 * The shell's summary labels are keyed by the lowercased state names, so the state word needs no
 * copy of its own and the document still hard-codes no user-visible string.
 */
function stateWord(summaryLabels, state) {
  const word = summaryLabels[state.toLowerCase()]
  return word === undefined ? state : word
}

function renderRow(row, summaryLabels) {
  const item = document.createElement('li')
  // The glyph is decorative and hidden from assistive technology, so the state is carried as
  // localized text as well: a screen reader announces the state word, while a sighted reader still
  // sees the glyph and its colour, and neither signal is the only one available.
  const glyph = document.createElement('span')
  glyph.className = 'state state-' + row.state
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = stateGlyph(row.state)
  const stateNode = document.createElement('span')
  stateNode.className = 'state-word visually-hidden'
  stateNode.textContent = stateWord(summaryLabels, row.state)
  const labelNode = document.createElement('span')
  labelNode.className = 'row-label'
  labelNode.textContent = row.label
  const valueNode = document.createElement('span')
  valueNode.className = 'row-value'
  valueNode.textContent = row.value
  const codeNode = document.createElement('span')
  codeNode.className = 'row-code'
  codeNode.textContent = row.code
  codeNode.hidden = row.code === ''
  item.append(glyph, stateNode, labelNode, valueNode, codeNode)
  return item
}

function renderCounts(counts, labels) {
  return [
    counts.pass + ' ' + labels.pass,
    counts.warn + ' ' + labels.warn,
    counts.fail + ' ' + labels.fail,
    counts.info + ' ' + labels.info,
  ].join(' · ')
}

function render(state) {
  if (state === null || (view !== undefined && state.revision <= view.revision)) return
  view = state
  copying = false
  document.documentElement.lang = state.locale
  document.title = state.title
  titleNode.textContent = state.title
  refreshNode.textContent = state.refreshLabel
  copyNode.textContent = state.copyReportLabel
  copiedNode.textContent = ''
  unavailableNode.textContent = state.unavailable
  unavailableNode.hidden = state.unavailable === ''
  listNode.replaceChildren(...state.rows.map(row => renderRow(row, state.summaryLabels)))
  listNode.hidden = state.unavailable !== ''
  summaryNode.textContent = renderCounts(state.summary, state.summaryLabels)
  summaryNode.hidden = state.unavailable !== ''
  root.hidden = false
}

function refresh() {
  void api.refresh().catch(() => {})
}

function copyReport() {
  if (copying || view === undefined) return
  copying = true
  const revision = view.revision
  void api.copyReport(revision).then(accepted => {
    copying = false
    if (view !== undefined && view.revision === revision) copiedNode.textContent = accepted ? view.copiedLabel : ''
  }).catch(() => { copying = false })
}

refreshNode.addEventListener('click', refresh)
copyNode.addEventListener('click', copyReport)
let received = false
const unsubscribe = api.subscribe(state => { received = true; render(state) })
window.addEventListener('pagehide', unsubscribe, { once: true })
void api.status().then(state => { if (!received) render(state) })
