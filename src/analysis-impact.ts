import type { RegexIndex } from "./analysis-index.js";
import { documentPath } from "./analysis-index.js";
import type { AnalysisLocation } from "./lsp.js";

export type ImpactEvidence = "semantic" | "heuristic";

export type ImpactItem = AnalysisLocation & {
  relation?: string;
  evidence: ImpactEvidence;
};

export type ChangeImpact = {
  symbol: string;
  origin?: AnalysisLocation;
  callers: ImpactItem[];
  dependencies: ImpactItem[];
  implementations: ImpactItem[];
  tests: ImpactItem[];
  contracts: ImpactItem[];
  mentions: ImpactItem[];
};

type RawImpactItem = Omit<ImpactItem, "evidence">;

export type ChangeImpactInput = {
  symbol: string;
  origin: AnalysisLocation;
  references: AnalysisLocation[];
  implementations: AnalysisLocation[];
  index: RegexIndex;
  referenceEvidence: ImpactEvidence;
  implementationEvidence: ImpactEvidence;
};

// Convert semantic/heuristic locations into reviewer-facing relationships. This module deliberately has
// no LSP/process dependencies: classification can evolve and be tested without changing query orchestration.
export function buildChangeImpact(input: ChangeImpactInput): ChangeImpact {
  const { symbol, origin, references, implementations, index, referenceEvidence, implementationEvidence } = input;
  const callers: ImpactItem[] = [];
  const tests: ImpactItem[] = [];
  const contracts: ImpactItem[] = [];
  const mentions: ImpactItem[] = [];
  for (const item of references) {
    if (item.path === origin.path && item.lineIndex === origin.lineIndex) continue;
    const text = item.text ?? lineText(index, item.path, item.lineIndex);
    const enriched = { ...item, text };
    if (testPath(item.path)) tests.push({ ...enriched, relation: "test", evidence: referenceEvidence });
    else if (contractPath(item.path)) contracts.push({ ...enriched, relation: "contract", evidence: referenceEvidence });
    else if (documentPath(item.path)) mentions.push({ ...enriched, relation: "mention", evidence: referenceEvidence });
    else if (/\b(?:import|require|use|include)\b/.test(text)) {
      callers.push({ ...enriched, relation: "importer", evidence: referenceEvidence });
    } else if (referenceEvidence === "semantic" || apparentCall(text, symbol)) {
      callers.push({ ...enriched, relation: "caller", evidence: referenceEvidence });
    } else {
      mentions.push({ ...enriched, relation: "mention", evidence: "heuristic" });
    }
  }

  const dependencies = outgoingDependencies(index, origin, symbol)
    .map((item) => ({ ...item, evidence: "heuristic" as const }));
  const inheritance: ImpactItem[] = [];
  const originDeclaration = origin.text ?? lineText(index, origin.path, origin.lineIndex);
  const inheritanceMatch = /\b(?:extends|implements)\s+([^\n{]+)/.exec(originDeclaration);
  if (inheritanceMatch) {
    const parents = inheritanceMatch[1].match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    for (const parent of parents) {
      const target = (index.definitions.get(parent) ?? [])[0];
      if (target) inheritance.push({ ...target, name: parent, relation: "inherits", evidence: "heuristic" });
    }
  }

  const signatureTokens = originDeclaration.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  for (const token of signatureTokens) {
    if (token === symbol) continue;
    for (const item of index.definitions.get(token) ?? []) {
      if (item.symbolKind === "type" || item.symbolKind === "interface" || contractPath(item.path)) {
        contracts.push({ ...item, relation: "type", evidence: "heuristic" });
      }
    }
  }
  if (contractPath(origin.path)) contracts.unshift({ ...origin, relation: "changed contract", evidence: "heuristic" });

  return {
    symbol,
    origin,
    callers: uniqueImpactItems(callers, 120),
    dependencies: uniqueImpactItems(dependencies, 120),
    implementations: uniqueImpactItems([
      ...implementations
        .filter((item) => item.path !== origin.path || item.lineIndex !== origin.lineIndex)
        .map((item) => ({ ...item, relation: "implementation", evidence: implementationEvidence })),
      ...inheritance,
    ], 120),
    tests: uniqueImpactItems(tests, 120),
    contracts: uniqueImpactItems(contracts, 120),
    mentions: uniqueImpactItems(mentions, 120),
  };
}

function outgoingDependencies(index: RegexIndex, origin: AnalysisLocation, symbol: string): RawImpactItem[] {
  const content = index.files.get(origin.path) ?? "";
  const lines = content.split(/\r?\n/);
  const sameFileDefinitions = index.symbols.filter((item) => item.path === origin.path && item.lineIndex > origin.lineIndex);
  const nextDefinition = sameFileDefinitions.sort((a, b) => a.lineIndex - b.lineIndex)[0]?.lineIndex ?? Math.min(lines.length, origin.lineIndex + 160);
  const out: RawImpactItem[] = [];
  const scopeText = lines.slice(origin.lineIndex, nextDefinition).join("\n");
  for (let lineIndex = 0; lineIndex < origin.lineIndex; lineIndex += 1) {
    const text = lines[lineIndex];
    const jsImport = /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(text);
    const requireImport = /^\s*(?:const|let|var)\s+(.+?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]/.exec(text);
    const pythonFrom = /^\s*from\s+([^\s]+)\s+import\s+(.+)/.exec(text);
    const pythonImport = /^\s*import\s+([^\s,]+)/.exec(text);
    const module = jsImport?.[2] || requireImport?.[2] || pythonFrom?.[1] || pythonImport?.[1];
    const bindings = (jsImport?.[1] || requireImport?.[1] || pythonFrom?.[2] || pythonImport?.[1] || "")
      .replace(/\b(?:type|as|default)\b/g, " ")
      .match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    if (module && bindings.some((binding) => new RegExp(`\\b${escapeRegExp(binding)}\\b`).test(scopeText))) {
      out.push({ path: origin.path, lineIndex, column: Math.max(0, text.indexOf(module)), text, name: module, relation: "module" });
    }
  }
  const keywordCalls = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "super"]);
  for (let lineIndex = origin.lineIndex; lineIndex < Math.min(lines.length, nextDefinition); lineIndex += 1) {
    const text = lines[lineIndex];
    const importMatch = /\b(?:from|require\s*\(|import\s*\(|use\s+)[\s'"]*([^'";)\s]+)/.exec(text);
    if (importMatch) out.push({ path: origin.path, lineIndex, column: Math.max(0, text.indexOf(importMatch[1])), text, name: importMatch[1], relation: "module" });
    const calls = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = calls.exec(text))) {
      const name = match[1];
      if (name === symbol || keywordCalls.has(name)) continue;
      const target = (index.definitions.get(name) ?? [])[0];
      if (target) out.push({ ...target, name, relation: "call" });
    }
  }
  return uniqueLocations(out);
}

function uniqueLocations<T extends AnalysisLocation>(items: T[], limit = 500): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = `${item.path}\0${item.lineIndex}\0${item.column}\0${item.name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueImpactItems(items: ImpactItem[], limit: number): ImpactItem[] {
  const seen = new Set<string>();
  const out: ImpactItem[] = [];
  for (const item of items) {
    const key = `${item.path}\0${item.lineIndex}\0${item.relation ?? ""}\0${item.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function lineText(index: RegexIndex, path: string, line: number): string {
  return (index.files.get(path) ?? "").split(/\r?\n/)[line] ?? "";
}

function testPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path);
}

function contractPath(path: string): boolean {
  return /(^|\/)(types?|api|schema|schemas|config|configs)(\/|$)|(?:openapi|swagger|schema|config)|\.(?:graphql|gql|proto|json|ya?ml|toml)$/i.test(path);
}

function apparentCall(text: string, symbol: string): boolean {
  return new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`).test(text);
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
