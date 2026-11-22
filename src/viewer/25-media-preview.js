function previewMediaFor(path) {
  var name = String(path || '').replace(/\\/g, '/');
  var dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return PREVIEW_MEDIA[name.slice(dot + 1).toLowerCase()] || null;
}

function mediaElementHtml(kind, name) {
  if (kind === 'video') {
    return '<video class="media-preview" controls preload="metadata" playsinline title="' + escapeHtml(name) + '"></video>';
  }
  if (kind === 'audio') {
    return '<audio class="media-preview is-audio" controls preload="metadata" title="' + escapeHtml(name) + '"></audio>';
  }
  if (kind === 'pdf') {
    return '<embed class="pdf-frame" type="application/pdf" title="' + escapeHtml(name) + '">';
  }
  return '<img class="image-preview" alt="' + escapeHtml(name) + '" data-zoomable="1">';
}

var mediaObjectUrls = [];
function mediaObjectUrlFromDataUrl(dataUrl, mime) {
  var base64 = String(dataUrl).slice(String(dataUrl).indexOf(',') + 1);
  var binary = atob(base64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  var url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  mediaObjectUrls.push(url);
  while (mediaObjectUrls.length > 8) { try { URL.revokeObjectURL(mediaObjectUrls.shift()); } catch (e) {} }
  return url;
}

// The bytes come over the asset IPC rather than inside the review: a recording is tens of megabytes, and a
// base64 string of one would sit in the diff's HTML whether or not the reader ever scrolls to it.
function mountMediaSource(element, path, side, media, onFail) {
  if (!element) return;
  var bridge = typeof window !== 'undefined' ? window.kakapoFile : null;
  if (!bridge || typeof bridge.getAsset !== 'function') { if (onFail) onFail(); return; }
  Promise.resolve(bridge.getAsset(path, side)).then(function (res) {
    if (!res || !res.dataUrl) { if (onFail) onFail(); return; }
    try {
      element.src = mediaObjectUrlFromDataUrl(res.dataUrl, (media && media.mime) || '');
    } catch (e) {
      if (onFail) onFail();
    }
  }, function () { if (onFail) onFail(); });
}

function renderMediaView(file) {
  var media = file.media || previewMediaFor(file.path) || { kind: 'image' };
  return '<div class="image-view media-view">'
    + mediaElementHtml(media.kind, file.name)
    + '<div class="image-cap">' + escapeHtml(file.name) + ' &middot; ' + formatBytes(file.size || 0) + '</div>'
    + '</div>';
}

function mountMediaView(body, file) {
  var media = file.media || previewMediaFor(file.path);
  var element = body.querySelector('.media-preview, .pdf-frame');
  mountMediaSource(element, file.path, '', media, function () {
    body.textContent = t('source.previewUnavailable');
  });
}

function diffMediaSideHtml(kindLabelKey, media, name) {
  return '<div class="media-diff-side">'
    + '<div class="media-diff-kind" data-i18n="' + kindLabelKey + '">' + escapeHtml(t(kindLabelKey)) + '</div>'
    + mediaElementHtml(media.kind, name)
    + '</div>';
}

function mountDiffMediaPreview(wrapper) {
  if (!wrapper || wrapper.dataset.mediaPreview === 'done') return;
  var path = wrapper.dataset.path || '';
  var media = previewMediaFor(path);
  var body = wrapper.querySelector('.d2h-files-diff');
  if (!media || !body) return;
  if (body.querySelector('tr')) { wrapper.dataset.mediaPreview = 'done'; return; }
  wrapper.dataset.mediaPreview = 'done';
  body.removeAttribute('data-lazy');
  var name = path.slice(path.lastIndexOf('/') + 1);
  body.innerHTML = '<div class="media-diff">'
    + diffMediaSideHtml('diff.base', media, name)
    + diffMediaSideHtml('diff.workingTree', media, name)
    + '</div>';
  var sides = body.querySelectorAll('.media-diff-side');
  ['base', ''].forEach(function (side, index) {
    var side_el = sides[index];
    if (!side_el) return;
    mountMediaSource(side_el.querySelector('.media-preview, .image-preview, .pdf-frame'), path, side, media, function () {
      var element = side_el.querySelector('.media-preview, .image-preview, .pdf-frame');
      if (element) element.remove();
      var note = document.createElement('div');
      note.className = 'media-diff-absent';
      note.setAttribute('data-i18n', 'media.absent');
      note.textContent = t('media.absent');
      side_el.appendChild(note);
    });
  });
}

var diffMediaObserver = null;
function refreshDiffMediaPreviews() {
  var container = document.getElementById('diff2html-container');
  if (!container) return;
  if (!diffMediaObserver && typeof IntersectionObserver !== 'undefined') {
    diffMediaObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        diffMediaObserver.unobserve(entry.target);
        mountDiffMediaPreview(entry.target);
      });
    }, { rootMargin: '400px' });
  }
  Array.prototype.forEach.call(container.querySelectorAll('.d2h-file-wrapper'), function (wrapper) {
    if (wrapper.dataset.mediaPreview) return;
    if (!previewMediaFor(wrapper.dataset.path || '')) return;
    wrapper.dataset.mediaPreview = 'pending';
    if (diffMediaObserver) diffMediaObserver.observe(wrapper);
    else mountDiffMediaPreview(wrapper);
  });
}

refreshDiffMediaPreviews();
