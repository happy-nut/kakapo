var analysisStatusUpdatedAt = '';
var analysisStatusLast = null;
var ANALYSIS_ELAPSED_AFTER_MS = 3000;
var analysisPhaseStartedAt = 0;
var analysisElapsedTimer = 0;

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
  var wasIndexing = el.dataset.phase === 'indexing' || el.dataset.phase === 'starting';
  var becameReady = phase === 'ready' && wasIndexing;
  if (becameReady) showToast(t('analysis.readyToast'));
  el.className = 'analysis-status is-' + phase;
  el.dataset.phase = phase;
  el.dataset.generation = String(generation);
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
  if (becameReady) refreshAnalysisPaints();
}

function refreshAnalysisPaints() {
  paintSourceDecorations();
  refreshDiagnosticsFilter();
  refreshGuessedSemanticPeek();
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

