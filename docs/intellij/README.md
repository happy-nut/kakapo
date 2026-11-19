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
