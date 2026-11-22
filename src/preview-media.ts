export type PreviewKind = "image" | "video" | "audio" | "pdf";
export type PreviewMedia = { mime: string; kind: PreviewKind };

const IMAGE: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  pjpeg: "image/jpeg",
  pjp: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  avif: "image/avif",
};

const VIDEO: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
};

const AUDIO: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  opus: "audio/ogg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  weba: "audio/webm",
};

export const PREVIEW_MEDIA: Record<string, PreviewMedia> = {
  ...Object.fromEntries(Object.entries(IMAGE).map(([ext, mime]) => [ext, { mime, kind: "image" as const }])),
  ...Object.fromEntries(Object.entries(VIDEO).map(([ext, mime]) => [ext, { mime, kind: "video" as const }])),
  ...Object.fromEntries(Object.entries(AUDIO).map(([ext, mime]) => [ext, { mime, kind: "audio" as const }])),
  pdf: { mime: "application/pdf", kind: "pdf" },
};

export function previewMediaForPath(path: string): PreviewMedia | null {
  const name = String(path ?? "").replace(/\\/g, "/");
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  return PREVIEW_MEDIA[name.slice(dot + 1).toLowerCase()] ?? null;
}
