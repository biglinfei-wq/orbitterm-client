import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { Terminal, type ITheme } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebglAddon } from 'xterm-addon-webgl';
import { Unicode11Addon } from 'xterm-addon-unicode11';
import 'xterm/css/xterm.css';
import { sanitizeSshOutputForDisplay, sshResize } from '../../services/ssh';
import { toRgba, type OrbitTerminalChromePalette } from '../../theme/orbitTheme';

export type SplitDirection = 'horizontal' | 'vertical';

export interface TerminalSplitPane {
  id: string;
  sessionId: string;
  hostId: string;
  title: string;
}

export type TerminalLayoutNode =
  | {
      type: 'pane';
      pane: TerminalSplitPane;
    }
  | {
      type: 'split';
      id: string;
      direction: SplitDirection;
      first: TerminalLayoutNode;
      second: TerminalLayoutNode;
      sizes?: [number, number];
    };

interface OrbitTerminalProps {
  layout: TerminalLayoutNode;
  activePaneId: string;
  isTabActive: boolean;
  onActivePaneChange: (paneId: string) => void;
  onPaneContextMenu: (event: ReactMouseEvent<HTMLElement>, paneId: string) => void;
  onPaneInput: (sessionId: string, data: string) => void;
  onPaneSessionClosed: (paneId: string, sessionId: string) => void;
  onTerminalError: (message: string) => void;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  theme: ITheme;
  surfaceHex: string;
  surfaceOpacity: number;
  blurPx: number;
  borderColor: string;
  chromePalette: OrbitTerminalChromePalette;
  disableInteractiveInput?: boolean;
  allowPaneContextActions?: boolean;
  hidePaneHeader?: boolean;
  onCopyActiveOutputReady?: ((copyFn: ((scope?: 'visible' | 'all') => Promise<boolean>) | null) => void) | undefined;
}

interface TerminalInstanceProps {
  pane: TerminalSplitPane;
  isFocused: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  theme: ITheme;
  surfaceHex: string;
  surfaceOpacity: number;
  blurPx: number;
  borderColor: string;
  chromePalette: OrbitTerminalChromePalette;
  onFocusPane: (paneId: string) => void;
  onPaneContextMenu: (event: ReactMouseEvent<HTMLElement>, paneId: string) => void;
  onPaneInput: (sessionId: string, data: string) => void;
  onPaneSessionClosed: (paneId: string, sessionId: string) => void;
  onTerminalError: (message: string) => void;
  onRegisterApi: (paneId: string, api: TerminalInstanceApi | null) => void;
  disableInteractiveInput: boolean;
  allowPaneContextActions: boolean;
  hidePaneHeader: boolean;
}

interface SshOutputEvent {
  sessionId: string;
  data: string;
}

interface SshErrorEvent {
  sessionId?: string;
  message: string;
}

interface SshClosedEvent {
  sessionId: string;
}

interface TerminalInstanceApi {
  fit: () => void;
  focus: () => void;
  copyOutput: (scope?: 'visible' | 'all') => Promise<boolean>;
}

const OUTPUT_FLUSH_CHARS_PER_FRAME = 40 * 1024;
const OUTPUT_MAX_QUEUE_CHARS = 3 * 1024 * 1024;
const OUTPUT_QUEUE_TRIM_TARGET_CHARS = Math.floor(OUTPUT_MAX_QUEUE_CHARS * 0.75);
const MIN_XTERM_LINE_HEIGHT = 1;
const MAX_XTERM_LINE_HEIGHT = 2.4;

const sanitizeTerminalLineHeight = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 1.08;
  }
  if (value < MIN_XTERM_LINE_HEIGHT) {
    return MIN_XTERM_LINE_HEIGHT;
  }
  if (value > MAX_XTERM_LINE_HEIGHT) {
    return MAX_XTERM_LINE_HEIGHT;
  }
  return Math.round(value * 100) / 100;
};

const collectBufferText = (terminal: Terminal, scope: 'visible' | 'all'): string => {
  const buffer = terminal.buffer.active;
  const maxY = buffer.baseY + Math.max(terminal.rows - 1, 0);
  const startY = scope === 'visible' ? Math.max(0, buffer.viewportY) : 0;
  const endY = scope === 'visible' ? Math.min(maxY, buffer.viewportY + terminal.rows - 1) : maxY;
  if (endY < startY) {
    return '';
  }
  const lines: string[] = [];
  for (let y = startY; y <= endY; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      continue;
    }
    lines.push(line.translateToString(true));
  }
  return lines.join('\n').replace(/\u00a0/g, ' ').trimEnd();
};

const writeClipboardText = async (text: string): Promise<void> => {
  const normalized = text.trimEnd();
  if (!normalized) {
    throw new Error('empty');
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalized);
      return;
    } catch (_error) {
      // Fallback to legacy copy API.
    }
  }

  if (typeof document === 'undefined') {
    throw new Error('clipboard unavailable');
  }

  const textarea = document.createElement('textarea');
  textarea.value = normalized;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, normalized.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('clipboard unavailable');
  }
};

type OutputSubscriber = (data: string) => void;
type ErrorSubscriber = (message: string) => void;
type ClosedSubscriber = () => void;

const sshOutputSubscribers = new Map<string, Set<OutputSubscriber>>();
const sshErrorSubscribers = new Map<string, Set<ErrorSubscriber>>();
const sshClosedSubscribers = new Map<string, Set<ClosedSubscriber>>();
let sshBridgeBootPromise: Promise<void> | null = null;
let sshOutputUnlisten: UnlistenFn | null = null;
let sshErrorUnlisten: UnlistenFn | null = null;
let sshClosedUnlisten: UnlistenFn | null = null;

const hasAnySshBridgeSubscribers = (): boolean => {
  return (
    sshOutputSubscribers.size > 0 ||
    sshErrorSubscribers.size > 0 ||
    sshClosedSubscribers.size > 0
  );
};

const teardownSshEventBridge = (): void => {
  if (hasAnySshBridgeSubscribers()) {
    return;
  }
  if (sshOutputUnlisten) {
    sshOutputUnlisten();
    sshOutputUnlisten = null;
  }
  if (sshErrorUnlisten) {
    sshErrorUnlisten();
    sshErrorUnlisten = null;
  }
  if (sshClosedUnlisten) {
    sshClosedUnlisten();
    sshClosedUnlisten = null;
  }
  sshBridgeBootPromise = null;
};

const ensureSshEventBridge = (): void => {
  if (sshOutputUnlisten || sshBridgeBootPromise) {
    return;
  }

  sshBridgeBootPromise = (async () => {
    sshOutputUnlisten = await listen<SshOutputEvent>('ssh-output', (event) => {
      const bucket = sshOutputSubscribers.get(event.payload.sessionId);
      if (!bucket || bucket.size === 0) {
        return;
      }
      for (const subscriber of bucket) {
        subscriber(event.payload.data);
      }
    });

    sshErrorUnlisten = await listen<SshErrorEvent>('ssh-error', (event) => {
      const eventSessionId = event.payload.sessionId;
      if (eventSessionId) {
        const bucket = sshErrorSubscribers.get(eventSessionId);
        if (!bucket || bucket.size === 0) {
          return;
        }
        for (const subscriber of bucket) {
          subscriber(event.payload.message);
        }
        return;
      }

      for (const bucket of sshErrorSubscribers.values()) {
        for (const subscriber of bucket) {
          subscriber(event.payload.message);
        }
      }
    });

    sshClosedUnlisten = await listen<SshClosedEvent>('ssh-closed', (event) => {
      const bucket = sshClosedSubscribers.get(event.payload.sessionId);
      if (!bucket || bucket.size === 0) {
        return;
      }
      for (const subscriber of bucket) {
        subscriber();
      }
    });
  })()
    .catch((_error) => {
      teardownSshEventBridge();
    })
    .finally(() => {
      sshBridgeBootPromise = null;
      if (!hasAnySshBridgeSubscribers()) {
        teardownSshEventBridge();
      }
    });
};

const subscribeSshOutput = (sessionId: string, subscriber: OutputSubscriber): (() => void) => {
  const bucket = sshOutputSubscribers.get(sessionId) ?? new Set<OutputSubscriber>();
  bucket.add(subscriber);
  sshOutputSubscribers.set(sessionId, bucket);
  ensureSshEventBridge();
  return () => {
    const current = sshOutputSubscribers.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(subscriber);
    if (current.size === 0) {
      sshOutputSubscribers.delete(sessionId);
    }
    teardownSshEventBridge();
  };
};

const subscribeSshError = (sessionId: string, subscriber: ErrorSubscriber): (() => void) => {
  const bucket = sshErrorSubscribers.get(sessionId) ?? new Set<ErrorSubscriber>();
  bucket.add(subscriber);
  sshErrorSubscribers.set(sessionId, bucket);
  ensureSshEventBridge();
  return () => {
    const current = sshErrorSubscribers.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(subscriber);
    if (current.size === 0) {
      sshErrorSubscribers.delete(sessionId);
    }
    teardownSshEventBridge();
  };
};

const subscribeSshClosed = (sessionId: string, subscriber: ClosedSubscriber): (() => void) => {
  const bucket = sshClosedSubscribers.get(sessionId) ?? new Set<ClosedSubscriber>();
  bucket.add(subscriber);
  sshClosedSubscribers.set(sessionId, bucket);
  ensureSshEventBridge();
  return () => {
    const current = sshClosedSubscribers.get(sessionId);
    if (!current) {
      return;
    }
    current.delete(subscriber);
    if (current.size === 0) {
      sshClosedSubscribers.delete(sessionId);
    }
    teardownSshEventBridge();
  };
};

const collectPaneIds = (node: TerminalLayoutNode): string[] => {
  if (node.type === 'pane') {
    return [node.pane.id];
  }
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
};

function TerminalInstance({
  pane,
  isFocused,
  fontFamily,
  fontSize,
  lineHeight,
  theme,
  surfaceHex,
  surfaceOpacity,
  blurPx,
  borderColor,
  chromePalette,
  onFocusPane,
  onPaneContextMenu,
  onPaneInput,
  onPaneSessionClosed,
  onTerminalError,
  onRegisterApi,
  disableInteractiveInput,
  allowPaneContextActions,
  hidePaneHeader
}: TerminalInstanceProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const resizeSyncRef = useRef<(() => void) | null>(null);
  const skipFirstResizeObserverSyncRef = useRef<boolean>(true);

  const outputQueueRef = useRef<string[]>([]);
  const queuedCharsRef = useRef<number>(0);
  const flushRafRef = useRef<number>(0);
  const disposedRef = useRef<boolean>(false);
  const terminalContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [terminalContextMenu, setTerminalContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const chromeVars = useMemo<CSSProperties>(() => {
    return {
      '--ot-term-title-active-bg': chromePalette.titleActiveBackground,
      '--ot-term-title-active-text': chromePalette.titleActiveText,
      '--ot-term-title-active-ring': chromePalette.titleActiveRing,
      '--ot-term-title-idle-bg': chromePalette.titleIdleBackground,
      '--ot-term-title-idle-text': chromePalette.titleIdleText,
      '--ot-term-title-idle-ring': chromePalette.titleIdleRing,
      '--ot-term-hint-text': chromePalette.hintText,
      '--ot-term-menu-bg': chromePalette.contextMenuBackground,
      '--ot-term-menu-border': chromePalette.contextMenuBorder,
      '--ot-term-menu-text': chromePalette.contextMenuItemText,
      '--ot-term-menu-hover-bg': chromePalette.contextMenuItemHoverBackground,
      '--ot-term-menu-disabled-text': chromePalette.contextMenuDisabledText
    } as CSSProperties;
  }, [chromePalette]);
  const safeLineHeight = useMemo(() => sanitizeTerminalLineHeight(lineHeight), [lineHeight]);
  const blurTerminalTextarea = useCallback((): void => {
    const terminal = terminalRef.current as (Terminal & { textarea?: HTMLTextAreaElement }) | null;
    const textarea = terminal?.textarea;
    if (textarea) {
      textarea.blur();
    }
  }, []);

  const onPaneSessionClosedRef = useRef(onPaneSessionClosed);
  const onTerminalErrorRef = useRef(onTerminalError);
  const onPaneInputRef = useRef(onPaneInput);

  useEffect(() => {
    onPaneSessionClosedRef.current = onPaneSessionClosed;
  }, [onPaneSessionClosed]);

  useEffect(() => {
    onTerminalErrorRef.current = onTerminalError;
  }, [onTerminalError]);

  useEffect(() => {
    onPaneInputRef.current = onPaneInput;
  }, [onPaneInput]);

  useEffect(() => {
    if (!terminalContextMenu) {
      return;
    }
    const handlePointerDown = (event: PointerEvent): void => {
      const root = terminalContextMenuRef.current;
      if (!root) {
        setTerminalContextMenu(null);
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!root.contains(target)) {
        setTerminalContextMenu(null);
      }
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [terminalContextMenu]);

  useEffect(() => {
    if (!hostRef.current) {
      return;
    }

    disposedRef.current = false;
    outputQueueRef.current = [];
    queuedCharsRef.current = 0;
    flushRafRef.current = 0;
    skipFirstResizeObserverSyncRef.current = true;

    const terminal = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      customGlyphs: true,
      disableStdin: disableInteractiveInput,
      drawBoldTextInBrightColors: true,
      fontFamily,
      fontSize,
      lineHeight: safeLineHeight,
      fontWeight: '400',
      fontWeightBold: '600',
      letterSpacing: 0,
      scrollback: 120_000,
      theme,
      smoothScrollDuration: 0
    });
    terminalRef.current = terminal;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = '11';

    terminal.loadAddon(fitAddon);

    try {
      const webglAddon = new WebglAddon();
      webglAddonRef.current = webglAddon;
      terminal.loadAddon(webglAddon);
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
    } catch (_error) {
      // Keep silent fallback for a cleaner terminal experience.
    }

    terminal.open(hostRef.current);
    fitAddon.fit();
    if (disableInteractiveInput) {
      const textarea = (terminal as Terminal & { textarea?: HTMLTextAreaElement }).textarea;
      if (textarea) {
        textarea.readOnly = true;
        textarea.autocapitalize = 'none';
        textarea.autocomplete = 'off';
        textarea.autocorrect = false;
        textarea.inputMode = 'none';
        textarea.spellcheck = false;
        textarea.tabIndex = -1;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        textarea.blur();
      }
    }

    const pushResize = (): void => {
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (cols > 0 && rows > 0) {
        void sshResize(pane.sessionId, cols, rows).catch(() => {
          onTerminalErrorRef.current('终端窗口同步失败，请检查网络连接。');
        });
      }
    };
    resizeSyncRef.current = pushResize;

    const instanceApi: TerminalInstanceApi = {
      fit: () => {
        fitAddon.fit();
      },
      focus: () => {
        if (disableInteractiveInput) {
          return;
        }
        terminal.focus();
      },
      copyOutput: async (scope: 'visible' | 'all' = 'visible') => {
        try {
          const normalized = collectBufferText(terminal, scope).replace(/\r\n/g, '\n');
          if (!normalized) {
            return false;
          }
          await writeClipboardText(normalized);
          return true;
        } catch (_error) {
          return false;
        }
      }
    };
    onRegisterApi(pane.id, instanceApi);

    const scheduleFlush = (): void => {
      if (disposedRef.current || flushRafRef.current !== 0) {
        return;
      }

      flushRafRef.current = window.requestAnimationFrame(() => {
        flushRafRef.current = 0;

        if (disposedRef.current) {
          return;
        }

        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          return;
        }

        let remainingBudget = OUTPUT_FLUSH_CHARS_PER_FRAME;
        let payload = '';

        while (remainingBudget > 0 && outputQueueRef.current.length > 0) {
          const head = outputQueueRef.current[0];
          if (!head) {
            outputQueueRef.current.shift();
            continue;
          }

          if (head.length <= remainingBudget) {
            payload += head;
            remainingBudget -= head.length;
            queuedCharsRef.current = Math.max(0, queuedCharsRef.current - head.length);
            outputQueueRef.current.shift();
          } else {
            payload += head.slice(0, remainingBudget);
            outputQueueRef.current[0] = head.slice(remainingBudget);
            queuedCharsRef.current = Math.max(0, queuedCharsRef.current - remainingBudget);
            remainingBudget = 0;
          }
        }

        if (!payload) {
          if (outputQueueRef.current.length > 0) {
            scheduleFlush();
          }
          return;
        }

        activeTerminal.write(payload, () => {
          if (disposedRef.current) {
            return;
          }
          if (outputQueueRef.current.length > 0) {
            scheduleFlush();
          }
        });
      });
    };

    const enqueueOutput = (chunk: string): void => {
      if (disposedRef.current || !chunk) {
        return;
      }

      outputQueueRef.current.push(chunk);
      queuedCharsRef.current += chunk.length;
      if (queuedCharsRef.current > OUTPUT_MAX_QUEUE_CHARS) {
        while (
          queuedCharsRef.current > OUTPUT_QUEUE_TRIM_TARGET_CHARS &&
          outputQueueRef.current.length > 1
        ) {
          const dropped = outputQueueRef.current.shift();
          if (!dropped) {
            break;
          }
          queuedCharsRef.current = Math.max(0, queuedCharsRef.current - dropped.length);
        }
      }
      scheduleFlush();
    };

    const dataDisposable = terminal.onData((data) => {
      onPaneInputRef.current(pane.sessionId, data);
    });

    const unsubscribeOutput = subscribeSshOutput(pane.sessionId, (payload) => {
      const visiblePayload = sanitizeSshOutputForDisplay(pane.sessionId, payload);
      if (!visiblePayload) {
        return;
      }
      enqueueOutput(visiblePayload);
    });
    const unsubscribeError = subscribeSshError(pane.sessionId, (message) => {
      onTerminalErrorRef.current(message);
    });
    const unsubscribeClosed = subscribeSshClosed(pane.sessionId, () => {
      onPaneSessionClosedRef.current(pane.id, pane.sessionId);
    });

    let rafId = 0;
    const handleResize = (): void => {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        fitAddon.fit();
        if (skipFirstResizeObserverSyncRef.current) {
          // On initial mount, many shells redraw the prompt after a remote resize.
          // Skip the first sync to avoid a duplicated prompt line right after connect.
          skipFirstResizeObserverSyncRef.current = false;
          return;
        }
        pushResize();
      });
    };

    const resizeObserverSupported =
      typeof window !== 'undefined' && typeof window.ResizeObserver !== 'undefined';
    const observer = resizeObserverSupported ? new ResizeObserver(handleResize) : null;
    if (observer) {
      observer.observe(hostRef.current);
    } else {
      skipFirstResizeObserverSyncRef.current = false;
      window.addEventListener('resize', handleResize);
    }

    return () => {
      disposedRef.current = true;

      onRegisterApi(pane.id, null);

      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
      if (flushRafRef.current !== 0) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = 0;
      }

      if (observer) {
        observer.disconnect();
      } else {
        window.removeEventListener('resize', handleResize);
      }
      dataDisposable.dispose();
      unsubscribeOutput();
      unsubscribeError();
      unsubscribeClosed();

      outputQueueRef.current = [];
      queuedCharsRef.current = 0;

      if (webglAddonRef.current) {
        webglAddonRef.current.dispose();
        webglAddonRef.current = null;
      }

      fitAddonRef.current = null;
      resizeSyncRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [disableInteractiveInput, onRegisterApi, pane.id, pane.sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = safeLineHeight;
    terminal.options.theme = theme;
    terminal.options.disableStdin = disableInteractiveInput;
    fitAddonRef.current?.fit();
  }, [disableInteractiveInput, fontFamily, fontSize, safeLineHeight, theme]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }

    if (disableInteractiveInput) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isFocused]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }
    if (disableInteractiveInput) {
      return;
    }
    const handleWindowFocus = (): void => {
      window.requestAnimationFrame(() => {
        terminalRef.current?.focus();
      });
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [disableInteractiveInput, isFocused]);

  const handleTerminalContextMenuAction = useCallback(
    async (action: 'copy' | 'cut' | 'paste' | 'selectAll'): Promise<void> => {
      const terminal = terminalRef.current;
      if (!terminal) {
        return;
      }
      setTerminalContextMenu(null);
      try {
        if (action === 'selectAll') {
          terminal.selectAll();
          return;
        }
        if (action === 'paste') {
          if (disableInteractiveInput) {
            onTerminalErrorRef.current('移动端已禁用终端直接输入，请使用下方预输入栏。');
            return;
          }
          const clipboardText = await navigator.clipboard.readText();
          if (clipboardText) {
            onPaneInputRef.current(pane.sessionId, clipboardText);
          }
          return;
        }
        const selectedText = terminal.getSelection();
        if (!selectedText) {
          return;
        }
        await navigator.clipboard.writeText(selectedText);
        if (action === 'cut') {
          terminal.clearSelection();
        }
      } catch (_error) {
        onTerminalErrorRef.current('剪贴板访问失败，请检查系统权限。');
      }
    },
    [disableInteractiveInput, pane.sessionId]
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl p-1.5"
      onPointerDown={() => {
        onFocusPane(pane.id);
        if (!disableInteractiveInput) {
          terminalRef.current?.focus();
        } else {
          window.setTimeout(() => {
            blurTerminalTextarea();
          }, 0);
        }
        if (terminalContextMenu) {
          setTerminalContextMenu(null);
        }
      }}
      onTouchStart={() => {
        if (!disableInteractiveInput) {
          return;
        }
        window.setTimeout(() => {
          blurTerminalTextarea();
        }, 0);
      }}
      style={{
        ...chromeVars,
        background: isFocused
          ? chromePalette.paneBackgroundFocused
          : chromePalette.paneBackgroundIdle
      }}
    >
      {!hidePaneHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <button
            className="min-w-0 max-w-[240px] truncate rounded-md px-2 py-1 text-[11px] ring-1"
            onClick={() => {
              onFocusPane(pane.id);
            }}
            onContextMenu={(event) => {
              if (!allowPaneContextActions) {
                return;
              }
              onPaneContextMenu(event, pane.id);
            }}
            title={pane.title}
            style={
              isFocused
                ? {
                    background: 'var(--ot-term-title-active-bg)',
                    color: 'var(--ot-term-title-active-text)',
                    boxShadow: 'inset 0 0 0 1px var(--ot-term-title-active-ring)'
                  }
                : {
                    background: 'var(--ot-term-title-idle-bg)',
                    color: 'var(--ot-term-title-idle-text)',
                    boxShadow: 'inset 0 0 0 1px var(--ot-term-title-idle-ring)'
                  }
            }
            type="button"
          >
            {pane.title}
          </button>
          {allowPaneContextActions ? (
            <span className="text-[10px] text-[color:var(--ot-term-hint-text)]">右键标题分屏</span>
          ) : (
            <span className="text-[10px] text-[color:var(--ot-term-hint-text)]">移动端已关闭分屏</span>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <div
          className="orbitterm-xterm-host h-full min-h-[120px] w-full rounded-xl p-2"
          onContextMenu={(event) => {
            event.preventDefault();
            onFocusPane(pane.id);
            const selected = terminalRef.current?.getSelection() ?? '';
            setTerminalContextMenu({
              x: event.clientX,
              y: event.clientY,
              hasSelection: selected.length > 0
            });
          }}
          ref={hostRef}
          onTouchStart={() => {
            if (!disableInteractiveInput) {
              return;
            }
            window.setTimeout(() => {
              blurTerminalTextarea();
            }, 0);
          }}
          style={{
            background: toRgba(surfaceHex, surfaceOpacity / 100),
            backdropFilter: `blur(${blurPx}px)`,
            WebkitBackdropFilter: `blur(${blurPx}px)`,
            boxShadow: `inset 0 0 0 1px ${borderColor}`
          }}
        />
      </div>
      {terminalContextMenu && (
        <div
          className="fixed z-[150] min-w-[140px] rounded-lg border bg-[var(--ot-term-menu-bg)] p-1.5 shadow-2xl backdrop-blur"
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
          ref={terminalContextMenuRef}
          style={{
            left: terminalContextMenu.x,
            top: terminalContextMenu.y,
            borderColor: 'var(--ot-term-menu-border)'
          }}
        >
          <button
            className={`block w-full rounded px-2 py-1 text-left text-xs ${
              terminalContextMenu.hasSelection
                ? 'text-[color:var(--ot-term-menu-text)] hover:bg-[var(--ot-term-menu-hover-bg)]'
                : 'cursor-not-allowed text-[color:var(--ot-term-menu-disabled-text)]'
            }`}
            disabled={!terminalContextMenu.hasSelection}
            onClick={() => {
              void handleTerminalContextMenuAction('copy');
            }}
            type="button"
          >
            复制
          </button>
          <button
            className={`mt-1 block w-full rounded px-2 py-1 text-left text-xs ${
              terminalContextMenu.hasSelection
                ? 'text-[color:var(--ot-term-menu-text)] hover:bg-[var(--ot-term-menu-hover-bg)]'
                : 'cursor-not-allowed text-[color:var(--ot-term-menu-disabled-text)]'
            }`}
            disabled={!terminalContextMenu.hasSelection}
            onClick={() => {
              void handleTerminalContextMenuAction('cut');
            }}
            type="button"
          >
            剪切
          </button>
          <button
            className="mt-1 block w-full rounded px-2 py-1 text-left text-xs text-[color:var(--ot-term-menu-text)] hover:bg-[var(--ot-term-menu-hover-bg)]"
            onClick={() => {
              void handleTerminalContextMenuAction('paste');
            }}
            type="button"
          >
            粘贴
          </button>
          <button
            className="mt-1 block w-full rounded px-2 py-1 text-left text-xs text-[color:var(--ot-term-menu-text)] hover:bg-[var(--ot-term-menu-hover-bg)]"
            onClick={() => {
              void handleTerminalContextMenuAction('selectAll');
            }}
            type="button"
          >
            全选
          </button>
        </div>
      )}
    </div>
  );
}

export function OrbitTerminal({
  layout,
  activePaneId,
  isTabActive,
  onActivePaneChange,
  onPaneContextMenu,
  onPaneInput,
  onPaneSessionClosed,
  onTerminalError,
  fontFamily,
  fontSize,
  lineHeight,
  theme,
  surfaceHex,
  surfaceOpacity,
  blurPx,
  borderColor,
  chromePalette,
  disableInteractiveInput = false,
  allowPaneContextActions = true,
  hidePaneHeader = false,
  onCopyActiveOutputReady
}: OrbitTerminalProps): JSX.Element {
  const terminalApiMapRef = useRef<Map<string, TerminalInstanceApi>>(new Map());
  const fitRafRef = useRef<number>(0);

  const paneIds = useMemo(() => collectPaneIds(layout), [layout]);

  const fitAllTerminals = useCallback((): void => {
    for (const paneId of paneIds) {
      const api = terminalApiMapRef.current.get(paneId);
      api?.fit();
    }
  }, [paneIds]);

  const scheduleFitAll = useCallback((): void => {
    if (fitRafRef.current !== 0) {
      return;
    }
    fitRafRef.current = window.requestAnimationFrame(() => {
      fitRafRef.current = 0;
      fitAllTerminals();
    });
  }, [fitAllTerminals]);

  const copyActiveOutput = useCallback(async (scope: 'visible' | 'all' = 'visible'): Promise<boolean> => {
    const activeApi = terminalApiMapRef.current.get(activePaneId);
    if (!activeApi) {
      return false;
    }
    return activeApi.copyOutput(scope);
  }, [activePaneId]);

  const registerApi = useCallback((paneId: string, api: TerminalInstanceApi | null): void => {
    if (!api) {
      terminalApiMapRef.current.delete(paneId);
      return;
    }
    terminalApiMapRef.current.set(paneId, api);
  }, []);

  useEffect(() => {
    const activeSet = new Set(paneIds);
    for (const paneId of terminalApiMapRef.current.keys()) {
      if (!activeSet.has(paneId)) {
        terminalApiMapRef.current.delete(paneId);
      }
    }
  }, [paneIds]);

  useEffect(() => {
    scheduleFitAll();
  }, [layout, scheduleFitAll]);

  useEffect(() => {
    if (!isTabActive) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      const activeApi = terminalApiMapRef.current.get(activePaneId);
      activeApi?.fit();
      activeApi?.focus();
    });

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [activePaneId, isTabActive]);

  useEffect(() => {
    return () => {
      if (fitRafRef.current !== 0) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = 0;
      }
    };
  }, []);

  useEffect(() => {
    if (!onCopyActiveOutputReady) {
      return;
    }
    onCopyActiveOutputReady(copyActiveOutput);
    return () => {
      onCopyActiveOutputReady(null);
    };
  }, [copyActiveOutput, onCopyActiveOutputReady]);

  const renderNode = (node: TerminalLayoutNode): JSX.Element => {
    if (node.type === 'pane') {
      return (
        <TerminalInstance
          blurPx={blurPx}
          borderColor={borderColor}
          chromePalette={chromePalette}
          fontFamily={fontFamily}
          fontSize={fontSize}
          lineHeight={lineHeight}
          isFocused={isTabActive && activePaneId === node.pane.id}
          key={node.pane.id}
          onFocusPane={onActivePaneChange}
          onPaneContextMenu={onPaneContextMenu}
          onPaneInput={onPaneInput}
          onPaneSessionClosed={onPaneSessionClosed}
          onRegisterApi={registerApi}
          onTerminalError={onTerminalError}
          disableInteractiveInput={disableInteractiveInput}
          allowPaneContextActions={allowPaneContextActions}
          hidePaneHeader={hidePaneHeader}
          pane={node.pane}
          surfaceHex={surfaceHex}
          surfaceOpacity={surfaceOpacity}
          theme={theme}
        />
      );
    }

    return (
      <Group
        className="h-full w-full"
        key={node.id}
        orientation={node.direction}
      >
        <Panel defaultSize={node.sizes?.[0] ?? 50} minSize={12}>
          {renderNode(node.first)}
        </Panel>
        <Separator
          className={`rounded transition-colors ${
            node.direction === 'horizontal'
              ? 'mx-1 w-1 cursor-col-resize'
              : 'my-1 h-1 cursor-row-resize'
          }`}
          style={{
            background: chromePalette.splitterColor
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = chromePalette.splitterHoverColor;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = chromePalette.splitterColor;
          }}
        />
        <Panel defaultSize={node.sizes?.[1] ?? 50} minSize={12}>
          {renderNode(node.second)}
        </Panel>
      </Group>
    );
  };

  return <div className="h-full min-h-0 overflow-hidden">{renderNode(layout)}</div>;
}
