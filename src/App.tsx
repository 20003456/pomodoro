import { Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Mode = "focus" | "short" | "long";

type Settings = {
  focusMinutes: number;
  shortMinutes: number;
  longMinutes: number;
  longEvery: number;
  autoNext: boolean;
  soundEnabled: boolean;
  notifyEnabled: boolean;
};

type SessionLogItem = {
  id: string;
  mode: Mode;
  timestamp: number;
};

type InitialState = {
  settings: Settings;
  completedFocus: number;
  logs: SessionLogItem[];
};

type StoredPayload = {
  date?: unknown;
  completedFocus?: unknown;
  logs?: unknown;
  settings?: unknown;
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

const STORAGE_KEY = "pomodoro-state-v1";
const RING_RADIUS = 104;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const DEFAULT_SETTINGS: Settings = {
  focusMinutes: 25,
  shortMinutes: 5,
  longMinutes: 15,
  longEvery: 4,
  autoNext: true,
  soundEnabled: true,
  notifyEnabled: false,
};

const MODE_META: Record<
  Mode,
  {
    label: string;
    ready: string;
    running: string;
    complete: string;
    settingKey: keyof Pick<Settings, "focusMinutes" | "shortMinutes" | "longMinutes">;
  }
> = {
  focus: {
    label: "专注",
    ready: "准备专注",
    running: "专注中",
    complete: "专注完成",
    settingKey: "focusMinutes",
  },
  short: {
    label: "短休息",
    ready: "准备短休息",
    running: "短休息中",
    complete: "短休息结束",
    settingKey: "shortMinutes",
  },
  long: {
    label: "长休息",
    ready: "准备长休息",
    running: "长休息中",
    complete: "长休息结束",
    settingKey: "longMinutes",
  },
};

const NUMBER_LIMITS = {
  focusMinutes: { min: 1, max: 180 },
  shortMinutes: { min: 1, max: 60 },
  longMinutes: { min: 1, max: 120 },
  longEvery: { min: 1, max: 12 },
} satisfies Record<
  keyof Pick<Settings, "focusMinutes" | "shortMinutes" | "longMinutes" | "longEvery">,
  { min: number; max: number }
>;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function isMode(value: unknown): value is Mode {
  return value === "focus" || value === "short" || value === "long";
}

function todayId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function secondsFor(mode: Mode, settings: Settings): number {
  return settings[MODE_META[mode].settingKey] * 60;
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function nextModeAfter(mode: Mode, completedFocus: number, longEvery: number): Mode {
  if (mode !== "focus") {
    return "focus";
  }

  return completedFocus > 0 && completedFocus % longEvery === 0 ? "long" : "short";
}

function safeReadStorage(): StoredPayload {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as StoredPayload;
  } catch {
    return {};
  }
}

function readInitialState(): InitialState {
  const saved = safeReadStorage();
  const rawSettings =
    saved.settings && typeof saved.settings === "object"
      ? (saved.settings as Record<string, unknown>)
      : {};

  const settings: Settings = {
    focusMinutes: clampNumber(
      rawSettings.focusMinutes ?? rawSettings.focus,
      NUMBER_LIMITS.focusMinutes.min,
      NUMBER_LIMITS.focusMinutes.max,
      DEFAULT_SETTINGS.focusMinutes,
    ),
    shortMinutes: clampNumber(
      rawSettings.shortMinutes ?? rawSettings.short,
      NUMBER_LIMITS.shortMinutes.min,
      NUMBER_LIMITS.shortMinutes.max,
      DEFAULT_SETTINGS.shortMinutes,
    ),
    longMinutes: clampNumber(
      rawSettings.longMinutes ?? rawSettings.long,
      NUMBER_LIMITS.longMinutes.min,
      NUMBER_LIMITS.longMinutes.max,
      DEFAULT_SETTINGS.longMinutes,
    ),
    longEvery: clampNumber(
      rawSettings.longEvery,
      NUMBER_LIMITS.longEvery.min,
      NUMBER_LIMITS.longEvery.max,
      DEFAULT_SETTINGS.longEvery,
    ),
    autoNext:
      typeof rawSettings.autoNext === "boolean"
        ? rawSettings.autoNext
        : DEFAULT_SETTINGS.autoNext,
    soundEnabled:
      typeof rawSettings.soundEnabled === "boolean"
        ? rawSettings.soundEnabled
        : DEFAULT_SETTINGS.soundEnabled,
    notifyEnabled:
      typeof rawSettings.notifyEnabled === "boolean" &&
      rawSettings.notifyEnabled &&
      "Notification" in window &&
      Notification.permission === "granted",
  };

  if (saved.date !== todayId()) {
    return {
      settings,
      completedFocus: 0,
      logs: [],
    };
  }

  const completedFocus = clampNumber(saved.completedFocus, 0, 999, 0);
  const logs = Array.isArray(saved.logs)
    ? saved.logs
        .flatMap((entry): SessionLogItem[] => {
          if (!entry || typeof entry !== "object") {
            return [];
          }

          const rawEntry = entry as Record<string, unknown>;
          const logMode = rawEntry.mode;
          const timestamp = Number(rawEntry.timestamp);

          if (!isMode(logMode) || !Number.isFinite(timestamp)) {
            return [];
          }

          return [
            {
              id: `${logMode}-${timestamp}`,
              mode: logMode,
              timestamp,
            },
          ];
        })
        .slice(0, 6)
    : [];

  return {
    settings,
    completedFocus,
    logs,
  };
}

function playTone(): void {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return;
  }

  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(740, context.currentTime);
  oscillator.frequency.setValueAtTime(540, context.currentTime + 0.12);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.4);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.42);
}

function App() {
  const initialState = useMemo(readInitialState, []);
  const [settings, setSettings] = useState<Settings>(initialState.settings);
  const [mode, setMode] = useState<Mode>("focus");
  const [isRunning, setIsRunning] = useState(false);
  const [total, setTotal] = useState(() => secondsFor("focus", initialState.settings));
  const [remaining, setRemaining] = useState(() => secondsFor("focus", initialState.settings));
  const [completedFocus, setCompletedFocus] = useState(initialState.completedFocus);
  const [logs, setLogs] = useState<SessionLogItem[]>(initialState.logs);

  const timeText = formatTime(remaining);
  const progress = total <= 0 ? 0 : remaining / total;
  const activeMeta = MODE_META[mode];
  const statusLabel = isRunning ? activeMeta.running : activeMeta.ready;
  const themeClass = mode === "focus" ? "" : `theme-${mode}`;

  const persistState = useCallback(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          date: todayId(),
          completedFocus,
          logs: logs.map(({ mode: logMode, timestamp }) => ({
            mode: logMode,
            timestamp,
          })),
          settings,
        }),
      );
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
  }, [completedFocus, logs, settings]);

  const alertUser = useCallback(
    (message: string) => {
      if (settings.soundEnabled) {
        playTone();
      }

      if (
        settings.notifyEnabled &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          new Notification("番茄钟", { body: message });
        } catch {
          // Notification construction can fail in some embedded browsers.
        }
      }
    },
    [settings.notifyEnabled, settings.soundEnabled],
  );

  const applyMode = useCallback(
    (nextMode: Mode, shouldRun = false) => {
      const nextTotal = secondsFor(nextMode, settings);
      setMode(nextMode);
      setTotal(nextTotal);
      setRemaining(nextTotal);
      setIsRunning(shouldRun);
    },
    [settings],
  );

  const resetTimer = useCallback(() => {
    const nextTotal = secondsFor(mode, settings);
    setIsRunning(false);
    setTotal(nextTotal);
    setRemaining(nextTotal);
  }, [mode, settings]);

  const toggleTimer = useCallback(() => {
    if (!isRunning && remaining <= 0) {
      const nextTotal = secondsFor(mode, settings);
      setTotal(nextTotal);
      setRemaining(nextTotal);
    }

    setIsRunning((current) => !current);
  }, [isRunning, mode, remaining, settings]);

  const addLog = useCallback((completedMode: Mode) => {
    const timestamp = Date.now();
    setLogs((current) =>
      [
        {
          id: `${completedMode}-${timestamp}`,
          mode: completedMode,
          timestamp,
        },
        ...current,
      ].slice(0, 6),
    );
  }, []);

  const completeSession = useCallback(
    (countCompletion: boolean) => {
      const completedMode = mode;
      const nextCompletedFocus =
        countCompletion && completedMode === "focus" ? completedFocus + 1 : completedFocus;
      const upcomingMode = nextModeAfter(completedMode, nextCompletedFocus, settings.longEvery);

      setIsRunning(false);

      if (countCompletion) {
        if (completedMode === "focus") {
          setCompletedFocus(nextCompletedFocus);
        }

        addLog(completedMode);
        alertUser(MODE_META[completedMode].complete);
      }

      applyMode(upcomingMode, settings.autoNext);
    },
    [addLog, alertUser, applyMode, completedFocus, mode, settings.autoNext, settings.longEvery],
  );

  const updateNumberSetting = useCallback(
    (
      key: keyof Pick<Settings, "focusMinutes" | "shortMinutes" | "longMinutes" | "longEvery">,
      value: number,
      affectedMode?: Mode,
    ) => {
      const limits = NUMBER_LIMITS[key];
      const nextValue = clampNumber(value, limits.min, limits.max, DEFAULT_SETTINGS[key]);

      setSettings((current) => ({
        ...current,
        [key]: nextValue,
      }));

      if (affectedMode && affectedMode === mode && !isRunning) {
        const nextTotal = nextValue * 60;
        setTotal(nextTotal);
        setRemaining(nextTotal);
      }
    },
    [isRunning, mode],
  );

  const updateBooleanSetting = useCallback(
    (key: keyof Pick<Settings, "autoNext" | "soundEnabled">, value: boolean) => {
      setSettings((current) => ({
        ...current,
        [key]: value,
      }));
    },
    [],
  );

  const updateNotifySetting = useCallback(async (enabled: boolean) => {
    if (!enabled) {
      setSettings((current) => ({ ...current, notifyEnabled: false }));
      return;
    }

    if (!("Notification" in window)) {
      setSettings((current) => ({ ...current, notifyEnabled: false }));
      return;
    }

    const permission = await Notification.requestPermission();
    setSettings((current) => ({
      ...current,
      notifyEnabled: permission === "granted",
    }));
  }, []);

  useEffect(() => {
    if (!isRunning) {
      return undefined;
    }

    let lastTick = Date.now();
    const timerId = window.setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - lastTick) / 1000);

      if (elapsed < 1) {
        return;
      }

      lastTick += elapsed * 1000;
      setRemaining((current) => Math.max(0, current - elapsed));
    }, 250);

    return () => window.clearInterval(timerId);
  }, [isRunning]);

  useEffect(() => {
    if (remaining === 0 && isRunning) {
      completeSession(true);
    }
  }, [completeSession, isRunning, remaining]);

  useEffect(() => {
    document.title = `${isRunning ? "进行中" : "番茄钟"} ${timeText} - ${activeMeta.label}`;
  }, [activeMeta.label, isRunning, timeText]);

  useEffect(() => {
    persistState();
  }, [persistState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        toggleTimer();
      }

      if (event.key.toLowerCase() === "r") {
        resetTimer();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [resetTimer, toggleTimer]);

  return (
    <main className={`app-shell ${themeClass}`} aria-labelledby="app-title">
      <section className="timer-panel">
        <div className="topbar">
          <div>
            <p className="eyebrow">Pomodoro</p>
            <h1 id="app-title">番茄钟</h1>
          </div>
          <div className="rounds" aria-live="polite">
            <span>{completedFocus}</span>
            <small>已完成</small>
          </div>
        </div>

        <div className="mode-tabs" role="tablist" aria-label="计时模式">
          {(Object.keys(MODE_META) as Mode[]).map((option) => (
            <button
              className={`mode-btn ${option === mode ? "active" : ""}`}
              type="button"
              key={option}
              role="tab"
              aria-selected={option === mode}
              onClick={() => applyMode(option, false)}
            >
              {MODE_META[option].label}
            </button>
          ))}
        </div>

        <div className="timer-stage" aria-live="polite">
          <svg className="progress-ring" viewBox="0 0 240 240" aria-hidden="true">
            <circle className="ring-bg" cx="120" cy="120" r={RING_RADIUS}></circle>
            <circle
              className="ring-progress"
              cx="120"
              cy="120"
              r={RING_RADIUS}
              strokeDasharray={RING_LENGTH}
              strokeDashoffset={RING_LENGTH * (1 - progress)}
            ></circle>
          </svg>
          <div className="time-readout">
            <span>{timeText}</span>
            <small>{statusLabel}</small>
          </div>
        </div>

        <div className="controls" aria-label="计时控制">
          <button className="icon-btn" type="button" title="重置" aria-label="重置" onClick={resetTimer}>
            <RotateCcw aria-hidden="true" size={26} strokeWidth={2.4} />
          </button>
          <button className="primary-btn" type="button" onClick={toggleTimer}>
            {isRunning ? (
              <Pause aria-hidden="true" size={22} strokeWidth={2.7} />
            ) : (
              <Play aria-hidden="true" size={22} strokeWidth={2.7} />
            )}
            <span>{isRunning ? "暂停" : "开始"}</span>
          </button>
          <button className="icon-btn" type="button" title="跳过" aria-label="跳过" onClick={() => completeSession(false)}>
            <SkipForward aria-hidden="true" size={27} strokeWidth={2.4} />
          </button>
        </div>
      </section>

      <aside className="settings-panel" aria-label="设置">
        <div className="setting-card">
          <div className="setting-header">
            <h2>时长</h2>
            <span>分钟</span>
          </div>

          <label className="number-field">
            <span>专注</span>
            <input
              type="number"
              min={NUMBER_LIMITS.focusMinutes.min}
              max={NUMBER_LIMITS.focusMinutes.max}
              value={settings.focusMinutes}
              onChange={(event) =>
                updateNumberSetting("focusMinutes", event.currentTarget.valueAsNumber, "focus")
              }
            />
          </label>
          <label className="number-field">
            <span>短休息</span>
            <input
              type="number"
              min={NUMBER_LIMITS.shortMinutes.min}
              max={NUMBER_LIMITS.shortMinutes.max}
              value={settings.shortMinutes}
              onChange={(event) =>
                updateNumberSetting("shortMinutes", event.currentTarget.valueAsNumber, "short")
              }
            />
          </label>
          <label className="number-field">
            <span>长休息</span>
            <input
              type="number"
              min={NUMBER_LIMITS.longMinutes.min}
              max={NUMBER_LIMITS.longMinutes.max}
              value={settings.longMinutes}
              onChange={(event) =>
                updateNumberSetting("longMinutes", event.currentTarget.valueAsNumber, "long")
              }
            />
          </label>
          <label className="number-field">
            <span>长休息间隔</span>
            <input
              type="number"
              min={NUMBER_LIMITS.longEvery.min}
              max={NUMBER_LIMITS.longEvery.max}
              value={settings.longEvery}
              onChange={(event) => updateNumberSetting("longEvery", event.currentTarget.valueAsNumber)}
            />
          </label>
        </div>

        <div className="setting-card compact">
          <label className="switch-row">
            <span>自动进入下一轮</span>
            <input
              type="checkbox"
              checked={settings.autoNext}
              onChange={(event) => updateBooleanSetting("autoNext", event.currentTarget.checked)}
            />
          </label>
          <label className="switch-row">
            <span>提示音</span>
            <input
              type="checkbox"
              checked={settings.soundEnabled}
              onChange={(event) => updateBooleanSetting("soundEnabled", event.currentTarget.checked)}
            />
          </label>
          <label className="switch-row">
            <span>桌面通知</span>
            <input
              type="checkbox"
              checked={settings.notifyEnabled}
              onChange={(event) => void updateNotifySetting(event.currentTarget.checked)}
            />
          </label>
        </div>

        <div className="session-log" aria-label="记录">
          <h2>今日记录</h2>
          {logs.length === 0 ? (
            <p className="empty-log">暂无记录</p>
          ) : (
            <ul>
              {logs.map((item) => (
                <li key={item.id}>
                  <span>{MODE_META[item.mode].label}</span>
                  <time dateTime={new Date(item.timestamp).toISOString()}>
                    {new Date(item.timestamp).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </main>
  );
}

export default App;
