var analysisStatusUpdatedAt = '';

function renderAnalysisStatus(status) {
  var el = document.getElementById('analysis-status');
  if (!el || !status || typeof status !== 'object') return;
  var updatedAt = typeof status.updatedAt === 'string' ? status.updatedAt : '';
  if (updatedAt && analysisStatusUpdatedAt && updatedAt < analysisStatusUpdatedAt) return;
  analysisStatusUpdatedAt = updatedAt || analysisStatusUpdatedAt;
  var allowed = ['idle', 'starting', 'indexing', 'ready', 'fallback', 'failed'];
  var phase = allowed.indexOf(status.phase) >= 0 ? status.phase : 'failed';
  var generation = Math.max(0, Number(status.generation) || 0);
  // Finishing the indexing is worth being TOLD about, not just worth a chip changing colour: the reviewer
  // was given partial answers until this moment and has no other way to know that stopped. Announced on the
  // transition out of indexing only — a project whose server was ready before anyone looked says nothing.
  var wasIndexing = el.dataset.phase === 'indexing' || el.dataset.phase === 'starting';
  if (phase === 'ready' && wasIndexing) showToast(t('analysis.readyToast'));
  el.className = 'analysis-status is-' + phase;
  el.dataset.phase = phase;
  el.dataset.generation = String(generation);
  var label = el.querySelector('.analysis-status-label');
  if (label) {
    label.setAttribute('data-i18n', 'analysis.' + phase);
    label.textContent = t('analysis.' + phase);
  }
  var detail = [t('analysis.' + phase), 'generation ' + generation];
  if (status.family) detail.push(String(status.family));
  if (status.server) detail.push(String(status.server) + (status.serverSource ? ' (' + String(status.serverSource) + ')' : ''));
  if (status.fallbackReason) detail.push(String(status.fallbackReason));
  if (status.error) detail.push(String(status.error));
  el.title = detail.join('\n');
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

