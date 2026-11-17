import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let iconDataUri = "";

export function kakapoIconDataUri(): string {
  if (iconDataUri) return iconDataUri;
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "icon-ui.png");
  iconDataUri = `data:image/png;base64,${readFileSync(path).toString("base64")}`;
  return iconDataUri;
}

export function kakapoIconHtml(className: string, label = ""): string {
  const accessibility = label ? ` role="img" aria-label="${label}"` : ' aria-hidden="true"';
  return `<span class="${className}"${accessibility}></span>`;
}

export function kakapoIconCssVariable(): string {
  return `--kakapo-ui-icon:url("${kakapoIconDataUri()}")`;
}
