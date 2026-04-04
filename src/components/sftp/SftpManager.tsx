import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent
} from 'react';
import { open, save } from '@tauri-apps/api/dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { join } from '@tauri-apps/api/path';
import { toast } from 'sonner';
import {
  sftpCompress,
  sftpCopy,
  sftpExtract,
  type SftpEntry,
  sftpLs,
  sftpMkdir,
  sftpReadText,
  sftpRename,
  sftpRm,
  sftpUploadContent
} from '../../services/sftp';
import { useTransferStore } from '../../store/useTransferStore';
import type { OrbitSftpPalette } from '../../theme/orbitTheme';

interface SftpManagerProps {
  sessionId: string | null;
  syncRequest: SftpSyncRequest | null;
  onSendToTerminal: (command: string, execute: boolean) => Promise<void>;
  palette: OrbitSftpPalette;
  className?: string;
}

interface ContextMenuState {
  entry: SftpEntry;
  x: number;
  y: number;
}

interface SftpClipboardPayload {
  mode: 'copy' | 'cut';
  entry: SftpEntry;
}

interface SftpSyncRequest {
  sessionId: string;
  path: string;
  nonce: number;
}

interface BreadcrumbItem {
  label: string;
  path: string;
}

interface VirtualWindow {
  start: number;
  end: number;
  topSpacer: number;
  bottomSpacer: number;
}

const VIRTUAL_LIST_THRESHOLD = 1000;
const VIRTUAL_ROW_HEIGHT = 36;
const VIRTUAL_OVERSCAN = 8;

const MonacoEditor = lazy(async () => {
  const module = await import('@monaco-editor/react');
  return { default: module.default };
});

const joinRemotePath = (base: string, name: string): string => {
  if (base === '/') {
    return `/${name}`;
  }
  if (base.endsWith('/')) {
    return `${base}${name}`;
  }
  return `${base}/${name}`;
};

const basename = (path: string): string => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || 'upload.bin';
};

const escapeShellPath = (path: string): string => {
  return path.replace(/["\\$`]/g, '\\$&');
};

const buildBreadcrumbs = (path: string): BreadcrumbItem[] => {
  if (!path.startsWith('/')) {
    return [{ label: path || '.', path: path || '.' }];
  }

  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) {
    return [{ label: '/', path: '/' }];
  }

  const result: BreadcrumbItem[] = [{ label: '/', path: '/' }];
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    result.push({
      label: part,
      path: current
    });
  }

  return result;
};

const scriptRunCommand = (entry: SftpEntry): string | null => {
  if (entry.isDir) {
    return null;
  }

  const lower = entry.name.toLowerCase();
  if (lower.endsWith('.sh')) {
    return `bash "${escapeShellPath(entry.path)}"`;
  }
  if (lower.endsWith('.py')) {
    return `python3 "${escapeShellPath(entry.path)}"`;
  }
  return null;
};

const editableExtensions = new Set([
  'conf',
  'sh',
  'bash',
  'zsh',
  'yml',
  'yaml',
  'txt',
  'log',
  'ini',
  'cfg',
  'env',
  'json',
  'md',
  'properties'
]);

const extensionOf = (name: string): string => {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) {
    return '';
  }
  return name.slice(idx + 1).toLowerCase();
};

const canEditEntry = (entry: SftpEntry): boolean => {
  if (entry.isDir) {
    return false;
  }
  const ext = extensionOf(entry.name);
  return editableExtensions.has(ext);
};

const isArchiveEntry = (entry: SftpEntry): boolean => {
  if (entry.isDir) {
    return false;
  }
  const lower = entry.name.toLowerCase();
  return (
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar') ||
    lower.endsWith('.zip') ||
    lower.endsWith('.gz')
  );
};

const detectLanguage = (entry: SftpEntry): string => {
  const ext = extensionOf(entry.name);
  if (['sh', 'bash', 'zsh'].includes(ext)) {
    return 'shell';
  }
  if (['yml', 'yaml'].includes(ext)) {
    return 'yaml';
  }
  if (ext === 'json') {
    return 'json';
  }
  if (['md'].includes(ext)) {
    return 'markdown';
  }
  if (['ini', 'cfg', 'conf', 'properties', 'env'].includes(ext)) {
    return 'ini';
  }
  if (['ts', 'tsx'].includes(ext)) {
    return 'typescript';
  }
  if (['js', 'jsx', 'mjs'].includes(ext)) {
    return 'javascript';
  }
  if (ext === 'py') {
    return 'python';
  }
  return 'plaintext';
};

const iconForEntry = (entry: SftpEntry): string => {
  if (entry.isDir) {
    return '📁';
  }
  const ext = entry.name.toLowerCase().split('.').pop() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return '🖼️';
  }
  if (['sh', 'bash', 'zsh', 'ps1'].includes(ext)) {
    return '🧩';
  }
  if (['js', 'ts', 'tsx', 'rs', 'go', 'py', 'java', 'cpp', 'c', 'h'].includes(ext)) {
    return '📜';
  }
  if (['zip', 'tar', 'gz', '7z'].includes(ext)) {
    return '🗜️';
  }
  return '📄';
};

const readableSize = (size: number): string => {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
};

const readableTime = (ts: number | null): string => {
  if (!ts) {
    return '-';
  }
  return new Date(ts * 1000).toLocaleString();
};

export function SftpManager({
  sessionId,
  syncRequest,
  onSendToTerminal,
  palette,
  className
}: SftpManagerProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [pathInput, setPathInput] = useState<string>('/');
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [editorEntry, setEditorEntry] = useState<SftpEntry | null>(null);
  const [editorOpen, setEditorOpen] = useState<boolean>(false);
  const [editorLoading, setEditorLoading] = useState<boolean>(false);
  const [editorSaving, setEditorSaving] = useState<boolean>(false);
  const [editorLanguage, setEditorLanguage] = useState<string>('plaintext');
  const [editorContent, setEditorContent] = useState<string>('');
  const [editorOriginalContent, setEditorOriginalContent] = useState<string>('');
  const [editorTruncated, setEditorTruncated] = useState<boolean>(false);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(240);
  const [isExternalDropHover, setIsExternalDropHover] = useState<boolean>(false);
  const [isDownloadDropHover, setIsDownloadDropHover] = useState<boolean>(false);
  const [clipboardPayload, setClipboardPayload] = useState<SftpClipboardPayload | null>(null);
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const enqueueUploadTask = useTransferStore((state) => state.enqueueUploadTask);
  const enqueueDownloadTask = useTransferStore((state) => state.enqueueDownloadTask);
  const cssVars = useMemo<CSSProperties>(() => {
    return {
      '--ot-sftp-panel-bg': palette.panelBackground,
      '--ot-sftp-panel-border': palette.panelBorder,
      '--ot-sftp-soft-bg': palette.softBackground,
      '--ot-sftp-soft-border': palette.softBorder,
      '--ot-sftp-table-bg': palette.tableBackground,
      '--ot-sftp-row-hover': palette.rowHoverBackground,
      '--ot-sftp-text-primary': palette.textPrimary,
      '--ot-sftp-text-secondary': palette.textSecondary,
      '--ot-sftp-text-muted': palette.textMuted,
      '--ot-sftp-button-bg': palette.buttonBackground,
      '--ot-sftp-button-border': palette.buttonBorder,
      '--ot-sftp-button-text': palette.buttonText,
      '--ot-sftp-button-hover-bg': palette.buttonHoverBackground,
      '--ot-sftp-menu-bg': palette.menuBackground,
      '--ot-sftp-menu-border': palette.menuBorder,
      '--ot-sftp-menu-item-hover-bg': palette.menuItemHoverBackground,
      '--ot-sftp-editor-overlay-bg': palette.editorOverlayBackground,
      '--ot-sftp-editor-bg': palette.editorBackground,
      '--ot-sftp-editor-border': palette.editorBorder,
      '--ot-sftp-editor-header-border': palette.editorHeaderBorder,
      '--ot-sftp-editor-tag-bg': palette.editorTagBackground,
      '--ot-sftp-editor-tag-border': palette.editorTagBorder,
      '--ot-sftp-editor-tag-text': palette.editorTagText,
      '--ot-sftp-action-primary-bg': palette.actionPrimaryBackground,
      '--ot-sftp-action-primary-border': palette.actionPrimaryBorder,
      '--ot-sftp-action-primary-text': palette.actionPrimaryText,
      '--ot-sftp-action-primary-hover-bg': palette.actionPrimaryHoverBackground,
      '--ot-sftp-success-bg': palette.successBadgeBackground,
      '--ot-sftp-success-border': palette.successBadgeBorder,
      '--ot-sftp-success-text': palette.successBadgeText,
      '--ot-sftp-warning-bg': palette.warningBadgeBackground,
      '--ot-sftp-warning-border': palette.warningBadgeBorder,
      '--ot-sftp-warning-text': palette.warningBadgeText
    } as CSSProperties;
  }, [palette]);

  const sortedEntries = useMemo(() => {
    return [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }, [entries]);

  const breadcrumbs = useMemo(() => {
    return buildBreadcrumbs(currentPath);
  }, [currentPath]);

  useEffect(() => {
    setPathInput(currentPath);
  }, [currentPath]);

  const isVirtualList = sortedEntries.length > VIRTUAL_LIST_THRESHOLD;

  const virtualWindow = useMemo<VirtualWindow>(() => {
    if (!isVirtualList) {
      return {
        start: 0,
        end: sortedEntries.length,
        topSpacer: 0,
        bottomSpacer: 0
      };
    }

    const total = sortedEntries.length;
    const rawStart = Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT);
    const visibleCount = Math.ceil(viewportHeight / VIRTUAL_ROW_HEIGHT);

    const start = Math.max(0, rawStart - VIRTUAL_OVERSCAN);
    const end = Math.min(total, rawStart + visibleCount + VIRTUAL_OVERSCAN);
    const topSpacer = start * VIRTUAL_ROW_HEIGHT;
    const bottomSpacer = Math.max(0, (total - end) * VIRTUAL_ROW_HEIGHT);

    return {
      start,
      end,
      topSpacer,
      bottomSpacer
    };
  }, [isVirtualList, scrollTop, sortedEntries.length, viewportHeight]);

  const visibleEntries = useMemo(() => {
    if (!isVirtualList) {
      return sortedEntries;
    }
    return sortedEntries.slice(virtualWindow.start, virtualWindow.end);
  }, [isVirtualList, sortedEntries, virtualWindow.end, virtualWindow.start]);

  const editorDirty = useMemo(() => {
    return editorContent !== editorOriginalContent;
  }, [editorContent, editorOriginalContent]);

  const reportError = (message: string): void => {
    setError(message);
    toast.error(message, {
      description: 'SFTP 操作未完成，请检查路径或权限后重试。'
    });
  };

  const loadDirectory = async (path: string): Promise<void> => {
    if (!sessionId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await sftpLs(sessionId, path);
      setCurrentPath(res.path);
      setEntries(res.entries);
    } catch (err) {
      const message = err instanceof Error ? err.message : '读取目录失败。';
      reportError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sessionId) {
      setEntries([]);
      setCurrentPath('/');
      setError(null);
      setClipboardPayload(null);
      setEditorOpen(false);
      setEditorEntry(null);
      setEditorContent('');
      setEditorOriginalContent('');
      setEditorTruncated(false);
      return;
    }
    void loadDirectory('.');
  }, [sessionId]);

  useEffect(() => {
    const closeMenu = (): void => setMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  useEffect(() => {
    if (!sessionId || !syncRequest) {
      return;
    }
    if (syncRequest.sessionId !== sessionId) {
      return;
    }

    void loadDirectory(syncRequest.path);
  }, [sessionId, syncRequest]);

  const enqueueUploadsFromLocalPaths = useCallback(
    (localPaths: string[]): void => {
      if (!sessionId || localPaths.length === 0) {
        return;
      }
      let enqueuedCount = 0;
      for (const localPath of localPaths) {
        const trimmedPath = localPath.trim();
        if (!trimmedPath) {
          continue;
        }
        const name = basename(trimmedPath);
        const remotePath = joinRemotePath(currentPath, name);
        enqueueUploadTask({
          sessionId,
          localPath: trimmedPath,
          remotePath,
          fileName: name
        });
        enqueuedCount += 1;
      }
      if (enqueuedCount > 0) {
        toast.success(`已加入 ${enqueuedCount} 个拖拽上传任务`);
      }
    },
    [currentPath, enqueueUploadTask, sessionId]
  );

  useEffect(() => {
    if (!sessionId) {
      return;
    }
    let unlistenDrop: UnlistenFn | null = null;
    let unlistenHover: UnlistenFn | null = null;
    let unlistenCancel: UnlistenFn | null = null;
    let disposed = false;

    const bind = async (): Promise<void> => {
      try {
        unlistenDrop = await listen<string[]>('tauri://file-drop', (event) => {
          if (disposed) {
            return;
          }
          setIsExternalDropHover(false);
          const payloadPaths = Array.isArray(event.payload) ? event.payload : [];
          const localPaths = payloadPaths
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
          enqueueUploadsFromLocalPaths(localPaths);
        });
        unlistenHover = await listen('tauri://file-drop-hover', () => {
          if (!disposed) {
            setIsExternalDropHover(true);
          }
        });
        unlistenCancel = await listen('tauri://file-drop-cancelled', () => {
          if (!disposed) {
            setIsExternalDropHover(false);
          }
        });
      } catch (_error) {
        // Ignore global drop binding failures in web preview mode.
      }
    };

    void bind();
    return () => {
      disposed = true;
      setIsExternalDropHover(false);
      if (unlistenDrop) {
        unlistenDrop();
      }
      if (unlistenHover) {
        unlistenHover();
      }
      if (unlistenCancel) {
        unlistenCancel();
      }
    };
  }, [enqueueUploadsFromLocalPaths, sessionId]);

  useEffect(() => {
    setScrollTop(0);
    const node = listViewportRef.current;
    if (node) {
      node.scrollTop = 0;
    }
  }, [sessionId, currentPath]);

  useEffect(() => {
    const node = listViewportRef.current;
    if (!node) {
      return;
    }

    const syncHeight = (): void => {
      setViewportHeight(node.clientHeight || 240);
    };

    syncHeight();
    const resizeObserverSupported =
      typeof window !== 'undefined' && typeof window.ResizeObserver !== 'undefined';
    const observer = resizeObserverSupported ? new ResizeObserver(syncHeight) : null;
    if (observer) {
      observer.observe(node);
    } else {
      window.addEventListener('resize', syncHeight);
    }

    return () => {
      if (observer) {
        observer.disconnect();
      } else {
        window.removeEventListener('resize', syncHeight);
      }
    };
  }, [sessionId, loading, sortedEntries.length]);

  const handleEnter = (entry: SftpEntry): void => {
    if (!entry.isDir) {
      return;
    }
    void loadDirectory(entry.path);
  };

  const handleCreateFolder = async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const folderName = window.prompt('请输入新文件夹名称：', 'new-folder');
    if (!folderName) {
      return;
    }
    const targetPath = joinRemotePath(currentPath, folderName.trim());
    if (!targetPath.trim()) {
      return;
    }
    try {
      await sftpMkdir(sessionId, targetPath);
      await loadDirectory(currentPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : '创建文件夹失败。';
      reportError(message);
    }
  };

  const handleUpload = async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const selected = await open({
      multiple: true,
      directory: false
    });

    if (!selected) {
      return;
    }

    const localPaths = Array.isArray(selected) ? selected : [selected];
    let enqueuedCount = 0;
    for (const localPath of localPaths) {
      const name = basename(localPath);
      const remotePath = joinRemotePath(currentPath, name);
      enqueueUploadTask({
        sessionId,
        localPath,
        remotePath,
        fileName: name
      });
      enqueuedCount += 1;
    }
    if (enqueuedCount > 0) {
      toast.success(`已加入 ${enqueuedCount} 个上传任务`);
    }
  };

  const extractLocalPathsFromDropEvent = (event: DragEvent): string[] => {
    const result: string[] = [];
    if (event.dataTransfer?.files) {
      for (const file of Array.from(event.dataTransfer.files)) {
        const localPath = (file as File & { path?: string }).path ?? '';
        if (localPath.trim()) {
          result.push(localPath.trim());
        }
      }
    }
    return result;
  };

  const handleDownload = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId) {
      return;
    }
    if (entry.isDir) {
      reportError('暂不支持直接下载目录，请先进入目录选择文件。');
      return;
    }
    const savePath = await save({
      defaultPath: entry.name
    });
    if (!savePath || Array.isArray(savePath)) {
      return;
    }
    enqueueDownloadTask({
      sessionId,
      remotePath: entry.path,
      localPath: savePath,
      fileName: entry.name,
      totalBytes: entry.size
    });
    toast.success(`已加入下载队列：${entry.name}`);
  };

  const handleStartRemoteEntryDrag = (
    event: ReactDragEvent<HTMLButtonElement>,
    entry: SftpEntry
  ): void => {
    if (entry.isDir) {
      return;
    }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(
      'application/x-orbitterm-remote-entry',
      JSON.stringify({
        path: entry.path,
        name: entry.name,
        size: entry.size
      })
    );
  };

  const handleDropRemoteEntryToDownload = async (
    event: ReactDragEvent<HTMLDivElement>
  ): Promise<void> => {
    event.preventDefault();
    setIsDownloadDropHover(false);
    if (!sessionId) {
      return;
    }
    const payload = event.dataTransfer.getData('application/x-orbitterm-remote-entry');
    if (!payload) {
      return;
    }
    let parsed: { path?: string; name?: string; size?: number } = {};
    try {
      parsed = JSON.parse(payload) as { path?: string; name?: string; size?: number };
    } catch (_error) {
      reportError('拖拽下载数据无效，请重试。');
      return;
    }
    const remotePath = typeof parsed.path === 'string' ? parsed.path.trim() : '';
    const fileName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    if (!remotePath || !fileName) {
      reportError('拖拽下载数据不完整，请重试。');
      return;
    }
    const targetDirectory = await open({
      directory: true,
      multiple: false
    });
    if (!targetDirectory || Array.isArray(targetDirectory)) {
      return;
    }
    const localPath = await join(targetDirectory, fileName);
    enqueueDownloadTask({
      sessionId,
      remotePath,
      localPath,
      fileName,
      totalBytes: typeof parsed.size === 'number' ? parsed.size : 0
    });
    toast.success(`已加入拖拽下载队列：${fileName}`);
  };

  const handleDelete = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const confirmed = window.confirm(
      entry.isDir
        ? `确认删除目录「${entry.name}」及其内容吗？`
        : `确认删除文件「${entry.name}」吗？`
    );
    if (!confirmed) {
      return;
    }
    try {
      await sftpRm(sessionId, entry.path, entry.isDir);
      await loadDirectory(currentPath);
      toast.success(`已删除 ${entry.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除失败。';
      reportError(message);
    }
  };

  const handleRename = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const nextName = window.prompt('请输入新名称：', entry.name);
    if (!nextName || !nextName.trim()) {
      return;
    }
    const toPath = joinRemotePath(currentPath, nextName.trim());
    try {
      await sftpRename(sessionId, entry.path, toPath);
      await loadDirectory(currentPath);
      toast.success(`已重命名为 ${nextName.trim()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '重命名失败。';
      reportError(message);
    }
  };

  const handleCopyOrCut = (entry: SftpEntry, mode: 'copy' | 'cut'): void => {
    setClipboardPayload({
      mode,
      entry
    });
    toast.success(mode === 'copy' ? `已复制：${entry.name}` : `已剪切：${entry.name}`);
  };

  const handlePaste = async (): Promise<void> => {
    if (!sessionId || !clipboardPayload) {
      return;
    }
    const source = clipboardPayload.entry;
    const suggestedName = source.name;
    const nextName = window.prompt('粘贴到当前目录，输入目标名称：', suggestedName);
    if (!nextName || !nextName.trim()) {
      return;
    }
    const destinationPath = joinRemotePath(currentPath, nextName.trim());
    try {
      if (clipboardPayload.mode === 'copy') {
        await sftpCopy(sessionId, source.path, destinationPath);
        toast.success(`已复制到：${nextName.trim()}`);
      } else {
        await sftpRename(sessionId, source.path, destinationPath);
        toast.success(`已移动到：${nextName.trim()}`);
        setClipboardPayload(null);
      }
      await loadDirectory(currentPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : '粘贴失败。';
      reportError(message);
    }
  };

  const handleCompress = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const defaultName = `${entry.name}.tar.gz`;
    const archiveName = window.prompt('请输入压缩包名称（可留空自动生成）：', defaultName) ?? '';
    try {
      const result = await sftpCompress(sessionId, entry.path, archiveName.trim() || undefined);
      toast.success(result.message);
      await loadDirectory(currentPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : '压缩失败。';
      reportError(message);
    }
  };

  const handleExtract = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const destination = window.prompt('请输入解压目标目录（留空为当前目录）：', currentPath) ?? '';
    try {
      const result = await sftpExtract(sessionId, entry.path, destination.trim() || undefined);
      toast.success(result.message);
      await loadDirectory(currentPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : '解压失败。';
      reportError(message);
    }
  };

  const handleCopyPath = async (entry: SftpEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.path);
      toast.success('路径已复制到剪贴板');
    } catch (_err) {
      reportError('复制路径失败，请检查系统剪贴板权限。');
    }
  };

  const handleCopyCurrentPath = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(currentPath);
      toast.success('当前路径已复制到剪贴板');
    } catch (_error) {
      reportError('复制当前路径失败，请检查系统剪贴板权限。');
    }
  };

  const handleGoToPath = async (): Promise<void> => {
    const nextPath = pathInput.trim();
    if (!sessionId || !nextPath) {
      return;
    }
    await loadDirectory(nextPath);
  };

  const handleOpenInTerminal = async (entry: SftpEntry): Promise<void> => {
    if (!entry.isDir) {
      return;
    }
    const targetPath = entry.path;
    const command = `cd "${escapeShellPath(targetPath)}"`;
    try {
      await onSendToTerminal(command, true);
      toast.success(`终端已切换到 ${targetPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '写入终端失败。';
      reportError(message);
    }
  };

  const handleRunScript = async (entry: SftpEntry): Promise<void> => {
    const command = scriptRunCommand(entry);
    if (!command) {
      return;
    }

    try {
      await onSendToTerminal(command, true);
      toast.success(`已在终端执行：${entry.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : '执行脚本失败。';
      reportError(message);
    }
  };

  const openEditor = async (entry: SftpEntry): Promise<void> => {
    if (!sessionId || !canEditEntry(entry)) {
      return;
    }

    setEditorOpen(true);
    setEditorEntry(entry);
    setEditorLanguage(detectLanguage(entry));
    setEditorLoading(true);
    setEditorSaving(false);
    setEditorContent('');
    setEditorOriginalContent('');
    setEditorTruncated(false);
    setError(null);
    try {
      const response = await sftpReadText(sessionId, entry.path);
      setEditorContent(response.content);
      setEditorOriginalContent(response.content);
      setEditorTruncated(response.truncated);
      if (response.truncated) {
        toast.warning('文件较大，已按上限加载，保存将覆盖为当前内容。');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '读取远端文件失败。';
      setEditorOpen(false);
      setEditorEntry(null);
      reportError(message);
    } finally {
      setEditorLoading(false);
    }
  };

  const closeEditor = (): void => {
    if (editorSaving) {
      return;
    }
    if (editorDirty) {
      const confirmed = window.confirm('当前文件有未保存修改，确认关闭编辑器吗？');
      if (!confirmed) {
        return;
      }
    }
    setEditorOpen(false);
    setEditorEntry(null);
    setEditorContent('');
    setEditorOriginalContent('');
    setEditorTruncated(false);
  };

  const saveEditor = async (): Promise<void> => {
    if (!sessionId || !editorEntry || editorSaving || editorLoading) {
      return;
    }

    setEditorSaving(true);
    try {
      await sftpUploadContent(sessionId, editorEntry.path, editorContent);
      setEditorOriginalContent(editorContent);
      setEditorTruncated(false);
      toast.success('保存成功');
      await loadDirectory(currentPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存失败。';
      reportError(message);
    } finally {
      setEditorSaving(false);
    }
  };

  useEffect(() => {
    if (!editorOpen) {
      return;
    }

    const handler = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) {
        return;
      }
      if (event.key.toLowerCase() !== 's') {
        return;
      }
      event.preventDefault();
      void saveEditor();
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [editorOpen, editorEntry, editorContent, editorLoading, editorSaving, sessionId]);

  const renderRow = (entry: SftpEntry): JSX.Element => {
    return (
      <button
        className="grid w-full grid-cols-[2.3fr_1fr_1.3fr] items-center border-t px-3 text-left text-xs text-[color:var(--ot-sftp-text-primary)] hover:bg-[var(--ot-sftp-row-hover)]"
        draggable={!entry.isDir}
        key={entry.path}
        onClick={() => {
          handleEnter(entry);
        }}
        onDragStart={(event) => {
          handleStartRemoteEntryDrag(event, entry);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            entry,
            x: event.clientX,
            y: event.clientY
          });
        }}
        style={{
          height: `${VIRTUAL_ROW_HEIGHT}px`,
          borderColor: 'var(--ot-sftp-soft-border)'
        }}
        type="button"
      >
        <span className="truncate">
          {iconForEntry(entry)} {entry.name}
        </span>
        <span className="text-[color:var(--ot-sftp-text-muted)]">{readableSize(entry.size)}</span>
        <span className="text-[color:var(--ot-sftp-text-muted)]">{readableTime(entry.modifiedAt)}</span>
      </button>
    );
  };

  return (
    <section
      className={`flex h-full min-h-0 flex-col rounded-2xl border bg-[var(--ot-sftp-panel-bg)] p-3 ${
        className ?? ''
      } ${isExternalDropHover ? 'ring-2 ring-emerald-300/80' : ''}`}
      style={{
        ...cssVars,
        borderColor: 'var(--ot-sftp-panel-border)'
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--ot-sftp-text-muted)]">
            SFTP Manager
          </p>
          <p className="truncate text-xs text-[color:var(--ot-sftp-text-secondary)]">
            {sessionId ? currentPath : '请先建立 SSH 会话'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-md border bg-[var(--ot-sftp-button-bg)] px-2.5 py-1 text-xs text-[color:var(--ot-sftp-button-text)] hover:bg-[var(--ot-sftp-button-hover-bg)]"
            disabled={!sessionId || loading}
            onClick={() => {
              void loadDirectory(currentPath);
            }}
            style={{ borderColor: 'var(--ot-sftp-button-border)' }}
            type="button"
          >
            刷新
          </button>
          <button
            className="rounded-md border bg-[var(--ot-sftp-button-bg)] px-2.5 py-1 text-xs text-[color:var(--ot-sftp-button-text)] hover:bg-[var(--ot-sftp-button-hover-bg)]"
            disabled={!sessionId}
            onClick={() => {
              void handleCreateFolder();
            }}
            style={{ borderColor: 'var(--ot-sftp-button-border)' }}
            type="button"
          >
            新建目录
          </button>
          <button
            className="rounded-md border bg-[var(--ot-sftp-button-bg)] px-2.5 py-1 text-xs text-[color:var(--ot-sftp-button-text)] hover:bg-[var(--ot-sftp-button-hover-bg)]"
            disabled={!sessionId}
            onClick={() => {
              void handleUpload();
            }}
            style={{ borderColor: 'var(--ot-sftp-button-border)' }}
            type="button"
          >
            上传文件
          </button>
          <button
            className="rounded-md border bg-[var(--ot-sftp-button-bg)] px-2.5 py-1 text-xs text-[color:var(--ot-sftp-button-text)] hover:bg-[var(--ot-sftp-button-hover-bg)] disabled:opacity-55"
            disabled={!sessionId || !clipboardPayload}
            onClick={() => {
              void handlePaste();
            }}
            style={{ borderColor: 'var(--ot-sftp-button-border)' }}
            type="button"
          >
            粘贴
          </button>
        </div>
      </div>

      <div
        className="mt-2 flex flex-wrap items-center gap-1 rounded-lg border bg-[var(--ot-sftp-soft-bg)] px-2 py-1"
        style={{ borderColor: 'var(--ot-sftp-soft-border)' }}
      >
        {breadcrumbs.map((item, index) => (
          <button
            className="rounded px-1.5 py-0.5 text-[11px] text-[color:var(--ot-sftp-text-secondary)] hover:bg-[var(--ot-sftp-row-hover)] hover:text-[color:var(--ot-sftp-text-primary)]"
            key={`${item.path}-${index}`}
            onClick={() => {
              void loadDirectory(item.path);
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
        <div className="ml-auto flex min-w-[250px] flex-1 items-center justify-end gap-1">
          <input
            className="min-w-[140px] flex-1 rounded border bg-[var(--ot-sftp-table-bg)] px-2 py-1 text-[11px] text-[color:var(--ot-sftp-text-primary)] outline-none focus:border-sky-300"
            disabled={!sessionId || loading}
            onChange={(event) => {
              setPathInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleGoToPath();
              }
            }}
            placeholder="/var/log"
            style={{ borderColor: 'var(--ot-sftp-soft-border)' }}
            type="text"
            value={pathInput}
          />
          <button
            className="rounded border bg-[var(--ot-sftp-button-bg)] px-2 py-1 text-[11px] text-[color:var(--ot-sftp-button-text)] hover:bg-[var(--ot-sftp-button-hover-bg)] disabled:opacity-55"
            disabled={!sessionId || loading}
            onClick={() => {
              void handleGoToPath();
            }}
            style={{ borderColor: 'var(--ot-sftp-button-border)' }}
            type="button"
          >
            进入路径
          </button>
          <button
            className="rounded border bg-[var(--ot-sftp-button-bg)] px-2 py-1 text-[11px] text-[color:var(--ot-sftp-button-text)] hover:bg-[var(--ot-sftp-button-hover-bg)] disabled:opacity-55"
            disabled={!sessionId}
            onClick={() => {
              void handleCopyCurrentPath();
            }}
            style={{ borderColor: 'var(--ot-sftp-button-border)' }}
            type="button"
          >
            复制当前路径
          </button>
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      {sessionId && !loading && isVirtualList && (
        <p className="mt-2 text-[11px] text-[color:var(--ot-sftp-text-muted)]">
          当前目录包含 {sortedEntries.length} 项，已启用虚拟滚动以提升性能。
        </p>
      )}
      {sessionId && (
        <p className="mt-2 text-[11px] text-[color:var(--ot-sftp-text-muted)]">
          支持拖拽本地文件到此区域上传；支持将远端文件拖到“拖拽下载”区快速加入下载队列。
        </p>
      )}
      {clipboardPayload && (
        <p className="mt-1 text-[11px] text-[color:var(--ot-sftp-text-muted)]">
          剪贴板：{clipboardPayload.mode === 'copy' ? '复制' : '剪切'}「{clipboardPayload.entry.name}」
        </p>
      )}

      <div
        className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--ot-sftp-soft-border)' }}
      >
        <div className="grid grid-cols-[2.3fr_1fr_1.3fr] bg-[var(--ot-sftp-soft-bg)] px-3 py-2 text-[11px] font-semibold text-[color:var(--ot-sftp-text-muted)]">
          <span>名称</span>
          <span>大小</span>
          <span>修改时间</span>
        </div>
        <div
          className="h-full min-h-0 overflow-auto bg-[var(--ot-sftp-table-bg)]"
          onDragEnter={(event) => {
            event.preventDefault();
            setIsExternalDropHover(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
              return;
            }
            setIsExternalDropHover(false);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            setIsExternalDropHover(true);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const paths = extractLocalPathsFromDropEvent(event.nativeEvent);
            setIsExternalDropHover(false);
            if (paths.length === 0) {
              reportError('未检测到可读取的本地文件路径，请改用“上传文件”按钮。');
              return;
            }
            enqueueUploadsFromLocalPaths(paths);
          }}
          onScroll={(event) => {
            if (isVirtualList) {
              setScrollTop(event.currentTarget.scrollTop);
            }
          }}
          ref={listViewportRef}
        >
          {!sessionId && (
            <p className="px-3 py-4 text-xs text-[color:var(--ot-sftp-text-muted)]">
              连接终端后即可浏览远程文件。
            </p>
          )}
          {sessionId && loading && (
            <p className="px-3 py-4 text-xs text-[color:var(--ot-sftp-text-muted)]">
              正在读取目录...
            </p>
          )}

          {sessionId && !loading && sortedEntries.length > 0 && !isVirtualList && (
            <>{visibleEntries.map((entry) => renderRow(entry))}</>
          )}

          {sessionId && !loading && sortedEntries.length > 0 && isVirtualList && (
            <div>
              {virtualWindow.topSpacer > 0 && (
                <div style={{ height: `${virtualWindow.topSpacer}px` }} />
              )}
              {visibleEntries.map((entry) => renderRow(entry))}
              {virtualWindow.bottomSpacer > 0 && (
                <div style={{ height: `${virtualWindow.bottomSpacer}px` }} />
              )}
            </div>
          )}

          {sessionId && !loading && sortedEntries.length === 0 && (
            <p className="px-3 py-4 text-xs text-[color:var(--ot-sftp-text-muted)]">目录为空。</p>
          )}
        </div>
      </div>

      <div
        className={`mt-2 rounded-lg border border-dashed px-3 py-2 text-xs ${
          isDownloadDropHover
            ? 'border-sky-300 bg-sky-500/10 text-sky-200'
            : 'border-[var(--ot-sftp-soft-border)] text-[color:var(--ot-sftp-text-muted)]'
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          if (event.dataTransfer.types.includes('application/x-orbitterm-remote-entry')) {
            event.dataTransfer.dropEffect = 'copy';
            setIsDownloadDropHover(true);
          }
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setIsDownloadDropHover(false);
        }}
        onDrop={(event) => {
          void handleDropRemoteEntryToDownload(event);
        }}
      >
        将远端文件拖拽到此处，选择本地目录后即可下载。
      </div>

      {menu && (
        <div
          className="fixed z-50 min-w-[150px] rounded-lg border bg-[var(--ot-sftp-menu-bg)] p-1 text-xs text-[color:var(--ot-sftp-text-primary)] shadow-xl"
          style={{
            left: menu.x,
            top: menu.y,
            borderColor: 'var(--ot-sftp-menu-border)'
          }}
        >
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
            onClick={() => {
              void handleUpload();
              setMenu(null);
            }}
            type="button"
          >
            上传
          </button>
          {!menu.entry.isDir && (
            <button
              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
              onClick={() => {
                void handleDownload(menu.entry);
                setMenu(null);
              }}
              type="button"
            >
              下载
            </button>
          )}
          {canEditEntry(menu.entry) && (
            <button
              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
              onClick={() => {
                void openEditor(menu.entry);
                setMenu(null);
              }}
              type="button"
            >
              编辑
            </button>
          )}
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
            onClick={() => {
              handleCopyOrCut(menu.entry, 'copy');
              setMenu(null);
            }}
            type="button"
          >
            复制
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
            onClick={() => {
              handleCopyOrCut(menu.entry, 'cut');
              setMenu(null);
            }}
            type="button"
          >
            剪切
          </button>
          <button
            className={`block w-full rounded px-2 py-1 text-left ${
              clipboardPayload
                ? 'hover:bg-[var(--ot-sftp-menu-item-hover-bg)]'
                : 'cursor-not-allowed opacity-55'
            }`}
            disabled={!clipboardPayload}
            onClick={() => {
              void handlePaste();
              setMenu(null);
            }}
            type="button"
          >
            粘贴
          </button>
          {menu.entry.isDir && (
            <button
              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
              onClick={() => {
                void handleOpenInTerminal(menu.entry);
                setMenu(null);
              }}
              type="button"
            >
              在终端中打开
            </button>
          )}
          {scriptRunCommand(menu.entry) && (
            <button
              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
              onClick={() => {
                void handleRunScript(menu.entry);
                setMenu(null);
              }}
              type="button"
            >
              在终端运行
            </button>
          )}
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
            onClick={() => {
              void handleCompress(menu.entry);
              setMenu(null);
            }}
            type="button"
          >
            压缩
          </button>
          {isArchiveEntry(menu.entry) && (
            <button
              className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
              onClick={() => {
                void handleExtract(menu.entry);
                setMenu(null);
              }}
              type="button"
            >
              解压
            </button>
          )}
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
            onClick={() => {
              void handleRename(menu.entry);
              setMenu(null);
            }}
            type="button"
          >
            重命名
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
            onClick={() => {
              void handleDelete(menu.entry);
              setMenu(null);
            }}
            type="button"
          >
            删除
          </button>
          <button
            className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--ot-sftp-menu-item-hover-bg)]"
            onClick={() => {
              void handleCopyPath(menu.entry);
              setMenu(null);
            }}
            type="button"
          >
            复制路径
          </button>
        </div>
      )}

      {editorOpen && editorEntry && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-[var(--ot-sftp-editor-overlay-bg)] p-4 backdrop-blur-sm">
          <div
            className="flex h-[80vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border bg-[var(--ot-sftp-editor-bg)] shadow-2xl"
            style={{ borderColor: 'var(--ot-sftp-editor-border)' }}
          >
            <div
              className="flex items-center justify-between gap-3 border-b px-4 py-3"
              style={{ borderColor: 'var(--ot-sftp-editor-header-border)' }}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[color:var(--ot-sftp-text-primary)]">
                  {editorEntry.name}
                </p>
                <p className="truncate text-[11px] text-[color:var(--ot-sftp-text-muted)]">
                  {editorEntry.path}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="rounded-md border px-2 py-1 text-[10px] uppercase tracking-[0.12em]"
                  style={{
                    background: 'var(--ot-sftp-editor-tag-bg)',
                    borderColor: 'var(--ot-sftp-editor-tag-border)',
                    color: 'var(--ot-sftp-editor-tag-text)'
                  }}
                >
                  {editorLanguage}
                </span>
                <span
                  className={`rounded-md border px-2 py-1 text-[10px] ${
                    editorDirty
                      ? 'border-[var(--ot-sftp-warning-border)] bg-[var(--ot-sftp-warning-bg)] text-[color:var(--ot-sftp-warning-text)]'
                      : 'border-[var(--ot-sftp-success-border)] bg-[var(--ot-sftp-success-bg)] text-[color:var(--ot-sftp-success-text)]'
                  }`}
                >
                  {editorDirty ? '未保存' : '已保存'}
                </span>
                <button
                  className="rounded-md border bg-[var(--ot-sftp-action-primary-bg)] px-3 py-1.5 text-xs text-[color:var(--ot-sftp-action-primary-text)] hover:bg-[var(--ot-sftp-action-primary-hover-bg)] disabled:opacity-50"
                  disabled={editorSaving || editorLoading}
                  onClick={() => {
                    void saveEditor();
                  }}
                  style={{ borderColor: 'var(--ot-sftp-action-primary-border)' }}
                  type="button"
                >
                  {editorSaving ? '保存中...' : '保存 (Cmd/Ctrl+S)'}
                </button>
                <button
                  className="rounded-md border bg-[var(--ot-sftp-button-bg)] px-3 py-1.5 text-xs text-[color:var(--ot-sftp-button-text)] hover:bg-[var(--ot-sftp-button-hover-bg)] disabled:opacity-50"
                  disabled={editorSaving}
                  onClick={closeEditor}
                  style={{ borderColor: 'var(--ot-sftp-button-border)' }}
                  type="button"
                >
                  关闭
                </button>
              </div>
            </div>
            {editorTruncated && (
              <p className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-200">
                当前文件超出加载上限，编辑器仅显示部分内容。保存会覆盖为当前内容。
              </p>
            )}
            <div className="min-h-0 flex-1">
              {editorLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-[color:var(--ot-sftp-text-muted)]">
                  正在加载远端文件...
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-[color:var(--ot-sftp-text-muted)]">
                      正在加载编辑器...
                    </div>
                  }
                >
                  <MonacoEditor
                    height="100%"
                    language={editorLanguage}
                    onChange={(value) => {
                      setEditorContent(value ?? '');
                    }}
                    options={{
                      automaticLayout: true,
                      fontSize: 13,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      wordWrap: 'on'
                    }}
                    theme={palette.monacoTheme}
                    value={editorContent}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
