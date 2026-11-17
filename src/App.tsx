import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FolderOpen,
  Gamepad2,
  Globe2,
  Info,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import * as api from "./api";
import Titlebar from "./Titlebar";
import { version as launcherVersion } from "../package.json";
import {
  defaults,
  defaultFilters,
  emptyServer,
  filterServers,
  mergeServers,
  normalizeAddress,
  type Config,
  type Details,
  type Filters,
  type Installed,
  type Progress,
  type Server,
} from "./model";

type Tab = "favorites" | "arizona" | "custom" | "recent";
type Modal = "add" | "settings" | "password" | "connecting" | null;
const format = (n: number) => n.toLocaleString("ru-RU");
function IconButton({
  label,
  onClick,
  children,
  disabled = false,
  className = "",
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="toggle-label">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle" />
      <span>{label}</span>
    </label>
  );
}
function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const list = ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, select, a[href]",
        );
        if (!list?.length) return;
        const first = list[0],
          last = list[list.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <header>
          <h2>{title}</h2>
          <IconButton label="Закрыть диалог" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}
export default function App() {
  const [config, setConfig] = useState<Config>(defaults),
    [catalog, setCatalog] = useState<Server[]>([]),
    [live, setLive] = useState<Record<string, Partial<Server>>>({});
  const [tab, setTab] = useState<Tab>("arizona"),
    [filters, setFilters] = useState<Filters>(defaultFilters),
    [selected, setSelected] = useState("");
  const [sort, setSort] = useState<{
    key: "name" | "online" | "pingMs";
    desc: boolean;
  }>({ key: "name", desc: false });
  const [modal, setModal] = useState<Modal>(null),
    [form, setForm] = useState<Config>(defaults),
    [addAddress, setAddAddress] = useState(""),
    [addName, setAddName] = useState(""),
    [addArz, setAddArz] = useState(false),
    [addInfo, setAddInfo] = useState<Server | null>(null),
    [adding, setAdding] = useState(false);
  const [details, setDetails] = useState<Details | null>(null),
    [detailTab, setDetailTab] = useState<"players" | "rules">("players"),
    [history, setHistory] = useState<Record<string, number[]>>({});
  const [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false),
    [busy, setBusy] = useState(false),
    [running, setRunning] = useState(false),
    [engine, setEngine] = useState<Installed | null>(null),
    [progress, setProgress] = useState<Progress | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
      null,
    ),
    [password, setPassword] = useState(""),
    [launcherBusy, setLauncherBusy] = useState(false),
    [restartReady, setRestartReady] = useState(false);
  const configRef = useRef(config);
  configRef.current = config;
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const refreshRef = useRef(false);
  const initRef = useRef(false);
  const addRequest = useRef(0);
  const notify = useCallback(
    (text: string, error = false) => setNotice({ text, error }),
    [],
  );
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveSerial = useRef(0);
  const persist = useCallback(async (next: Config) => {
    const previous = configRef.current;
    const serial = ++saveSerial.current;
    configRef.current = next;
    setConfig(next);
    const pending = saveQueue.current
      .catch(() => {})
      .then(() => api.saveConfig(next));
    saveQueue.current = pending;
    try {
      const saved = await pending;
      if (serial === saveSerial.current) {
        configRef.current = saved;
        setConfig(saved);
      }
      return saved;
    } catch (error) {
      if (serial === saveSerial.current) {
        configRef.current = previous;
        setConfig(previous);
      }
      throw error;
    }
  }, []);
  const servers = useMemo(
    () => mergeServers(catalog, config.servers, live),
    [catalog, config.servers, live],
  );
  const cur = servers.find((s) => s.address === selected);
  const scoped = useMemo(
    () =>
      servers.filter((s) =>
        tab === "favorites"
          ? config.favorites.includes(s.address)
          : tab === "recent"
            ? config.recent.includes(s.address)
            : tab === "arizona"
              ? s.source === "arizona"
              : s.source !== "arizona",
      ),
    [servers, tab, config.favorites, config.recent],
  );
  const rows = useMemo(
    () =>
      filterServers(scoped, filters).sort((a, b) => {
        const av = a[sort.key] ?? Infinity,
          bv = b[sort.key] ?? Infinity;
        const n =
          typeof av === "string"
            ? av.localeCompare(String(bv), "ru")
            : Number(av) - Number(bv);
        return sort.desc ? -n : n;
      }),
    [scoped, filters, sort],
  );
  const close = useCallback(() => {
    setModal(null);
    setPassword("");
  }, []);
  const refresh = useCallback(
    async (reload = true) => {
      if (refreshRef.current) return;
      refreshRef.current = true;
      setRefreshing(true);
      try {
        let source = catalogRef.current;
        if (reload) {
          try {
            const response = await api.getCatalog();
            source = response.servers;
            catalogRef.current = source;
            setCatalog(source);
            if (response.warning) notify(response.warning);
          } catch (e) {
            notify(String(e), true);
          }
        }
        if (api.desktop) {
          const all = mergeServers(source, configRef.current.servers, {});
          for (let i = 0; i < all.length; i += 8) {
            await Promise.all(
              all.slice(i, i + 8).map(async (server) => {
                try {
                  const info = await api.query(server.address);
                  setLive((previous) => ({
                    ...previous,
                    [server.address]: info,
                  }));
                  if (info.pingMs !== null)
                    setHistory((previous) => ({
                      ...previous,
                      [server.address]: [
                        ...(previous[server.address] ?? []),
                        info.pingMs!,
                      ].slice(-30),
                    }));
                } catch {
                  setLive((previous) => ({
                    ...previous,
                    [server.address]: {
                      ...previous[server.address],
                      reachable: false,
                      pingMs: null,
                    },
                  }));
                }
              }),
            );
          }
        }
      } finally {
        refreshRef.current = false;
        setRefreshing(false);
        setLoading(false);
      }
    },
    [notify],
  );
  const checkLauncher = useCallback(
    async (manual = false) => {
      if (!api.desktop) {
        if (manual)
          notify("Обновление лаунчера доступно в настольном приложении");
        return;
      }
      try {
        setLauncherBusy(true);
        const update = await check({ timeout: 15000 });
        if (!update) {
          if (manual) notify("Установлена последняя версия лаунчера");
          return;
        }
        notify(`Загрузка лаунчера ${update.version}…`);
        await update.downloadAndInstall();
        setRestartReady(true);
        notify("Обновление лаунчера установлено. Перезапустите приложение.");
      } catch (e) {
        if (manual) notify(`Не удалось обновить лаунчер: ${e}`, true);
      } finally {
        setLauncherBusy(false);
      }
    },
    [notify],
  );
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    void (async () => {
      let c = defaults;
      try {
        c = await api.loadConfig();
        configRef.current = c;
        setConfig(c);
      } catch (e) {
        notify(String(e), true);
      }
      try {
        setEngine(await api.installed());
      } catch (e) {
        notify(String(e), true);
      }
      void refresh();
      if (c.autoUpdateLauncher) void checkLauncher();
    })();
    const timer = setInterval(() => void refresh(false), 30000);
    return () => clearInterval(timer);
  }, [refresh, notify, checkLauncher]);
  useEffect(() => {
    if (!api.desktop) return;
    let disposed = false;
    const unsub: (() => void)[] = [];
    void Promise.all([
      listen<Progress>("launcher-progress", (e) => {
        setProgress(e.payload);
        if (e.payload.stage === "exited") notify(e.payload.message);
      }),
      listen<boolean>("engine-running", (e) => setRunning(e.payload)),
    ]).then((values) => {
      if (disposed) values.forEach((fn) => fn());
      else unsub.push(...values);
    });
    return () => {
      disposed = true;
      unsub.forEach((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (!rows.some((s) => s.address === selected))
      setSelected(rows[0]?.address ?? "");
  }, [rows, selected]);
  useEffect(() => {
    let active = true;
    setDetails(null);
    if (selected)
      void api
        .getDetails(selected)
        .then((value) => {
          if (active) setDetails(value);
        })
        .catch((e) => {
          if (active)
            setDetails({ players: [], rules: [], errors: [String(e)] });
        });
    return () => {
      active = false;
    };
  }, [selected]);
  const editFilter = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((old) => ({ ...old, [key]: value }));
  const toggleFavorite = async (server: Server) => {
    try {
      const c = configRef.current;
      const favorite = c.favorites.includes(server.address);
      await persist({
        ...c,
        favorites: favorite
          ? c.favorites.filter((s) => s !== server.address)
          : [...c.favorites, server.address],
      });
    } catch (e) {
      notify(String(e), true);
    }
  };
  const setArz = async (server: Server, value: boolean) => {
    try {
      const c = configRef.current;
      await persist({
        ...c,
        servers: [
          ...c.servers.filter((s) => s.address !== server.address),
          { ...server, arzMode: value },
        ],
      });
    } catch (e) {
      notify(String(e), true);
    }
  };
  const deleteServer = async (server: Server) => {
    try {
      const c = configRef.current;
      await persist({
        ...c,
        servers: c.servers.filter((s) => s.address !== server.address),
        favorites: c.favorites.filter((s) => s !== server.address),
        recent: c.recent.filter((s) => s !== server.address),
      });
      setSelected("");
    } catch (e) {
      notify(String(e), true);
    }
  };
  const connect = async (secret = "", force = false, server = cur) => {
    if (!server || busy || running || launcherBusy) return;
    if (!api.desktop) {
      notify("Запуск игры доступен в настольном приложении NoveraMP Launcher");
      return;
    }
    if (!configRef.current.assetsDir) {
      setForm(configRef.current);
      setModal("settings");
      notify("Сначала выберите папку с GTA San Andreas / Arizona");
      return;
    }
    if (server.password && !force) {
      setPassword("");
      setModal("password");
      return;
    }
    setSelected(server.address);
    setModal("connecting");
    setBusy(true);
    setProgress({
      stage: "checking",
      percent: 0,
      message: "Подготовка к запуску…",
    });
    try {
      await api.launch(server.address, server.arzMode, secret);
      setRunning(true);
      setPassword("");
      try {
        const c = await api.loadConfig();
        setConfig(c);
        configRef.current = c;
        setEngine(await api.installed());
      } catch {
        /* launch already succeeded */
      }
    } catch (e) {
      notify(String(e), true);
      setProgress({ stage: "error", percent: 0, message: String(e) });
    } finally {
      setBusy(false);
    }
  };
  const addServer = async () => {
    const request = ++addRequest.current;
    setAdding(true);
    setAddInfo(null);
    try {
      const address = normalizeAddress(addAddress);
      let info = emptyServer(address);
      try {
        info = await api.query(address);
      } catch {
        /* A temporarily offline server can still be saved. */
      }
      if (request !== addRequest.current) return;
      setAddInfo(info);
    } catch (e) {
      notify(String(e), true);
    } finally {
      if (request === addRequest.current) setAdding(false);
    }
  };
  const saveServer = async () => {
    try {
      const address = normalizeAddress(addAddress);
      const server = {
        ...(addInfo ?? emptyServer(address)),
        address,
        name: addName.trim() || addInfo?.name || address,
        arzMode: addArz,
        source: "custom",
      };
      const c = configRef.current;
      await persist({
        ...c,
        servers: [...c.servers.filter((s) => s.address !== address), server],
        favorites: [...new Set([...c.favorites, address])],
      });
      setTab("favorites");
      setSelected(address);
      setFilters(defaultFilters);
      close();
    } catch (e) {
      notify(String(e), true);
    }
  };
  const choosePath = async (kind: "assetsDir" | "engineOverride") => {
    if (!api.desktop) {
      notify("Выбор папки доступен в настольном приложении");
      return;
    }
    try {
      const path = await open({
        directory: kind === "assetsDir",
        multiple: false,
        title:
          kind === "assetsDir"
            ? "Папка игровых ресурсов"
            : "Исполняемый файл NoveraMP",
      });
      if (typeof path === "string")
        setForm((previous) => ({ ...previous, [kind]: path }));
    } catch (e) {
      notify(String(e), true);
    }
  };
  const installEngine = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setEngine(await api.updateEngine());
      notify("Движок обновлён");
    } catch (e) {
      notify(String(e), true);
    } finally {
      setBusy(false);
    }
  };
  const cycleSort = (key: typeof sort.key) =>
    setSort((old) => ({
      key,
      desc: old.key === key ? !old.desc : key === "online",
    }));
  const connectRef = useRef(connect);
  connectRef.current = connect;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.key !== "Enter" ||
        event.repeat ||
        event.defaultPrevented ||
        modal
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('button,input,select,textarea,[contenteditable="true"]')
      )
        return;
      event.preventDefault();
      void connectRef.current();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [modal]);
  const chart = cur ? (history[cur.address] ?? []) : [];
  const maxPing = Math.max(100, ...chart);
  const graph = chart
    .map(
      (v, i) =>
        `${(i * 286) / Math.max(chart.length - 1, 1)},${66 - (v / maxPing) * 58}`,
    )
    .join(" ");
  const totalPlayers = scoped.reduce((sum, s) => sum + s.online, 0);
  const available = scoped.filter((s) => s.reachable === true).length;
  return (
    <main className="launcher">
      <Titlebar onError={notify} />
      <header className="topbar">
        <div className="brand">
          <img
            className="brand-mark"
            src="/brand/icon.png"
            alt=""
            draggable={false}
          />
          <div>
            <h1>NoveraMP</h1>
            <span>Мультиплеер начинается здесь</span>
          </div>
        </div>
        <nav aria-label="Разделы серверов">
          {(
            [
              {
                id: "favorites",
                label: "Избранное",
                icon: Star,
                count: config.favorites.length,
              },
              {
                id: "arizona",
                label: "Arizona RP",
                icon: Globe2,
                count: catalog.length,
              },
              { id: "custom", label: "Мои серверы", icon: Monitor },
              { id: "recent", label: "Недавние", icon: Clock },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              onClick={() => {
                setTab(item.id);
                setFilters(defaultFilters);
              }}
            >
              <item.icon size={15} />
              <span>{item.label}</span>
              {"count" in item && <small>{item.count}</small>}
            </button>
          ))}
        </nav>
        <div className="profile">
          <label htmlFor="nickname">Ник</label>
          <input
            id="nickname"
            aria-label="Ник игрока"
            value={config.nickname}
            maxLength={24}
            onChange={(e) =>
              setConfig((old) => ({ ...old, nickname: e.target.value }))
            }
            onBlur={() =>
              void persist(configRef.current).catch((e) =>
                notify(String(e), true),
              )
            }
          />
          <span className="avatar">
            {config.nickname.slice(0, 1).toUpperCase() || "N"}
          </span>
          <IconButton
            label="Настройки"
            onClick={() => {
              setForm(config);
              setModal("settings");
            }}
          >
            <Settings2 size={18} />
          </IconButton>
        </div>
      </header>
      {!api.desktop && (
        <div className="preview-note">
          <Info size={14} /> Веб-предпросмотр · каталог Arizona настоящий;
          запуск, UDP-опрос и обновления доступны в приложении.
        </div>
      )}
      <section className="toolbar" aria-label="Поиск и фильтры">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Поиск сервера"
            placeholder="Название сервера или IP:порт"
            value={filters.search}
            onChange={(e) => editFilter("search", e.target.value)}
          />
          {filters.search && (
            <button
              aria-label="Очистить поиск"
              onClick={() => editFilter("search", "")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <select
          aria-label="Режим сервера"
          value={filters.mode}
          onChange={(e) => editFilter("mode", e.target.value)}
        >
          <option value="">Режим: любой</option>
          {[...new Set(scoped.map((s) => s.mode))]
            .filter((m) => m && m !== "—")
            .map((m) => (
              <option key={m}>{m}</option>
            ))}
        </select>
        <select
          aria-label="Язык сервера"
          value={filters.language}
          onChange={(e) => editFilter("language", e.target.value)}
        >
          <option value="">Язык: любой</option>
          {[...new Set(scoped.map((s) => s.language))]
            .filter((l) => l && l !== "—")
            .map((l) => (
              <option key={l}>{l}</option>
            ))}
        </select>
        <div className="filter-chips">
          {(
            [
              { key: "notFull", label: "Не полные" },
              { key: "notEmpty", label: "Не пустые" },
              { key: "noPassword", label: "Без пароля" },
            ] as const
          ).map((f) => (
            <button
              key={f.key}
              className={filters[f.key] ? "chip checked" : "chip"}
              aria-pressed={filters[f.key]}
              onClick={() => editFilter(f.key, !filters[f.key])}
            >
              {filters[f.key] && <Check size={12} />} {f.label}
            </button>
          ))}
        </div>
        <button
          className="add-button"
          onClick={() => {
            setAddAddress("");
            setAddName("");
            setAddInfo(null);
            setAddArz(false);
            setModal("add");
          }}
        >
          <Plus size={16} /> Добавить сервер
        </button>
        <IconButton
          label="Обновить серверы"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          <RefreshCw size={17} className={refreshing ? "spin" : ""} />
        </IconButton>
      </section>
      <div className="workspace">
        <section className="server-list" aria-label="Список серверов">
          <div className="list-caption">
            <span>
              {tab === "arizona"
                ? "Серверы Arizona RP"
                : tab === "favorites"
                  ? "Ваше избранное"
                  : tab === "recent"
                    ? "Недавно играли"
                    : "Добавленные серверы"}
            </span>
            <span>
              {rows.length} серверов {refreshing && "· обновление…"}
            </span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="star-cell" />
                  <th>
                    <button onClick={() => cycleSort("name")}>
                      Сервер{" "}
                      {sort.key === "name" &&
                        (sort.desc ? (
                          <ArrowDown size={12} />
                        ) : (
                          <ArrowUp size={12} />
                        ))}
                    </button>
                  </th>
                  <th>
                    <button onClick={() => cycleSort("online")}>
                      Игроки {sort.key === "online" && <ArrowDown size={12} />}
                    </button>
                  </th>
                  <th>
                    <button onClick={() => cycleSort("pingMs")}>Пинг</button>
                  </th>
                  <th className="mode-col">Режим</th>
                  <th className="language-col">Язык</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((server) => (
                  <tr
                    key={server.address}
                    className={`${selected === server.address ? "selected " : ""}${server.reachable === false ? "offline" : ""}`}
                    tabIndex={0}
                    aria-selected={selected === server.address}
                    onClick={() => setSelected(server.address)}
                    onDoubleClick={() => {
                      setSelected(server.address);
                      void connect("", false, server);
                    }}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        setSelected(server.address);
                        void connect("", false, server);
                      }
                      if (e.key === " ") {
                        e.preventDefault();
                        setSelected(server.address);
                      }
                    }}
                  >
                    <td className="star-cell">
                      <button
                        className={`favorite ${config.favorites.includes(server.address) ? "is-favorite" : ""}`}
                        aria-label={`${config.favorites.includes(server.address) ? "Убрать из" : "Добавить в"} избранное: ${server.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleFavorite(server);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <Star size={14} />
                      </button>
                    </td>
                    <td className="server-title">
                      <strong>
                        {server.password && <LockKeyhole size={12} />}{" "}
                        {server.name}
                      </strong>
                      <span>{server.address}</span>
                    </td>
                    <td className="population">
                      <span>
                        {server.maxplayers
                          ? `${format(server.online)} / ${format(server.maxplayers)}`
                          : "—"}
                      </span>
                      {server.maxplayers > 0 && (
                        <i>
                          <b
                            style={{
                              width: `${Math.min((server.online / server.maxplayers) * 100, 100)}%`,
                            }}
                            className={
                              server.online >= server.maxplayers ? "full" : ""
                            }
                          />
                        </i>
                      )}
                    </td>
                    <td>
                      <span
                        className={`ping ${server.reachable === false ? "dead" : server.pingMs === null ? "unknown" : server.pingMs < 100 ? "good" : server.pingMs < 200 ? "fair" : "slow"}`}
                      >
                        {server.reachable === false ? (
                          "Нет ответа"
                        ) : server.pingMs !== null ? (
                          <>
                            <i />
                            {server.pingMs} мс
                          </>
                        ) : (
                          "—"
                        )}
                      </span>
                    </td>
                    <td className="mode-col mode">
                      {server.arzMode ? (
                        <span className="arz-badge">ARZ</span>
                      ) : (
                        server.mode
                      )}
                    </td>
                    <td className="language-col muted">{server.language}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && (
              <div className="empty-state">
                {loading ? (
                  <LoaderCircle className="spin" size={28} />
                ) : (
                  <Globe2 size={32} />
                )}
                <h2>
                  {loading
                    ? "Загружаем серверы…"
                    : filters.search
                      ? "Ничего не найдено"
                      : tab === "favorites"
                        ? "Здесь будут любимые серверы"
                        : tab === "recent"
                          ? "Пока без истории"
                          : "Список пока пуст"}
                </h2>
                <p>
                  {loading
                    ? "Получаем актуальный каталог Arizona RP."
                    : filters.search
                      ? "Измените запрос или сбросьте фильтры."
                      : "Добавьте сервер по адресу или нажмите звёздочку рядом с ним."}
                </p>
                {!loading && (
                  <button
                    onClick={() => {
                      setFilters(defaultFilters);
                      setTab("arizona");
                    }}
                  >
                    Открыть Arizona RP <ChevronRight size={14} />
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="list-footnote">
            <span className="status-dot" /> Каталог Arizona · обновление опроса
            каждые 30 с{" "}
            <span>
              {rows.length} из {scoped.length}
            </span>
          </div>
        </section>
        <aside className="details-panel" aria-label="Выбранный сервер">
          {cur ? (
            <>
              <div className="selected-heading">
                <div className="selected-eyebrow">
                  {cur.source === "arizona" ? (
                    <>
                      <ShieldCheck size={13} /> ARIZONA ROLE PLAY
                    </>
                  ) : (
                    "ВЫБРАННЫЙ СЕРВЕР"
                  )}
                </div>
                <div className="selected-title">
                  <h2>{cur.name}</h2>
                  <IconButton
                    label="Избранное"
                    onClick={() => void toggleFavorite(cur)}
                    className={
                      config.favorites.includes(cur.address)
                        ? "is-favorite"
                        : ""
                    }
                  >
                    <Star size={18} />
                  </IconButton>
                </div>
                <button
                  className="copy-address"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(cur.address)
                      .then(() => notify("Адрес скопирован"))
                      .catch((e) => notify(String(e), true))
                  }
                >
                  {cur.address}
                  <Copy size={12} />
                </button>
              </div>
              <div className="play-area">
                <button
                  className="play-button"
                  disabled={busy || running || launcherBusy}
                  onClick={() => void connect()}
                >
                  {busy || launcherBusy ? (
                    <LoaderCircle size={17} className="spin" />
                  ) : (
                    <Play size={17} fill="currentColor" />
                  )}
                  {running
                    ? "Игра запущена"
                    : busy
                      ? "Подготовка…"
                      : launcherBusy
                        ? "Обновление…"
                        : "Играть"}
                  <kbd>Enter</kbd>
                </button>
                <Toggle
                  checked={cur.arzMode}
                  onChange={(v) => void setArz(cur, v)}
                  label="Режим Arizona"
                />
                <p className="helper">
                  {cur.arzMode
                    ? "Интерфейс и игровые ресурсы Arizona RP."
                    : "Стандартное подключение SA-MP."}
                </p>
              </div>
              <div className="server-summary">
                <div>
                  <span className="section-label">Игроки</span>
                  <strong>
                    {format(cur.online)}{" "}
                    <small>/ {format(cur.maxplayers)}</small>
                  </strong>
                  <div className="capacity">
                    <b
                      style={{
                        width: `${cur.maxplayers ? Math.min((cur.online / cur.maxplayers) * 100, 100) : 0}%`,
                      }}
                    />
                  </div>
                </div>
                <div>
                  <span className="section-label">Режим и язык</span>
                  <strong className="game-mode">{cur.mode}</strong>
                  <small>{cur.language} · SA-MP 0.3.7</small>
                </div>
              </div>
              <div className="ping-card">
                <div>
                  <span className="section-label">Пинг</span>
                  <span className="muted">Последние измерения</span>
                  <strong>
                    {cur.pingMs === null ? "—" : `${cur.pingMs} мс`}
                  </strong>
                </div>
                <div className="chart">
                  {chart.length > 1 ? (
                    <svg
                      viewBox="0 0 286 76"
                      role="img"
                      aria-label="История пинга"
                    >
                      <path
                        d="M0 20H286 M0 45H286 M0 70H286"
                        stroke="#343439"
                        strokeDasharray="3 4"
                      />
                      <polyline
                        points={graph}
                        stroke="#5b89f7"
                        strokeWidth="2"
                        fill="none"
                      />
                    </svg>
                  ) : (
                    <span>
                      {api.desktop
                        ? "Ожидание измерений пинга"
                        : "Пинг измеряется в приложении"}
                    </span>
                  )}
                </div>
              </div>
              <div className="detail-tabs">
                <button
                  className={detailTab === "players" ? "active" : ""}
                  onClick={() => setDetailTab("players")}
                >
                  Игроки <small>{cur.online}</small>
                </button>
                <button
                  className={detailTab === "rules" ? "active" : ""}
                  onClick={() => setDetailTab("rules")}
                >
                  Правила сервера
                </button>
              </div>
              <div className="detail-content">
                {!details ? (
                  <div className="details-empty">
                    <LoaderCircle className="spin" size={18} /> Получаем данные…
                  </div>
                ) : detailTab === "players" ? (
                  details.players.length ? (
                    <table className="players">
                      <thead>
                        <tr>
                          <th>Ник</th>
                          <th>Очки</th>
                        </tr>
                      </thead>
                      <tbody>
                        {details.players.map((p, i) => (
                          <tr key={`${p.name}-${i}`}>
                            <td>{p.name}</td>
                            <td>{format(p.score)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="details-empty">
                      <Users size={22} />
                      <p>Список игроков недоступен</p>
                      <small>Сервер может ограничивать SA-MP запросы.</small>
                    </div>
                  )
                ) : details.rules.length ? (
                  <dl>
                    {details.rules.map(([k, v], i) => (
                      <div key={`${k}-${i}`}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <div className="details-empty">
                    <Info size={22} />
                    <p>Сервер не предоставил правила</p>
                  </div>
                )}
              </div>
              {cur.source === "custom" && (
                <button
                  className="remove-server"
                  onClick={() => void deleteServer(cur)}
                >
                  <Trash2 size={13} /> Удалить сервер
                </button>
              )}
            </>
          ) : (
            <div className="details-empty panel-placeholder">
              <Gamepad2 size={40} />
              <h2>Выберите сервер</h2>
              <p>Информация и подключение появятся здесь.</p>
            </div>
          )}
        </aside>
      </div>
      <footer className="statusbar">
        <button
          onClick={() => {
            setForm(config);
            setModal("settings");
          }}
        >
          <span className={`status-dot ${config.assetsDir ? "" : "amber"}`} />
          {config.assetsDir ? "Папка игры выбрана" : "Укажите папку игры"}
          <span className="assets-path">{config.assetsDir}</span>
        </button>
        <span>
          {config.engineOverride
            ? "Локальный движок"
            : engine
              ? `Движок ${engine.version}`
              : "Движок не установлен"}
        </span>
        <span className="footer-spacer" />
        <span>
          Игроков <b>{format(totalPlayers)}</b> · отвечают {available} из{" "}
          {scoped.length}
        </span>
        <span className="launcher-version">Launcher {launcherVersion}</span>
      </footer>
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? <Info size={17} /> : <CheckCircle2 size={17} />}
          <span>{notice.text}</span>
          {restartReady && (
            <button onClick={() => void relaunch()}>Перезапустить</button>
          )}
          <IconButton
            label="Закрыть уведомление"
            onClick={() => setNotice(null)}
          >
            <X size={15} />
          </IconButton>
        </div>
      )}
      {modal === "add" && (
        <Dialog title="Добавить сервер" onClose={close}>
          <div className="dialog-body">
            <label className="field">
              Адрес сервера
              <input
                autoFocus
                placeholder="IP:порт или домен"
                value={addAddress}
                onChange={(e) => {
                  setAddAddress(e.target.value);
                  setAddInfo(null);
                  addRequest.current++;
                  setAdding(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addServer();
                }}
              />
            </label>
            <p className="helper">
              Без порта используется 7777. Сервер можно добавить, даже если он
              не отвечает.
            </p>
            <button
              className="secondary full-width"
              disabled={adding || !addAddress.trim()}
              onClick={() => void addServer()}
            >
              {adding ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}{" "}
              Опросить сервер
            </button>
            {addInfo && (
              <div className="query-result">
                <span
                  className={`status-dot ${addInfo.reachable ? "" : "amber"}`}
                />
                <div>
                  <strong>
                    {addInfo.reachable
                      ? addInfo.name
                      : "Сервер пока не ответил"}
                  </strong>
                  <small>
                    {addInfo.reachable
                      ? `${addInfo.online} / ${addInfo.maxplayers} игроков · ${addInfo.pingMs} мс`
                      : addInfo.address}
                  </small>
                </div>
              </div>
            )}
            <label className="field">
              Название <span className="optional">необязательно</span>
              <input
                placeholder="Мой сервер"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </label>
            <Toggle
              checked={addArz}
              onChange={setAddArz}
              label="Использовать режим Arizona"
            />
          </div>
          <footer>
            <button className="secondary" onClick={close}>
              Отмена
            </button>
            <button
              className="primary"
              disabled={!addAddress.trim() || adding}
              onClick={() => void saveServer()}
            >
              <Star size={15} /> В избранное
            </button>
          </footer>
        </Dialog>
      )}
      {modal === "settings" && (
        <Dialog title="Настройки лаунчера" onClose={close} wide>
          <div className="dialog-body settings-body">
            <label className="field">
              Папка GTA San Andreas / Arizona
              <div className="path-field">
                <input
                  placeholder="Выберите установленную игру"
                  value={form.assetsDir}
                  onChange={(e) =>
                    setForm((old) => ({ ...old, assetsDir: e.target.value }))
                  }
                />
                <IconButton
                  label="Выбрать папку игры"
                  onClick={() => void choosePath("assetsDir")}
                >
                  <FolderOpen size={18} />
                </IconButton>
              </div>
            </label>
            <p className="helper">
              Нужны ваши игровые ресурсы. Лаунчер обновляет движок, игровые
              файлы не скачивает.
            </p>
            <label className="field">
              Локальный noveramp <span className="optional">необязательно</span>
              <div className="path-field">
                <input
                  placeholder="Пусто — использовать загруженный движок"
                  value={form.engineOverride}
                  onChange={(e) =>
                    setForm((old) => ({
                      ...old,
                      engineOverride: e.target.value,
                    }))
                  }
                />
                <IconButton
                  label="Выбрать файл движка"
                  onClick={() => void choosePath("engineOverride")}
                >
                  <FolderOpen size={18} />
                </IconButton>
              </div>
            </label>
            <div className="settings-switches">
              <Toggle
                checked={form.autoUpdateEngine}
                onChange={(v) =>
                  setForm((old) => ({ ...old, autoUpdateEngine: v }))
                }
                label="Обновлять движок перед запуском"
              />
              <Toggle
                checked={form.autoUpdateLauncher}
                onChange={(v) =>
                  setForm((old) => ({ ...old, autoUpdateLauncher: v }))
                }
                label="Автоматически обновлять лаунчер"
              />
              <Toggle
                checked={form.hideAfterLaunch}
                onChange={(v) =>
                  setForm((old) => ({ ...old, hideAfterLaunch: v }))
                }
                label="Скрывать лаунчер после запуска игры"
              />
            </div>
            <div className="update-card">
              <div>
                <strong>
                  {engine
                    ? `Движок ${engine.version}`
                    : "Движок ещё не установлен"}
                </strong>
                <small>GitHub · NoveraMP/engine-releases</small>
              </div>
              <button
                className="secondary"
                disabled={busy || running}
                onClick={() => void installEngine()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Download size={14} />
                )}{" "}
                Обновить
              </button>
            </div>
            {busy && progress && (
              <div className="inline-progress">
                <progress max={100} value={progress.percent} />
                <small>{progress.message}</small>
              </div>
            )}
            <button
              className="text-button"
              disabled={launcherBusy || running}
              onClick={() => void checkLauncher(true)}
            >
              <RefreshCw size={14} className={launcherBusy ? "spin" : ""} />{" "}
              Проверить обновление лаунчера
            </button>
          </div>
          <footer>
            <button className="secondary" onClick={close}>
              Отмена
            </button>
            <button
              className="primary"
              onClick={() =>
                void persist(form)
                  .then(() => {
                    close();
                    notify("Настройки сохранены");
                  })
                  .catch((e) => notify(String(e), true))
              }
            >
              <Check size={15} /> Сохранить
            </button>
          </footer>
        </Dialog>
      )}
      {modal === "password" && cur && (
        <Dialog title="Нужен пароль" onClose={close}>
          <div className="dialog-body">
            <div className="dialog-server">
              <strong>{cur.name}</strong>
              <span>{cur.address}</span>
            </div>
            <label className="field">
              Пароль сервера
              <input
                autoFocus
                type="password"
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void connect(password, true);
                }}
              />
            </label>
            <p className="helper">
              Пароль выдаёт администрация сервера. Лаунчер не сохраняет его на
              диск.
            </p>
          </div>
          <footer>
            <button className="secondary" onClick={close}>
              Отмена
            </button>
            <button
              className="primary"
              onClick={() => void connect(password, true)}
            >
              Подключиться <ChevronRight size={15} />
            </button>
          </footer>
        </Dialog>
      )}
      {modal === "connecting" && (
        <Dialog title="Подключение" onClose={close}>
          <div className="dialog-body">
            <div className="dialog-server">
              <strong>{cur?.name ?? "NoveraMP"}</strong>
              <span>{cur?.address}</span>
            </div>
            <div className="connection-status">
              {busy ? (
                <LoaderCircle size={22} className="spin" />
              ) : running ? (
                <CheckCircle2 size={22} />
              ) : (
                <Info size={22} />
              )}
              <span>{progress?.message ?? "Подготовка…"}</span>
            </div>
            <progress max={100} value={progress?.percent ?? 0} />
            <p className="helper">
              {running
                ? "Игровое окно открыто. Подключение продолжится в движке."
                : "Можно скрыть это окно — подготовка продолжится."}
            </p>
          </div>
          <footer>
            <button className="secondary" onClick={close}>
              {busy ? "Скрыть" : "Закрыть"}
            </button>
          </footer>
        </Dialog>
      )}
    </main>
  );
}
