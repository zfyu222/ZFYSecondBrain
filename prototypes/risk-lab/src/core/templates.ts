export const templateDirectory = "raw/Areas/_templates/";

/** Templates remain ordinary portable Markdown under raw, never a hidden DB-only type. */
export function isTemplateStem(stem: string) {
  return stem.startsWith(templateDirectory);
}

export function templateName(stem: string) {
  return stem.slice(templateDirectory.length) || stem;
}
