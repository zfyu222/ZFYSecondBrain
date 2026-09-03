import type { FastifyInstance } from "fastify";

/** Claim the local listening port before any recovery or initialization writes. */
export async function startLocalServer(
  app: FastifyInstance,
  initialize: () => Promise<unknown>,
  port = 4173,
) {
  let ready = false;
  app.addHook("onRequest", async (_request, reply) => {
    if (!ready)
      return reply
        .code(503)
        .header("Cache-Control", "no-store")
        .header("Retry-After", "1")
        .send({ error: "知识库正在初始化，尚未开放读写" });
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port });
    await initialize();
    ready = true;
    return address;
  } catch (error) {
    await app.close();
    throw error;
  }
}
