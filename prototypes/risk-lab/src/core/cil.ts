import { z } from "zod";
import { matchesNoteSearch } from "./search";

/** Fixed, JSON-only boundary between an AI manager and the knowledge service. */
export const cilRequestSchema = z
  .object({
    version: z.literal(1),
    task: z.string().min(1).max(120),
    command: z.enum(["search", "read", "propose-change"]),
    paths: z.array(z.string().startsWith("raw/")).max(50),
    query: z.string().max(2_000).optional(),
    authorization: z.enum(["read", "propose-change"]),
  })
  .strict();
export type CilRequest = z.infer<typeof cilRequestSchema>;

export function validateCilRequest(input: unknown): CilRequest {
  const request = cilRequestSchema.parse(input);
  if (request.command === "search" && !request.query?.trim())
    throw new Error("搜索命令需要查询内容");
  if (
    request.command === "propose-change" &&
    request.authorization !== "propose-change"
  )
    throw new Error("未经明确授权，CIL 只能读取或搜索知识库");
  return request;
}

export type CilResult =
  | { command: "search"; matches: { path: string; excerpt: string }[] }
  | { command: "read"; documents: { path: string; content: string }[] }
  | { command: "propose-change"; accepted: true };

const insideScope = (path: string, scope: string) =>
  path === scope || path.startsWith(scope.endsWith("/") ? scope : scope + "/");

/**
 * Executes only read-only commands against an explicitly supplied snapshot.
 * The manager never receives a filesystem handle through this boundary.
 */
export function executeCilRequest(
  input: unknown,
  files: Record<string, string>,
): CilResult {
  const request = validateCilRequest(input);
  if (request.command === "propose-change") return { command: request.command, accepted: true };
  const candidates = Object.entries(files).filter(
    ([path]) =>
      path.endsWith(".md") && request.paths.some((scope) => insideScope(path, scope)),
  );
  if (request.command === "read")
    return {
      command: "read",
      documents: candidates.map(([path, content]) => ({ path, content })),
    };
  const query = request.query!;
  return {
    command: "search",
    matches: candidates
      .filter(([path, content]) =>
        matchesNoteSearch(path.slice(0, -3), content, query, false),
      )
      .slice(0, 20)
      .map(([path, content]) => ({
        path,
        excerpt: content.replace(/\s+/g, " ").slice(0, 280),
      })),
  };
}
