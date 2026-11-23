/** @jsxRuntime automatic */
/** @jsxImportSource react */
// The terminal view of an endless run.
//
// It folds the engine's events into a RunState (./events.mts) and draws it:
// a status header, one row per agent, the newest notices, and a full-screen
// log view. Keys go to the Control (./control.mts); the view never touches
// the loop in any other way.

import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Box, measureElement, render, Text, useApp, useInput, useWindowSize, type DOMElement } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import type { Control } from "./control.mts";
import { initialState, reduce, type AgentRow, type RunEvent, type RunState } from "./events.mts";
import { formatTokens } from "./format.mts";
import type { UiElement } from "./plugin.mts";
import { SettingsWindow } from "./settings.tsx";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class RunStore {
  private state: RunState = initialState();
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = () => this.state;

  apply(event: RunEvent): void {
    this.state = reduce(this.state, event);
    for (const listener of this.listeners) listener();
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const duration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
};

/** A wall-clock time, "14:05". */
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const cell = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);

const shortModel = (model?: string) =>
  (model ?? "—").replace(/^claude-/, "");

const ROLE_COLOR: Record<string, string> = {
  planner: "magenta",
  implementer: "cyan",
  reviewer: "yellow",
  merger: "green",
  queued: "gray",
};

const OUTCOME: Record<string, { mark: string; color: string }> = {
  done: { mark: "✓", color: "green" },
  failed: { mark: "✗", color: "red" },
  blocked: { mark: "⛔", color: "red" },
  aborted: { mark: "■", color: "gray" },
  "no-commits": { mark: "∅", color: "gray" },
  "needs-human": { mark: "?", color: "yellow" },
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

type MeterElement = Extract<UiElement, { kind: "meter" }>;

function Meter({ element }: { element: MeterElement }) {
  const width = 12;
  const { label, percent, stop = 100 } = element;
  const warn = element.warn ?? stop - 15;
  if (percent === undefined) {
    return (
      <Text>
        {label} <Text dimColor>{"·".repeat(width)} --%</Text>
      </Text>
    );
  }
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  const color = percent >= stop ? "red" : percent >= warn ? "yellow" : "green";
  return (
    <Text>
      {label} <Text color={color}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(width - filled)}</Text>{" "}
      <Text color={color}>{percent.toFixed(0).padStart(3)}%</Text>
    </Text>
  );
}

const BADGE_COLOR = { ok: "green", warn: "yellow", error: "red" } as const;

/** One declarative element of a plugin's header slot. */
function Element({ element }: { element: UiElement }) {
  if (element.kind === "meter") return <Meter element={element} />;
  if (element.kind === "badge") return <Text color={BADGE_COLOR[element.level]}>{element.text}</Text>;
  return <Text dimColor>{element.text}</Text>;
}

function Header({ state, now }: { state: RunState; now: number }) {
  const spin = SPINNER[Math.floor(now / 100) % SPINNER.length];
  let phase: ReactNode;
  if (state.phase === "wait" && state.waitUntil) {
    phase = (
      <Text color="yellow">
        ⏸ waiting {duration(state.waitUntil - now)} <Text dimColor>— {state.waitReason}</Text>
      </Text>
    );
  } else if (state.phase === "done") {
    phase = <Text color="green">done</Text>;
  } else {
    phase = (
      <Text color="cyan">
        {spin} {state.phase}
      </Text>
    );
  }

  return (
    <Box borderStyle="round" borderColor={state.stop === "none" ? "cyan" : "red"} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color="cyan">
            SANDCASTLE
          </Text>{" "}
          <Text dimColor>{state.mode}</Text> · base <Text bold>{state.base}</Text> · iteration{" "}
          <Text bold>{state.iteration}</Text>
          {state.maxIterations ? `/${state.maxIterations}` : ""}
        </Text>
        <Box gap={2}>
          {Object.entries(state.header).flatMap(([plugin, elements]) =>
            elements.map((element, i) => <Element key={`${plugin}:${i}`} element={element} />),
          )}
        </Box>
      </Box>
      <Box justifyContent="space-between">
        {phase}
        {state.stop === "soft" && (
          <Text color="red" bold>
            ■ STOP REQUESTED — running agents finish, then merge and exit (s cancels)
          </Text>
        )}
        {state.stop === "hard" && (
          <Text color="red" bold>
            ■ HARD STOP — aborting agents
          </Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Agent table
// ---------------------------------------------------------------------------

export interface ListItem {
  key: string;
  kind: "orchestrator" | "agent" | "history" | "history-header";
  row?: AgentRow;
  logPath?: string;
}

export function listItems(state: RunState, orchestratorPath: string): ListItem[] {
  const items: ListItem[] = [{ key: "orchestrator", kind: "orchestrator", logPath: orchestratorPath }];
  for (const row of state.agents) items.push({ key: `a:${row.key}`, kind: "agent", row, logPath: row.logPath });
  if (state.history.length > 0) {
    items.push({ key: "history", kind: "history-header" });
    state.history.forEach((row, i) =>
      items.push({ key: `h:${i}:${row.key}`, kind: "history", row, logPath: row.logPath }),
    );
  }
  return items;
}

const COLS = { issue: 20, role: 11, model: 9, start: 5, time: 8, tools: 6, context: 5, commits: 4 };

function TableHeader() {
  return (
    <Text dimColor>
      {"  "}
      {cell("ISSUE", COLS.issue)} {cell("ROLE", COLS.role)} {cell("MODEL", COLS.model)}{" "}
      {cell("START", COLS.start)} {cell("TIME", COLS.time)}{" "}
      {cell("TOOLS", COLS.tools)} {cell("CTX", COLS.context)}{" "}
      {cell("⎇", COLS.commits)} LAST ACTION
    </Text>
  );
}

function AgentLine({ row, selected, now, dim }: { row: AgentRow; selected: boolean; now: number; dim: boolean }) {
  const outcome = row.outcome ? OUTCOME[row.outcome] : undefined;
  const spin = SPINNER[Math.floor(now / 100) % SPINNER.length];
  const mark = outcome ? outcome.mark : row.role === "queued" ? "·" : spin;
  const markColor = outcome ? outcome.color : row.role === "queued" ? "gray" : "cyan";
  const elapsed = row.startedAt ? duration((row.endedAt ?? now) - row.startedAt) : "";
  const started = row.taskStartedAt ? clock(row.taskStartedAt) : "";
  const label = row.issue ? `#${row.issue}` : row.key;
  const last = row.last ?? row.title ?? "";

  return (
    <Box>
      <Text inverse={selected} dimColor={dim} wrap="truncate-end">
        <Text color={markColor}>{mark}</Text> {cell(label, COLS.issue)}{" "}
        <Text color={ROLE_COLOR[row.role] ?? "white"}>{cell(row.role, COLS.role)}</Text>{" "}
        {cell(shortModel(row.model), COLS.model)}{" "}
        {cell(started, COLS.start)} {cell(elapsed, COLS.time)} {cell(row.tools ? String(row.tools) : "", COLS.tools)}{" "}
        {cell(row.context === undefined ? "" : formatTokens(row.context), COLS.context)}{" "}
        {cell(row.commits ? String(row.commits) : "", COLS.commits)}{" "}
        {row.note ? <Text color="magenta">[{row.note}] </Text> : null}
        <Text dimColor={!selected}>{last}</Text>
      </Text>
    </Box>
  );
}

function AgentTable({
  items,
  selected,
  now,
  height,
}: {
  items: ListItem[];
  selected: number;
  now: number;
  height: number;
}) {
  // Keep the selected row in view.
  const first = Math.max(0, Math.min(selected - Math.floor(height / 2), items.length - height));
  const visible = items.slice(first, first + height);

  return (
    <Box flexDirection="column" paddingX={1}>
      <TableHeader />
      {visible.map((item, i) => {
        const index = first + i;
        if (item.kind === "orchestrator") {
          return (
            <Text key={item.key} inverse={index === selected} wrap="truncate-end">
              <Text color="blue">≡</Text> {cell("run", COLS.issue)} <Text color="blue">{cell("orchestrator", COLS.role)}</Text>{" "}
              <Text dimColor>{item.logPath ? basename(item.logPath) : ""}</Text>
            </Text>
          );
        }
        if (item.kind === "history-header") {
          return (
            <Text key={item.key} dimColor>
              ── history ──
            </Text>
          );
        }
        return (
          <AgentLine
            key={item.key}
            row={item.row!}
            selected={index === selected}
            now={now}
            dim={item.kind === "history"}
          />
        );
      })}
    </Box>
  );
}

function Notices({ state, height }: { state: RunState; height: number }) {
  const shown = state.notices.slice(-height);
  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} borderDimColor>
      {shown.map((notice, i) => (
        <Text
          key={`${notice.at}-${i}`}
          wrap="truncate-end"
          color={notice.level === "error" ? "red" : notice.level === "warn" ? "yellow" : undefined}
          dimColor={notice.level === "info"}
        >
          {new Date(notice.at).toLocaleTimeString("en-GB")} {notice.text}
        </Text>
      ))}
    </Box>
  );
}

function Footer({ hint }: { hint?: string }) {
  return (
    <Box paddingX={1}>
      <Text dimColor wrap="truncate-end">
        {hint ??
          "↑↓ select · ⏎ log · o pager · s stop/cancel · K hard stop · w check now · ? help"}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Log view
// ---------------------------------------------------------------------------

const MAX_LOG_LINES = 20_000;

/** Reads a growing file: the lines so far, then the lines added since. */
function useTail(path: string | undefined): string[] {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!path) return;
    let offset = 0;
    let partial = "";
    let all: string[] = [];
    const read = () => {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return;
      }
      if (size < offset) {
        offset = 0;
        all = [];
        partial = "";
      }
      if (size === offset) return;
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        readSync(fd, buffer, 0, buffer.length, offset);
        offset = size;
        const text = partial + buffer.toString("utf8");
        const parts = text.split("\n");
        partial = parts.pop() ?? "";
        all = all.concat(parts).slice(-MAX_LOG_LINES);
        setLines(all);
      } finally {
        closeSync(fd);
      }
    };
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [path]);

  return lines;
}

/** The colour of a log line: tool calls stand apart from the agent's text. */
export function lineStyle(line: string): { color?: string; dim?: boolean } {
  if (/^[A-Z][A-Za-z_]*(__[\w-]+)*\(/.test(line) || /^mcp__/.test(line)) return { color: "cyan" };
  if (/^(--- Run started|Iteration \d|Setting up|Expanding|Agent (started|stopped)|Syncing|Collecting|Run complete|Agent signaled)/.test(line)) {
    return { dim: true };
  }
  if (/^\s*(✗|Error|error:)/.test(line)) return { color: "red" };
  return {};
}

/** The issue an agent works on, shown above its log. */
export interface TaskInfo {
  title: string;
  body: string;
}

/** The body lines the task panel shows: blank runs folded to one. */
export function taskLines(body: string): string[] {
  const lines: string[] = [];
  for (const raw of body.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line && (lines.length === 0 || lines[lines.length - 1] === "")) continue;
    lines.push(line);
  }
  while (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Rows measured after a render: the whole panel, its scroll window, and the body inside. */
type PanelSizes = { panel: number; viewport: number; content: number };

/** Layout metrics read after each render; the same object comes back while they do not change. */
function useMeasured<T extends object>(initial: T, measure: () => T | undefined): T {
  const [sizes, setSizes] = useState(initial);
  useEffect(() => {
    const next = measure();
    if (!next) return;
    setSizes((prev) => {
      for (const key of Object.keys(next) as (keyof T)[]) if (prev[key] !== next[key]) return next;
      return prev;
    });
  });
  return sizes;
}

type PanelRefs = { [K in keyof PanelSizes]: RefObject<DOMElement | null> };

/**
 * The task above an implementer log. Lines wrap; the body scrolls inside a
 * window capped at `maxHeight` rows, the title stays put above it.
 */
function TaskPanel({
  task,
  lines,
  maxHeight,
  offset,
  focused,
  position,
  refs,
}: {
  task: TaskInfo;
  lines: string[];
  maxHeight: number;
  offset: number;
  focused: boolean;
  position?: string;
  refs: PanelRefs;
}) {
  return (
    <Box
      ref={refs.panel}
      flexDirection="column"
      maxHeight={maxHeight}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      <Box flexShrink={0} paddingX={1} justifyContent="space-between">
        <Text bold color={focused ? "cyan" : undefined} wrap="wrap">
          {task.title}
        </Text>
        {position && <Text dimColor> {position}</Text>}
      </Box>
      <Box ref={refs.viewport} flexDirection="column" overflow="hidden" contentOffsetY={offset}>
        <Box ref={refs.content} flexShrink={0} flexDirection="column" paddingX={1}>
          {lines.map((line, i) => (
            <Text key={i} dimColor wrap="wrap">
              {line || " "}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

function LogView({
  path,
  title,
  task,
  height,
  onClose,
  onPager,
}: {
  path: string;
  title: string;
  task?: TaskInfo;
  height: number;
  onClose: () => void;
  onPager: () => void;
}) {
  const lines = useTail(path);
  const [showTask, setShowTask] = useState(true);
  const [focus, setFocus] = useState<"log" | "task">("log");
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(true);
  const [top, setTop] = useState(0);
  const [taskTop, setTaskTop] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState<number | undefined>();

  // The task panel takes at most a third of the screen: title, body, rule.
  // Its lines wrap, so its real height comes from the render, one frame late.
  const panelShown = Boolean(task) && showTask;
  const panelLines = task && panelShown ? taskLines(task.body) : [];
  const panelMax = Math.max(3, Math.floor(height / 3));
  const panelRefs: PanelRefs = { panel: useRef(null), viewport: useRef(null), content: useRef(null) };
  const panelSizes = useMeasured<PanelSizes>(
    { panel: panelShown ? Math.min(panelMax, panelLines.length + 2) : 0, viewport: 0, content: 0 },
    () => {
      if (!panelShown) return { panel: 0, viewport: 0, content: 0 };
      const { panel, viewport, content } = panelRefs;
      if (!panel.current || !viewport.current || !content.current) return undefined;
      return {
        panel: measureElement(panel.current).height,
        viewport: measureElement(viewport.current).clientHeight,
        content: measureElement(content.current).height,
      };
    },
  );
  const taskMax = Math.max(0, panelSizes.content - panelSizes.viewport);
  const taskOffset = Math.min(taskTop, taskMax);
  const taskFocused = panelShown && focus === "task";

  const bodyHeight = Math.max(3, height - 3 - panelSizes.panel);
  // Wrapped, a line may take several rows: the window is `bodyHeight` lines
  // from `start`, and Ink clips the rest. In follow mode the window is the
  // last lines, shifted up so that the newest row sits at the bottom.
  const maxTop = Math.max(0, wrap ? lines.length - 1 : lines.length - bodyHeight);
  const start = follow ? Math.max(0, lines.length - bodyHeight) : Math.min(top, maxTop);
  const logRef = useRef<DOMElement>(null);
  const logSizes = useMeasured<{ content: number }>({ content: 0 }, () =>
    wrap && logRef.current ? { content: measureElement(logRef.current).height } : { content: 0 },
  );
  const logOffset = wrap && follow ? Math.max(0, logSizes.content - bodyHeight) : 0;

  const find = (from: number, text: string) => {
    if (!text) return;
    const needle = text.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const index = (from + i) % lines.length;
      if (lines[index]!.toLowerCase().includes(needle)) {
        setHit(index);
        setFollow(false);
        setTop(Math.max(0, index - Math.floor(bodyHeight / 3)));
        return;
      }
    }
    setHit(undefined);
  };

  useInput((input, key) => {
    if (searching) {
      if (key.return) {
        setSearching(false);
        find(start, query);
      } else if (key.escape) {
        setSearching(false);
      } else if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
      }
      return;
    }
    const scroll = (delta: number) => {
      setFollow(false);
      setTop(Math.max(0, Math.min(maxTop, start + delta)));
    };
    const scrollTask = (delta: number) => setTaskTop(Math.max(0, Math.min(taskMax, taskOffset + delta)));
    const page = taskFocused ? Math.max(1, panelSizes.viewport) : bodyHeight;
    if (key.escape || input === "q") onClose();
    else if (key.tab) {
      if (panelShown) setFocus((pane) => (pane === "log" ? "task" : "log"));
    } else if (key.upArrow || input === "k") (taskFocused ? scrollTask : scroll)(-1);
    else if (key.downArrow || input === "j") (taskFocused ? scrollTask : scroll)(1);
    else if (key.pageUp || input === "b") (taskFocused ? scrollTask : scroll)(-page);
    else if (key.pageDown || input === " ") (taskFocused ? scrollTask : scroll)(page);
    else if (input === "g") {
      if (taskFocused) setTaskTop(0);
      else {
        setFollow(false);
        setTop(0);
      }
    } else if (input === "G") {
      if (taskFocused) setTaskTop(taskMax);
      else setFollow(true);
    } else if (input === "/") {
      setQuery("");
      setSearching(true);
    } else if (input === "n") find((hit ?? start) + 1, query);
    else if (input === "o") onPager();
    else if (input === "w") setWrap((on) => !on);
    else if (input === "i" && task) {
      setShowTask((shown) => !shown);
      setFocus("log");
    }
  });

  const visible = lines.slice(start, start + bodyHeight);
  const keys = [
    "esc back",
    task ? "tab focus" : "",
    "↑↓ PgUp PgDn scroll",
    "g top",
    "G follow",
    "/ search",
    "n next",
    "o pager",
    `w ${wrap ? "cut" : "wrap"}`,
    task ? "i task" : "",
  ].filter(Boolean);
  return (
    <Box flexDirection="column" height={height}>
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color={taskFocused ? undefined : "cyan"} wrap="truncate-end">
          {title} <Text dimColor>{path}</Text>
        </Text>
        <Text color={follow ? "green" : "yellow"}>{follow ? "● follow" : `${start + 1}/${lines.length}`}</Text>
      </Box>
      {task && panelShown && (
        <TaskPanel
          task={task}
          lines={panelLines}
          maxHeight={panelMax}
          offset={taskOffset}
          focused={taskFocused}
          position={taskMax > 0 ? `${taskOffset + 1}/${panelSizes.content}` : undefined}
          refs={panelRefs}
        />
      )}
      <Box flexDirection="column" height={bodyHeight} overflow="hidden" contentOffsetY={logOffset}>
        <Box ref={logRef} flexShrink={0} flexDirection="column" paddingX={1}>
          {visible.length === 0 && <Text dimColor>(empty — waiting for output)</Text>}
          {visible.map((line, i) => {
            const style = lineStyle(line);
            const isHit = hit === start + i;
            return (
              <Text key={start + i} wrap={wrap ? "wrap" : "truncate-end"} color={style.color} dimColor={style.dim} inverse={isHit}>
                {line || " "}
              </Text>
            );
          })}
        </Box>
      </Box>
      <Footer hint={searching ? `/${query}▏ (⏎ find · esc cancel)` : keys.join(" · ")} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function Dialog({ title, lines, color = "yellow" }: { title: string; lines: string[]; color?: string }) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={color} paddingX={2} paddingY={0} alignSelf="center">
      <Text bold color={color}>
        {title}
      </Text>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}

const HELP = [
  "↑ ↓        select a row",
  "⏎          open the log of the row, full screen",
  "o          open the log in $PAGER (less)",
  "s          stop: running agents finish, merge, exit; press again to cancel",
  "K          hard stop: abort the agents now, no merge (asks first)",
  "w          check for work now, skip the pause",
  "c          settings: the config file, saved for the next iteration",
  "Ctrl-C     choose soft stop / hard stop / cancel",
  "?          this help",
  "",
  "In the log: esc back · tab focus task/log · ↑↓ PgUp PgDn scroll · g top · G follow · / search · n next · w wrap · i task",
];

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type Screen =
  | { kind: "main" }
  | { kind: "log"; path: string; title: string; task?: TaskInfo }
  | { kind: "help" }
  | { kind: "settings" }
  | { kind: "hard" }
  | { kind: "ctrl-c" }
  | { kind: "confirm"; text: string[]; resolve: (yes: boolean) => void };

export interface AppProps {
  store: RunStore;
  control: Control;
  orchestratorPath: string;
  confirmations: ConfirmQueue;
  /** The config file the settings window edits; without it the key does nothing. */
  configFile?: string;
}

export class ConfirmQueue {
  private listener: ((text: string[], resolve: (yes: boolean) => void) => void) | undefined;
  private pending: { text: string[]; resolve: (yes: boolean) => void }[] = [];

  ask(text: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.listener) this.listener(text, resolve);
      else this.pending.push({ text, resolve });
    });
  }

  listen(listener: (text: string[], resolve: (yes: boolean) => void) => void): void {
    this.listener = listener;
    for (const item of this.pending.splice(0)) listener(item.text, item.resolve);
  }
}

export function App({ store, control, orchestratorPath, confirmations, configFile }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const now = useNow(state.agents.some((row) => !row.outcome && row.role !== "queued") ? 100 : 1000);
  const { columns, rows } = useWindowSize();
  const { suspendTerminal } = useApp();
  const [screen, setScreen] = useState<Screen>({ kind: "main" });
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    confirmations.listen((text, resolve) => setScreen({ kind: "confirm", text, resolve }));
  }, [confirmations]);

  const items = useMemo(() => listItems(state, orchestratorPath), [state, orchestratorPath]);
  const current = items[Math.min(selected, items.length - 1)];

  const openPager = (path?: string) => {
    if (!path) return;
    void suspendTerminal(
      () =>
        new Promise<void>((resolve) => {
          const pager = process.env.PAGER || "less";
          const child = spawn(pager, pager === "less" ? ["+G", "-R", path] : [path], { stdio: "inherit" });
          child.on("exit", () => resolve());
          child.on("error", () => resolve());
        }),
    );
  };

  const titleOf = (item?: ListItem) =>
    item?.kind === "orchestrator"
      ? "orchestrator"
      : item?.row
        ? `${item.row.issue ? `#${item.row.issue} ` : ""}${item.row.role}`
        : "";

  useInput(
    (input, key) => {
      if (screen.kind === "confirm") {
        if (input === "y" || input === "Y") {
          screen.resolve(true);
          setScreen({ kind: "main" });
        } else if (input === "n" || input === "N" || key.escape) {
          screen.resolve(false);
          setScreen({ kind: "main" });
        }
        return;
      }
      if (screen.kind === "help") {
        setScreen({ kind: "main" });
        return;
      }
      if (screen.kind === "hard") {
        if (input === "y" || input === "Y") control.hardStop();
        setScreen({ kind: "main" });
        return;
      }
      if (screen.kind === "ctrl-c") {
        if (input === "s") {
          if (control.stop === "none") control.toggleSoft();
        } else if (input === "k" || input === "K") control.hardStop();
        else if (key.ctrl && input === "c") control.hardStop();
        setScreen({ kind: "main" });
        return;
      }
      if (screen.kind !== "main") return;

      const step = (delta: number) => {
        let next = Math.max(0, Math.min(items.length - 1, selected + delta));
        if (items[next]?.kind === "history-header") next = Math.max(0, Math.min(items.length - 1, next + delta));
        setSelected(next);
      };
      if (key.ctrl && input === "c") setScreen({ kind: "ctrl-c" });
      else if (key.upArrow || input === "k") step(-1);
      else if (key.downArrow || input === "j") step(1);
      else if (key.return && current?.logPath) {
        const row = current.row;
        const task = row?.issue && row.title ? { title: `#${row.issue} ${row.title}`, body: row.body ?? "" } : undefined;
        setScreen({ kind: "log", path: current.logPath, title: titleOf(current), task });
      }
      else if (input === "o") openPager(current?.logPath);
      else if (input === "s") control.toggleSoft();
      else if (input === "K") setScreen({ kind: "hard" });
      else if (input === "w") control.wake();
      else if (input === "c" && configFile) setScreen({ kind: "settings" });
      else if (input === "?") setScreen({ kind: "help" });
    },
    { isActive: screen.kind !== "log" },
  );

  if (screen.kind === "log") {
    return (
      <LogView
        path={screen.path}
        title={screen.title}
        task={screen.task}
        height={rows}
        onClose={() => setScreen({ kind: "main" })}
        onPager={() => openPager(screen.path)}
      />
    );
  }

  if (screen.kind === "settings" && configFile) {
    return <SettingsWindow file={configFile} onClose={() => setScreen({ kind: "main" })} />;
  }

  const headerHeight = 4;
  const noticesHeight = Math.min(6, Math.max(2, Math.floor(rows / 6)));
  const tableHeight = Math.max(3, rows - headerHeight - noticesHeight - 4);

  let overlay: ReactNode = null;
  if (screen.kind === "help") overlay = <Dialog title="Keys" lines={[...HELP, "", "any key closes"]} color="cyan" />;
  if (screen.kind === "hard")
    overlay = (
      <Dialog
        title="Hard stop?"
        color="red"
        lines={[
          "Aborts every running agent now. No merge.",
          "Worktrees and branches stay; the next run resumes them.",
          "A merge already running finishes first.",
          "",
          "y — hard stop     any other key — back",
        ]}
      />
    );
  if (screen.kind === "ctrl-c")
    overlay = (
      <Dialog
        title="Stop the run?"
        color="red"
        lines={[
          "s — soft stop: running agents finish, merge, exit",
          "k — hard stop: abort the agents, no merge",
          "esc — cancel",
        ]}
      />
    );
  if (screen.kind === "confirm") overlay = <Dialog title="Confirm" lines={[...screen.text, "", "y — go on     n — quit"]} />;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Header state={state} now={now} />
      {overlay ?? <AgentTable items={items} selected={Math.min(selected, items.length - 1)} now={now} height={tableHeight} />}
      <Box flexGrow={1} />
      <Notices state={state} height={noticesHeight} />
      <Footer />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface Tui {
  emit: (event: RunEvent) => void;
  /** Asks a yes/no question in the TUI. */
  confirm: (text: string[]) => Promise<boolean>;
  close: () => Promise<void>;
}

export function startTui(control: Control, orchestratorPath: string, configFile?: string): Tui {
  const store = new RunStore();
  const confirmations = new ConfirmQueue();
  const instance = render(
    <App store={store} control={control} orchestratorPath={orchestratorPath} confirmations={confirmations} configFile={configFile} />,
    { exitOnCtrlC: false, patchConsole: false, alternateScreen: true, incrementalRendering: true },
  );
  return {
    emit: (event) => store.apply(event),
    confirm: (text) => confirmations.ask(text),
    close: async () => {
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
