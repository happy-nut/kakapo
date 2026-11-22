// The regex guess that answers Cmd+B when no language server does. It is asked twice from two processes —
// the index the main process builds (src/analysis-index.ts) and the renderer's own scan over the files it
// has materialised (src/viewer/15-semantic-navigation.js) — so it lives here once, as strings a JSON
// prelude can carry into the viewer bundle. Tighten a word in one place and both turns tighten together;
// the renderer's turn arrives as a silent jump rather than a list, which looks less like a bug and is worse.
export const DECLARATION_HEURISTICS = {
  notADeclaredName: "if|for|while|switch|catch|with|function|return|new|typeof|void|delete|throw|await|yield",
  // Words that can only be an operator, a statement or a macro header, refused in the prefix of a method
  // that writes its return type before its name. `return foo(a);`, `new Foo(a) {` and `throw new Error(m);`
  // are calls of exactly that shape. Grow it by feeding candidate lines through the real index.
  notAType: "new|typedef|co_await|co_return|co_yield|emit|requires|return|await|yield|throw|else|do|case"
    + "|assert|delete|typeof|instanceof|export|import|function",
  // Only the languages that write a return type before the name. A TypeScript `void bootWindow(state);` is
  // the void operator applied to a call, so widening this list costs real records.
  returnTypeExtensions: [".java", ".cs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hxx"],
  // `synchronized (lock) {`, `lock (gate) {` and `foreach (…) {` are a name, a parenthesised expression and
  // a brace. Scoped to the languages those statements belong to, which is what makes the refusal free: a
  // method in Java or C# carries a return type, so the only plain `name(args) {` left there is a constructor.
  statementHeads: [
    { extensions: [".java", ".kt"], name: "^synchronized$" },
    { extensions: [".cs"], name: "^(?:lock|fixed|checked|unchecked|unsafe|using|foreach)$" },
  ],
} as const;

export function returnTypeBeforeName(): string {
  return `(?!(?:${DECLARATION_HEURISTICS.notAType})\\b)[A-Za-z_$][A-Za-z0-9_$]*`
    + "(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*(?:<(?:[^<>()]|<[^<>()]*>)*>)?(?:\\[\\s*\\]|[*?])*";
}

export function extensionsPattern(extensions: readonly string[]): string {
  return `\\.(?:${extensions.map((extension) => extension.slice(1)).join("|")})$`;
}
