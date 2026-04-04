import { create } from 'zustand';
import {
  sftpDownload,
  type SftpTransferProgressEvent,
  sftpUpload
} from '../services/sftp';

export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'waiting' | 'running' | 'completed' | 'failed';

export interface TransferTask {
  id: string;
  sessionId: string;
  direction: TransferDirection;
  fileName: string;
  localPath: string;
  remotePath: string;
  totalBytes: number;
  transferredBytes: number;
  status: TransferStatus;
  error: string | null;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

interface TransferStoreState {
  transferQueue: TransferTask[];
  maxConcurrent: number;
  panelCollapsed: boolean;
  enqueueUploadTask: (payload: {
    sessionId: string;
    localPath: string;
    remotePath: string;
    fileName: string;
    totalBytes?: number;
  }) => string;
  enqueueDownloadTask: (payload: {
    sessionId: string;
    localPath: string;
    remotePath: string;
    fileName: string;
    totalBytes?: number;
  }) => string;
  retryTask: (taskId: string) => void;
  removeTask: (taskId: string) => void;
  clearFinished: () => void;
  setMaxConcurrent: (value: number) => void;
  setPanelCollapsed: (value: boolean) => void;
  applyProgressEvent: (event: SftpTransferProgressEvent) => void;
}

const MAX_ALLOWED_CONCURRENT = 6;
const MIN_ALLOWED_CONCURRENT = 1;

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const createTaskId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `transfer-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

const activeTaskIds = new Set<string>();
const progressEventBuffer = new Map<string, SftpTransferProgressEvent>();
let progressFlushTimerId: number | null = null;
const PROGRESS_FLUSH_INTERVAL_MS = 120;

const selectWaitingTasksWithFairness = (
  queue: TransferTask[],
  availableSlots: number
): TransferTask[] => {
  const waiting = queue
    .filter((task) => task.status === 'waiting' && !activeTaskIds.has(task.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (waiting.length === 0 || availableSlots <= 0) {
    return [];
  }

  const runningBySession = new Map<string, number>();
  for (const task of queue) {
    if (task.status !== 'running') {
      continue;
    }
    runningBySession.set(task.sessionId, (runningBySession.get(task.sessionId) ?? 0) + 1);
  }

  const selected: TransferTask[] = [];
  const selectedBySession = new Map<string, number>();
  const remaining = [...waiting];
  while (selected.length < availableSlots && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (!candidate) {
        continue;
      }
      const score =
        (runningBySession.get(candidate.sessionId) ?? 0) +
        (selectedBySession.get(candidate.sessionId) ?? 0);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    if (!picked) {
      break;
    }
    selected.push(picked);
    selectedBySession.set(picked.sessionId, (selectedBySession.get(picked.sessionId) ?? 0) + 1);
  }
  return selected;
};

const flushBufferedProgressEvents = (): void => {
  progressFlushTimerId = null;
  if (progressEventBuffer.size === 0) {
    return;
  }
  const snapshot = new Map(progressEventBuffer);
  progressEventBuffer.clear();
  const updatedAt = Date.now();
  useTransferStore.setState((state) => ({
    transferQueue: state.transferQueue.map((item) => {
      const event = snapshot.get(item.id);
      if (!event) {
        return item;
      }
      const nextTotal = event.totalBytes > 0 ? event.totalBytes : item.totalBytes;
      const nextTransferred = Math.max(item.transferredBytes, event.transferredBytes);
      const nextStatus = item.status === 'waiting' ? 'running' : item.status;
      return {
        ...item,
        status: nextStatus,
        totalBytes: nextTotal,
        transferredBytes: nextTransferred,
        updatedAt
      };
    })
  }));
};

const scheduleProgressFlush = (): void => {
  if (progressFlushTimerId !== null) {
    return;
  }
  progressFlushTimerId = window.setTimeout(() => {
    flushBufferedProgressEvents();
  }, PROGRESS_FLUSH_INTERVAL_MS);
};

const runScheduler = (): void => {
  void runSchedulerAsync();
};

const runSchedulerAsync = async (): Promise<void> => {
  const state = useTransferStore.getState();
  const runningCount = state.transferQueue.filter((task) => task.status === 'running').length;
  const availableSlots = Math.max(0, state.maxConcurrent - runningCount);
  if (availableSlots <= 0) {
    return;
  }

  const waitingTasks = selectWaitingTasksWithFairness(state.transferQueue, availableSlots);

  for (const task of waitingTasks) {
    if (activeTaskIds.has(task.id)) {
      continue;
    }
    activeTaskIds.add(task.id);
    useTransferStore.setState((prev) => ({
      transferQueue: prev.transferQueue.map((item) => {
        if (item.id !== task.id) {
          return item;
        }
        return {
          ...item,
          status: 'running',
          error: null,
          updatedAt: Date.now()
        };
      })
    }));

    void executeTask(task.id);
  }
};

const executeTask = async (taskId: string): Promise<void> => {
  const current = useTransferStore.getState().transferQueue.find((item) => item.id === taskId);
  if (!current) {
    activeTaskIds.delete(taskId);
    return;
  }

  const resumeFrom = current.transferredBytes > 0 ? current.transferredBytes : 0;
  try {
    const response =
      current.direction === 'upload'
        ? await sftpUpload(current.sessionId, current.localPath, current.remotePath, {
            transferId: current.id,
            resumeFrom
          })
        : await sftpDownload(current.sessionId, current.remotePath, current.localPath, {
            transferId: current.id,
            resumeFrom
          });

    useTransferStore.setState((prev) => ({
      transferQueue: prev.transferQueue.map((item) => {
        if (item.id !== taskId) {
          return item;
        }
        const resolvedTotal = response.totalBytes > 0 ? response.totalBytes : item.totalBytes;
        const resolvedTransferred =
          resolvedTotal > 0 ? resolvedTotal : Math.max(item.transferredBytes, response.bytes);
        return {
          ...item,
          status: 'completed',
          totalBytes: resolvedTotal,
          transferredBytes: resolvedTransferred,
          error: null,
          updatedAt: Date.now()
        };
      })
    }));
  } catch (error) {
    const fallback = '传输中断，请点击重试继续。';
    const message = error instanceof Error ? error.message : fallback;
    useTransferStore.setState((prev) => ({
      transferQueue: prev.transferQueue.map((item) => {
        if (item.id !== taskId) {
          return item;
        }
        return {
          ...item,
          status: 'failed',
          error: message || fallback,
          updatedAt: Date.now()
        };
      })
    }));
  } finally {
    activeTaskIds.delete(taskId);
    runScheduler();
  }
};

export const useTransferStore = create<TransferStoreState>((set) => ({
  transferQueue: [],
  maxConcurrent: 2,
  panelCollapsed: true,
  enqueueUploadTask: (payload) => {
    const id = createTaskId();
    const now = Date.now();
    set((state) => {
      const nextTask: TransferTask = {
        id,
        sessionId: payload.sessionId,
        direction: 'upload',
        fileName: payload.fileName,
        localPath: payload.localPath,
        remotePath: payload.remotePath,
        totalBytes: payload.totalBytes ?? 0,
        transferredBytes: 0,
        status: 'waiting',
        error: null,
        retryCount: 0,
        createdAt: now,
        updatedAt: now
      };
      return {
        transferQueue: [...state.transferQueue, nextTask],
        panelCollapsed: false
      };
    });
    runScheduler();
    return id;
  },
  enqueueDownloadTask: (payload) => {
    const id = createTaskId();
    const now = Date.now();
    set((state) => {
      const nextTask: TransferTask = {
        id,
        sessionId: payload.sessionId,
        direction: 'download',
        fileName: payload.fileName,
        localPath: payload.localPath,
        remotePath: payload.remotePath,
        totalBytes: payload.totalBytes ?? 0,
        transferredBytes: 0,
        status: 'waiting',
        error: null,
        retryCount: 0,
        createdAt: now,
        updatedAt: now
      };
      return {
        transferQueue: [...state.transferQueue, nextTask],
        panelCollapsed: false
      };
    });
    runScheduler();
    return id;
  },
  retryTask: (taskId) => {
    set((state) => ({
      transferQueue: state.transferQueue.map((item) => {
        if (item.id !== taskId) {
          return item;
        }
        if (item.status === 'running') {
          return item;
        }
        return {
          ...item,
          status: 'waiting',
          error: null,
          retryCount: item.retryCount + 1,
          updatedAt: Date.now()
        };
      })
    }));
    runScheduler();
  },
  removeTask: (taskId) => {
    activeTaskIds.delete(taskId);
    progressEventBuffer.delete(taskId);
    set((state) => ({
      transferQueue: state.transferQueue.filter((item) => item.id !== taskId)
    }));
  },
  clearFinished: () => {
    const keepTaskIds = new Set(
      useTransferStore
        .getState()
        .transferQueue.filter((item) => item.status === 'running' || item.status === 'waiting')
        .map((item) => item.id)
    );
    for (const taskId of progressEventBuffer.keys()) {
      if (!keepTaskIds.has(taskId)) {
        progressEventBuffer.delete(taskId);
      }
    }
    set((state) => ({
      transferQueue: state.transferQueue.filter(
        (item) => item.status === 'running' || item.status === 'waiting'
      )
    }));
  },
  setMaxConcurrent: (value) => {
    set({
      maxConcurrent: clamp(
        Math.round(value),
        MIN_ALLOWED_CONCURRENT,
        MAX_ALLOWED_CONCURRENT
      )
    });
    runScheduler();
  },
  setPanelCollapsed: (value) => {
    set({ panelCollapsed: value });
  },
  applyProgressEvent: (event) => {
    progressEventBuffer.set(event.transferId, event);
    scheduleProgressFlush();
  }
}));
