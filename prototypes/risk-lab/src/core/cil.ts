import { z } from "zod";

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
