# IntelliJ's highlighting keys

`highlighting-keys.txt` is every colour key IntelliJ IDEA CE 2025.2.5 declares, grouped by language and
split into the ones a lexer decides (a brace, a number) and the ones analysis decides (an instance field,
a static method, a reassigned parameter). It is the list kakapo's semantic highlighting is measured
against, and the reason `DEFAULT SEMANTIC` is only seventeen keys: IntelliJ's platform vocabulary is
`type × modifier`, the same shape LSP's semantic tokens have. That is where the paint table's groupings
and its use of slant for `static` come from — not from guessing which kinds deserve a colour.

Three facts that cost time to find:

- IntelliJ's own default schemes use roughly nine colours for all of this and separate the rest with
  **bold, italic and underline** (`STATIC_FIELD_ATTRIBUTES` is italic, `REASSIGNED_*` is underlined). A
  port that gives every key a colour of its own looks nothing like the IDE it is copying.
- Primitive types are painted with the keyword colour, not a type colour. `builtinType` maps to
  `--token-keyword` for that reason.
- Punctuation has keys (`DEFAULT_COMMA`, `DEFAULT_DOT`, `DEFAULT_BRACES`) and every shipped scheme paints
  them the editor's default foreground. That is why rust-analyzer's `comma`, `dot`, `brace` and the rest
  are deliberately plain in `semanticTokenClasses()`.

## Re-extracting it

The keys are string constants in the IDE's own classes, so they are read out of the class files' constant
pool rather than from any documentation:

```bash
python3 docs/intellij/extract-class-constants.py \
  "/Applications/IntelliJ IDEA CE.app/Contents/lib/app-client.jar" \
  com/intellij/openapi/editor/DefaultLanguageHighlighterColors out.txt
```

UI classes live in `app-client.jar`, not `app.jar`. Language-specific keys live in that language's plugin
jar (`plugins/java/lib/java-impl.jar`, `plugins/Kotlin/lib/kotlin-plugin.jar`, and so on). The shipped
colour values — which key is bold, which is italic — are in `colorSchemes/` XML inside the same jars.

## What the shipped schemes actually do

`test/fixtures/intellij-schemes.json` is IntelliJ's own two base schemes, read out of the installed IDE and
reduced to the platform vocabulary. `test/intellij-parity.test.mjs` checks kakapo against it: every key is
either mapped to a class the paint table hands out, or refused in writing. Re-read it after an IDE upgrade:

```bash
python3 docs/intellij/extract-shipped-schemes.py \
  "/Applications/IntelliJ IDEA CE.app/Contents/lib/app-client.jar" test/fixtures/intellij-schemes.json
```

Measured on IDEA CE 2025.2.5: the platform declares 31 keys in Darcula and 28 in Default, and each scheme
resolves them to **17 distinct looks** — 12 colours in Darcula, 10 in Default, with italic, bold, underline
and a wavy line carrying the rest. kakapo's table hands out 28 classes, each a look no other class has.

Three places the two shipped schemes disagree, so there is no single IntelliJ answer to copy:

- `DEFAULT_COMMA` and `DEFAULT_SEMICOLON` are the keyword colour in Darcula and the default foreground in
  Default. kakapo leaves them plain, with the other punctuation.
- `DEFAULT_DOC_COMMENT` is a colour and a slant of its own in Darcula and identical to a line comment in
  Default. kakapo italicises it — `tokmod-documentation`, from rust-analyzer's `documentation` modifier.
- `DEFAULT_FUNCTION_CALL` is the default foreground in Darcula while the declaration is yellow; Default
  paints neither. kakapo colours both, because losing the colour on every call reads as a loss, not a
  distinction.

`DEFAULT_REASSIGNED_LOCAL_VARIABLE` and `DEFAULT_REASSIGNED_PARAMETER` are underlined in both schemes and
cannot be reproduced at all: it takes dataflow to know a variable is reassigned, and no semantic token
carries it.

## The stack-trace parser

`ExceptionWorker.parseStackTraceLine` is IntelliJ's answer to "is this line a stack frame, and which
file and line does it name". It lives in the Java plugin, not the platform, and it is not a regex: it
scans for the closing parenthesis that follows a digit, then walks backwards for the method name and
the class. Prose about it is worth nothing, because the five rules interact — four claims written out
of a careful reading of the source were still wrong about this corpus.

So the answers are captured from the real parser rather than described:

```bash
npm run stack:oracle
```

It needs an installed IntelliJ IDEA (Community is enough, for
`plugins/java/lib/java-impl.jar`) and a JDK on `PATH`. `docs/intellij/StackTraceOracle.java` is
compiled against the IDE's own jars, run over `test/fixtures/stack-trace-corpus.txt`, and its answers
land in `test/fixtures/stack-trace-oracle.json`, which `test/stack-trace.test.mjs` asserts the port
against row by row. Add a line to the corpus and re-run to pin a new case.

The extractor refuses two results that would otherwise look like success: zero frames, which means the
classpath resolved but the parser never ran, and every line a frame, which means the corpus has lost
the negative cases that give the positive ones meaning.

Four things the corpus pins that a reading of the source got wrong:

- `Bar.java:0` is a frame whose line number is `0`; `Native Method` and `Unknown Source` are frames
  whose line number is `-1`. Conflating the two sentinels costs the `:0` frame its link.
- `at Object.foo (/p/a.js:1:2)` IS claimed by the JVM reader, which reads the file as `/p/a.js:1` and
  the line as `2`. A V8 reader has to be tried first or every Node frame resolves to a file that does
  not exist.
- `- locked <0x…> (a java.lang.Object) line=42` is not a frame, although it has the `- ` and the
  `line=` that `parseForcedLine` looks for: there is no `.` before the parenthesis, so the method-name
  candidate is refused.
- `com.foo.Bar.baz(Bar.java:42)` with no `at` at all is a frame, and `Bar.java : 42` with spaces
  around the colon is not.

## Real traces, from real crashes

The JVM reader has IntelliJ itself as an oracle. The other readers have none, so their fixture is the
output of actual failing programs rather than lines written from memory:

```bash
npm run stack:samples
```

`scripts/stack-trace-samples.mjs` writes a small crashing program for node, python, go, rust and ruby
into a temporary directory, runs it, and records stderr in
`test/fixtures/stack-trace-samples.json` with the directory replaced by `<DIR>`. It refuses a program
that stops crashing, a crash with nothing on stderr, and a trace that names no path inside the sample
directory, since each of those would be captured as an empty success. A runtime that is not installed
is reported as skipped, never counted as clean.

Four things these captures say that a description of the formats got wrong:

- Go's frame is `\t<path>:<line>` and the ` +0x4c` offset is **optional** — the inlined `Deep(...)`
  frames carry no offset at all, so a reader that requires one loses half of every panic.
- Node's first line is a bare `<path>:<line>` with no `at`, and it is the most useful frame in the
  trace: it is where the error was thrown. `at Array.map (<anonymous>)` in the same trace is prose.
- Rust's panic header is `thread 'main' (…) panicked at main.rs:3:9:` — a relative path with a
  trailing colon, nothing like the `at …` lines of the backtrace below it.
- Ruby's frames are `<path>:<line>:in 'Object#deep'` and `\tfrom <path>:<line>:in '…'`, a shape none
  of the other readers match.

The rust capture is not byte-stable: it carries a thread id, instruction addresses and the rustc
commit hash, so re-running the script rewrites those. Re-capture when a format changes, not to tidy
the diff.
