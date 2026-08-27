// ===== The knowledge map (⌘⇧K): the words the reviewer uses about this repository, drawn as a graph.
//
// This is the knowledge base. Notes on a diff explain ONE change and are retired by the next explanation
// (23-annotations.js); a word the reviewer has taken up outlives every change, so it lives in its own file
// beside the repository (terms-file.ts) and is drawn here.
//
// Two rules run the whole thing:
//   - a node is a word the READER used. The agent never adds one; it only fills in what that word turns out
//     to be in the code. An answer nobody read must not become the language the next explanation is in.
//   - nobody writes a link. A word of the vocabulary appearing inside another word's meaning IS the edge —
//     Obsidian's unlinked mentions, except the vocabulary is closed, so it stays a map instead of a hairball.
var termsState = { terms: [], path: '', loaded: false };

function termKeyOf(t) { return t.parent ? t.parent + '·' + t.w : t.w; }

// Longest first: "핵심 파일" has to win over "파일" before the shorter one eats the match, and a word already
// consumed cannot be matched again inside the same sentence.
function termMentions(text, exclude, names) {
  var found = [], masked = String(text || '');
  names.slice().sort(function (a, b) { return b.length - a.length; }).forEach(function (w) {
    if (w === exclude || masked.indexOf(w) < 0) return;
    found.push(w);
    masked = masked.split(w).join(' ');
  });
  return found;
}

// Nodes, edges, and how abstract each word is. Abstraction is measured the only honest way the data allows:
// how many OTHER words are explained in terms of it. A word four others lean on is the one they have in
// common, so it belongs in the middle — see the note on `inDeg` in the layout.
function termGraph(terms) {
  // Proposals are the agent's, not the reader's. They are drawn (around the outside, see layoutTerms) but
  // they are not vocabulary: they draw no edges, they are not what other words are matched against, and they
  // never count towards how abstract a word is. An edge to one would claim the reader had connected two
  // ideas that they have not so much as used yet.
  terms = terms.filter(function (t) { return !t.proposed; });
  var names = terms.map(function (t) { return t.w; });
  var nodes = terms.map(function (t) { return { t: t, key: termKeyOf(t) }; });
  var byKey = {}, core = {}, byWord = {};
  nodes.forEach(function (n) {
    byKey[n.key] = n;
    if (!n.t.parent) core[n.t.w] = n; // a bare mention means the unscoped word
    // A word can be a detail of a detail — 레일 under 워크스페이스, 빨간콩 under 레일 — and then its parent has
    // no unscoped entry to point at. Looking it up by name as well is what keeps that third level attached;
    // without it 빨간콩 had no edge at all and was laid out as an island in the far corner of the map.
    if (!byWord[n.t.w] || !n.t.parent) byWord[n.t.w] = n;
  });
  var find = function (word, scope) {
    return byKey[scope + '·' + word] || core[word] || byWord[word] || byKey[word] || null;
  };
  var links = [];
  var join = function (a, b) {
    if (!a || !b || a === b) return;
    for (var i = 0; i < links.length; i++) {
      if ((links[i].a === a && links[i].b === b) || (links[i].a === b && links[i].b === a)) return;
    }
    links.push({ a: a, b: b });
  };
  nodes.forEach(function (n) {
    if (n.t.parent) join(n, find(n.t.parent, '')); // a detail hangs off its own concept
    n.mentions = termMentions(n.t.gloss, n.t.w, names);
    n.mentions.forEach(function (w) {
      if (w === n.t.w) return;
      join(n, find(w, n.t.parent || n.t.w));
    });
  });
  var inDeg = {};
  nodes.forEach(function (n) { inDeg[n.key] = 0; });
  nodes.forEach(function (n) {
    n.mentions.forEach(function (w) {
      var target = find(w, n.t.parent || n.t.w);
      if (target) inDeg[target.key] += 1;
    });
  });
  nodes.forEach(function (n) { n.deg = 0; });
  links.forEach(function (l) { l.a.deg += 1; l.b.deg += 1; });
  return { nodes: nodes, links: links, inDeg: inDeg };
}

// Words added since the reader last read them. Opening the map is not reading — only opening a word's own
// detail is, which is what `seen` records (terms-file.ts).
function unreadTerms() {
  return liveTerms().filter(function (t) { return !t.seen; });
}
// The vocabulary as it stands. A word the reader threw out keeps its line in the file (that is what makes the
// removal stick — see `dropped` in terms-file.ts), so everything that DRAWS the vocabulary reads it through
// here instead: the map, the count, the unread dot, the words a harvest already knows about.
function liveTerms() {
  return termsState.terms.filter(function (t) { return !t.dropped; });
}

function loadTerms() {
  if (!(window.kakapoTerms && typeof window.kakapoTerms.read === 'function')) {
    termsState.loaded = true;
    return Promise.resolve(termsState);
  }
  return window.kakapoTerms.read().then(function (result) {
    termsState.terms = (result && Array.isArray(result.terms)) ? result.terms : [];
    termsState.path = (result && result.path) || '';
    termsState.loaded = true;
    try { syncTermsBadge(); } catch (e) {}
    return termsState;
  }, function () {
    termsState.loaded = true;
    return termsState;
  });
}

// The write comes back with the merged file — whatever the agent appended while this window had its own copy
// is in there (mergeTerms, terms-file.ts). Taking that back is what stops the NEXT write from dropping it
// again, and it is how a word the agent added shows up on the map without a reopen.
function saveTerms() {
  if (!(window.kakapoTerms && typeof window.kakapoTerms.write === 'function')) return Promise.resolve();
  return window.kakapoTerms.write(termsState.terms).then(function (result) {
    if (result && Array.isArray(result.terms)) termsState.terms = result.terms;
    syncTermsBadge();
    return result;
  }, function () {});
}

// The launcher row carries an unread dot, and it clears only when every new word's detail has been opened —
// the same rule the pips on the map itself follow.
function syncTermsBadge() {
  var dot = document.getElementById('terms-unread-dot');
  if (!dot) return;
  dot.classList.toggle('hidden', unreadTerms().length === 0);
}

var termsHash01 = function (str) {
  var h = 2166136261;
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
};

// Clusters, then a seeded force over the TOP concepts only, then a tidy ring of words around each one.
//
// Seeded, and run to completion before anything is drawn: a live simulation re-rolls the picture on every
// open, and a map you cannot recognise twice is not a map. The words themselves are not in the simulation at
// all — a hub with many leaves gets a ring, which reads better than whatever a force would settle on.
function layoutTerms(g, W, H) {
  var nodes = g.nodes, links = g.links, inDeg = g.inDeg;
  var adj = {}; nodes.forEach(function (n) { adj[n.key] = []; });
  links.forEach(function (l) { adj[l.a.key].push(l.b.key); adj[l.b.key].push(l.a.key); });

  var ranked = nodes.slice().sort(function (a, b) {
    return (inDeg[b.key] - inDeg[a.key]) || (adj[b.key].length - adj[a.key].length) || (a.key < b.key ? -1 : 1);
  });
  var cap = Math.max(1, Math.min(10, Math.round(Math.sqrt(nodes.length || 1))));
  var hubs = ranked.filter(function (n) { return inDeg[n.key] >= 2; }).slice(0, cap);
  if (!hubs.length && ranked.length) hubs = ranked.slice(0, 1);

  var home = {}, q = [];
  hubs.forEach(function (h) { home[h.key] = h.key; q.push(h.key); });
  while (q.length) {
    var k = q.shift();
    adj[k].forEach(function (m) { if (home[m] === undefined) { home[m] = home[k]; q.push(m); } });
  }
  // An island with no hub leads itself, rather than being dumped into a cluster it is not connected to and
  // then drawn in that cluster's ring.
  var orphans = nodes.filter(function (n) { return home[n.key] === undefined; });
  while (orphans.length) {
    var lead = orphans.slice().sort(function (a, b) {
      return (inDeg[b.key] - inDeg[a.key]) || (a.key < b.key ? -1 : 1);
    })[0];
    var qq = [lead.key];
    home[lead.key] = lead.key;
    while (qq.length) {
      var kk = qq.shift();
      adj[kk].forEach(function (m) { if (home[m] === undefined) { home[m] = lead.key; qq.push(m); } });
    }
    hubs.push(lead);
    orphans = nodes.filter(function (n) { return home[n.key] === undefined; });
  }

  var cx = W / 2, cy = (H - 30) / 2;
  var members = {}, ring = {};
  hubs.forEach(function (h) {
    members[h.key] = nodes.filter(function (n) { return n !== h && home[n.key] === h.key; });
    ring[h.key] = Math.max(56, 34 + members[h.key].length * 11);
  });

  // Clusters that share lines pull together; ones that share nothing only need to not overlap. Repulsion
  // alone spread related clusters to opposite sides and spent the whole canvas on the line between them.
  var tie = {};
  links.forEach(function (l) {
    var ha = home[l.a.key], hb = home[l.b.key];
    if (!ha || !hb || ha === hb) return;
    var key = ha < hb ? ha + '|' + hb : hb + '|' + ha;
    tie[key] = (tie[key] || 0) + 1;
  });

  // The room the clusters may use, per axis. A single radius meant a square graph in the middle of a wide
  // window with the right and bottom thirds left empty — the window's own shape is the shape to fill.
  var spanX = W * 0.34, spanY = H * 0.34;
  hubs.forEach(function (h) {
    var a = termsHash01(h.key) * Math.PI * 2;
    var grow = 0.45 + 0.55 * termsHash01(h.key + '~');
    h.x = cx + Math.cos(a) * spanX * grow;
    h.y = cy + Math.sin(a) * spanY * grow;
    h.vx = 0; h.vy = 0;
  });

  var STEPS = 300;
  for (var step = 0; step < STEPS; step++) {
    var cool = 1 - step / STEPS;
    for (var i = 0; i < hubs.length; i++) {
      var A = hubs[i];
      for (var j = i + 1; j < hubs.length; j++) {
        var B = hubs[j];
        var dx = B.x - A.x, dy = B.y - A.y;
        var d2 = dx * dx + dy * dy; if (d2 < 1) { d2 = 1; dx = 0.7; dy = 0.7; }
        var d = Math.sqrt(d2);
        var kk2 = A.key < B.key ? A.key + '|' + B.key : B.key + '|' + A.key;
        var w = tie[kk2] || 0;
        var want = ring[A.key] + ring[B.key] + (w ? 8 : 26);
        var f = (want * want * 22) / d2;
        A.vx -= (dx / d) * f; A.vy -= (dy / d) * f;
        B.vx += (dx / d) * f; B.vy += (dy / d) * f;
        if (w) {
          var pull = (d - want) * 0.17 * Math.min(w, 8);
          A.vx += (dx / d) * pull; A.vy += (dy / d) * pull;
          B.vx -= (dx / d) * pull; B.vy -= (dy / d) * pull;
        }
      }
      // No fixed distance from the middle: that draws a ring, and a ring is the arrangement where two
      // clusters that belong together are as far apart as they can get. Just keep them on the canvas.
      // Measured in units of the room available on each axis, so "too far out" means the same thing sideways
      // on a wide window as it does downwards.
      var rx = A.x - cx, ry = A.y - cy;
      var rd = Math.sqrt(rx * rx + ry * ry) || 1;
      var out = Math.sqrt((rx / spanX) * (rx / spanX) + (ry / spanY) * (ry / spanY));
      var near = (ring[A.key] + 60) / Math.min(spanX, spanY);
      if (out < near) { var fin = (near - out) * Math.min(spanX, spanY) * 0.10; A.vx += (rx / rd) * fin; A.vy += (ry / rd) * fin; }
      else if (out > 1) { var fo = (out - 1) * Math.min(spanX, spanY) * 0.09; A.vx -= (rx / rd) * fo; A.vy -= (ry / rd) * fo; }
      A.vx -= (rx / rd) * 0.9; A.vy -= (ry / rd) * 0.9;
      A.x += Math.max(-16, Math.min(16, A.vx)) * cool;
      A.y += Math.max(-16, Math.min(16, A.vy)) * cool;
      A.vx *= 0.70; A.vy *= 0.70;
      var pad = ring[A.key] + 26;
      A.x = Math.max(pad, Math.min(W - pad, A.x));
      A.y = Math.max(pad, Math.min(H - pad - 30, A.y));
    }
  }

  // Each concept keeps a circle of its own words, evenly spaced, starting from the side facing away from the
  // middle. A word whose line leaves the cluster sits on the side that line goes to, so it does not cross
  // its own ring to get there.
  hubs.forEach(function (h) {
    var mine = members[h.key];
    if (!mine.length) return;
    var base = Math.atan2(h.y - cy, h.x - cx);
    var R = ring[h.key];
    mine.forEach(function (n, i) {
      var out = null;
      links.forEach(function (l) {
        var other = l.a === n ? l.b : (l.b === n ? l.a : null);
        if (!other || other === h || home[other.key] === h.key) return;
        out = other;
      });
      n.want = out ? Math.atan2(out.y - h.y, out.x - h.x) : base + (Math.PI * 2 * i) / mine.length;
      while (n.want < base) n.want += Math.PI * 2;
    });
    mine.slice().sort(function (a, b) { return a.want - b.want; }).forEach(function (n, i) {
      var ang = base + (Math.PI * 2 * i) / mine.length;
      n.x = h.x + Math.cos(ang) * R;
      n.y = h.y + Math.sin(ang) * R;
    });
  });

  var isHub = {}; hubs.forEach(function (h) { isHub[h.key] = 1; });
  for (var pass = 0; pass < 24; pass++) {
    for (var u = 0; u < nodes.length; u++) {
      for (var v = u + 1; v < nodes.length; v++) {
        var P = nodes[u], Q = nodes[v];
        // A top concept is the one thing that never moves — the reader is meant to find it in the same place
        // twice. So a collision with one is resolved entirely by the other, and two of them are left alone
        // (the force pass already spaced them by their ring radii).
        if (isHub[P.key] && isHub[Q.key]) continue;
        var ux = Q.x - P.x, uy = Q.y - P.y;
        var need = (P.r || 6) + (Q.r || 6) + (nodes.length > 40 ? 9 : 14);
        var du = Math.sqrt(ux * ux + uy * uy) || 0.01;
        if (du >= need) continue;
        var gap = need - du;
        var pShare = isHub[P.key] ? 0 : (isHub[Q.key] ? gap : gap / 2);
        var qShare = isHub[Q.key] ? 0 : (isHub[P.key] ? gap : gap / 2);
        P.x -= (ux / du) * pShare; P.y -= (uy / du) * pShare;
        Q.x += (ux / du) * qShare; Q.y += (uy / du) * qShare;
      }
    }
    nodes.forEach(function (n) {
      n.x = Math.max((n.r || 6) + 16, Math.min(W - (n.r || 6) - 16, n.x));
      n.y = Math.max((n.r || 6) + 16, Math.min(H - (n.r || 6) - 30, n.y));
    });
  }
  g.hubs = hubs;
  return { hubs: hubs, home: home };
}

// ===== The map itself =============================================================================
// Screen and world are kept apart on purpose: the nodes and their lines live in a world the pan/zoom
// transform moves as one, and the open card does NOT — it is placed in screen space every frame, so it stays
// legible at any zoom and can be clamped against the window rather than against the graph.
var termMap = {
  nodes: [], links: [], g: null,
  W: 0, H: 0, tx: 0, ty: 0, k: 1,
  hover: null, pinned: null, raf: 0, drag: null,
};

function termMapOpen() { return !!document.getElementById('mc-map'); }

function termNodeRadius(inDeg, deg) {
  // In-degree is how many other words are explained USING this one, which is the only measure of abstraction
  // the vocabulary actually contains. Plain degree only breaks ties.
  return 3.5 + Math.min(5.5, inDeg * 1.1) + Math.min(1.5, deg * 0.2);
}

function toggleTermMap() {
  if (termMapOpen()) closeTermMap();
  else openTermMap();
}

function openTermMap() {
  if (termMapOpen()) return;
  var host = document.createElement('div');
  host.className = 'mc-map';
  host.id = 'mc-map';
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-label', t('rail.terms'));
  host.innerHTML = '<div class="mc-map-head">'
    + '<span class="mc-map-title">' + escapeHtml(t('rail.terms')) + '</span>'
    + '<span class="mc-map-count" id="mc-map-count"></span>'
    + '<span class="mc-map-sp"></span>'
    // A word the reader wants to write down themselves. Until now the vocabulary could only be added to by
    // an agent noticing one (mcp-server.ts) — so the reader could remove their own words but never write one.
    + '<button type="button" class="mc-map-add" id="mc-map-add" title="' + escapeHtml(t('terms.add')) + '">'
      + '+ ' + escapeHtml(t('terms.add')) + '</button>'
    + '<button type="button" class="mc-map-x" id="mc-map-x" aria-label="' + escapeHtml(t('terms.close')) + '">✕</button>'
    + '</div>'
    + '<div class="mc-map-stage" id="mc-map-stage">'
    + '<div class="mc-map-world" id="mc-map-world"><svg class="mc-map-edges" id="mc-map-edges"></svg></div>'
    + '<div class="mc-map-empty hidden" id="mc-map-empty"></div>'
    + '</div>';
  document.body.appendChild(host);
  document.getElementById('mc-map-x').addEventListener('click', closeTermMap);
  document.getElementById('mc-map-add').addEventListener('click', openTermAdd);
  var stage = document.getElementById('mc-map-stage');
  stage.addEventListener('pointerdown', onTermMapPointerDown);
  stage.addEventListener('wheel', onTermMapWheel, { passive: false });
  stage.addEventListener('pointermove', onTermMapHover);
  buildTermMap();
  loadTerms().then(buildTermMap);
}

function closeTermMap() {
  var host = document.getElementById('mc-map');
  if (termMap.raf) cancelAnimationFrame(termMap.raf);
  termMap.raf = 0;
  termMap.hover = null;
  termMap.pinned = null;
  if (host) host.remove();
  syncTermsBadge();
}


// The proposals ring. Evenly spaced around the outside of whatever the reader's own words occupy, so the map
// reads as "here is what you know, and here is what is out there" — with nothing but distance between them.
// The repository itself, dead centre. It is NOT a word — nobody said it, it has no meaning to open, and it is
// deliberately excluded from termGraph — but a map needs a middle. With two words and no root the map is two
// dots in a void; with it, the same two words are two things about this project. The lines from it to the
// leading concepts are structural, not claims about the reader's language: they say "these are what this
// repository is, to you", which is the one thing a map of a repository is entitled to say for itself.
function projectNodeName() {
  var brand = document.querySelector('.brand-project');
  var name = brand ? brand.textContent.trim() : '';
  if (name) return name;
  var title = String(document.title || '').split(' - ').pop();
  return (title || 'project').trim();
}

function placeRootTerm(g, W, H) {
  if (!g.nodes.length) return;
  var cx = W / 2, cy = (H - 30) / 2;
  var root = {
    t: { w: projectNodeName(), gloss: '', seen: true }, key: '\u0000root',
    isRoot: true, r: 9, deg: 0, mentions: [], near: {}, x: cx, y: cy,
  };
  // Its own words move out of the middle rather than being drawn under it.
  g.nodes.forEach(function (n) {
    var dx = n.x - cx, dy = n.y - cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d >= root.r + n.r + 34) return;
    var ang = d < 1 ? termsHash01(n.key) * Math.PI * 2 : Math.atan2(dy, dx);
    n.x = cx + Math.cos(ang) * (root.r + n.r + 34);
    n.y = cy + Math.sin(ang) * (root.r + n.r + 34);
  });
  // Joined to the cluster leaders only — everything else already hangs off one of those, and a line to every
  // word would be a star that says nothing.
  var leaders = (g.hubs && g.hubs.length ? g.hubs : g.nodes.slice(0, 1)).filter(function (n) { return !n.offered; });
  leaders.forEach(function (hub) { g.links.push({ a: root, b: hub, structural: true }); });
  g.nodes.push(root);
}

function placeProposedTerms(g, W, H) {
  var offered = liveTerms().filter(function (t) { return t.proposed; });
  if (!offered.length) return;
  var cx = W / 2, cy = (H - 30) / 2;
  var reach = 0;
  g.nodes.forEach(function (n) {
    reach = Math.max(reach, Math.sqrt((n.x - cx) * (n.x - cx) + (n.y - cy) * (n.y - cy)));
  });
  var rx = Math.max(reach + 90, W * 0.45), ry = Math.max(reach + 70, H * 0.45);
  offered.forEach(function (term, i) {
    var ang = -Math.PI / 2 + (Math.PI * 2 * i) / offered.length;
    g.nodes.push({
      t: term, key: termKeyOf(term), offered: true, r: 4, deg: 0, mentions: [], near: {},
      x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry,
    });
  });
}

function buildTermMap() {
  var stage = document.getElementById('mc-map-stage');
  var world = document.getElementById('mc-map-world');
  if (!stage || !world) return;
  // Every node object is replaced below, so an open card would be left following a node that is no longer
  // on the page. The map is rebuilt on open (once from the boot read, once when the file comes back) and on
  // resize — all three are moments where the card has nothing to stay open for.
  closeTermCard();
  var empty = document.getElementById('mc-map-empty');
  var count = document.getElementById('mc-map-count');
  if (count) count.textContent = liveTerms().length ? String(liveTerms().length) : '';
  if (!liveTerms().length) {
    if (empty) {
      empty.classList.toggle('hidden', !termsState.loaded);
      empty.innerHTML = '<p class="mc-map-empty-h">' + escapeHtml(t('terms.empty.title')) + '</p>'
        + '<p class="mc-map-empty-p">' + escapeHtml(t('terms.empty.body')) + '</p>';
    }
    world.querySelectorAll('.mc-node').forEach(function (n) { n.remove(); });
    return;
  }
  if (empty) empty.classList.add('hidden');

  // The stage can still be zero-sized on the frame the dialog is appended; laying out into a 0×0 box parks
  // every node on top of every other one, and the collision pass cannot recover from that.
  var W = Math.max(640, stage.clientWidth || 0);
  var H = Math.max(420, stage.clientHeight || 0);
  var g = termGraph(liveTerms());
  g.nodes.forEach(function (n) { n.r = termNodeRadius(g.inDeg[n.key], n.deg); });
  layoutTerms(g, W, H);
  // The agent's offerings, ringed around everything the reader owns. Outside, because that is what they are:
  // concepts that exist in the code and not yet in the reader's head. Using one in a comment is how it
  // crosses the line and becomes an ordinary word.
  placeProposedTerms(g, W, H);
  placeRootTerm(g, W, H);
  termMap.g = g;
  termMap.nodes = g.nodes;
  termMap.links = g.links;
  termMap.W = W;
  termMap.H = H;

  var cx = W / 2, cy = H / 2, far = Math.sqrt(cx * cx + cy * cy);
  g.nodes.forEach(function (n) {
    n.bx = n.x; n.by = n.y; // where it belongs; x/y is only where it is right now
    var d = Math.sqrt((n.x - cx) * (n.x - cx) + (n.y - cy) * (n.y - cy)) / far;
    n.rest = 1 - Math.min(0.5, d * 0.62); // the middle is the core; the rim reads as background
    if (n.offered) n.rest = 0.4;             // an offering is quieter still — it is not the reader's yet
    n.near = {};
  });
  g.links.forEach(function (l) { l.a.near[l.b.key] = 1; l.b.near[l.a.key] = 1; });

  world.style.width = W + 'px';
  world.style.height = H + 'px';
  world.querySelectorAll('.mc-node').forEach(function (n) { n.remove(); });
  var svg = document.getElementById('mc-map-edges');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.innerHTML = g.links.map(function (l, i) {
    return '<line class="mc-edge' + (l.structural ? ' is-structural' : '') + '" data-edge="' + i + '"'
      + ' x1="' + l.a.x + '" y1="' + l.a.y + '" x2="' + l.b.x + '" y2="' + l.b.y + '"/>';
  }).join('');

  world.insertAdjacentHTML('beforeend', g.nodes.map(function (n) {
    // --r is what puts the line where the eye expects it: the box is a column of circle-then-label, so
    // centring the whole box on (x,y) parks the circle above the point every edge is drawn to, and the lines
    // arrive at the bottom of the circle instead of its middle. The transform offsets by one radius.
    return '<div class="mc-node' + (n.offered ? ' is-offered' : '') + (n.isRoot ? ' is-root' : '') + '" data-node="' + escapeHtml(n.key) + '" tabindex="0" role="button" style="left:' + n.x + 'px;top:' + n.y + 'px;--r:' + n.r + 'px">'
      + '<span class="mc-node-dot" style="width:' + (n.r * 2) + 'px;height:' + (n.r * 2) + 'px"></span>'
      // No unread pip on an offering: the dot means "a word of yours arrived and you have not read it",
      // and a proposal is not yet a word of theirs.
      + (n.t.seen || n.offered ? '' : '<span class="mc-node-new" aria-hidden="true"></span>')
      + '<span class="mc-node-t"' + (n.isRoot ? ' title="' + escapeHtml(termsState.path || '') + '"' : '') + '>'
      + escapeHtml(n.t.w) + '</span>'
      + '</div>';
  }).join(''));
  g.nodes.forEach(function (n) { n.el = world.querySelector('.mc-node[data-node="' + cssEscape(n.key) + '"]'); });
  // Held once, not looked up per frame: at a hundred words the frame loop would otherwise re-query a
  // hundred and fifty lines sixty times a second to move four of them.
  g.links.forEach(function (l, i) { l.el = svg.querySelectorAll('.mc-edge')[i]; });
  termMap.litKey = null;
  fitTermMap();
  kickTermMap();
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// Start centred on the graph's own bounds rather than on the world box: an empty rim on one side is the first
// thing that makes a map look broken.
function fitTermMap() {
  var stage = document.getElementById('mc-map-stage');
  if (!stage || !termMap.nodes.length) return;
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  termMap.nodes.forEach(function (n) {
    x0 = Math.min(x0, n.bx - n.r - 30); x1 = Math.max(x1, n.bx + n.r + 30);
    y0 = Math.min(y0, n.by - n.r - 14); y1 = Math.max(y1, n.by + n.r + 26);
  });
  var sw = stage.clientWidth || termMap.W, sh = stage.clientHeight || termMap.H;
  termMap.k = Math.max(0.45, Math.min(1.35, Math.min(sw / (x1 - x0), sh / (y1 - y0))));
  termMap.tx = (sw - (x1 - x0) * termMap.k) / 2 - x0 * termMap.k;
  termMap.ty = (sh - (y1 - y0) * termMap.k) / 2 - y0 * termMap.k;
  applyTermMapTransform();
}

function applyTermMapTransform() {
  var world = document.getElementById('mc-map-world');
  if (world) world.style.transform = 'translate(' + termMap.tx + 'px,' + termMap.ty + 'px) scale(' + termMap.k + ')';
}

// ── the frame loop ────────────────────────────────────────────────────────────────────────────────
// Only ever a PULL: a focused word draws its neighbours in a little, and nothing is ever pushed away. Pushing
// was the version that vibrated — the card moved a node, the node slid under the cursor, and the cursor
// re-focused it. And it is slow on purpose: a graph that snaps is a graph you have to re-read every time.
function focusedTermNode() {
  return termMap.pinned || termMap.hover || null;
}

function kickTermMap() {
  if (termMap.raf || !termMapOpen()) return;
  termMap.raf = requestAnimationFrame(termMapFrame);
}

function termMapFrame() {
  termMap.raf = 0;
  if (!termMapOpen()) return;
  var focus = focusedTermNode();
  var moved = 0;
  termMap.nodes.forEach(function (n) {
    var tx = n.bx, ty = n.by;
    if (focus && n !== focus && focus.near[n.key]) {
      tx = n.bx + (focus.bx - n.bx) * 0.16;
      ty = n.by + (focus.by - n.by) * 0.16;
    }
    var dx = tx - n.x, dy = ty - n.y;
    if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
      n.x += dx * 0.045;
      n.y += dy * 0.045;
      moved += 1;
      if (n.el) { n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; }
    }
    if (n.el) {
      var lit = !focus || n === focus || focus.near[n.key];
      n.el.style.opacity = String(lit ? Math.max(n.rest, focus ? 1 : n.rest) : n.rest * 0.28);
      n.el.classList.toggle('is-lit', !!focus && lit);
      n.el.classList.toggle('is-focus', n === focus);
    }
  });
  if (moved) {
    termMap.links.forEach(function (l) {
      if (!l.el) return;
      l.el.setAttribute('x1', l.a.x); l.el.setAttribute('y1', l.a.y);
      l.el.setAttribute('x2', l.b.x); l.el.setAttribute('y2', l.b.y);
    });
  }
  // Which lines are lit only changes when the focus changes, so it is done then — not sixty times a second
  // for a picture that is already right.
  var focusKey = focus ? focus.key : '';
  if (termMap.litKey !== focusKey) {
    termMap.litKey = focusKey;
    termMap.links.forEach(function (l) {
      if (!l.el) return;
      l.el.classList.toggle('is-lit', !!focusKey && (l.a.key === focusKey || l.b.key === focusKey));
      l.el.classList.toggle('is-dim', !!focusKey && l.a.key !== focusKey && l.b.key !== focusKey);
    });
  }
  placeTermCard();
  if (moved) kickTermMap();
}

// ── pan, zoom, hover ──────────────────────────────────────────────────────────────────────────────
// Capturing the pointer on pointerdown is what made a plain click on a word do nothing: while the stage holds
// the capture, the browser dispatches the click at the STAGE, so `closest('.mc-node')` found nothing and the
// map read every click as "clicked the background". (jsdom stubs setPointerCapture into a no-op, which is why
// the tests were happy.) So the capture is taken only once a real drag starts, and opening a word is decided
// on pointerup — the one event that is ours either way.
function onTermMapPointerDown(event) {
  if (event.target.closest && event.target.closest('.mc-term-card')) return;
  if (event.button !== 0) return;
  var stage = document.getElementById('mc-map-stage');
  var node = event.target.closest ? event.target.closest('.mc-node') : null;
  termMap.drag = {
    x: event.clientX, y: event.clientY, tx: termMap.tx, ty: termMap.ty,
    moved: false, node: node ? node.dataset.node : '', id: event.pointerId,
  };
  var move = function (e) {
    if (!termMap.drag) return;
    var dx = e.clientX - termMap.drag.x, dy = e.clientY - termMap.drag.y;
    if (!termMap.drag.moved && Math.abs(dx) + Math.abs(dy) <= 3) return; // still a click, not a drag
    if (!termMap.drag.moved) {
      termMap.drag.moved = true;
      try { stage.setPointerCapture(termMap.drag.id); } catch (e2) {}
    }
    termMap.tx = termMap.drag.tx + dx;
    termMap.ty = termMap.drag.ty + dy;
    applyTermMapTransform();
    placeTermCard();
  };
  var up = function () {
    stage.removeEventListener('pointermove', move);
    stage.removeEventListener('pointerup', up);
    stage.removeEventListener('pointercancel', up);
    var drag = termMap.drag;
    termMap.drag = null;
    if (!drag || drag.moved) return; // a drag panned the map; it did not pick anything
    if (!drag.node) { closeTermCard(); return; }
    var picked = termNodeByKey(drag.node);
    if (!picked || picked.isRoot) { closeTermCard(); return; } // the repository has no meaning to open
    if (termMap.pinned === picked) closeTermCard();
    else openTermCard(picked);
  };
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
}

function onTermMapWheel(event) {
  event.preventDefault();
  var stage = document.getElementById('mc-map-stage');
  var rect = stage.getBoundingClientRect();
  var px = event.clientX - rect.left, py = event.clientY - rect.top;
  var next = Math.max(0.35, Math.min(2.6, termMap.k * Math.exp(-event.deltaY * 0.0016)));
  // Keep whatever is under the pointer under the pointer.
  termMap.tx = px - (px - termMap.tx) * (next / termMap.k);
  termMap.ty = py - (py - termMap.ty) * (next / termMap.k);
  termMap.k = next;
  applyTermMapTransform();
  placeTermCard();
}

function onTermMapHover(event) {
  if (termMap.drag) return;
  if (termMap.pinned) return; // an open card owns the focus; hover must not fight it
  var el = event.target.closest && event.target.closest('.mc-node');
  var node = el ? termNodeByKey(el.dataset.node) : null;
  if (node === termMap.hover) return;
  termMap.hover = node;
  kickTermMap();
}

function termNodeByKey(key) {
  for (var i = 0; i < termMap.nodes.length; i++) if (termMap.nodes[i].key === key) return termMap.nodes[i];
  return null;
}

// ── the card ──────────────────────────────────────────────────────────────────────────────────────
// It hangs under its own node and follows it every frame. Positioning it once was the version that ended up
// covering the node it belonged to as soon as a link inside it moved the focus somewhere else.
// A blank card, opened over the map with no node behind it. openTermCard needs a node (it pins, marks seen,
// and verifies addresses); this one deliberately does none of that — there is no word yet.
function openTermAdd() {
  closeTermCard();
  var stage = document.getElementById('mc-map-stage');
  if (!stage) return;
  var card = document.createElement('div');
  card.className = 'mc-term-card is-adding';
  card.id = 'mc-term-card';
  card.addEventListener('click', onTermCardClick);
  stage.appendChild(card);
  openTermEditor(null, true);
}

function openTermCard(node) {
  closeTermCard();
  termMap.pinned = node;
  termMap.hover = null;
  var stage = document.getElementById('mc-map-stage');
  if (!stage) return;
  var card = document.createElement('div');
  card.className = 'mc-term-card';
  card.id = 'mc-term-card';
  card.innerHTML = termCardHtml(node);
  card.addEventListener('click', onTermCardClick);
  stage.appendChild(card);
  markTermSeen(node.t);
  // Opening a word is when its addresses matter, so that is when they are checked. The card is drawn from
  // the cache first and corrected a moment later — waiting on ripgrep to show a word would make every
  // click feel like a load.
  verifyTermCode(node.t).then(function (changed) {
    if (termMap.pinned !== node) return;
    if (changed) saveTerms();
    // Redrawn even when nothing was written: settling "not checked" into an address or into "not found" is
    // exactly the state the reader opened the card to see, and only one of those two outcomes touches the file.
    var live = document.getElementById('mc-term-card');
    if (live) live.innerHTML = termCardHtml(node);
  });
  kickTermMap();
  placeTermCard();
}

function closeTermCard() {
  var card = document.getElementById('mc-term-card');
  if (card) card.remove();
  termCardEditing = null;
  termCardIsNew = false;
  termMap.pinned = null;
  kickTermMap();
}

function termCardHtml(node) {
  var term = node.t;
  var head = term.parent
    ? '<span class="mc-term-parent">' + escapeHtml(term.parent) + '</span><span class="mc-term-sep">·</span>'
    : '';
  var code = (term.code || []).map(function (entry) {
    // "not found" is a CLAIM: a search ran and the name was not in the repository. Most address-less entries
    // have never been searched for at all — the writer stores {name} alone when the agent supplies no address
    // (mcp-server.ts) — and saying "not found" about a name that is sitting in six files is simply wrong.
    // `gone` is set only by a search that came back empty, and it is deliberately not persisted (terms-file.ts
    // serialises {name, at} and nothing else), so a reload goes back to "not checked" rather than inheriting a
    // verdict from whatever the repository looked like last time.
    var at = entry.at
      ? '<span class="mc-term-at">' + escapeHtml(entry.at) + '</span>'
      : entry.gone
        ? '<span class="mc-term-at is-gone">' + escapeHtml(t('terms.code.gone')) + '</span>'
        : '<span class="mc-term-at is-unchecked">' + escapeHtml(t('terms.code.unchecked')) + '</span>';
    return '<button type="button" class="mc-term-code" data-at="' + escapeHtml(entry.at || '') + '">'
      + '<code>' + escapeHtml(entry.name) + '</code>' + at + '</button>';
  }).join('');
  // The \u00d7 in this header CLOSES. It used to be the only button here and it DELETED the word — and a
  // \u00d7 in the corner of an opened panel is read as "close" by everyone, so the reader dismissed a detail
  // and silently lost the word instead.
  //
  // The card is a thing to READ, so nothing acting on the word stands in it at rest: the two tools appear on
  // hover (and on keyboard focus, which is the half hover always forgets). They are in the SAME group as the
  // \u00d7 — one `margin-left: auto` between them and the word, none inside — because two auto margins in one
  // flex row split the slack between them and push the close button across the card, away from the tools it
  // belongs beside. A rule divides them: the two icons act on the word, the \u00d7 acts on the card.
  return '<div class="mc-term-h">' + head + '<span class="mc-term-w">' + escapeHtml(term.w) + '</span>'
    + (term.proposed ? '<span class="mc-term-offered">' + escapeHtml(t('terms.offered')) + '</span>' : '')
    + '<span class="mc-term-tools">'
    + '<button type="button" class="mc-term-icon mc-term-edit" aria-label="' + escapeHtml(t('terms.edit'))
      + '" title="' + escapeHtml(t('terms.edit')) + '">' + TERM_ICON_EDIT + '</button>'
    // A vocabulary you cannot take a word OUT of is a vocabulary that only grows, and a word the reader
    // disagrees with is exactly the one that must not be the language the next explanation is written in.
    + '<button type="button" class="mc-term-icon mc-term-drop" data-drop="' + escapeHtml(termKeyOf(term))
      + '" aria-label="' + escapeHtml(t('terms.drop')) + '" title="' + escapeHtml(t('terms.drop')) + '">'
      + TERM_ICON_DROP + '</button>'
    + '<span class="mc-term-rule" aria-hidden="true"></span>'
    + termCloseHtml()
    + '</span>'
    + '</div>'
    + '<p class="mc-term-gloss">' + termGlossHtml(node) + '</p>'
    + (code ? '<div class="mc-term-codes"><span class="mc-term-kicker">' + escapeHtml(t('terms.code')) + '</span>' + code + '</div>' : '');
}

// Line icons at the same stroke weight as every other glyph in the app's chrome (1.9 on a 24 box) — a pencil
// for the meaning, a bin for the word. Named constants because both cards draw the header.
var TERM_ICON_EDIT = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
var TERM_ICON_DROP = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>';

function termCloseHtml() {
  return '<button type="button" class="mc-term-close" aria-label="' + escapeHtml(t('terms.close'))
    + '" title="' + escapeHtml(t('terms.close')) + '">\u00d7</button>';
}

// The same card with its meaning open for writing. The gloss is what the vocabulary IS — a word is only the
// handle — so that is what can be edited. The WORD itself is deliberately not editable here: it is the key
// the record is stored under and the thing other glosses are matched against to draw the edges, so renaming
// one is a graph operation, not a text edit (see termGraph).
function termEditHtml(node, isNew) {
  var term = node ? node.t : { w: '', gloss: '' };
  return '<div class="mc-term-h">'
    + (isNew
      ? '<input type="text" class="mc-term-input mc-term-w-input" placeholder="' + escapeHtml(t('terms.add.word')) + '" value="' + escapeHtml(term.w) + '">'
      : '<span class="mc-term-w">' + escapeHtml(term.w) + '</span>')
    + '<span class="mc-term-tools">' + termCloseHtml() + '</span>'
    + '</div>'
    + '<textarea class="mc-term-input mc-term-gloss-input" rows="3" spellcheck="false" placeholder="'
      + escapeHtml(t('terms.add.gloss')) + '">' + escapeHtml(term.gloss || '') + '</textarea>'
    + '<div class="mc-term-actions">'
    + '<button type="button" class="mc-term-act is-primary mc-term-save">' + escapeHtml(t('terms.save')) + '</button>'
    + '<button type="button" class="mc-term-act mc-term-cancel">' + escapeHtml(t('terms.cancel')) + '</button>'
    + '</div>';
}

// Every vocabulary word inside the meaning is a way in — the same mentions that drew the edges, so what the
// card offers to follow and what the graph drew can never disagree.
function termGlossHtml(node) {
  var text = String(node.t.gloss || '');
  var marks = [];
  (node.mentions || []).forEach(function (w, i) {
    if (text.indexOf(w) < 0) return;
    marks.push(w);
    text = text.split(w).join('\u0001' + (marks.length - 1) + '\u0002');
  });
  return escapeHtml(text).replace(/\u0001(\d+)\u0002/g, function (_, i) {
    var w = marks[Number(i)];
    return '<button type="button" class="mc-term-link" data-w="' + escapeHtml(w) + '">' + escapeHtml(w) + '</button>';
  });
}

function termKeyOf(term) {
  return term.parent ? term.parent + '\u00b7' + term.w : term.w;
}
// Thrown out, not forgotten: the record stays and carries `dropped`, so the merge cannot re-add it, an agent
// proposing it again is refused (mcp-server.ts), and a later harvest does not offer it back.
function dropTerm(key) {
  var term = null;
  termsState.terms.forEach(function (candidate) { if (termKeyOf(candidate) === key) term = candidate; });
  if (!term) return;
  term.dropped = true;
  closeTermCard();
  saveTerms();
  buildTermMap();
}
// Editing and adding both happen in the card, because that is where the word already is. `termCardEditing`
// holds the node being written to — null while a NEW word is being added, which is the only difference
// between the two: one starts from a record and one starts from nothing.
var termCardEditing;
var termCardIsNew = false;

function openTermEditor(node, isNew) {
  var card = document.getElementById('mc-term-card');
  if (!card) return;
  termCardEditing = node || null;
  termCardIsNew = !!isNew;
  card.innerHTML = termEditHtml(node, isNew);
  var first = card.querySelector(isNew ? '.mc-term-w-input' : '.mc-term-gloss-input');
  if (first) { first.focus(); try { first.setSelectionRange(first.value.length, first.value.length); } catch (e) {} }
}

// Saving is an upsert by key, which is exactly what the file's own merge does (mergeTerms, terms-file.ts) —
// so a word the reader writes here and a word an agent kept are the same kind of record, stored the same way.
function saveTermEditor() {
  var card = document.getElementById('mc-term-card');
  if (!card) return;
  var glossEl = card.querySelector('.mc-term-gloss-input');
  var gloss = glossEl ? glossEl.value.trim() : '';
  if (termCardIsNew) {
    var wEl = card.querySelector('.mc-term-w-input');
    var w = wEl ? wEl.value.trim() : '';
    if (!w || !gloss) { showToast(t('terms.add.needBoth')); return; }
    var clash = null;
    termsState.terms.forEach(function (x) { if (!x.dropped && termKeyOf(x) === w) clash = x; });
    if (clash) { showToast(t('terms.add.exists')); return; }
    // `seen` from the start: the reader did not just meet this word, they wrote it. Leaving it unread would
    // put an unread dot on the rail for something they typed themselves a second ago.
    termsState.terms.push({ w: w, gloss: gloss, seen: true });
  } else {
    if (!termCardEditing) return;
    if (!gloss) { showToast(t('terms.add.needBoth')); return; }
    termCardEditing.t.gloss = gloss;
    // A word the reader has edited is theirs now, whatever it arrived as. Leaving `proposed` on it would keep
    // it drawn out at the edge, unconnected, as something still merely offered.
    delete termCardEditing.t.proposed;
  }
  closeTermCard();
  saveTerms();
  buildTermMap();
}

function onTermCardClick(event) {
  var close = event.target.closest && event.target.closest('.mc-term-close');
  if (close) { closeTermCard(); return; }
  var edit = event.target.closest && event.target.closest('.mc-term-edit');
  if (edit) { openTermEditor(termMap.pinned, false); return; }
  var save = event.target.closest && event.target.closest('.mc-term-save');
  if (save) { saveTermEditor(); return; }
  var cancel = event.target.closest && event.target.closest('.mc-term-cancel');
  if (cancel) { closeTermCard(); return; }
  var drop = event.target.closest && event.target.closest('.mc-term-drop');
  if (drop) { dropTerm(drop.dataset.drop); return; }
  var link = event.target.closest && event.target.closest('.mc-term-link');
  if (link) {
    var scoped = termMap.pinned && termMap.pinned.t.parent
      ? termNodeByKey(termMap.pinned.t.parent + '·' + link.dataset.w)
      : null;
    var next = scoped || termNodeByKey(link.dataset.w);
    if (next) openTermCard(next);
    return;
  }
  var code = event.target.closest && event.target.closest('.mc-term-code');
  if (code && code.dataset.at) {
    var parts = String(code.dataset.at).split(':');
    closeTermMap();
    // The floating terminal sits over exactly the place the file is about to open in — the same reason ⌘0/⌘1
    // put it away (closeTerminalForViewSwitch, 05-keymap.js). Going to a line and landing behind a terminal
    // is a navigation that looks like it did nothing.
    closeTerminalForViewSwitch();
    navigateToLine(parts[0], Number(parts[1]) || 1);
  }
}

function placeTermCard() {
  var card = document.getElementById('mc-term-card');
  var node = termMap.pinned;
  var stage = document.getElementById('mc-map-stage');
  if (!card || !node || !stage) return;
  var sw = stage.clientWidth, sh = stage.clientHeight;
  // offsetHeight alone is read mid-open-animation and comes back short, which is how the card ended up
  // clipped at the bottom of the window.
  var h = Math.min(340, Math.max(card.offsetHeight, card.scrollHeight));
  var w = card.offsetWidth || 300;
  var sx = termMap.tx + node.x * termMap.k;
  var sy = termMap.ty + node.y * termMap.k;
  var gap = node.r * termMap.k + 26;
  var top = sy + gap;
  if (top + h > sh - 12) top = sy - gap - h; // no room below: stand it above its own node instead
  card.style.left = Math.max(12, Math.min(sw - w - 12, sx - w / 2)) + 'px';
  card.style.top = Math.max(12, Math.min(sh - h - 12, top)) + 'px';
}

// Read means read: opening this word's own card, not opening the map. Written back straight away so the dot
// is gone the next time any window draws the rail.
function markTermSeen(term) {
  if (term.seen) return;
  term.seen = true;
  var el = termMap.pinned && termMap.pinned.el && termMap.pinned.el.querySelector('.mc-node-new');
  if (el) el.remove();
  saveTerms();
  syncTermsBadge();
}

// Registered in KEY_OWNERS (05-keymap.js): while the map is up it is the whole window, so Esc closes it and
// the zoom keys are its own.
function handleTermsKey(event) {
  // The harvest offer is dismissible from the keyboard, and Esc there means "no" — the same answer as its
  // own skip button, so the thread stays deleted and nothing is written.
  if (document.getElementById('mc-harvest') && event.key === 'Escape' && !inTextField()) {
    closeTermHarvest();
    event.preventDefault();
    return true;
  }
  if (!termMapOpen()) return false;
  if (event.key === 'Escape') {
    if (termMap.pinned) closeTermCard();
    else closeTermMap();
  } else if ((event.metaKey || event.ctrlKey) && (event.key === '0')) {
    fitTermMap();
  } else if ((event.metaKey || event.ctrlKey) && (event.key === '=' || event.key === '+' || event.key === '-')) {
    var next = event.key === '-' ? termMap.k / 1.2 : termMap.k * 1.2;
    termMap.k = Math.max(0.35, Math.min(2.6, next));
    applyTermMapTransform();
    placeTermCard();
  } else return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

window.addEventListener('resize', function () { if (termMapOpen()) { buildTermMap(); } });

// The unread dot has to be right before anyone opens the map, so the vocabulary is read once at boot. It is a
// small file beside the repository and nothing else in the review waits on it.
requestAnimationFrame(function () { loadTerms(); });

// ===== Harvest: pulling the concepts out of a conversation that is about to go ====================
// A thread is deleted when it has served its purpose, and everything the reader learned in it goes with it.
// So that is where the offer is made — after the delete (which is already undoable), never before it, so
// nothing has to wait on a dialog.
//
// The rules are the ones that keep the vocabulary the READER's:
//   - a word must appear in something the READER wrote. An agent answer alone is never knowledge; a reader
//     who did not read the answer must not end up with the answer's words as their own.
//   - and in an agent reply too, because that reply is where the one-line meaning comes from.
//   - and it must not look like code. An identifier is what a word turns out to BE in the code — the `code`
//     half of a record — never the word itself.
var TERM_JOSA = [
  '이라는', '라는', '으로는', '에서는', '에게는', '에서', '에게', '으로', '까지', '부터', '보다', '한테',
  '이란', '란', '는', '은', '을', '를', '이', '가', '의', '도', '만', '와', '과', '로', '에', '야', '나',
];
// Words that carry no concept: they are how a question is ASKED, not what it is about. Both languages are
// listed because both are review languages — a vocabulary that could only fill up in Korean would leave an
// English reviewer with an empty map forever, and every explanation written in words nobody chose.
var TERM_STOP = [
  '이거', '저거', '그거', '이게', '저게', '그게', '여기', '거기', '저기', '무슨', '무엇', '어떤', '어떻게',
  '왜냐', '지금', '다시', '그냥', '진짜', '정말', '조금', '이런', '저런', '그런', '경우', '때문', '부분',
  '하는', '되는', '있는', '없는', '같은', '자체', '전부', '모두', '항상', '먼저', '나중', '정도', '가지',
  '생각', '문제', '얘기', '이야기', '이유', '방법', '내용', '사용', '동작', '확인', '수정', '설명',
  // Generic programming nouns: alone they name the whole profession, not a concept of THIS repository —
  // a vocabulary entry for "함수" teaches nobody anything. Inside a spaced phrase they still count
  // ("핵심 파일" is a real word here): the stop check sees the full phrase, not its chunks.
  '함수', '코드', '파일', '에러', '버그', '로그', '테스트',
  'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which', 'when', 'where', 'why', 'how',
  'the', 'and', 'but', 'for', 'with', 'from', 'into', 'about', 'because', 'just', 'only', 'also', 'then',
  'does', 'doing', 'done', 'have', 'has', 'had', 'was', 'were', 'been', 'being', 'will', 'would', 'should',
  'thing', 'things', 'stuff', 'case', 'cases', 'part', 'parts', 'way', 'ways', 'time', 'times', 'point',
  'problem', 'reason', 'idea', 'code', 'line', 'lines', 'file', 'files', 'change', 'changes', 'work',
  'works', 'value', 'values', 'thanks', 'sure', 'okay', 'right', 'good', 'same', 'other', 'another',
];

function termStrip(word) {
  var out = String(word || '').replace(/^[^0-9A-Za-z가-힣]+|[^0-9A-Za-z가-힣]+$/g, '');
  for (var i = 0; i < TERM_JOSA.length; i++) {
    var j = TERM_JOSA[i];
    if (out.length > j.length + 1 && out.slice(-j.length) === j) return out.slice(0, -j.length);
  }
  return out;
}

// What a concept looks like in either language, and — more to the point — what an IDENTIFIER looks like, so
// that `loadSourceFile`, `terms_file`, `src/x.ts` and `foo()` never become words. Those belong in the `code`
// half of a record; the word itself is what a person says out loud.
function termLooksLikeConcept(word) {
  if (/[._/(){}[\]<>:;=]/.test(word)) return false; // a path, a call, an accessor
  if (/[a-z][A-Z]/.test(word)) return false;         // camelCase
  if (/[0-9]/.test(word) && !/[가-힣]/.test(word)) return false;
  if (TERM_STOP.indexOf(word.toLowerCase()) >= 0) return false;
  // Korean concepts are short — 앵커, 걷기 — so two syllables is a word. Latin needs three letters before it
  // is one, which also drops the "of/in/is" that survive any stopword list.
  if (/[가-힣]/.test(word)) return word.length >= 2 && word.length <= 16;
  if (!/^[A-Za-z][A-Za-z'\- ]*$/.test(word)) return false;
  return word.replace(/[^A-Za-z]/g, '').length >= 3 && word.length <= 24;
}

// One line, from the agent's own answer: the sentence the word was explained in. Not the answer — the
// sentence. Moving the whole reply in would make the vocabulary a copy of the conversation, and the point of
// a word is that it is shorter than the conversation that produced it.
function termGlossFor(word, replies) {
  for (var i = 0; i < replies.length; i++) {
    var sentences = String(replies[i].text || '').replace(/`+/g, '').split(/(?<=[.!?。])\s+|\n+/);
    for (var s = 0; s < sentences.length; s++) {
      var line = sentences[s].trim().replace(/^[-*#>\s]+/, '');
      if (line.length > 6 && line.length < 160 && line.indexOf(word) >= 0) return line;
    }
  }
  return '';
}

// What the word turns out to be in the code, taken from the same reply: a backticked name, and the path[:line]
// next to it if the agent gave one. `at` is a cache from the moment it is written — the name is the truth.
function termCodeFor(word, replies) {
  var code = [], seen = {};
  replies.forEach(function (r) {
    var text = String(r.text || '');
    (text.match(/`[^`\n]{2,60}`/g) || []).forEach(function (raw) {
      var name = raw.slice(1, -1).trim();
      if (!name || seen[name] || /\s{2,}/.test(name)) return;
      seen[name] = 1;
      var at = /^[\w./-]+\.[a-z]{1,4}(:\d+)?$/.test(name) ? name : '';
      code.push(at ? { name: name, at: at } : { name: name });
    });
    if (r.path && code.length && !code[0].at) code[0].at = r.line ? r.path + ':' + r.line : r.path;
  });
  return code.slice(0, 3);
}

// The candidates in one deleted thread. Everything about who owns a word is decided here.
function termCandidates(batch) {
  var mine = batch.filter(function (c) { return c.by !== 'agent'; });
  var replies = batch.filter(function (c) { return c.by === 'agent'; });
  if (!mine.length || !replies.length) return []; // an agent talking to itself teaches nobody anything
  var known = {};
  termsState.terms.forEach(function (term) { known[term.w] = 1; }); // a dropped word counts as known: it must not be offered again

  // Korean concepts are written with spaces in them — 지연 로딩, 핵심 파일, 지식 베이스 — so a splitter that
  // stops at whitespace can only ever return half of one. Runs of up to three neighbouring chunks are
  // considered, longest first, and the answer decides: a run the agent also wrote is a phrase, and one it
  // never wrote is two words that happened to sit next to each other.
  var said = replies.map(function (r) { return String(r.text || ''); }).join('\n');
  var counts = {}, order = [];
  mine.forEach(function (c) {
    var chunks = String(c.text || '').split(/[\s,()[\]{}"'“”‘’·…\/]+/);
    var takenTo = -1; // a chunk swallowed by a longer phrase must not come back as a word of its own
    for (var i = 0; i < chunks.length; i++) {
      if (i <= takenTo) continue;
      for (var span = Math.min(3, chunks.length - i); span >= 1; span--) {
        // Every chunk of a phrase except the last must be a BARE noun. A chunk still carrying its josa
        // ("캐시를 안") is syntax passing by, not a name — real spaced concepts are noun compounds: 지연
        // 로딩, 핵심 파일. And one hangul syllable ("이 함수", "안") is a determiner or an adverb, never
        // half a concept. The last chunk keeps its josa here; termStrip takes it off the phrase edge.
        if (span > 1) {
          var bareRun = true;
          for (var k = i; k < i + span - 1; k++) {
            var chunk = String(chunks[k] || '').replace(/^[^0-9A-Za-z가-힣]+|[^0-9A-Za-z가-힣]+$/g, '');
            if (termStrip(chunk) !== chunk || (/[가-힣]/.test(chunk) && chunk.length < 2)) { bareRun = false; break; }
          }
          if (!bareRun) continue;
        }
        var raw = chunks.slice(i, i + span).join(' ');
        var word = termStrip(raw);
        if (!termLooksLikeConcept(word) || known[word]) continue;
        // A single chunk is allowed to stand alone; a phrase has to have been used by the answer as well,
        // which is what tells "지연 로딩" from "그래서 로딩".
        if (span > 1 && said.indexOf(word) < 0) continue;
        if (!counts[word]) { counts[word] = 0; order.push(word); }
        counts[word] += 1;
        takenTo = i + span - 1;
        break;
      }
    }
  });

  var out = [];
  order.forEach(function (word) {
    var explained = replies.some(function (r) { return String(r.text || '').indexOf(word) >= 0; });
    if (!explained) return; // the reader used it, but nothing in the thread says what it means
    var gloss = termGlossFor(word, replies);
    if (!gloss) return;
    out.push({
      w: word,
      gloss: gloss,
      code: termCodeFor(word, replies),
      from: batch.map(function (c) { return c.seq; }).filter(function (n) { return isFinite(n); }),
    });
  });
  // Longer words are the more specific ones and the ones a reader actually chose; a two-syllable fragment of
  // one of them is usually the same idea, said shorter.
  return out.filter(function (cand) {
    return !out.some(function (other) { return other !== cand && other.w.indexOf(cand.w) >= 0; });
  }).slice(0, 6);
}

// Called from removeComments (07-comments.js) with the batch that was just removed. Nothing to extract means
// no dialog: a thread with nothing in it to learn should just be gone.
//
// Asking belongs to deleting and to nothing else: the conversation is about to stop existing, so this is the
// last moment anything in it can be kept. A reply mid-conversation is judged by the agent when the thread is
// handed back to it (see the bottom of this file) — a prompt on every reply would be a toll on talking.
function offerTermHarvest(batch) {
  if (!window.kakapoTerms || document.getElementById('mc-harvest')) return;
  var cands = termCandidates(batch || []);
  if (!cands.length) return;
  var box = document.createElement('div');
  box.className = 'mc-harvest';
  box.id = 'mc-harvest';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', t('terms.harvest.title'));
  box.innerHTML = '<div class="mc-harvest-h">' + escapeHtml(t('terms.harvest.title')) + '</div>'
    + '<p class="mc-harvest-p">' + escapeHtml(t('terms.harvest.body')) + '</p>'
    + '<div class="mc-harvest-list">' + cands.map(function (cand, i) {
      return '<label class="mc-harvest-row"><input type="checkbox" checked data-cand="' + i + '">'
        + '<span class="mc-harvest-w">' + escapeHtml(cand.w) + '</span>'
        + '<span class="mc-harvest-g">' + escapeHtml(cand.gloss) + '</span></label>';
    }).join('') + '</div>'
    + '<div class="mc-harvest-foot">'
    + '<button type="button" class="mc-harvest-skip" data-harvest="skip">' + escapeHtml(t('terms.harvest.skip')) + '</button>'
    + '<button type="button" class="mc-harvest-save" data-harvest="save">' + escapeHtml(t('terms.harvest.save')) + '</button>'
    + '</div>';
  box.addEventListener('click', function (event) {
    var btn = event.target.closest && event.target.closest('[data-harvest]');
    if (!btn) return;
    if (btn.dataset.harvest === 'save') {
      var picked = cands.filter(function (_, i) {
        var input = box.querySelector('[data-cand="' + i + '"]');
        return input && input.checked;
      });
      if (picked.length) {
        termsState.terms = termsState.terms.concat(picked.map(function (cand) {
          var term = { w: cand.w, gloss: cand.gloss, from: cand.from };
          if (cand.code && cand.code.length) term.code = cand.code;
          return term; // no `seen`: a word that has just arrived has not been read
        }));
        saveTerms();
        syncTermsBadge();
        noteTermWrite(); // new knowledge is when the code behind the old knowledge is most likely to have moved
        showToast(picked.length + ' · ' + t('terms.harvest.saved'));
      }
    }
    closeTermHarvest();
  });
  document.body.appendChild(box);
}

function closeTermHarvest() {
  var box = document.getElementById('mc-harvest');
  if (box) box.remove();
}

// ===== The address is a cache; the name is the truth ==============================================
// `at` says where a name was last seen. Line numbers rot on the next commit, so an address is never trusted
// on sight — it is CHECKED, and a check that finds the name somewhere else just rewrites the address. What is
// actually worth reporting is the other outcome: a name that is gone from the repository entirely, because
// then the word's meaning has drifted from the code and nobody would otherwise know.
//
// Checking is a ripgrep away (kakapoSearch), so "did it move within the file" and "did it move to another
// file" are the same question with the same answer, and neither needs the file read into the renderer.
var TERM_SWEEP_KEY = 'kakapo-terms-sweep';
var TERM_SWEEP_EVERY_KEY = 'kakapo-terms-sweep-every';
var TERM_SWEEP_CHOICES = [10, 30, 60, 0];

// persistRead only reads the Electron settings bridge, so a browser/static review would silently never read
// its own setting back. Same local fallback readExplainRuns uses (23-annotations.js).
function termSweepEvery() {
  var raw = persistRead(TERM_SWEEP_EVERY_KEY);
  if (raw == null) { try { raw = localStorage.getItem(TERM_SWEEP_EVERY_KEY); } catch (e) {} }
  var n = Number(raw);
  return isFinite(n) && n >= 0 ? n : 30;
}
function setTermSweepEvery(value) {
  persistSave(TERM_SWEEP_EVERY_KEY, String(value));
  try { localStorage.setItem(TERM_SWEEP_EVERY_KEY, String(value)); } catch (e) {}
}
function termSweepCount() {
  var raw = persistRead(TERM_SWEEP_KEY);
  if (raw == null) { try { raw = localStorage.getItem(TERM_SWEEP_KEY); } catch (e) {} }
  return Number(raw) || 0;
}
function setTermSweepCount(value) {
  persistSave(TERM_SWEEP_KEY, String(value));
  try { localStorage.setItem(TERM_SWEEP_KEY, String(value)); } catch (e) {}
}

function canVerifyTermCode() {
  return !!(window.kakapoSearch && typeof window.kakapoSearch.query === 'function');
}
function termSearchFirst(name) {
  return window.kakapoSearch.query({ query: name, limit: 3 }).then(function (result) {
    var hit = ((result && result.matches) || [])[0];
    if (!hit || !hit.path) return null;
    return hit.line ? hit.path + ':' + hit.line : hit.path;
  }, function () { return null; });
}

// One word. Returns true when something about it changed, so the caller knows whether to write the file back.
function verifyTermCode(term) {
  var code = term.code || [];
  // "I could not check" is not "it is gone". A browser or static review has no ripgrep behind it, and an
  // address struck off there would be a lie the file then carries into the app.
  if (!code.length || !canVerifyTermCode()) return Promise.resolve(false);
  return code.reduce(function (chain, entry) {
    return chain.then(function (changed) {
      return termSearchFirst(entry.name).then(function (found) {
        if (found === null) {
          entry.gone = true; // a search ran and came back empty — now "not found" is a thing we know
          if (!('at' in entry)) return changed;
          delete entry.at; // gone from the repository — the reader is told, the name is kept
          return true;
        }
        delete entry.gone;
        if (entry.at === found) return changed;
        entry.at = found; // moved: the address was the cache, so the cache is simply corrected
        return true;
      });
    });
  }, Promise.resolve(false));
}

// Every word, one after another rather than at once: this runs behind an open map and a burst of ripgreps is
// the one way it could be felt.
function sweepTermCode() {
  var terms = termsState.terms.slice();
  return terms.reduce(function (chain, term) {
    return chain.then(function (changed) {
      return verifyTermCode(term).then(function (hit) { return changed || hit; });
    });
  }, Promise.resolve(false)).then(function (changed) {
    setTermSweepCount(0);
    if (!changed) return false;
    saveTerms();
    if (termMapOpen() && termMap.pinned) openTermCard(termMap.pinned); // redraw the card it is under
    return true;
  });
}

// Called after every write to the vocabulary. A word arriving is exactly when the code it points at is most
// likely to have moved since the last time anyone looked, so the count is of WRITES, not of openings.
function noteTermWrite() {
  var every = termSweepEvery();
  if (!every) return;
  var next = termSweepCount() + 1;
  if (next < every) { setTermSweepCount(next); return; }
  sweepTermCode();
}

// ===== The other way in: the agent, when the conversation is handed back ==========================
// Deleting a thread asks the reader directly (offerTermHarvest above). The commoner moment — the reader
// answers an answer and moves on — is judged by the AGENT instead, in the hand-off document that already
// carries the conversation to it (mergePrompt.terms, 08-dock.js).
//
// It was a regex here first: "does this reply end in a question?" plus a stop-list, and it was wrong in both
// directions. "왜 그런지 알겠다" is understanding written with an interrogative in it; "그렇구나" is acknowledgement
// with no concept in it at all. Worse, the whole test was built out of Korean particles and
// Korean question words, so an English review could never have filled the vocabulary at all. Whether a reader
// took a concept in is a reading problem, and the agent is already reading the thread — including its own
// answer, which is the half that says what the word means.
//
// The rule that does not move: the words are still the READER's. The agent decides which of the words THEY
// used stuck; it never contributes one of its own.

// ── connecting the terminal's agent (Settings) ────────────────────────────────────────────────────
// One row per agent CLI found on this machine, each either connected or one click away. The click runs the
// CLI's own `mcp add`, because where that registration is stored is the CLI's business and has moved before.
function syncMcpAgents() {
  var host = document.getElementById('mcp-agents');
  if (!host || !window.kakapoMcp) return;
  window.kakapoMcp.status().then(function (list) {
    if (!Array.isArray(list) || !list.length) { host.innerHTML = ''; return; }
    host.innerHTML = list.map(function (row) {
      var state = !row.installed ? t('settings.mcp.missing') : (row.connected ? t('settings.mcp.connected') : '');
      return '<div class="mcp-agent' + (row.connected ? ' is-on' : '') + '">'
        + '<span class="mcp-agent-name">' + escapeHtml(row.agent) + '</span>'
        + '<span class="mcp-agent-state">' + escapeHtml(state) + '</span>'
        + (row.installed && !row.connected
          ? '<button type="button" class="plain-button" data-mcp="' + escapeHtml(row.agent) + '">' + escapeHtml(t('settings.mcp.connect')) + '</button>'
          : '')
        + '</div>';
    }).join('');
  }, function () {});
}

document.addEventListener('click', function (event) {
  var btn = event.target.closest && event.target.closest('[data-mcp]');
  if (!btn || !window.kakapoMcp) return;
  btn.disabled = true;
  window.kakapoMcp.connect(btn.dataset.mcp).then(function (result) {
    showToast(result && result.ok ? t('settings.mcp.connected') : ((result && result.message) || 'failed'));
    syncMcpAgents();
  }, function () { btn.disabled = false; });
});

// The sweep-interval row in Settings. Registered at the END of this slice, not beside the other selects in
// 08-dock.js and not in the middle of this file, because setupCustomSelect RENDERS ON THE SPOT: it calls the
// options function immediately, and that reads TERM_SWEEP_CHOICES.
//
// Half of that was already known — the row was moved out of 08-dock.js for exactly this reason — and the
// same trap was walked into thirty lines later inside this file, where TERM_SWEEP_CHOICES is declared some
// two hundred lines BELOW the call. A `var` read before its assignment is undefined rather than missing, so
// this threw at load and took every statement after it with it: the rest of this slice, and then every slice
// added after it (27-ask.js, which is how kakapo's own agent came to be wired up correctly and never run).
//
// Nothing in the bundle catches this: the DOM fixtures render a review, not the Settings panel, so
// setupCustomSelect returns early there and the options function is never called. It shows up only in the
// real app. The rule is therefore about placement — a registration that runs at load goes after the values
// it reads, and the safe place for that is the bottom of the file.
termsSweepSelectRef = setupCustomSelect('settings-terms-sweep',
  function () {
    return TERM_SWEEP_CHOICES.map(function (v) {
      return {
        value: String(v),
        label: v ? t('settings.termsSweep.every').split('{n}').join(String(v)) : t('settings.termsSweep.never'),
      };
    });
  },
  function () { return String(termSweepEvery()); },
  function (next) { setTermSweepEvery(Number(next)); });
