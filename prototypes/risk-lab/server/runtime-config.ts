import path from "node:path";

export type ServerRuntimeConfig = {
  dataDir: string;
  port: number;
};

/** Keeps ephemeral browser verification from opening the normal local store. */
export function serverRuntimeConfig(
  env: NodeJS.ProcessEnv,
  appRoot: string,
): ServerRuntimeConfig {
  const defaultDataDir = path.join(appRoot, ".prototype-data", "server");
  const configuredDataDir = env.ZFY_DATA_DIR;
  if (configuredDataDir && !path.isAbsolute(configuredDataDir))
    throw new Error("ZFY_DATA_DIR 必须是绝对路径");
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : defaultDataDir;
  if (dataDir === path.parse(dataDir).root)
    throw new Error("ZFY_DATA_DIR 不能指向文件系统根目录");

  const rawPort = env.ZFY_PORT;
  const port = rawPort === undefined ? 4173 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("ZFY_PORT 必须是 1024–65535 的整数");
  return { dataDir, port };
}
