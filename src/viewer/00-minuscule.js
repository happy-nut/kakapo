

function minusculeIsUpper(ch) {
  if (ch >= 'A' && ch <= 'Z') return true;
  if (ch < '\u0080') return false;
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}
function minusculeIsLower(ch) {
  if (ch >= 'a' && ch <= 'z') return true;
  if (ch < '\u0080') return false;
  return ch !== ch.toUpperCase() && ch === ch.toLowerCase();
}
function minusculeIsDigit(ch) { return ch >= '0' && ch <= '9'; }
var MINUSCULE_LETTER = /\p{L}/u;
var MINUSCULE_IDEOGRAPHIC = /\p{Ideographic}/u;
function minusculeIsLetter(ch) {
  if (ch < '\u0080') return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  return MINUSCULE_LETTER.test(ch);
}
function minusculeIsLetterOrDigit(ch) { return minusculeIsDigit(ch) || minusculeIsLetter(ch); }

function minusculeMaybeKana(code) {
  return (code >= 0x3040 && code <= 0x3358) || (code >= 0xff66 && code <= 0xff9d);
}
var MINUSCULE_KATAKANA = /\p{Script=Katakana}/u;
var MINUSCULE_HIRAGANA = /\p{Script=Hiragana}/u;
var MINUSCULE_COMMON = /\p{Script=Common}/u;
function minusculeIsKanaBreak(cur, prev) {
  if (!minusculeMaybeKana(cur.codePointAt(0)) && (!prev || !minusculeMaybeKana(prev.codePointAt(0)))) return false;
  if (!prev) return false;
  var curKana = MINUSCULE_KATAKANA.test(cur) ? 'k' : MINUSCULE_HIRAGANA.test(cur) ? 'h' : '';
  var prevKana = MINUSCULE_KATAKANA.test(prev) ? 'k' : MINUSCULE_HIRAGANA.test(prev) ? 'h' : '';
  if (curKana === prevKana && curKana !== '') return false;
  if (!curKana && !prevKana) return false;
  return !MINUSCULE_COMMON.test(cur) && !MINUSCULE_COMMON.test(prev);
}

function minusculeIsHardCodedWordStart(text, i) {
  return text.charAt(i) === 'l' && i < text.length - 1 && text.charAt(i + 1) === 'n'
    && (text.length === i + 2 || nameUtilIsWordStart(text, i + 2));
}

function nameUtilIsWordStart(text, i) {
  var cur = text.charAt(i);
  var prev = i > 0 ? text.charAt(i - 1) : '';
  if (minusculeIsUpper(cur)) {
    if (!prev || !minusculeIsUpper(prev)) return true;
    var nextPos = i + 1;
    return nextPos < text.length && minusculeIsLower(text.charAt(nextPos));
  }
  if (minusculeIsDigit(cur)) return true;
  if (!minusculeIsLetter(cur)) return false;
  if (cur >= '\u0080' && MINUSCULE_IDEOGRAPHIC.test(cur)) return true;
  return i === 0 || !minusculeIsLetterOrDigit(prev) || minusculeIsHardCodedWordStart(text, i)
    || minusculeIsKanaBreak(cur, prev);
}

function nameUtilNextWord(text, start) {
  var ch = text.charAt(start);
  if (!minusculeIsLetterOrDigit(ch)) return start + 1;
  var i = start;
  while (i < text.length && minusculeIsDigit(text.charAt(i))) i += 1;
  if (i > start) return i;
  while (i < text.length && minusculeIsUpper(text.charAt(i))) i += 1;
  if (i > start + 1) {
    return i !== text.length && minusculeIsLetter(text.charAt(i)) ? i - 1 : i;
  }
  if (i === start) i += 1;
  while (i < text.length) {
    var c = text.charAt(i);
    if (!minusculeIsLetter(c) || nameUtilIsWordStart(text, i)) break;
    i += 1;
  }
  return i;
}

function minusculeIsWildcardChar(ch) { return ch === ' ' || ch === '*'; }
function minusculeIsWordSeparatorChar(ch) {
  return /\s/.test(ch) || ch === '_' || ch === '-' || ch === ':' || ch === '+' || ch === '.';
}

var MINUSCULE_CACHE = new Map();
var MINUSCULE_CACHE_LIMIT = 64;

function minusculeMatcher(pattern) {
  var hit = MINUSCULE_CACHE.get(pattern);
  if (hit) return hit;
  var made = buildMinusculeMatcher(pattern);
  if (MINUSCULE_CACHE.size >= MINUSCULE_CACHE_LIMIT) MINUSCULE_CACHE.clear();
  MINUSCULE_CACHE.set(pattern, made);
  return made;
}

function buildMinusculeMatcher(rawPattern) {
  var raw = String(rawPattern == null ? '' : rawPattern);
  var pattern = raw.endsWith('* ') ? raw.slice(0, -2) : raw;
  var chars = Array.from(pattern);
  var isLowerCase = [];
  var isUpperCase = [];
  var isWordSeparator = [];
  var toUpperCase = [];
  var toLowerCase = [];
  var meaningful = '';
  for (var k = 0; k < chars.length; k += 1) {
    var c = chars[k];
    isLowerCase[k] = minusculeIsLower(c);
    isUpperCase[k] = minusculeIsUpper(c);
    isWordSeparator[k] = minusculeIsWordSeparatorChar(c);
    toUpperCase[k] = c.toUpperCase();
    toLowerCase[k] = c.toLowerCase();
    if (!minusculeIsWildcardChar(c)) meaningful += toLowerCase[k] + toUpperCase[k];
  }
  var firstMeaningful = 0;
  while (firstMeaningful < chars.length && minusculeIsWildcardChar(chars[firstMeaningful])) firstMeaningful += 1;
  var hasFlag = function (start, flags) {
    for (var i = start; i < chars.length; i += 1) if (flags[i]) return true;
    return false;
  };
  var hasHumps = hasFlag(firstMeaningful + 1, isUpperCase) && hasFlag(firstMeaningful, isLowerCase);
  var hasSeparators = hasFlag(firstMeaningful, isWordSeparator);
  var hasDots = chars.indexOf('.', firstMeaningful) >= 0;

  var self = {
    pattern: pattern,
    chars: chars,
    isLowerCase: isLowerCase,
    isUpperCase: isUpperCase,
    isWordSeparator: isWordSeparator,
    hasHumps: hasHumps,
    hasSeparators: hasSeparators,
    hasDots: hasDots,
    meaningful: meaningful,
  };
  self.fragments = function (name) { return minusculeFragments(self, String(name == null ? '' : name)); };
  self.degree = function (name, fragments, valueStartCaseMatch) {
    return minusculeDegree(self, String(name == null ? '' : name),
      fragments === undefined ? self.fragments(name) : fragments, valueStartCaseMatch === true);
  };
  self.matches = function (name) { return self.fragments(name) !== null; };
  return self;
}

function minusculePrepend(ranges, from, length) {
  var head = ranges.length ? ranges[0] : null;
  if (head && head.start === from + length) {
    return [{ start: from, end: head.end }].concat(ranges.slice(1));
  }
  return [{ start: from, end: from + length }].concat(ranges);
}

function minusculeIsWildcard(m, i) { return i >= 0 && i < m.chars.length && minusculeIsWildcardChar(m.chars[i]); }
function minusculeIsPatternChar(m, i, ch) { return i >= 0 && i < m.chars.length && m.chars[i] === ch; }
function minusculeIsTrailingSpacePattern(m) { return minusculeIsPatternChar(m, m.chars.length - 1, ' '); }
function minusculeIsUpperCaseOrDigit(ch) { return minusculeIsUpper(ch) || minusculeIsDigit(ch); }

function minusculeFragments(m, name) {
  if (!m.chars.length) return [];
  if (name.length < m.meaningful.length / 2) return null;
  if (m.chars.length > 100) return minusculeMatchBySubstring(m, name);
  var meaningful = m.meaningful;
  var patternIndex = 0;
  for (var i = 0; i < name.length && patternIndex < meaningful.length; i += 1) {
    var c = name.charAt(i);
    if (c === meaningful.charAt(patternIndex) || c === meaningful.charAt(patternIndex + 1)) patternIndex += 2;
  }
  if (patternIndex < meaningful.length) return null;
  return minusculeMatchWildcards(m, name, 0, 0);
}

function minusculeMatchBySubstring(m, name) {
  var infix = minusculeIsPatternChar(m, 0, '*');
  var bare = m.chars.filter(function (c) { return c !== '*'; }).join('');
  if (name.length < bare.length) return null;
  if (infix) {
    var index = name.toLowerCase().indexOf(bare.toLowerCase());
    return index >= 0 ? [{ start: index, end: index + bare.length - 1 }] : null;
  }
  return name.startsWith(bare) ? [{ start: 0, end: bare.length }] : null;
}

function minusculeMatchWildcards(m, name, patternIndex, nameIndex) {
  if (nameIndex < 0) return null;
  if (!minusculeIsWildcard(m, patternIndex)) {
    return patternIndex === m.chars.length ? [] : minusculeMatchFragment(m, name, patternIndex, nameIndex);
  }
  do { patternIndex += 1; } while (minusculeIsWildcard(m, patternIndex));
  if (patternIndex !== m.chars.length) {
    return minusculeMatchSkippingWords(m, name, patternIndex,
      minusculeNextPatternCharOccurrence(m, name, nameIndex, patternIndex), true);
  }
  if (minusculeIsTrailingSpacePattern(m) && nameIndex !== name.length
    && (patternIndex < 2 || !minusculeIsUpperCaseOrDigit(m.chars[patternIndex - 2]))) {
    var spaceIndex = name.indexOf(' ', nameIndex);
    return spaceIndex >= 0 ? [{ start: spaceIndex, end: spaceIndex + 1 }] : null;
  }
  return [];
}

function minusculeNextPatternCharOccurrence(m, name, startAt, patternIndex) {
  return !minusculeIsPatternChar(m, patternIndex - 1, '*') && !m.isWordSeparator[patternIndex]
    ? minusculeIndexOfWordStart(m, name, patternIndex, startAt)
    : minusculeIndexOfIgnoreCase(m, name, startAt, patternIndex);
}

function minusculeCheckForSpecialChars(m, name, start, end, patternIndex) {
  if (end < 0) return -1;
  if (!m.hasSeparators && !m.hasHumps && name.slice(start, end).indexOf('/') >= 0) return -1;
  if (m.hasDots && !minusculeIsPatternChar(m, patternIndex - 1, '.') && name.slice(start, end).indexOf('.') >= 0) return -1;
  return end;
}

function minusculeSeemsLikeFragmentStart(m, name, patternIndex, nextOccurrence) {
  return !m.isUpperCase[patternIndex] || minusculeIsUpper(name.charAt(nextOccurrence))
    || nameUtilIsWordStart(name, nextOccurrence) || !m.hasHumps;
}

function minusculeMatchSkippingWords(m, name, patternIndex, startIndex, allowSpecialChars) {
  var nameIndex = startIndex;
  var maxFoundLength = 0;
  while (nameIndex >= 0) {
    var fragmentLength = minusculeSeemsLikeFragmentStart(m, name, patternIndex, nameIndex)
      ? minusculeMaxMatchingFragment(m, name, patternIndex, nameIndex) : 0;
    if (fragmentLength > maxFoundLength
      || (nameIndex + fragmentLength === name.length && minusculeIsTrailingSpacePattern(m))) {
      if (!minusculeIsMiddleMatch(m, name, patternIndex, nameIndex)) maxFoundLength = fragmentLength;
      var ranges = minusculeMatchInsideFragment(m, name, patternIndex, nameIndex, fragmentLength);
      if (ranges !== null) return ranges;
    }
    var next = minusculeNextPatternCharOccurrence(m, name, nameIndex + 1, patternIndex);
    nameIndex = allowSpecialChars ? next : minusculeCheckForSpecialChars(m, name, nameIndex + 1, next, patternIndex);
  }
  return null;
}

function minusculeMatchFragment(m, name, patternIndex, nameIndex) {
  var fragmentLength = minusculeMaxMatchingFragment(m, name, patternIndex, nameIndex);
  return fragmentLength === 0 ? null : minusculeMatchInsideFragment(m, name, patternIndex, nameIndex, fragmentLength);
}

function minusculeMaxMatchingFragment(m, name, patternIndex, nameIndex) {
  if (!minusculeIsFirstCharMatching(m, name, nameIndex, patternIndex)) return 0;
  var i = 1;
  while (nameIndex + i < name.length && patternIndex + i < m.chars.length) {
    var nameChar = name.charAt(nameIndex + i);
    if (!minusculeMatchesAt(m, patternIndex + i, nameChar)) {
      if (minusculeIsDigit(m.chars[patternIndex + i]) && minusculeIsDigit(m.chars[patternIndex + i - 1])
        && minusculeIsDigit(nameChar)) return 0;
      break;
    }
    i += 1;
  }
  return i;
}

function minusculeMatchesAt(m, patternIndex, c) {
  var p = m.chars[patternIndex];
  return p === c || p.toLowerCase() === c || p.toUpperCase() === c;
}

function minusculeIsFirstCharMatching(m, name, nameIndex, patternIndex) {
  if (nameIndex >= name.length) return false;
  return minusculeMatchesAt(m, patternIndex, name.charAt(nameIndex));
}

function minusculeIsMiddleMatch(m, name, patternIndex, nameIndex) {
  return minusculeIsPatternChar(m, patternIndex - 1, '*') && !minusculeIsWildcard(m, patternIndex + 1)
    && minusculeIsLetterOrDigit(name.charAt(nameIndex)) && !nameUtilIsWordStart(name, nameIndex);
}

function minusculeMatchInsideFragment(m, name, patternIndex, nameIndex, fragmentLength) {
  var minFragment = minusculeIsMiddleMatch(m, name, patternIndex, nameIndex) ? 3 : 1;
  var camel = minusculeImproveCamelHumps(m, name, patternIndex, nameIndex, fragmentLength, minFragment);
  return camel !== null ? camel
    : minusculeFindLongestMatchingPrefix(m, name, patternIndex, nameIndex, fragmentLength, minFragment);
}

function minusculeFindLongestMatchingPrefix(m, name, patternIndex, nameIndex, fragmentLength, minFragment) {
  if (patternIndex + fragmentLength >= m.chars.length) {
    return [{ start: nameIndex, end: nameIndex + fragmentLength }];
  }
  for (var i = fragmentLength; i >= minFragment || (i > 0 && minusculeIsWildcard(m, patternIndex + i)); i -= 1) {
    var ranges;
    if (minusculeIsWildcard(m, patternIndex + i)) {
      ranges = minusculeMatchWildcards(m, name, patternIndex + i, nameIndex + i);
    } else {
      var nextOccurrence = minusculeNextPatternCharOccurrence(m, name, nameIndex + i + 1, patternIndex + i);
      nextOccurrence = minusculeCheckForSpecialChars(m, name, nameIndex + i, nextOccurrence, patternIndex + i);
      ranges = nextOccurrence >= 0
        ? minusculeMatchSkippingWords(m, name, patternIndex + i, nextOccurrence, false) : null;
    }
    if (ranges !== null) return minusculePrepend(ranges, nameIndex, i);
  }
  return null;
}

function minusculeImproveCamelHumps(m, name, patternIndex, nameIndex, maxFragment, minFragment) {
  for (var i = minFragment; i < maxFragment; i += 1) {
    if (m.isUpperCase[patternIndex + i] && m.chars[patternIndex + i] !== name.charAt(nameIndex + i)) {
      var nextWordStart = minusculeIndexOfWordStart(m, name, patternIndex + i, nameIndex + i);
      var ranges = minusculeMatchWildcards(m, name, patternIndex + i, nextWordStart);
      if (ranges !== null) return minusculePrepend(ranges, nameIndex, i);
    }
  }
  return null;
}

function minusculeIndexOfWordStart(m, name, patternIndex, startFrom) {
  var p = m.chars[patternIndex];
  if (startFrom >= name.length) return -1;
  if (m.hasHumps && m.isLowerCase[patternIndex] && !(patternIndex > 0 && m.isWordSeparator[patternIndex - 1])) return -1;
  var isSpecialSymbol = !minusculeIsLetterOrDigit(p);
  var i = startFrom;
  for (;;) {
    i = minusculeIndexOfIgnoreCase(m, name, i, patternIndex);
    if (i < 0) return -1;
    if (isSpecialSymbol || nameUtilIsWordStart(name, i)) return i;
    i += 1;
  }
}

function minusculeIndexOfIgnoreCase(m, name, fromIndex, patternIndex) {
  var upper = m.chars[patternIndex].toUpperCase();
  var lower = m.chars[patternIndex].toLowerCase();
  for (var i = Math.max(0, fromIndex); i < name.length; i += 1) {
    var c = name.charAt(i);
    if (c === upper || c === lower) return i;
  }
  return -1;
}

function minusculeNextWord(name, start) {
  return start < name.length && minusculeIsDigit(name.charAt(start)) ? start + 1 : nameUtilNextWord(name, start);
}

function minusculeDegree(m, name, fragments, valueStartCaseMatch) {
  if (fragments === null) return -Infinity;
  if (!fragments.length) return 0;
  var first = fragments[0];
  var startMatch = first.start === 0;
  var valuedStartMatch = startMatch && valueStartCaseMatch === true;
  var matchingCase = 0;
  var p = -1;
  var skippedHumps = 0;
  var nextHumpStart = 0;
  var humpStartMatchedUpperCase = false;

  for (var r = 0; r < fragments.length; r += 1) {
    var range = fragments[r];
    for (var i = range.start; i < range.end; i += 1) {
      var afterGap = i === range.start && r !== 0;
      var isHumpStart = false;
      while (nextHumpStart <= i) {
        if (nextHumpStart === i) isHumpStart = true;
        else if (afterGap) skippedHumps += 1;
        var advanced = minusculeNextWord(name, nextHumpStart);
        nextHumpStart = advanced > nextHumpStart ? advanced : nextHumpStart + 1;
      }
      var c = name.charAt(i);
      p = minusculeIndexOfPatternChar(m, c, p + 1);
      if (p < 0) break;
      if (isHumpStart) humpStartMatchedUpperCase = c === m.chars[p] && m.isUpperCase[p];
      matchingCase += minusculeEvaluateCaseMatching(m, valuedStartMatch, p, humpStartMatchedUpperCase, i, afterGap, isHumpStart, c);
    }
  }

  var startIndex = first.start;
  var afterSeparator = false;
  var wordStart = startIndex === 0
    || (nameUtilIsWordStart(name, startIndex) && !nameUtilIsWordStart(name, startIndex - 1));
  var finalMatch = fragments[fragments.length - 1].end === name.length;
  return (wordStart ? 1000 : 0) + matchingCase - fragments.length + (-skippedHumps * 10)
    + (afterSeparator ? 0 : 2) + (startMatch ? 1 : 0) + (finalMatch ? 1 : 0);
}

function minusculeIndexOfPatternChar(m, c, from) {
  var lower = c.toLowerCase();
  for (var i = Math.max(0, from); i < m.chars.length; i += 1) {
    if (m.chars[i] === c || m.chars[i].toLowerCase() === lower) return i;
  }
  return -1;
}

var QUERY_MATCHER_CACHE = new Map();
function queryMatcher(variant) {
  var text = String(variant == null ? '' : variant);
  var hit = QUERY_MATCHER_CACHE.get(text);
  if (hit) return hit;
  var made = minusculeMatcher(text.charAt(0) === '*' ? text : '*' + text);
  if (QUERY_MATCHER_CACHE.size >= MINUSCULE_CACHE_LIMIT) QUERY_MATCHER_CACHE.clear();
  QUERY_MATCHER_CACHE.set(text, made);
  return made;
}

var MINUSCULE_FIELD_PENALTY = 1200;

function minusculeQueryScore(fields, queries) {
  var list = Array.isArray(fields) ? fields : [fields];
  var best = -Infinity;
  for (var q = 0; q < queries.length; q += 1) {
    var m = queryMatcher(queries[q]);
    var penalty = 0;
    var seen = '';
    for (var f = 0; f < list.length; f += 1) {
      var text = String(list[f] == null ? '' : list[f]);
      if (text && text !== seen) {
        var fragments = m.fragments(text);
        if (fragments !== null) {
          var degree = m.degree(text, fragments) - penalty;
          if (degree > best) best = degree;
          break;
        }
        seen = text;
      }
      penalty += MINUSCULE_FIELD_PENALTY;
    }
  }
  return best;
}

function minusculeMatchesQuery(fields, queries) {
  return minusculeQueryScore(fields, queries) > -Infinity;
}

function minusculeQueryRanges(text, queries) {
  var subject = String(text == null ? '' : text);
  if (!subject) return [];
  var best = null;
  var bestDegree = -Infinity;
  for (var i = 0; i < queries.length; i += 1) {
    var m = queryMatcher(queries[i]);
    var fragments = m.fragments(subject);
    if (fragments === null || !fragments.length) continue;
    var degree = m.degree(subject, fragments);
    if (degree > bestDegree) { bestDegree = degree; best = fragments; }
  }
  return best || [];
}

function minusculeEvaluateCaseMatching(m, valuedStartMatch, patternIndex, humpStartMatchedUpperCase, nameIndex, afterGap, isHumpStart, nameChar) {
  if (afterGap && isHumpStart && m.isLowerCase[patternIndex]) return -10;
  if (nameChar === m.chars[patternIndex]) {
    if (m.isUpperCase[patternIndex]) return 50;
    if (nameIndex === 0 && valuedStartMatch) return 150;
    if (isHumpStart) return 1;
  } else {
    if (isHumpStart) return -1;
    if (m.isLowerCase[patternIndex] && humpStartMatchedUpperCase) return -1;
  }
  return 0;
}
