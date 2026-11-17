
var endpointRows = [];
var endpointsBusy = false;
var endpointsSeq = 0;
var endpointsAsked = false;

function openEndpoints() {
  openQuickOpen('endpoints');
  if (quickInput) quickInput.value = '';
  if (!endpointsAsked) loadEndpoints();
  else renderEndpointResults('');
  return true;
}

function loadEndpoints() {
  endpointsAsked = true;
  endpointsBusy = true;
  var seq = ++endpointsSeq;
  renderEndpointResults(String(quickInput && quickInput.value || ''));
  ensureProjectIndex().then(function () {
    return queryProjectAnalysis('endpoints', null, null);
  }).then(function (response) {
    if (seq !== endpointsSeq) return;
    endpointRows = (response && Array.isArray(response.endpoints)) ? response.endpoints : [];
    endpointsBusy = false;
    if (quickMode === 'endpoints') renderEndpointResults(String(quickInput && quickInput.value || ''));
  }).catch(function () {
    if (seq !== endpointsSeq) return;
    endpointRows = [];
    endpointsBusy = false;
    if (quickMode === 'endpoints') renderEndpointResults(String(quickInput && quickInput.value || ''));
  });
}

function resetEndpoints() {
  endpointRows = [];
  endpointsAsked = false;
  endpointsSeq += 1;
}

function visibleEndpointRows(query) {
  var queries = queryVariants(String(query || '').trim());
  var own = reviewedPaths();
  return endpointRows.filter(function (row) {
    if (!String(query || '').trim()) return true;
    return matchesQueryVariants([row.path, row.file, row.method, row.framework], queries);
  }).sort(function (a, b) {
    return ((own.has(b.file) ? 1 : 0) - (own.has(a.file) ? 1 : 0))
      || a.path.localeCompare(b.path)
      || a.method.localeCompare(b.method);
  });
}

function renderEndpointResults(query) {
  if (!quickResults) return;
  var rows = visibleEndpointRows(query);
  quickItems = rows.map(function (row) {
    return {
      path: row.file,
      name: row.path,
      detail: row.method + ' · ' + row.framework,
      kind: 'symbol',
      recent: false,
      lineIndex: row.lineIndex,
      column: 0,
      text: row.text,
      endpoint: row,
    };
  });
  clampQuickActive();
  var frameworks = {};
  endpointRows.forEach(function (row) { frameworks[row.framework] = true; });
  var names = Object.keys(frameworks).sort();
  setQuickFilterChip(endpointsBusy,
    t('endpoints.summary', { n: endpointRows.length }) + (names.length ? ' · ' + names.join(', ') : ''),
    t('quickopen.searching'));
  if (!rows.length) {
    showQuickEmpty(endpointsBusy ? t('quickopen.searching')
      : endpointRows.length ? t('quickopen.noMatches') : t('endpoints.none'));
    return;
  }
  quickResults.innerHTML = rows.map(function (row, index) {
    return '<button type="button" class="quick-open-item endpoint-result' + (index === quickActive ? ' active' : '')
      + (row.deprecated ? ' endpoint-deprecated' : '')
      + '" data-index="' + index + '">'
      + '<span class="endpoint-method" data-method="' + escapeHtml(row.method.split(',')[0].trim()) + '">'
      + escapeHtml(row.method) + '</span>'
      + '<span class="quick-open-main"><span class="quick-open-name">' + quickNameHtml(row.path) + '</span>'
      + '<span class="quick-open-path">' + escapeHtml(semanticFileLabel(row.file, row.lineIndex)) + '</span>'
      + projectRowTagsHtml(row.file) + '</span>'
      + '<span class="endpoint-framework">' + escapeHtml(row.framework) + '</span>'
      + '</button>';
  }).join('');
  renderQuickPreview(quickItems[quickActive]);
}

function copyEndpointRequest() {
  var item = quickItems[quickActive];
  var endpoint = item && item.endpoint;
  if (!endpoint) return false;
  if (String(endpoint.method || '') === 'RPC') { showCaretHint(t('endpoints.requestNotHttp')); return true; }
  var method = String(endpoint.method || "GET").split(",")[0].trim() || "GET";
  var path = endpoint.path.charAt(0) === "/" ? endpoint.path : "/" + endpoint.path;
  var lines = [
    "### " + endpoint.framework + " · " + endpoint.file + ":" + (endpoint.lineIndex + 1),
    (method === "ANY" ? "GET" : method) + " {{host}}" + path,
  ];
  if (method !== "GET" && method !== "ANY") lines.push("Content-Type: application/json", "", "{}");
  if (!copyTextToClipboard(lines.join("\n") + "\n")) return false;
  showCaretHint(t('endpoints.requestCopied'));
  return true;
}

function handleEndpointsKey(event) {
  if (quickMode !== 'endpoints') return false;
  if (isShortcut(event, 'endpointsView')) { event.preventDefault(); closeQuickOpen(); return true; }
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
    && (event.code === 'KeyC' || String(event.key).toLowerCase() === 'c')) {
    event.preventDefault();
    return copyEndpointRequest();
  }
  return false;
}
