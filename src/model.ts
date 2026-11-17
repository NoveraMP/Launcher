export interface Server {
  address: string;
  name: string;
  arzMode: boolean;
  password: boolean;
  online: number;
  maxplayers: number;
  pingMs: number | null;
  mode: string;
  language: string;
  source: string;
  reachable: boolean | null;
}
export interface Config {
  nickname: string;
  assetsDir: string;
  engineOverride: string;
  autoUpdateEngine: boolean;
  autoUpdateLauncher: boolean;
  hideAfterLaunch: boolean;
  servers: Server[];
  favorites: string[];
  recent: string[];
}
export interface Details {
  players: { name: string; score: number }[];
  rules: [string, string][];
  errors: string[];
}
export interface Progress {
  stage: string;
  percent: number;
  message: string;
}
export interface Installed {
  releaseId: number;
  version: string;
  directory: string;
}
export const defaults: Config = {
  nickname: "RustPlayer",
  assetsDir: "",
  engineOverride: "",
  autoUpdateEngine: true,
  autoUpdateLauncher: true,
  hideAfterLaunch: false,
  servers: [],
  favorites: [],
  recent: [],
};
export function normalizeAddress(input: string): string {
  const text = input
    .trim()
    .replace(/^samp:\/\//, "")
    .replace(/\/$/, "");
  const match = /^([a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(text);
  if (!match || match[1].length > 253)
    throw new Error(
      "Укажите IP:порт или домен, например play.example.com:7777",
    );
  const port = Number(match[2] ?? 7777);
  if (port < 1 || port > 65535)
    throw new Error("Порт должен быть от 1 до 65535");
  return `${match[1].toLowerCase()}:${port}`;
}
export function emptyServer(address: string): Server {
  return {
    address,
    name: address,
    arzMode: false,
    password: false,
    online: 0,
    maxplayers: 0,
    pingMs: null,
    mode: "—",
    language: "—",
    source: "custom",
    reachable: null,
  };
}
export function mergeServers(
  catalog: Server[],
  saved: Server[],
  live: Record<string, Partial<Server>>,
): Server[] {
  const map = new Map<string, Server>();
  for (const server of [...catalog, ...saved]) {
    const origin = map.get(server.address);
    map.set(server.address, {
      ...server,
      ...live[server.address],
      name: server.name || origin?.name || server.address,
      source: origin?.source ?? server.source,
    });
  }
  return [...map.values()];
}
export interface Filters {
  search: string;
  mode: string;
  language: string;
  notFull: boolean;
  notEmpty: boolean;
  noPassword: boolean;
}
export const defaultFilters: Filters = {
  search: "",
  mode: "",
  language: "",
  notFull: false,
  notEmpty: false,
  noPassword: false,
};
export function filterServers(servers: Server[], filters: Filters): Server[] {
  const search = filters.search.toLocaleLowerCase();
  return servers.filter(
    (s) =>
      (s.name + " " + s.address).toLocaleLowerCase().includes(search) &&
      (!filters.mode || s.mode === filters.mode) &&
      (!filters.language || s.language === filters.language) &&
      (!filters.notFull || s.maxplayers === 0 || s.online < s.maxplayers) &&
      (!filters.notEmpty || s.online > 0) &&
      (!filters.noPassword || !s.password),
  );
}
