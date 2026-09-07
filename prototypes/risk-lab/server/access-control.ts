export type AccessControl = {
  hosts: readonly string[];
  origins: readonly string[];
  listenHost: "127.0.0.1" | "0.0.0.0";
};

const local: AccessControl = {
  hosts: ["127.0.0.1:4173", "localhost:4173"],
  origins: ["http://127.0.0.1:4173", "http://localhost:4173"],
  listenHost: "127.0.0.1",
};

/**
 * A remote listener is deliberately opt-in.  The public endpoint must be an
 * origin-only HTTPS URL so a reverse proxy cannot accidentally widen the API
 * to an arbitrary Host or cross-site browser origin.
 */
export function accessControlFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): AccessControl {
  const configured = environment.ZFY_PUBLIC_ORIGIN?.trim();
  if (!configured) return local;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("ZFY_PUBLIC_ORIGIN 必须是完整 HTTPS 地址");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("ZFY_PUBLIC_ORIGIN 必须是无路径、无凭据的 HTTPS Origin");
  return {
    hosts: [url.host],
    origins: [url.origin],
    listenHost: "0.0.0.0",
  };
}
