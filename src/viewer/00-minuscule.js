// ===== IntelliJ's name matcher ===================================================================
// How a typed query matches a name. Until this file the answer was `haystack.includes(query)`, so
// `SEC` found nothing and `qop` did not find `quick-open.js` — the one navigation gesture every
// IntelliJ user has in their hands, and the one this app's search box could not answer.
//
// This is MinusculeMatcherImpl + NameUtilCore, read off the shipped IDE (lib/app-client.jar and
// lib/util-8.jar, decompiled with the IDE's own FernFlower). The class each part comes from is named
// where it is written, because the point of reading them was to stop guessing: a fuzzy matcher is easy
// to write and almost impossible to write so that it ranks the way a reader expects.
//
// Two things are deliberately NOT here. The typo-tolerant matcher (TypoTolerantMatcher) and the Pinyin
// one are separate matchers IntelliJ layers on top for other alphabets, and this app already answers
// the equivalent question its own way — queryVariants() tries the Latin keys that typed a Hangul query,
// which is what FixingLayoutMatcher does there. MatchingCaseSensitivity is fixed at NONE, the setting
// Search Everywhere itself uses.

// ---- NameUtilCore -------------------------------------------------------------------------------
// Where the humps are. `isWordStart` is the whole camel-hump rule and everything else reads it.

// ASCII first, in every one of these. Measured, not assumed: these four run per character inside
// nameUtilIsWordStart, which runs per character inside indexOfWordStart's loop, so a `toLowerCase()`
// allocating a string each time was most of the matcher's cost — filtering 6,000 paths went from 96 ms
// a keystroke to single digits with nothing else changed. IntelliJ carries an `isAsciiName` flag
// through the same functions for the same reason.
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
// `isLetterOrDigit` in Java terms: a letter in ANY script, or a digit. A JS `\w` would answer "no" to
// every Hangul, Han and accented character, which would make every such name one undivided word.
var MINUSCULE_LETTER = /\p{L}/u;
var MINUSCULE_IDEOGRAPHIC = /\p{Ideographic}/u;
function minusculeIsLetter(ch) {
  if (ch < '\u0080') return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  return MINUSCULE_LETTER.test(ch);
}
function minusculeIsLetterOrDigit(ch) { return minusculeIsDigit(ch) || minusculeIsLetter(ch); }

// Kana runs break into words where the script changes — NameUtilCore.isKanaBreak. Hangul, Han and the
// Latin alphabet are not kana, so for them this is always false and costs one range test.
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

// `ln` is a word start after a letter. IntelliJ hard-codes exactly this one pair
// (NameUtilCore.isHardCodedWordStart) and nothing else, so it is copied rather than generalised.
function minusculeIsHardCodedWordStart(text, i) {
  return text.charAt(i) === 'l' && i < text.length - 1 && text.charAt(i + 1) === 'n'
    && (text.length === i + 2 || nameUtilIsWordStart(text, i + 2));
}

/**
 * Does a word begin at `i` — NameUtilCore.isWordStart, verbatim.
 *
 * The clause worth reading twice is the one for an upper-case char after another upper-case char: it is
 * a word start only when a LOWER-case char follows. That is what makes `URLLoader` three words
 * (`URL`, `Loader`) rather than nine, and it is why `URL` typed against `URLLoader` is a hump match
 * while `RLL` is not.
 */
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

/** Where the word containing `start` ends — NameUtilCore.nextWord, verbatim. */
function nameUtilNextWord(text, start) {
  var ch = text.charAt(start);
  if (!minusculeIsLetterOrDigit(ch)) return start + 1;
  var i = start;
  while (i < text.length && minusculeIsDigit(text.charAt(i))) i += 1;
  if (i > start) return i;
  while (i < text.length && minusculeIsUpper(text.charAt(i))) i += 1;
  if (i > start + 1) {
    // A run of capitals that runs into a lower-case letter gives that letter's capital back to the
    // NEXT word: `URLLoader` is `URL` + `Loader`, not `URLL` + `oader`.
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

// ---- MinusculeMatcherImpl -----------------------------------------------------------------------
// A compiled pattern. Built once per query string and reused across every candidate, which is the
// reason it is an object at all: the per-character case tables below are what the inner loops read,
// and recomputing them for each of several thousand names is the whole cost of the matcher.

// ' ' and '*' are both wildcards in a pattern. A space is how IntelliJ spells "then, later, another
// word" (`se cont`), and that is why a space does not simply split the query into two searches.
function minusculeIsWildcardChar(ch) { return ch === ' ' || ch === '*'; }
// MinusculeMatcherImpl.isWordSeparator — which pattern characters are allowed to match anywhere rather
// than only at a word start.
function minusculeIsWordSeparatorChar(ch) {
  return /\s/.test(ch) || ch === '_' || ch === '-' || ch === ':' || ch === '+' || ch === '.';
}

var MINUSCULE_CACHE = new Map();
var MINUSCULE_CACHE_LIMIT = 64;

/**
 * Compile `pattern` into a matcher, memoised.
 *
 * Memoised because every list in this app filters a few thousand candidates against ONE query per
 * keystroke; without the cache the tables below are rebuilt per candidate.
 */
function minusculeMatcher(pattern) {
  var hit = MINUSCULE_CACHE.get(pattern);
  if (hit) return hit;
  var made = buildMinusculeMatcher(pattern);
  // A plain cap rather than an LRU: the keys are the prefixes of what someone is typing, so the set is
  // naturally small and short-lived, and an eviction policy would be machinery for nothing.
  if (MINUSCULE_CACHE.size >= MINUSCULE_CACHE_LIMIT) MINUSCULE_CACHE.clear();
  MINUSCULE_CACHE.set(pattern, made);
  return made;
}

function buildMinusculeMatcher(rawPattern) {
  // `Strings.trimEnd(pattern, "* ")` — and that is the two-character suffix "* ", once, not a set of
  // characters to strip. Read carefully, because the difference is a whole feature: a pattern may end in
  // a bare space and that space MEANS something (minusculeIsTrailingSpacePattern). Stripping trailing
  // spaces as a class would silently delete it and make the two branches that read it look like dead
  // code.
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
  // `myHasHumps` decides whether a LOWER-case pattern char may match in the middle of a word. With
  // humps in the pattern it may not — that is what makes `SEC` mean three humps rather than "those
  // three letters anywhere".
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
  // `valueStartCaseMatch` defaults to FALSE, as MinusculeMatcher.matchingDegree(name) does. Worth
  // stating because the obvious guess is the other way: it is the flag that turns a first-character
  // match from +1 into +150, and setting it swamps the hump bonuses it is supposed to sit beside.
  // Different IntelliJ call sites choose; this app uses the plain default everywhere.
  self.degree = function (name, fragments, valueStartCaseMatch) {
    return minusculeDegree(self, String(name == null ? '' : name),
      fragments === undefined ? self.fragments(name) : fragments, valueStartCaseMatch === true);
  };
  self.matches = function (name) { return self.fragments(name) !== null; };
  return self;
}

// A fragment list is a plain array of {start, end} in name coordinates, ascending and non-touching —
// IntelliJ's FList<TextRange> with prependRange's merge of adjacent ranges.
function minusculePrepend(ranges, from, length) {
  var head = ranges.length ? ranges[0] : null;
  if (head && head.start === from + length) {
    return [{ start: from, end: head.end }].concat(ranges.slice(1));
  }
  return [{ start: from, end: from + length }].concat(ranges);
}

function minusculeIsWildcard(m, i) { return i >= 0 && i < m.chars.length && minusculeIsWildcardChar(m.chars[i]); }
function minusculeIsPatternChar(m, i, ch) { return i >= 0 && i < m.chars.length && m.chars[i] === ch; }
// A pattern ending in a space asks for a name whose word ENDS there: `get ` finds `getName` but not
// `getter`. Live because the constructor only trims the two-character suffix "* " — see the note there.
function minusculeIsTrailingSpacePattern(m) { return minusculeIsPatternChar(m, m.chars.length - 1, ' '); }
function minusculeIsUpperCaseOrDigit(ch) { return minusculeIsUpper(ch) || minusculeIsDigit(ch); }

/**
 * The matched ranges, or null when the pattern does not match at all.
 *
 * The cheap pre-pass is IntelliJ's and it earns its place: before any backtracking, walk the name once
 * and check that the pattern's characters appear in order at all. Nearly every candidate in a list
 * fails here, so the recursive matcher below only ever runs on plausible names.
 */
function minusculeFragments(m, name) {
  if (!m.chars.length) return [];
  // Two bails IntelliJ takes before the backtracker, both worth keeping: a name shorter than the
  // pattern's meaningful characters cannot match, and a pattern over 100 characters long (someone
  // pasted something) degrades to a plain substring test rather than backtracking over it.
  if (name.length < m.meaningful.length / 2) return null;   // myMinNameLength
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

// MinusculeMatcherImpl.matchBySubstring — the long-pattern escape hatch.
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
  // The pattern ran out on a trailing space: the name has to have a space left in it for the word to
  // end at. The upper-case/digit exception is IntelliJ's — after `getF ` the space is the wildcard that
  // separates humps, not an end-of-word request.
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

// Where a '.' or a hard separator in the NAME stops the search. Without this, `foo` would match across
// a dot in `a.foo` for a pattern that never mentioned one.
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

// How many pattern chars run on matching from here. Case-insensitive, because the matcher is built with
// MatchingCaseSensitivity.NONE — case is not a filter here, it is a SCORE (see minusculeDegree).
function minusculeMaxMatchingFragment(m, name, patternIndex, nameIndex) {
  if (!minusculeIsFirstCharMatching(m, name, nameIndex, patternIndex)) return 0;
  var i = 1;
  while (nameIndex + i < name.length && patternIndex + i < m.chars.length) {
    var nameChar = name.charAt(nameIndex + i);
    if (!minusculeMatchesAt(m, patternIndex + i, nameChar)) {
      // Two pattern digits in a row may not skip a name digit: `x1` must not match `x21`.
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

// A match that starts inside a word rather than at its start, reached through a '*'. Such a match has
// to be at least 3 characters long (minFragment below) — otherwise `*a` would light up every name.
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

// The step that makes `SEC` beat a plain subsequence search: where an upper-case pattern char does not
// match the name char here, jump to the next WORD START and try there.
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
  // The guard that gives a humped pattern its meaning: with humps in the pattern, a LOWER-case pattern
  // char may not start a search of its own unless a separator precedes it in the pattern.
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

// ---- The score ----------------------------------------------------------------------------------

/**
 * Where the next hump starts, for SCORING — MinusculeMatcherImpl.nextWord, which is not
 * NameUtilCore.nextWord: a digit advances by exactly one instead of swallowing the digit run, so every
 * digit is its own hump. The difference is one term in one name out of twenty, which is exactly why it
 * would never have been noticed by reading: `x1` against `x21` scores 994 with this and 993 with the
 * other, and only a run against the real matcher says which.
 */
function minusculeNextWord(name, start) {
  return start < name.length && minusculeIsDigit(name.charAt(start)) ? start + 1 : nameUtilNextWord(name, start);
}

/**
 * How WELL the pattern matches — MinusculeMatcherImpl.matchingDegree.
 *
 * This is the number every ranked list in this app wants, and the reason porting the matcher without
 * it would have been half a port: the fragments say whether a name matches, and only the degree says
 * which of two matching names a reader meant. The 1000 for a match that starts at a word start swamps
 * everything else, which is why `quickOpen` beats `aQuickOpenThing` for `quick`.
 *
 * Returns -Infinity for no match at all, mirroring Integer.MIN_VALUE there.
 */
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
  // myHardSeparators is "" for every matcher this app builds, so nothing is ever "after a separator".
  var afterSeparator = false;
  var wordStart = startIndex === 0
    || (nameUtilIsWordStart(name, startIndex) && !nameUtilIsWordStart(name, startIndex - 1));
  var finalMatch = fragments[fragments.length - 1].end === name.length;
  return (wordStart ? 1000 : 0) + matchingCase - fragments.length + (-skippedHumps * 10)
    + (afterSeparator ? 0 : 2) + (startMatch ? 1 : 0) + (finalMatch ? 1 : 0);
}

// Strings.indexOf(myPattern, c, p + 1, length, false) — and that trailing `false` is `caseSensitive`,
// so this search IGNORES case. Easy to read backwards, and reading it backwards costs more than the one
// term it looks like: a case-sensitive search returns -1 for every hump the reader typed in lower case,
// which `break`s out of the range early and leaves `nextHumpStart` stale for every range after it — so
// the skipped-hump penalty goes wrong too. Case is not how the corresponding pattern character is
// FOUND; it is what evaluateCaseMatching then rewards or punishes.
function minusculeIndexOfPatternChar(m, c, from) {
  var lower = c.toLowerCase();
  for (var i = Math.max(0, from); i < m.chars.length; i += 1) {
    if (m.chars[i] === c || m.chars[i].toLowerCase() === lower) return i;
  }
  return -1;
}

// ---- What the app's lists ask ------------------------------------------------------------------
// Everything above is IntelliJ's. Everything below is this app asking it the question its own lists
// have: a haystack that is a path, or a path joined to a name and a detail, rather than a bare name.

/**
 * The matcher for one typed variant, in "search anywhere" form.
 *
 * The leading '*' is the whole difference between IntelliJ's Go to File box and this app's lists. A bare
 * MinusculeMatcher pattern is anchored at the START of the name — `quick` does not match
 * `aQuickOpenThing` at all, it returns null — and that is right for a list of bare file names. The
 * haystacks here are paths and joins (`src/viewer/03-quick-open.js`), so an anchored pattern would only
 * ever match things beginning with `s`. IntelliJ prefixes '*' for exactly this case, which is what its
 * "search anywhere" means, and the '*' brings its own discipline with it: a match that lands in the
 * MIDDLE of a word then has to be at least three characters long (minusculeIsMiddleMatch), so a
 * two-letter query still only matches at word starts.
 */
var QUERY_MATCHER_CACHE = new Map();
function queryMatcher(variant) {
  var text = String(variant == null ? '' : variant);
  // Keyed on the variant as typed, so the '*' is prepended once per query rather than once per
  // candidate: this is called inside the loop over every path in the repository, and the concatenation
  // alone was thousands of throwaway strings a keystroke.
  var hit = QUERY_MATCHER_CACHE.get(text);
  if (hit) return hit;
  var made = minusculeMatcher(text.charAt(0) === '*' ? text : '*' + text);
  if (QUERY_MATCHER_CACHE.size >= MINUSCULE_CACHE_LIMIT) QUERY_MATCHER_CACHE.clear();
  QUERY_MATCHER_CACHE.set(text, made);
  return made;
}

// A match in a later field is worth less than one in the first: what someone types is usually the
// thing's own name, and the path or the line it sits on is how two things of the same name are told
// apart. Subtracted rather than scaled so the fields stay on one scale — a degree is already dominated
// by its 1000-for-a-word-start.
var MINUSCULE_FIELD_PENALTY = 1200;

/**
 * How well what was typed matches, as one number, higher being better; -Infinity for no match.
 *
 * `fields` is the row's text IN ORDER OF IMPORTANCE — `[name, path]` for a file, `[name, path, detail]`
 * for a symbol — and each field is matched on its own. Separately, not joined, for two reasons that
 * happen to agree: a match running across the join between a path and a name is not a match of
 * anything, and the matcher backtracks over word starts, so one 48-character join costs several times
 * what the two strings in it cost (measured: 31 ms against 18 ms to filter 6,000 files for `SEC`).
 *
 * One function because there were three: a 1000/800/600/400/200 ladder in the Search Everywhere list, a
 * 3000/2000/1000/500 one in the file list, and `haystack.includes(query)` as the filter — three answers
 * to one question, which disagreed about whether a path hit beats a name hit and none of which could
 * tell `quickOpen` from `aQuickOpenThing`, because `includes` says the same about both.
 */
function minusculeQueryScore(fields, queries) {
  var list = Array.isArray(fields) ? fields : [fields];
  var best = -Infinity;
  for (var q = 0; q < queries.length; q += 1) {
    var m = queryMatcher(queries[q]);
    var penalty = 0;
    var seen = '';
    for (var f = 0; f < list.length; f += 1) {
      var text = String(list[f] == null ? '' : list[f]);
      // A row whose name IS its path (a file listed by path alone) must not be charged the penalty for
      // its own name, and must not be matched twice.
      if (text && text !== seen) {
        var fragments = m.fragments(text);
        if (fragments !== null) {
          var degree = m.degree(text, fragments) - penalty;
          if (degree > best) best = degree;
          // Stop at the first field that answers. A later field is charged a whole MINUSCULE_FIELD_PENALTY
          // more than this one, and a degree cannot climb that far — the scale is dominated by its single
          // 1000-for-a-word-start — so reading on could only ever confirm this answer, at the cost of
          // another matcher run per candidate on every path in the repository.
          break;
        }
        seen = text;
      }
      penalty += MINUSCULE_FIELD_PENALTY;
    }
  }
  return best;
}

/**
 * Does any variant of what was typed match at all — the same question as a score above -Infinity.
 *
 * Deliberately not a cheaper independent test: a filter that answered differently from the ranker would
 * put rows in a list the ranker then could not place, and the two were separate functions here for
 * exactly as long as it took to notice they disagreed.
 */
function minusculeMatchesQuery(fields, queries) {
  return minusculeQueryScore(fields, queries) > -Infinity;
}

/**
 * Which characters of `text` the query matched, as [{start, end}] — for drawing them.
 *
 * The visible half of the port. IntelliJ bolds the matched characters in every list it has, and that is
 * not decoration: with camel-hump matching a reader cannot otherwise tell WHY a row answered `SEC`, and
 * a list of reasons they cannot see reads as a list that guessed.
 */
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
  // A lower-case pattern char landing on a hump start after a gap is the shape of an accidental match.
  if (afterGap && isHumpStart && m.isLowerCase[patternIndex]) return -10;
  if (nameChar === m.chars[patternIndex]) {
    if (m.isUpperCase[patternIndex]) return 50;      // the hump the reader typed on purpose
    if (nameIndex === 0 && valuedStartMatch) return 150;
    if (isHumpStart) return 1;
  } else {
    if (isHumpStart) return -1;
    if (m.isLowerCase[patternIndex] && humpStartMatchedUpperCase) return -1;
  }
  return 0;
}
