var analysisStatusUpdatedAt = '';
// The last status main sent us, kept so the tooltip can be rebuilt without one. The chip's visible label
// carries data-i18n and follows a language switch; the tooltip is written straight onto `el.title` by the
// render below, so without this it kept the phase name in whichever language was on when the analyzer last
// reported — which, on a project whose server is already up, is forever.
var analysisStatusLast = null;
// How long the current phase has been running, and the ticker that keeps saying so.
//
// "Analysis starting" on its own is a label that looks identical after two seconds and after two minutes,
// which is the complaint: a reviewer cannot tell a slow project from a stuck one. A counter turns that
// into a fact. It appears only after ANALYSIS_ELAPSED_AFTER_MS so a project whose server is up in a
// second never shows one, and it stops the moment the phase leaves starting/indexing.
var ANALYSIS_ELAPSED_AFTER_MS = 3000;
var analysisPhaseStartedAt = 0;
var analysisElapsedTimer = 0;

/**
 * The counter, in a span of its own beside the label.
 *
 * Beside it rather than inside it because the label carries `data-i18n`: applyI18n rewrites it on every
 * locale switch and on every rebind pass, and a counter written into that text would be wiped by the next
 * one (and would put the previous language back if it were not).
 */
function paintAnalysisElapsed() {
  var el = document.getElementById('analysis-status');
  var phase = el ? el.dataset.phase : '';
  var counting = phase === 'starting' || phase === 'indexing';
  if (!el) return;
  var span = el.querySelector('.analysis-status-elapsed');
  if (!counting) {
    if (analysisElapsedTimer) { clearInterval(analysisElapsedTimer); analysisElapsedTimer = 0; }
    if (span) span.textContent = '';
    return;
  }
  var elapsed = Date.now() - analysisPhaseStartedAt;
  if (elapsed < ANALYSIS_ELAPSED_AFTER_MS) { if (span) span.textContent = ''; return; }
  if (!span) {
    span = document.createElement('span');
    span.className = 'analysis-status-elapsed';
    el.appendChild(span);
  }
  span.textContent = ' · ' + t('analysis.elapsed', { n: Math.round(elapsed / 1000) });
}

/**
 * The chip's hover detail, rebuilt from the last status rather than from the one being delivered — which is
 * what lets applyI18n call it with no status at all after a language switch. The phase name is the only
 * translated part; the family, the server and any error are names the server itself chose and stay as sent.
 */
function paintAnalysisStatusTitle() {
  var el = document.getElementById('analysis-status');
  var status = analysisStatusLast;
  if (!el || !status) return;
  var phase = el.dataset.phase || 'idle';
  var detail = [t('analysis.' + phase), t('analysis.generation', { n: Math.max(0, Number(status.generation) || 0) })];
  if (status.family) detail.push(String(status.family));
  if (status.server) detail.push(String(status.server) + (status.serverSource ? ' (' + String(status.serverSource) + ')' : ''));
  if (status.fallbackReason) detail.push(String(status.fallbackReason));
  if (status.error) detail.push(String(status.error));
  el.title = detail.join('\n');
}

function renderAnalysisStatus(status) {
  var el = document.getElementById('analysis-status');
  if (!el || !status || typeof status !== 'object') return;
  var updatedAt = typeof status.updatedAt === 'string' ? status.updatedAt : '';
  if (updatedAt && analysisStatusUpdatedAt && updatedAt < analysisStatusUpdatedAt) return;
  analysisStatusUpdatedAt = updatedAt || analysisStatusUpdatedAt;
  analysisStatusLast = status;
  var allowed = ['idle', 'starting', 'indexing', 'ready', 'fallback', 'failed'];
  var phase = allowed.indexOf(status.phase) >= 0 ? status.phase : 'failed';
  var generation = Math.max(0, Number(status.generation) || 0);
  // Finishing the indexing is worth being TOLD about, not just worth a chip changing colour: the reviewer
  // was given partial answers until this moment and has no other way to know that stopped. Announced on the
  // transition out of indexing only — a project whose server was ready before anyone looked says nothing.
  var wasIndexing = el.dataset.phase === 'indexing' || el.dataset.phase === 'starting';
  var becameReady = phase === 'ready' && wasIndexing;
  if (becameReady) showToast(t('analysis.readyToast'));
  el.className = 'analysis-status is-' + phase;
  el.dataset.phase = phase;
  el.dataset.generation = String(generation);
  // A phase that is still the same phase keeps its clock: the analyzer re-reports its status, and
  // restarting the count on every report would hold the counter at zero forever.
  if (wasIndexing !== (phase === 'starting' || phase === 'indexing') || !analysisPhaseStartedAt) {
    analysisPhaseStartedAt = Date.now();
  }
  var label = el.querySelector('.analysis-status-label');
  if (label) {
    label.setAttribute('data-i18n', 'analysis.' + phase);
    label.textContent = t('analysis.' + phase);
  }
  if (phase === 'starting' || phase === 'indexing') {
    if (!analysisElapsedTimer) analysisElapsedTimer = setInterval(paintAnalysisElapsed, 1000);
  } else if (analysisElapsedTimer) {
    clearInterval(analysisElapsedTimer);
    analysisElapsedTimer = 0;
  }
  paintAnalysisElapsed();
  paintAnalysisStatusTitle();
  // The moment the index finishes is the moment the earlier answers are worth having again. A file opened
  // while a server was still starting was told, honestly, that nothing could judge it: the diagnostics
  // cache holds that as the file's state and the decoration cache drops its entry, and neither is asked a
  // second time by anything a reader does. So ask here, once, on the transition — not on every status
  // report, which arrives on a timer and would send a round trip per open file several times a minute.
  if (becameReady) refreshAnalysisPaints();
}

/** Re-ask for whatever the open file is decorated and marked with. */
function refreshAnalysisPaints() {
  paintSourceDecorations();
  refreshDiagnosticsFilter();
}

(function setupAnalysisStatus() {
  var bridge = window.kakapoAnalysis;
  if (!bridge) return;
  if (typeof bridge.onStatus === 'function') bridge.onStatus(renderAnalysisStatus);
  if (typeof bridge.status === 'function') {
    Promise.resolve(bridge.status()).then(renderAnalysisStatus).catch(function () {});
  }
})();

if (typeof window !== 'undefined') window.__kakapoAnalysisStatus = { render: renderAnalysisStatus };

