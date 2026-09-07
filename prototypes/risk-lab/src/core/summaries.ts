import { stringify } from "yaml";
import { safeYaml } from "./formats";

export type SummaryLayer = {
  text: string;
  source: "ai" | "user-confirmed";
};
export type SummaryDocument = {
  version: 1;
  source_path: string;
  source_revision: string;
  generated_at: string;
  layers: SummaryLayer[];
};

const characters = (value: string) => Array.from(value).length;

export function summaryPath(sourcePath: string) {
  if (!/^raw\/(Inbox|Projects|Areas)\/.+\.md$/.test(sourcePath))
    throw new Error("摘要只能关联未归档的 raw Markdown 文档");
  return sourcePath
    .replace(/^raw\//, "derived/summaries/")
    .replace(/\.md$/, ".summary.yaml");
}

export function validateSummary(
  value: unknown,
  sourceContent?: string,
): SummaryDocument {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("摘要必须是 YAML 对象");
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    typeof data.source_path !== "string" ||
    typeof data.source_revision !== "string" ||
    !/^[a-f\d]{64}$/i.test(data.source_revision) ||
    typeof data.generated_at !== "string" ||
    !Array.isArray(data.layers) ||
    !data.layers.length ||
    data.layers.length > 8
  )
    throw new Error("摘要格式无效");
  const path = summaryPath(data.source_path);
  void path;
  const layers = data.layers.map((layer) => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer))
      throw new Error("摘要层格式无效");
    const item = layer as Record<string, unknown>;
    if (
      typeof item.text !== "string" ||
      !item.text.trim() ||
      characters(item.text) > 200_000 ||
      (item.source !== "ai" && item.source !== "user-confirmed")
    )
      throw new Error("摘要层格式无效");
    return { text: item.text, source: item.source } as SummaryLayer;
  });
  if (characters(layers[0].text) > 10)
    throw new Error("顶层摘要不能超过 10 字");
  for (let index = 0; index < layers.length - 1; index++)
    if (characters(layers[index].text) * 10 > characters(layers[index + 1].text))
      throw new Error("每层摘要最多为下一层的十分之一");
  if (
    sourceContent !== undefined &&
    characters(layers.at(-1)!.text) * 10 > characters(sourceContent)
  )
    throw new Error("最底层摘要最多为原文的十分之一");
  return {
    version: 1,
    source_path: data.source_path,
    source_revision: data.source_revision,
    generated_at: data.generated_at,
    layers,
  };
}

export function parseSummary(source: string, sourceContent?: string) {
  return validateSummary(safeYaml(source), sourceContent);
}

export function serializeSummary(summary: SummaryDocument) {
  validateSummary(summary);
  return stringify(summary, { lineWidth: 0 });
}
