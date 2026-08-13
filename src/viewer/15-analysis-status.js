var analysisStatusUpdatedAt = '';

function renderAnalysisStatus(status) {
  var el = document.getElementById('analysis-status');
  if (!el || !status || typeof status !== 'object') return;
  var updatedAt = typeof status.updatedAt === 'string' ? status.updatedAt : '';
  if (updatedAt && analysisStatusUpdatedAt && updatedAt < analysisStatusUpdatedAt) return;
  analysisStatusUpdatedAt = updatedAt || analysisStatusUpdatedAt;
  var allowed = ['idle', 'starting', 'ready', 'fallback', 'failed'];
  var phase = allowed.indexOf(status.phase) >= 0 ? status.phase : 'failed';
  var generation = Math.max(0, Number(status.generation) || 0);
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


// ===== Update download progress, drawn ON the brand mark =====
// The reviewer keeps working while ~200MB streams down, so the report has to be somewhere that costs no
// layout and interrupts nothing. The kakapo mark in the sidebar header is already sitting there saying only
// "this is kakapo" — it becomes the progress indicator for as long as there is progress, and goes back to
// being the logo the moment there is not. No bar, no dialog, no percentage text competing with the version
// number beside it: the ring fills, and the number lives in the title for anyone who wants it.
function applyUpdateProgress(payload) {
  var host = document.getElementById('app-version');
  if (!host) return;
  var percent = Math.max(0, Math.min(100, Math.round(Number(payload && payload.percent) || 0)));
  var active = !!payload && !payload.done;
  host.classList.toggle('is-updating', active);
  host.style.setProperty('--update-progress', percent + '%');
  host.title = active ? t('update.downloading').replace('{n}', String(percent)) : '';
}
if (window.kakapoUpdate && typeof window.kakapoUpdate.onProgress === 'function') {
  window.kakapoUpdate.onProgress(applyUpdateProgress);
}
