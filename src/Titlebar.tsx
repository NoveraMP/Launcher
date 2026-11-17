import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { desktop } from "./api";

type Props = { onError: (message: string, error: boolean) => void };

export default function Titlebar({ onError }: Props) {
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!desktop) return;
    const current = getCurrentWindow();
    let disposed = false;
    const unsubscribers: (() => void)[] = [];
    const failed = (error: unknown) => {
      if (!disposed) onError(`Управление окном: ${error}`, true);
    };
    const syncMaximized = () =>
      current.isMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      });
    void syncMaximized().catch(failed);
    void current
      .isFocused()
      .then((value) => {
        if (!disposed) setFocused(value);
      })
      .catch(failed);
    void Promise.all([
      current.onResized(() => void syncMaximized().catch(failed)),
      current.onFocusChanged(({ payload }) => setFocused(payload)),
    ])
      .then((listeners) => {
        if (disposed) listeners.forEach((unlisten) => unlisten());
        else unsubscribers.push(...listeners);
      })
      .catch(failed);
    return () => {
      disposed = true;
      unsubscribers.forEach((unlisten) => unlisten());
    };
  }, [onError]);

  const action = (operation: "minimize" | "toggleMaximize" | "close") => {
    if (!desktop) return;
    void getCurrentWindow()
      [operation]()
      .catch((error) => onError(`Управление окном: ${error}`, true));
  };
  const maximizeLabel = maximized ? "Восстановить окно" : "Развернуть окно";

  return (
    <div className={`window-titlebar ${focused ? "focused" : ""}`}>
      <div className="window-drag-region" data-tauri-drag-region="deep">
        <img
          className="window-title-mark"
          src="/brand/icon.png"
          alt=""
          draggable={false}
        />
        <span>NoveraMP Launcher</span>
      </div>
      <div className="window-controls" data-tauri-drag-region="false">
        <button
          type="button"
          aria-label="Свернуть окно"
          title="Свернуть"
          disabled={!desktop}
          onClick={() => action("minimize")}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          aria-label={maximizeLabel}
          title={maximizeLabel}
          disabled={!desktop}
          onClick={() => action("toggleMaximize")}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          type="button"
          className="window-close"
          aria-label="Закрыть лаунчер"
          title="Закрыть"
          disabled={!desktop}
          onClick={() => action("close")}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
