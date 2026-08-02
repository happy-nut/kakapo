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

// ---- Sidebar-footer usage quota widgets (compact): Claude + Codex, each a provider glyph + a donut pie of the
// used %. Data from kakapoUsage (Claude 5h/weekly % via the OAuth usage API, Codex from its session logs).
// Values are all app-provided numbers/glyphs, so innerHTML here carries no user-controlled text. ----
var CLAUDE_ICO = '<svg class="usage-ico usage-ico-claude" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.2l1.7 6 5.9-2.4-4 5 4 5-5.9-2.4L12 21.8l-1.7-6-5.9 2.4 4-5-4-5 5.9 2.4z"/></svg>';
var CODEX_ICO = '<svg class="usage-ico usage-ico-codex" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><path d="M12 3.2l7.4 4.3v8.6L12 20.8 4.6 16.1V7.5z"/><circle cx="12" cy="12" r="2.4"/></svg>';
function usageFmtTokens(n) { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'; if (n >= 1e3) return Math.round(n / 1e3) + 'k'; return String(n); }
function usageFmtReset(ms) { var d = ms - Date.now(); if (!ms || d <= 0) return 'now'; var h = Math.floor(d / 3600000), days = Math.floor(h / 24), rh = h % 24, m = Math.floor((d % 3600000) / 60000); if (days > 0) return days + 'd ' + rh + 'h'; if (h > 0) return h + 'h ' + m + 'm'; return m + 'm'; }
function usageDonut(pct, color) {
  var C = 2 * Math.PI * 7, p = Math.max(0, Math.min(100, pct));
  return '<svg class="usage-donut" viewBox="0 0 18 18" aria-hidden="true">'
    + '<circle class="usage-donut-track" cx="9" cy="9" r="7"/>'
    + '<circle class="usage-donut-fill" cx="9" cy="9" r="7" stroke="' + color + '" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + (C * (1 - p / 100)).toFixed(2) + '" transform="rotate(-90 9 9)"/></svg>';
}
function usageItem(kind, ico, color, pct, valText, tooltip) {
  var el = document.createElement('span');
  el.className = 'usage-item usage-item-' + kind;
  el.title = tooltip;
  el.innerHTML = ico + (typeof pct === 'number'
    ? usageDonut(pct, color) + '<span class="usage-pct">' + Math.round(pct) + '%</span>'
    : '<span class="usage-pct usage-pct-tokens">' + valText + '</span>');
  return el;
}
function renderUsageFoot() {
  var el = document.getElementById('usage-foot');
  if (!el || !window.kakapoUsage || typeof window.kakapoUsage.get !== 'function') return;
  Promise.resolve(window.kakapoUsage.get()).then(function (s) {
    if (!el.isConnected) return;
    el.textContent = '';
    if (!s) return;
    if (s.claude) {
      var c = s.claude, pct = c.fiveHour ? c.fiveHour.utilization : undefined;
      var tip = 'Claude';
      if (c.fiveHour) tip += '\n5h: ' + Math.round(c.fiveHour.utilization) + '% · resets ' + usageFmtReset(c.fiveHour.resetsAt);
      if (c.sevenDay) tip += '\nweekly: ' + Math.round(c.sevenDay.utilization) + '% · resets ' + usageFmtReset(c.sevenDay.resetsAt);
      if (c.tokensToday) tip += '\n' + usageFmtTokens(c.tokensToday) + ' tokens today';
      el.appendChild(usageItem('claude', CLAUDE_ICO, '#d97757', pct, usageFmtTokens(c.tokensToday), tip));
    }
    if (s.codex && s.codex.primary) {
      var p = s.codex.primary;
      var ctip = 'Codex' + (s.codex.planType ? ' (' + s.codex.planType + ')' : '') + '\nweekly: ' + Math.round(p.usedPercent) + '% · resets ' + usageFmtReset(p.resetsAt);
      el.appendChild(usageItem('codex', CODEX_ICO, '#10a37f', p.usedPercent, '', ctip));
    }
  }).catch(function () {});
}
(function setupUsageFoot() {
  if (!document.getElementById('usage-foot')) return;
  renderUsageFoot();
  setInterval(renderUsageFoot, 60000);
  if (typeof window !== 'undefined') window.__kakapoUsageFoot = { render: renderUsageFoot };
})();
