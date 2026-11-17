import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  defaults,
  emptyServer,
  type Config,
  type Details,
  type Installed,
  type Server,
} from "./model";
export const desktop = isTauri();
const key = "noveramp-launcher-preview";
export async function loadConfig(): Promise<Config> {
  return desktop
    ? invoke("get_config")
    : { ...defaults, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
}
export async function saveConfig(config: Config): Promise<Config> {
  if (desktop) return invoke("save_config", { config });
  localStorage.setItem(key, JSON.stringify(config));
  return config;
}
export async function getCatalog(): Promise<{
  servers: Server[];
  stale: boolean;
  warning: string | null;
}> {
  if (desktop) return invoke("get_arizona_servers");
  const response = await fetch("/catalog/arizona");
  if (!response.ok) throw new Error("Каталог Arizona недоступен");
  const data = (await response.json()) as {
    query: {
      ip: string;
      port: number;
      name: string;
      online: number;
      maxplayers: number;
      password?: boolean;
    }[];
  };
  return {
    stale: false,
    warning: null,
    servers: data.query.map((s) => ({
      ...emptyServer(`${s.ip}:${s.port}`),
      name: `Arizona RP | ${s.name}`,
      arzMode: true,
      online: s.online,
      maxplayers: s.maxplayers,
      password: s.password ?? false,
      mode: "Arizona Role Play",
      language: "Русский",
      source: "arizona",
    })),
  };
}
export async function query(address: string): Promise<Server> {
  if (!desktop) throw new Error("Живой UDP-опрос доступен в приложении");
  return invoke("query_server", { address });
}
export async function getDetails(address: string): Promise<Details> {
  return desktop
    ? invoke("server_details", { address })
    : {
        players: [],
        rules: [],
        errors: ["Список игроков и правила доступны в настольном приложении."],
      };
}
export async function installed(): Promise<Installed | null> {
  return desktop ? invoke("engine_status") : null;
}
export async function updateEngine(): Promise<Installed> {
  if (!desktop)
    throw new Error("Обновление движка доступно в настольном приложении");
  return invoke("update_engine");
}
export async function launch(
  address: string,
  arzMode: boolean,
  password: string,
): Promise<void> {
  if (!desktop)
    throw new Error("Для запуска игры откройте настольный NoveraMP Launcher");
  return invoke("launch_game", {
    address,
    arzMode,
    password: password || null,
  });
}
