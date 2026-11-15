// ===== The endpoints this project declares =======================================================
// IntelliJ Ultimate's Endpoints tool window, in the shape this app already has for a list: the quick-open
// overlay, a row per endpoint, Enter to jump to the declaration.
//
// Read JetBrains' documentation for the behaviour rather than the IDE's own code — Endpoints is Ultimate
// and the machine has Community, so there is nothing to decompile (see src/endpoints.ts). What the
// documentation settles and this follows: a row shows the ADDRESS with its type and framework beside it,
// a deprecated endpoint is drawn struck through, and the row's two actions are "jump to source" and a
// generated HTTP request.
//
// The request is why this is worth having here rather than being a nicer grep. Running one was the thing
// this app could already do and had no way to begin: `.http` files have been runnable since the HTTP
// Client port, and an endpoint is where a request comes from.

var endpointRows = [];
var endpointsBusy = false;
var endpointsSeq = 0;
var endpointsAsked = false;

function openEndpoints() {
  openQuickOpen('endpoints');
  if (quickInput) quickInput.value = '';
  // Asked once per review. The scan is over what main already holds in the project index, and the answer
  // only changes when the index does — which is a rebuild, and a rebuild reopens this list empty anyway.
  if (!endpointsAsked) loadEndpoints();
  else renderEndpointResults('');
  return true;
}

function loadEndpoints() {
  endpointsAsked = true;
  endpointsBusy = true;
  var seq = ++endpointsSeq;
  renderEndpointResults(String(quickInput && quickInput.value || ''));
  // The full project index first. A review's first paint indexes only the CHANGED files, so until this
  // lands the renderer has never heard of most of the paths these rows name — and Enter on a row whose
  // path `sourceByPath` does not hold opens nothing at all, which is what it did: a row pointing at a
  // Kotlin controller left the reader wherever they already were, silently.
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

/** Dropped when the review is rebuilt: the index it was read from has been replaced. */
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
    // The address first, because that is what a reader types — then the file, the method and the
    // framework, so "post", "spring" and a filename all reach the row they name.
    return matchesQueryVariants([row.path, row.file, row.method, row.framework], queries);
  }).sort(function (a, b) {
    // The review's own files first. An endpoint the change touched is the one the reader came for, and a
    // project with four hundred of them buries it otherwise.
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
      // Which module the endpoint lives in, and whether it is test code — a list that prints a path owes
      // the reader that, and a monorepo serving four backends is exactly where it matters.
      + projectRowTagsHtml(row.file) + '</span>'
      + '<span class="endpoint-framework">' + escapeHtml(row.framework) + '</span>'
      + '</button>';
  }).join('');
  // Clicks are delegated on the results container (03-quick-open.js), so a row only needs its index.
  renderQuickPreview(quickItems[quickActive]);
}

/**
 * The selected endpoint as a request, on the clipboard.
 *
 * The documentation's own actions for a row are "jump to source" and a generated HTTP request, and the
 * request is the half worth having here: running one is the thing this app could already do and had no
 * way to begin. Ultimate writes it into a scratch file; this puts it on the clipboard, which lands in the
 * `.http` file the reader already has open and runs with ⌘Enter — the same ending, without this app
 * writing a file anywhere to get there.
 *
 * A path parameter is left exactly as written. `{id}` has no value until the reader supplies one, and
 * inventing a `1` would produce a request that looks ready and is not.
 */
function copyEndpointRequest() {
  var item = quickItems[quickActive];
  var endpoint = item && item.endpoint;
  if (!endpoint) return false;
  // An RPC is not a request this client can make. Its address is `Service/Method` over HTTP/2 with a
  // protobuf body, and writing it as `GET {{host}}/Transfers/Send` would hand the reader a URL this
  // service does not serve — a request that looks ready and is not, which is the one thing this copy
  // exists to avoid. Say so instead of inventing one.
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

/**
 * The list's own keys. ⌘7 again closes it (the launcher owns every key while it is up, so the chord that
 * opened the list never reaches the dispatcher), and ⌘C copies the selected endpoint as a request.
 */
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
