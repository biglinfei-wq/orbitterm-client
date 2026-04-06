import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent
} from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { exit as processExit } from '@tauri-apps/plugin-process';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Toaster, toast } from 'sonner';
import { Step1 } from './components/wizard/Step1';
import { Step2 } from './components/wizard/Step2';
import { Step3 } from './components/wizard/Step3';
import { StepIndicator } from './components/wizard/StepIndicator';
import { UnlockScreen } from './components/UnlockScreen';
import { FirstRunOnboarding } from './components/FirstRunOnboarding';
import { HostEditDialog, type HostEditFormValues } from './components/HostEditDialog';
import { CommandPalette, type CommandPaletteItem } from './components/CommandPalette';
import {
  OrbitTerminal,
  type SplitDirection,
  type TerminalLayoutNode,
  type TerminalSplitPane
} from './components/terminal/OrbitTerminal';
import { MetricTrendChart, type MetricTrendPoint } from './components/terminal/MetricTrendChart';
import { OrbitAiAssistant } from './components/terminal/OrbitAiAssistant';
import { OrbitInspector } from './components/terminal/OrbitInspector';
import { SnippetsPanel } from './components/terminal/SnippetsPanel';
import { SftpManager } from './components/sftp/SftpManager';
import { TransferCenter } from './components/transfer/TransferCenter';
import { MobileLayout, type MobileNavTab } from './components/layout/MobileLayout';
import { AboutOrbitTermModal } from './components/settings/AboutOrbitTermModal';
import { SettingsDrawer, type SettingsCategory } from './components/settings/SettingsDrawer';
import { CloudAuthModal } from './components/cloud/CloudAuthModal';
import { BrandLogo } from './components/BrandLogo';
import { useHostStore } from './store/useHostStore';
import { useUiSettingsStore, type CloseWindowAction } from './store/useUiSettingsStore';
import { useTransferStore } from './store/useTransferStore';
import { useAppLogStore } from './store/useAppLogStore';
import { aiExplainSshError } from './services/ai';
import type { HealthCheckResponse, SshDiagnosticLogEvent } from './services/inspector';
import { runHealthCheck } from './services/inspector';
import {
  sshDeployPublicKey,
  sshDerivePublicKey,
  sshDisconnect,
  sshQueryHostInfo,
  sshQueryPwd,
  sshSetPulseActivity,
  sshWrite,
  type SshHostInfoResponse,
  type SshSysStatusEvent
} from './services/ssh';
import type { SftpTransferProgressEvent } from './services/sftp';
import { getAppVersion } from './services/appInfo';
import {
  checkReleaseAvailability,
  readReleaseNoticeState,
  rememberDailyLockCheck,
  type ReleaseNoticeState,
  wasDailyLockChecked,
  writeReleaseNoticeState
} from './services/updater';
import { discoverCloudSyncPolicy } from './services/cloudSync';
import { openExternalLink } from './services/externalLink';
import {
  resolveSftpPalette,
  resolveTerminalChromePalette,
  resolveThemePreset,
  resolveUiPalette,
  toRgba
} from './theme/orbitTheme';
import { buildHostKey } from './utils/hostKey';
import { useI18n } from './i18n/useI18n';
import { detectMobileFormFactor, isAndroidRuntime } from './services/runtime';
import { applyMobileOrientationMode } from './services/mobileOrientation';
const appWindow = getCurrentWebviewWindow();

type DashboardSection = 'hosts' | 'terminal';

interface SftpSyncRequest {
  sessionId: string;
  path: string;
  nonce: number;
}

type SessionSysStatus = SshSysStatusEvent['status'];

interface TabSplitWorkspace {
  root: TerminalLayoutNode;
  activePaneId: string;
  syncInput: boolean;
}

interface SplitMenuState {
  x: number;
  y: number;
  tabSessionId: string;
  paneId: string;
}

interface SessionMetricSample {
  at: number;
  cpu: number;
  memory: number;
  rx: number;
  tx: number;
  latency: number;
}

type MetricCardKey = 'cpu' | 'memory' | 'rx' | 'tx' | 'latency';

interface TerminalPerfSummary {
  inputChunks: number;
  inputBytes: number;
  inputFlushes: number;
  pendingInputSessions: number;
  sysStatusEvents: number;
  sysUiFlushes: number;
  updatedAt: number;
}

const toolbarButtonClass =
  'rounded-lg border border-slate-300 bg-white/90 px-2.5 py-1 text-[11px] font-medium text-slate-800 hover:bg-white disabled:cursor-not-allowed disabled:opacity-55';
const darkPanelButtonClass =
  'ot-compact-hit rounded-lg border border-[#5a79a8] bg-[#0f1726] px-2 py-[1px] text-[11px] leading-4 font-medium text-[#d7e5ff] hover:bg-[#13203a]';
const compactDarkPanelButtonClass =
  'ot-compact-hit h-[18px] rounded-md border border-[#5a79a8] bg-[#0f1726] px-2 py-0 text-[11px] leading-[1] font-medium text-[#d7e5ff] hover:bg-[#13203a]';
const SFTP_PANEL_MIN_WIDTH = 280;
const SFTP_PANEL_MAX_WIDTH = 680;
const IDLE_RELEASE_CHECK_MS = 5 * 60 * 1000;
const AUTO_PULL_INTERVAL_MS = 25_000;
const SYS_TREND_WINDOW_MS = 10 * 60 * 1000;
const SYS_TREND_MAX_SAMPLES = 900;
const SYS_METRICS_UI_FLUSH_MS = 260;
const DIAGNOSTIC_LOG_MAX = 1200;
const AUTO_SFTP_SYNC_DEBOUNCE_MS = 260;
const TERMINAL_INPUT_BUFFER_LIMIT = 1024;
const TERMINAL_INPUT_FLUSH_MS = 6;
const TERMINAL_INPUT_MAX_BUFFER_CHARS = 8192;
const PERF_STATS_FLUSH_MS = 1000;
const MOBILE_SESSION_SWIPE_THRESHOLD_PX = 72;
const MOBILE_SESSION_SWIPE_MAX_Y_DRIFT = 60;
const AUTO_RECONNECT_WAIT_ONLINE_MS = 20_000;
const TERMINAL_DRAFT_HISTORY_LIMIT = 120;
const CWD_CHANGE_COMMAND_PATTERN =
  /(^|[;&|]{1,2})\s*(?:builtin\s+)?(?:cd|pushd|popd|z|j)\b/i;

const SETTINGS_SECTION_CATEGORY_MAP: Record<string, SettingsCategory> = {
  'settings-font': 'settings',
  'settings-acrylic': 'settings',
  'settings-theme': 'settings',
  'settings-security': 'settings',
  'settings-identity': 'files',
  'settings-sync': 'profile',
  'settings-sync-license': 'profile',
  'settings-devices': 'profile',
  'settings-about': 'other'
};

type AppLocalePack = {
  navHosts: string;
  navTerminal: string;
  navPalette: string;
  navSync: string;
  navLastSync: string;
  navSyncStatus: string;
  navSyncHealthy: string;
  navSyncUnhealthy: string;
  navPullNow: string;
  navPushNow: string;
  navLockNow: string;
  navCloudOnline: string;
  navCloudOffline: string;
  navQuickPrefs: string;
  navAutoPathSync: string;
  navCloseAction: string;
  navCloseActionAsk: string;
  navCloseActionTray: string;
  navCloseActionExit: string;
  navSave: string;
  navCancel: string;
  navUpgradePro: string;
  navRenewPro: string;
  navProExpires: string;
  navProLifetime: string;
  hostTitle: string;
  hostAdd: string;
  hostSearchPlaceholder: string;
  hostFilterAll: string;
  hostFilterTitle: string;
  hostNoItems: string;
  hostNoResults: string;
  hostIdentity: string;
  hostIdentityMissing: string;
  hostRemark: string;
  hostConnect: string;
  hostConnecting: string;
  hostEdit: string;
  hostDelete: string;
  hostDeployKey: string;
  hostDeployingKey: string;
  hostBatchDeployKey: string;
  hostBatchDeploying: string;
  hostSelectAll: string;
  hostClearSelection: string;
  hostSelectedCount: string;
  terminalTitle: string;
  terminalNewWindow: string;
  terminalLogs: string;
  terminalPathSync: string;
  terminalPathSyncOn: string;
  terminalPathSyncOff: string;
  terminalSyncNow: string;
  terminalSyncing: string;
  terminalInputSync: string;
  terminalCloseCurrent: string;
  terminalMaximize: string;
  terminalRestore: string;
  terminalExpandSftp: string;
  terminalCollapseSftp: string;
  terminalNoSession: string;
  terminalNoSessionPlaceholder: string;
  terminalPreInputLabel: string;
  terminalPreInputPlaceholder: string;
  terminalPreInputDisabled: string;
  terminalSnippetOpen: string;
  terminalSnippetClose: string;
};

const APP_LOCALE_PACKS: Record<'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP', AppLocalePack> = {
  'zh-CN': {
    navHosts: '资产管理',
    navTerminal: '终端会话',
    navPalette: '命令面板 (Cmd/Ctrl+K)',
    navSync: '同步',
    navLastSync: '上次同步',
    navSyncStatus: '同步状态',
    navSyncHealthy: '正常',
    navSyncUnhealthy: '异常',
    navPullNow: '立即拉取',
    navPushNow: '强制推送',
    navLockNow: '立即锁定',
    navCloudOnline: '私有云已连接',
    navCloudOffline: '私有云未连接',
    navQuickPrefs: '快速偏好（修改后请保存）',
    navAutoPathSync: '自动同步终端路径到 SFTP',
    navCloseAction: '关闭窗口按钮行为',
    navCloseActionAsk: '每次询问',
    navCloseActionTray: '默认最小化到托盘',
    navCloseActionExit: '默认直接退出',
    navSave: '保存',
    navCancel: '取消',
    navUpgradePro: '升级 Pro 版',
    navRenewPro: '续期 Pro',
    navProExpires: 'Pro 到期',
    navProLifetime: 'Pro 永久版',
    hostTitle: '主机资产列表',
    hostAdd: '添加主机',
    hostSearchPlaceholder: '搜索别名、IP 或标签（Cmd/Ctrl+F 聚焦）',
    hostFilterAll: '全部',
    hostFilterTitle: '标签分类',
    hostNoItems: '当前金库中暂无主机，请点击顶部“新增主机”开始配置。',
    hostNoResults: '未匹配到主机，请调整搜索关键词或标签筛选。',
    hostIdentity: '身份',
    hostIdentityMissing: '未绑定身份',
    hostRemark: '备注',
    hostConnect: '连接',
    hostConnecting: '连接中...',
    hostEdit: '编辑',
    hostDelete: '删除',
    hostDeployKey: '一键部署密钥',
    hostDeployingKey: '部署中...',
    hostBatchDeployKey: '批量部署密钥',
    hostBatchDeploying: '批量部署中...',
    hostSelectAll: '全选筛选结果',
    hostClearSelection: '清空选择',
    hostSelectedCount: '已选择',
    terminalTitle: '轨连终端',
    terminalNewWindow: '新建窗口',
    terminalLogs: '连接日志',
    terminalPathSync: '路径同步',
    terminalPathSyncOn: '开',
    terminalPathSyncOff: '关',
    terminalSyncNow: '立即同步',
    terminalSyncing: '同步中...',
    terminalInputSync: '同步输入',
    terminalCloseCurrent: '关闭当前',
    terminalMaximize: '最大化',
    terminalRestore: '恢复',
    terminalExpandSftp: '展开 SFTP',
    terminalCollapseSftp: '收起 SFTP',
    terminalNoSession: '暂无会话，请点击“新建窗口”或在主机列表中连接。',
    terminalNoSessionPlaceholder: '请选择一台主机并点击“连接”，或使用“新建窗口”。',
    terminalPreInputLabel: '预输入命令（可编辑，按 Enter 发送并执行）',
    terminalPreInputPlaceholder: '例如：sudo systemctl restart nginx',
    terminalPreInputDisabled: '请先建立终端会话后再输入命令',
    terminalSnippetOpen: '打开指令库',
    terminalSnippetClose: '收起指令库'
  },
  'zh-TW': {
    navHosts: '資產管理',
    navTerminal: '終端會話',
    navPalette: '命令面板 (Cmd/Ctrl+K)',
    navSync: '同步',
    navLastSync: '上次同步',
    navSyncStatus: '同步狀態',
    navSyncHealthy: '正常',
    navSyncUnhealthy: '異常',
    navPullNow: '立即拉取',
    navPushNow: '強制推送',
    navLockNow: '立即鎖定',
    navCloudOnline: '私有雲已連線',
    navCloudOffline: '私有雲未連線',
    navQuickPrefs: '快速偏好（修改後請儲存）',
    navAutoPathSync: '自動同步終端路徑到 SFTP',
    navCloseAction: '關閉視窗行為',
    navCloseActionAsk: '每次詢問',
    navCloseActionTray: '預設最小化到系統匣',
    navCloseActionExit: '預設直接退出',
    navSave: '儲存',
    navCancel: '取消',
    navUpgradePro: '升級 Pro 版',
    navRenewPro: '續期 Pro',
    navProExpires: 'Pro 到期',
    navProLifetime: 'Pro 永久版',
    hostTitle: '主機資產清單',
    hostAdd: '新增主機',
    hostSearchPlaceholder: '搜尋別名、IP 或標籤（Cmd/Ctrl+F 聚焦）',
    hostFilterAll: '全部',
    hostFilterTitle: '標籤分類',
    hostNoItems: '目前金庫沒有主機，請點擊上方「新增主機」開始設定。',
    hostNoResults: '找不到符合條件的主機，請調整搜尋或篩選。',
    hostIdentity: '身份',
    hostIdentityMissing: '未綁定身份',
    hostRemark: '備註',
    hostConnect: '連線',
    hostConnecting: '連線中...',
    hostEdit: '編輯',
    hostDelete: '刪除',
    hostDeployKey: '一鍵部署金鑰',
    hostDeployingKey: '部署中...',
    hostBatchDeployKey: '批量部署金鑰',
    hostBatchDeploying: '批量部署中...',
    hostSelectAll: '全選篩選結果',
    hostClearSelection: '清空選擇',
    hostSelectedCount: '已選擇',
    terminalTitle: 'OrbitTerm 終端',
    terminalNewWindow: '新建視窗',
    terminalLogs: '連線日誌',
    terminalPathSync: '路徑同步',
    terminalPathSyncOn: '開',
    terminalPathSyncOff: '關',
    terminalSyncNow: '立即同步',
    terminalSyncing: '同步中...',
    terminalInputSync: '同步輸入',
    terminalCloseCurrent: '關閉目前會話',
    terminalMaximize: '最大化',
    terminalRestore: '還原',
    terminalExpandSftp: '展開 SFTP',
    terminalCollapseSftp: '收起 SFTP',
    terminalNoSession: '尚無會話，請點擊「新建視窗」或在主機清單連線。',
    terminalNoSessionPlaceholder: '請選擇主機並點擊「連線」，或使用「新建視窗」。',
    terminalPreInputLabel: '預輸入命令（可編輯，按 Enter 送出）',
    terminalPreInputPlaceholder: '例如：sudo systemctl restart nginx',
    terminalPreInputDisabled: '請先建立終端會話再輸入命令',
    terminalSnippetOpen: '開啟指令庫',
    terminalSnippetClose: '收起指令庫'
  },
  'en-US': {
    navHosts: 'Assets',
    navTerminal: 'Terminal',
    navPalette: 'Command Palette (Cmd/Ctrl+K)',
    navSync: 'Sync',
    navLastSync: 'Last Sync',
    navSyncStatus: 'Sync Status',
    navSyncHealthy: 'Normal',
    navSyncUnhealthy: 'Abnormal',
    navPullNow: 'Pull Now',
    navPushNow: 'Force Push',
    navLockNow: 'Lock Now',
    navCloudOnline: 'Private sync connected',
    navCloudOffline: 'Private sync disconnected',
    navQuickPrefs: 'Quick preferences (save to apply)',
    navAutoPathSync: 'Auto-sync terminal path to SFTP',
    navCloseAction: 'Close button behavior',
    navCloseActionAsk: 'Ask every time',
    navCloseActionTray: 'Minimize to tray by default',
    navCloseActionExit: 'Exit app by default',
    navSave: 'Save',
    navCancel: 'Cancel',
    navUpgradePro: 'Upgrade to Pro',
    navRenewPro: 'Renew Pro',
    navProExpires: 'Pro Expires',
    navProLifetime: 'Pro Lifetime',
    hostTitle: 'Host Inventory',
    hostAdd: 'Add Host',
    hostSearchPlaceholder: 'Search alias, IP, or tag (Cmd/Ctrl+F)',
    hostFilterAll: 'All',
    hostFilterTitle: 'Tag Filters',
    hostNoItems: 'No hosts in vault yet. Click Add Host to start.',
    hostNoResults: 'No host matches found. Adjust search or tag filter.',
    hostIdentity: 'Identity',
    hostIdentityMissing: 'Unbound identity',
    hostRemark: 'Remark',
    hostConnect: 'Connect',
    hostConnecting: 'Connecting...',
    hostEdit: 'Edit',
    hostDelete: 'Delete',
    hostDeployKey: 'Deploy SSH Key',
    hostDeployingKey: 'Deploying...',
    hostBatchDeployKey: 'Batch Deploy Keys',
    hostBatchDeploying: 'Batch Deploying...',
    hostSelectAll: 'Select All Results',
    hostClearSelection: 'Clear Selection',
    hostSelectedCount: 'Selected',
    terminalTitle: 'Orbit Terminal',
    terminalNewWindow: 'New Window',
    terminalLogs: 'Connection Logs',
    terminalPathSync: 'Path Sync',
    terminalPathSyncOn: 'On',
    terminalPathSyncOff: 'Off',
    terminalSyncNow: 'Sync Now',
    terminalSyncing: 'Syncing...',
    terminalInputSync: 'Input Broadcast',
    terminalCloseCurrent: 'Close Current',
    terminalMaximize: 'Maximize',
    terminalRestore: 'Restore',
    terminalExpandSftp: 'Expand SFTP',
    terminalCollapseSftp: 'Collapse SFTP',
    terminalNoSession: 'No session yet. Click New Window or connect from host list.',
    terminalNoSessionPlaceholder: 'Choose a host and click Connect, or use New Window.',
    terminalPreInputLabel: 'Pre-input command (editable, press Enter to run)',
    terminalPreInputPlaceholder: 'Example: sudo systemctl restart nginx',
    terminalPreInputDisabled: 'Start a terminal session before entering commands',
    terminalSnippetOpen: 'Open Snippets',
    terminalSnippetClose: 'Hide Snippets'
  },
  'ja-JP': {
    navHosts: '資産',
    navTerminal: 'ターミナル',
    navPalette: 'コマンドパレット (Cmd/Ctrl+K)',
    navSync: '同期',
    navLastSync: '最終同期',
    navSyncStatus: '同期状態',
    navSyncHealthy: '正常',
    navSyncUnhealthy: '異常',
    navPullNow: '今すぐ取得',
    navPushNow: '強制送信',
    navLockNow: '今すぐロック',
    navCloudOnline: 'プライベート同期接続中',
    navCloudOffline: 'プライベート同期未接続',
    navQuickPrefs: 'クイック設定（保存で反映）',
    navAutoPathSync: 'ターミナルパスを SFTP に自動同期',
    navCloseAction: '閉じるボタンの動作',
    navCloseActionAsk: '毎回確認する',
    navCloseActionTray: '既定でトレイに最小化',
    navCloseActionExit: '既定でアプリ終了',
    navSave: '保存',
    navCancel: 'キャンセル',
    navUpgradePro: 'Pro にアップグレード',
    navRenewPro: 'Pro を更新',
    navProExpires: 'Pro 有効期限',
    navProLifetime: 'Pro 永続版',
    hostTitle: 'ホスト一覧',
    hostAdd: 'ホスト追加',
    hostSearchPlaceholder: '別名・IP・タグで検索（Cmd/Ctrl+F）',
    hostFilterAll: 'すべて',
    hostFilterTitle: 'タグフィルター',
    hostNoItems: 'ボールトにホストがありません。ホスト追加から開始してください。',
    hostNoResults: '一致するホストがありません。検索条件を調整してください。',
    hostIdentity: 'ID',
    hostIdentityMissing: '未紐付け',
    hostRemark: 'メモ',
    hostConnect: '接続',
    hostConnecting: '接続中...',
    hostEdit: '編集',
    hostDelete: '削除',
    hostDeployKey: '鍵を一括配備',
    hostDeployingKey: '配備中...',
    hostBatchDeployKey: '鍵を一括配備',
    hostBatchDeploying: '一括配備中...',
    hostSelectAll: '検索結果を全選択',
    hostClearSelection: '選択解除',
    hostSelectedCount: '選択済み',
    terminalTitle: 'Orbit ターミナル',
    terminalNewWindow: '新規ウィンドウ',
    terminalLogs: '接続ログ',
    terminalPathSync: 'パス同期',
    terminalPathSyncOn: 'オン',
    terminalPathSyncOff: 'オフ',
    terminalSyncNow: '今すぐ同期',
    terminalSyncing: '同期中...',
    terminalInputSync: '入力同期',
    terminalCloseCurrent: '現在を閉じる',
    terminalMaximize: '最大化',
    terminalRestore: '元に戻す',
    terminalExpandSftp: 'SFTP を展開',
    terminalCollapseSftp: 'SFTP を折りたたむ',
    terminalNoSession: 'セッションがありません。新規ウィンドウかホスト一覧から接続してください。',
    terminalNoSessionPlaceholder: 'ホストを選択して接続するか、新規ウィンドウを使ってください。',
    terminalPreInputLabel: '事前入力コマンド（編集可・Enter で実行）',
    terminalPreInputPlaceholder: '例: sudo systemctl restart nginx',
    terminalPreInputDisabled: '先にターミナルセッションを開始してください',
    terminalSnippetOpen: 'スニペットを開く',
    terminalSnippetClose: 'スニペットを閉じる'
  }
};

const resolveAppLocalePack = (locale: string): AppLocalePack => {
  if (locale === 'zh-TW') {
    return APP_LOCALE_PACKS['zh-TW'];
  }
  if (locale === 'ja-JP') {
    return APP_LOCALE_PACKS['ja-JP'];
  }
  if (locale === 'en-US') {
    return APP_LOCALE_PACKS['en-US'];
  }
  return APP_LOCALE_PACKS['zh-CN'];
};

const buildLocalDayLabel = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
};

const normalizeSampledAtMs = (sampledAt: number): number => {
  if (!Number.isFinite(sampledAt)) {
    return Date.now();
  }
  if (sampledAt > 1_000_000_000_000) {
    return Math.round(sampledAt);
  }
  if (sampledAt > 1_000_000_000) {
    return Math.round(sampledAt * 1000);
  }
  return Date.now();
};

const shouldTriggerAutoSftpPathSync = (rawCommand: string): boolean => {
  const normalized = rawCommand
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\].*?(?:\u0007|\u001b\\)/g, '')
    .trim();
  if (!normalized) {
    return false;
  }
  return CWD_CHANGE_COMMAND_PATTERN.test(normalized);
};

const shouldFlushTerminalInputImmediately = (data: string): boolean => {
  return (
    data.includes('\r') ||
    data.includes('\n') ||
    data.includes('\u0003') ||
    data.includes('\u0004') ||
    data.includes('\u001b')
  );
};

const waitForBrowserOnline = async (timeoutMs: number): Promise<boolean> => {
  if (typeof navigator === 'undefined' || navigator.onLine) {
    return true;
  }
  return new Promise<boolean>((resolve) => {
    let done = false;
    const timerId = window.setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      window.removeEventListener('online', handleOnline);
      resolve(false);
    }, timeoutMs);

    const handleOnline = (): void => {
      if (done) {
        return;
      }
      done = true;
      window.clearTimeout(timerId);
      window.removeEventListener('online', handleOnline);
      resolve(true);
    };

    window.addEventListener('online', handleOnline, { once: true });
  });
};

const createPaneId = (tabSessionId: string): string => {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `pane-${tabSessionId}-${randomPart}`;
};

const createSplitId = (): string => {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 10);
  return `split-${randomPart}`;
};

const createPaneNode = (pane: TerminalSplitPane): TerminalLayoutNode => ({
  type: 'pane',
  pane
});

const createDefaultWorkspace = (session: {
  id: string;
  hostId: string;
  title: string;
}): TabSplitWorkspace => {
  const paneId = `pane-${session.id}`;
  const pane: TerminalSplitPane = {
    id: paneId,
    sessionId: session.id,
    hostId: session.hostId,
    title: session.title
  };
  return {
    root: createPaneNode(pane),
    activePaneId: paneId,
    syncInput: false
  };
};

const collectWorkspacePanes = (node: TerminalLayoutNode): TerminalSplitPane[] => {
  if (node.type === 'pane') {
    return [node.pane];
  }
  return [...collectWorkspacePanes(node.first), ...collectWorkspacePanes(node.second)];
};

const hasPaneId = (node: TerminalLayoutNode, paneId: string): boolean => {
  if (node.type === 'pane') {
    return node.pane.id === paneId;
  }
  return hasPaneId(node.first, paneId) || hasPaneId(node.second, paneId);
};

const findPaneById = (node: TerminalLayoutNode, paneId: string): TerminalSplitPane | null => {
  if (node.type === 'pane') {
    return node.pane.id === paneId ? node.pane : null;
  }
  return findPaneById(node.first, paneId) ?? findPaneById(node.second, paneId);
};

const findPaneBySessionId = (node: TerminalLayoutNode, sessionId: string): TerminalSplitPane | null => {
  if (node.type === 'pane') {
    return node.pane.sessionId === sessionId ? node.pane : null;
  }
  return findPaneBySessionId(node.first, sessionId) ?? findPaneBySessionId(node.second, sessionId);
};

const updatePaneBySessionId = (
  node: TerminalLayoutNode,
  sessionId: string,
  patch: Partial<TerminalSplitPane>
): TerminalLayoutNode => {
  if (node.type === 'pane') {
    if (node.pane.sessionId !== sessionId) {
      return node;
    }
    return {
      ...node,
      pane: {
        ...node.pane,
        ...patch
      }
    };
  }

  const nextFirst = updatePaneBySessionId(node.first, sessionId, patch);
  const nextSecond = updatePaneBySessionId(node.second, sessionId, patch);
  if (nextFirst === node.first && nextSecond === node.second) {
    return node;
  }
  return {
    ...node,
    first: nextFirst,
    second: nextSecond
  };
};

const replacePaneWithSplit = (
  node: TerminalLayoutNode,
  targetPaneId: string,
  direction: SplitDirection,
  nextPane: TerminalSplitPane
): TerminalLayoutNode => {
  if (node.type === 'pane') {
    if (node.pane.id !== targetPaneId) {
      return node;
    }
    return {
      type: 'split',
      id: createSplitId(),
      direction,
      sizes: [50, 50],
      first: node,
      second: createPaneNode(nextPane)
    };
  }

  const nextFirst = replacePaneWithSplit(node.first, targetPaneId, direction, nextPane);
  if (nextFirst !== node.first) {
    return {
      ...node,
      first: nextFirst
    };
  }
  const nextSecond = replacePaneWithSplit(node.second, targetPaneId, direction, nextPane);
  if (nextSecond !== node.second) {
    return {
      ...node,
      second: nextSecond
    };
  }
  return node;
};

const removePaneFromLayout = (
  node: TerminalLayoutNode,
  targetPaneId: string
): { nextNode: TerminalLayoutNode | null; removedPane: TerminalSplitPane | null } => {
  if (node.type === 'pane') {
    if (node.pane.id === targetPaneId) {
      return {
        nextNode: null,
        removedPane: node.pane
      };
    }
    return {
      nextNode: node,
      removedPane: null
    };
  }

  const leftResult = removePaneFromLayout(node.first, targetPaneId);
  if (leftResult.removedPane) {
    if (!leftResult.nextNode) {
      return {
        nextNode: node.second,
        removedPane: leftResult.removedPane
      };
    }
    return {
      nextNode: {
        ...node,
        first: leftResult.nextNode
      },
      removedPane: leftResult.removedPane
    };
  }

  const rightResult = removePaneFromLayout(node.second, targetPaneId);
  if (rightResult.removedPane) {
    if (!rightResult.nextNode) {
      return {
        nextNode: node.first,
        removedPane: rightResult.removedPane
      };
    }
    return {
      nextNode: {
        ...node,
        second: rightResult.nextNode
      },
      removedPane: rightResult.removedPane
    };
  }

  return {
    nextNode: node,
    removedPane: null
  };
};

const formatRate = (bytesPerSec: number): string => {
  const value = Number.isFinite(bytesPerSec) ? Math.max(0, bytesPerSec) : 0;
  if (value < 1024) {
    return `${value.toFixed(0)} B/s`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB/s`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB/s`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
};

const formatBytes = (bytes: number): string => {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) {
    return `${value.toFixed(0)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatLatency = (latencyMs?: number | null): string => {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs) || latencyMs < 0) {
    return '--';
  }
  if (latencyMs < 1) {
    return '<1 ms';
  }
  if (latencyMs < 1000) {
    return `${latencyMs.toFixed(0)} ms`;
  }
  return `${(latencyMs / 1000).toFixed(2)} s`;
};

const resolveTagMicroIcon = (tag: string): string => {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    return '◻';
  }
  if (normalized.includes('prod') || normalized.includes('生产')) {
    return '🏭';
  }
  if (normalized.includes('node') || normalized.includes('节点')) {
    return '🧩';
  }
  if (normalized.includes('db') || normalized.includes('数据库')) {
    return '🗄';
  }
  if (normalized.includes('dev') || normalized.includes('测试')) {
    return '🧪';
  }
  if (normalized.includes('route') || normalized.includes('网络')) {
    return '🌐';
  }
  return '🏷';
};

const scoreSearchField = (query: string, rawValue: string): number => {
  const value = rawValue.trim().toLowerCase();
  if (!value) {
    return 0;
  }
  if (value === query) {
    return 220;
  }
  if (value.startsWith(query)) {
    return 160;
  }
  const index = value.indexOf(query);
  if (index >= 0) {
    return Math.max(50, 130 - index);
  }
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => value.includes(token))) {
    return 40;
  }
  return 0;
};

const scoreSearchFields = (query: string, values: string[]): number => {
  if (!query) {
    return 0;
  }
  let best = 0;
  let hitCount = 0;
  for (const value of values) {
    const score = scoreSearchField(query, value);
    if (score > 0) {
      hitCount += 1;
    }
    if (score > best) {
      best = score;
    }
  }
  return best + Math.min(36, hitCount * 12);
};

type PaletteRuntimeItem = CommandPaletteItem & {
  score: number;
  execute: () => Promise<void> | void;
};

interface PaletteSettingEntry {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  sectionId: string;
}

const PALETTE_SETTINGS_ENTRIES: ReadonlyArray<PaletteSettingEntry> = [
  {
    id: 'settings-font',
    title: '设置 · 终端字体',
    subtitle: '调整字体家族、字号与渲染显示',
    keywords: ['字体', '字号', 'font', 'nerd', 'terminal font'],
    sectionId: 'settings-font'
  },
  {
    id: 'settings-acrylic',
    title: '设置 · 毛玻璃与透明度',
    subtitle: '调整终端透明度、模糊与全局 Acrylic 参数',
    keywords: ['透明度', '模糊', 'acrylic', 'blur', 'glass'],
    sectionId: 'settings-acrylic'
  },
  {
    id: 'settings-theme',
    title: '设置 · 主题配色',
    subtitle: '切换 OrbitTerm 内置终端主题',
    keywords: ['主题', '配色', 'theme', 'solarized', 'dracula', 'monokai'],
    sectionId: 'settings-theme'
  },
  {
    id: 'settings-security',
    title: '设置 · 安全',
    subtitle: '自动锁定时长与安全策略',
    keywords: ['安全', '锁定', 'auto lock', 'vault'],
    sectionId: 'settings-security'
  },
  {
    id: 'settings-identity',
    title: '设置 · 身份管理与 SSH 密钥',
    subtitle: '生成密钥、部署公钥、导出私钥',
    keywords: ['身份', '密钥', 'ssh key', 'identity', 'ed25519', 'rsa'],
    sectionId: 'settings-identity'
  },
  {
    id: 'settings-sync',
    title: '设置 · 私有云同步',
    subtitle: '同步状态、手动拉取与会话信息',
    keywords: ['同步', 'cloud', 'push', 'pull', '状态'],
    sectionId: 'settings-sync'
  },
  {
    id: 'settings-devices',
    title: '设置 · 登录设备管理',
    subtitle: '查看在线设备与一键退出',
    keywords: ['设备', '登录设备', 'device', 'logout'],
    sectionId: 'settings-devices'
  },
  {
    id: 'settings-about',
    title: '设置 · 关于 OrbitTerm',
    subtitle: '版本信息与下载提示',
    keywords: ['关于', 'version', 'release', '更新'],
    sectionId: 'settings-about'
  }
];

function App(): JSX.Element {
  const { locale, t } = useI18n();
  const [isAiAssistantOpen, setIsAiAssistantOpen] = useState<boolean>(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState<string>('');
  const [commandPaletteActiveIndex, setCommandPaletteActiveIndex] = useState<number>(0);
  const [isMobileLayout, setIsMobileLayout] = useState<boolean>(() => detectMobileFormFactor());
  const [isInspectorOpen, setIsInspectorOpen] = useState<boolean>(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>('settings');
  const [settingsFocusSectionId, setSettingsFocusSectionId] = useState<string | null>(null);
  const [settingsFocusSequence, setSettingsFocusSequence] = useState<number>(0);
  const [isAboutOpen, setIsAboutOpen] = useState<boolean>(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState<boolean>(false);
  const [dashboardSection, setDashboardSection] = useState<DashboardSection>('hosts');
  const [mobileNavTab, setMobileNavTab] = useState<MobileNavTab>('hosts');
  const [isHostFilterDrawerOpen, setIsHostFilterDrawerOpen] = useState<boolean>(false);
  const [hostSearchQuery, setHostSearchQuery] = useState<string>('');
  const [activeTagFilter, setActiveTagFilter] = useState<string>('all');
  const [highlightedSearchIndex, setHighlightedSearchIndex] = useState<number>(0);
  const [isHostWizardOpen, setIsHostWizardOpen] = useState<boolean>(false);
  const [isNewTabModalOpen, setIsNewTabModalOpen] = useState<boolean>(false);
  const [selectedTabHostId, setSelectedTabHostId] = useState<string>('');
  const [releaseNotice, setReleaseNotice] = useState<ReleaseNoticeState>(() => readReleaseNoticeState());
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [isSyncPopoverOpen, setIsSyncPopoverOpen] = useState<boolean>(false);
  const [isSyncingPath, setIsSyncingPath] = useState<boolean>(false);
  const [sftpSyncRequest, setSftpSyncRequest] = useState<SftpSyncRequest | null>(null);
  const [isSftpCollapsed, setIsSftpCollapsed] = useState<boolean>(false);
  const [sftpPanelWidth, setSftpPanelWidth] = useState<number>(380);
  const [isResizingSplit, setIsResizingSplit] = useState<boolean>(false);
  const [reconnectMessage, setReconnectMessage] = useState<string | null>(null);
  const [sshDiagnosticLogs, setSshDiagnosticLogs] = useState<SshDiagnosticLogEvent[]>([]);
  const [healthReport, setHealthReport] = useState<HealthCheckResponse | null>(null);
  const [sysStatusBySession, setSysStatusBySession] = useState<Record<string, SessionSysStatus>>({});
  const [sysTrendBySession, setSysTrendBySession] = useState<Record<string, SessionMetricSample[]>>(
    {}
  );
  const [splitWorkspaces, setSplitWorkspaces] = useState<Record<string, TabSplitWorkspace>>({});
  const [splitMenu, setSplitMenu] = useState<SplitMenuState | null>(null);
  const [isCloudAuthModalOpen, setIsCloudAuthModalOpen] = useState<boolean>(false);
  const [skippedCloudAuthForCurrentUnlock, setSkippedCloudAuthForCurrentUnlock] =
    useState<boolean>(false);
  const [isCloseWindowPromptOpen, setIsCloseWindowPromptOpen] = useState<boolean>(false);
  const [rememberCloseActionChoice, setRememberCloseActionChoice] = useState<boolean>(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState<boolean>(false);
  const [terminalDraftCommand, setTerminalDraftCommand] = useState<string>('');
  const [terminalDraftHistory, setTerminalDraftHistory] = useState<string[]>([]);
  const [terminalDraftHistoryCursor, setTerminalDraftHistoryCursor] = useState<number>(-1);
  const [terminalDraftSnapshot, setTerminalDraftSnapshot] = useState<string>('');
  const [isDraftHistoryOpen, setIsDraftHistoryOpen] = useState<boolean>(false);
  const [isMobileTerminalToolsExpanded, setIsMobileTerminalToolsExpanded] = useState<boolean>(false);
  const [isMobileMetricsExpanded, setIsMobileMetricsExpanded] = useState<boolean>(false);
  const [isMobilePortraitKeyboardInputEnabled, setIsMobilePortraitKeyboardInputEnabled] =
    useState<boolean>(false);
  const isMobileLandscape = false;
  const [mobileKeyboardInset, setMobileKeyboardInset] = useState<number>(0);
  const [isHostInfoOpen, setIsHostInfoOpen] = useState<boolean>(false);
  const [isLoadingHostInfo, setIsLoadingHostInfo] = useState<boolean>(false);
  const [hostInfoError, setHostInfoError] = useState<string | null>(null);
  const [hostInfo, setHostInfo] = useState<SshHostInfoResponse | null>(null);
  const [isMetricDetailOpen, setIsMetricDetailOpen] = useState<boolean>(false);
  const [metricDetailKey, setMetricDetailKey] = useState<MetricCardKey>('cpu');
  const [metricDetailWindowSeconds, setMetricDetailWindowSeconds] = useState<number>(300);
  const [connectingHostId, setConnectingHostId] = useState<string | null>(null);
  const [deployingHostId, setDeployingHostId] = useState<string | null>(null);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(() => new Set());
  const [isBatchDeploying, setIsBatchDeploying] = useState<boolean>(false);
  const [profileDraftAutoPathSync, setProfileDraftAutoPathSync] = useState<boolean>(true);
  const [profileDraftCloseAction, setProfileDraftCloseAction] = useState<CloseWindowAction>('ask');
  const [terminalPerfSummary, setTerminalPerfSummary] = useState<TerminalPerfSummary>({
    inputChunks: 0,
    inputBytes: 0,
    inputFlushes: 0,
    pendingInputSessions: 0,
    sysStatusEvents: 0,
    sysUiFlushes: 0,
    updatedAt: Date.now()
  });
  const [isPrivacyMaskVisible, setIsPrivacyMaskVisible] = useState<boolean>(false);

  const appView = useHostStore((state) => state.appView);
  const hosts = useHostStore((state) => state.hosts);
  const identities = useHostStore((state) => state.identities);
  const snippets = useHostStore((state) => state.snippets);
  const activeSessions = useHostStore((state) => state.activeSessions);
  const activeSessionId = useHostStore((state) => state.activeSessionId);
  const isConnectingTerminal = useHostStore((state) => state.isConnectingTerminal);
  const terminalError = useHostStore((state) => state.terminalError);
  const openTerminal = useHostStore((state) => state.openTerminal);
  const setActiveSession = useHostStore((state) => state.setActiveSession);
  const closeSession = useHostStore((state) => state.closeSession);
  const handleSessionClosed = useHostStore((state) => state.handleSessionClosed);
  const closeTerminal = useHostStore((state) => state.closeTerminal);
  const setTerminalError = useHostStore((state) => state.setTerminalError);
  const currentStep = useHostStore((state) => state.currentStep);
  const submittedHost = useHostStore((state) => state.submittedHost);
  const isSavingVault = useHostStore((state) => state.isSavingVault);
  const saveError = useHostStore((state) => state.saveError);
  const cloudSyncSession = useHostStore((state) => state.cloudSyncSession);
  const cloudSyncPolicy = useHostStore((state) => state.cloudSyncPolicy);
  const cloudLicenseStatus = useHostStore((state) => state.cloudLicenseStatus);
  const cloudSyncLastAt = useHostStore((state) => state.cloudSyncLastAt);
  const isSyncingCloud = useHostStore((state) => state.isSyncingCloud);
  const cloudSyncError = useHostStore((state) => state.cloudSyncError);
  const syncPullFromCloud = useHostStore((state) => state.syncPullFromCloud);
  const syncPushToCloud = useHostStore((state) => state.syncPushToCloud);
  const refreshCloudSyncPolicy = useHostStore((state) => state.refreshCloudSyncPolicy);
  const reset = useHostStore((state) => state.reset);
  const lockVault = useHostStore((state) => state.lockVault);
  const updateHostAndIdentity = useHostStore((state) => state.updateHostAndIdentity);
  const deleteHost = useHostStore((state) => state.deleteHost);
  const openDetachedSession = useHostStore((state) => state.openDetachedSession);
  const addSnippet = useHostStore((state) => state.addSnippet);
  const updateSnippet = useHostStore((state) => state.updateSnippet);
  const deleteSnippet = useHostStore((state) => state.deleteSnippet);

  const terminalFontSize = useUiSettingsStore((state) => state.terminalFontSize);
  const setTerminalFontSize = useUiSettingsStore((state) => state.setTerminalFontSize);
  const terminalFontFamily = useUiSettingsStore((state) => state.terminalFontFamily);
  const terminalLineHeight = useUiSettingsStore((state) => state.terminalLineHeight);
  const terminalOpacity = useUiSettingsStore((state) => state.terminalOpacity);
  const terminalBlur = useUiSettingsStore((state) => state.terminalBlur);
  const acrylicBlur = useUiSettingsStore((state) => state.acrylicBlur);
  const acrylicSaturation = useUiSettingsStore((state) => state.acrylicSaturation);
  const acrylicBrightness = useUiSettingsStore((state) => state.acrylicBrightness);
  const themePresetId = useUiSettingsStore((state) => state.themePresetId);
  const autoLockEnabled = useUiSettingsStore((state) => state.autoLockEnabled);
  const autoLockMinutes = useUiSettingsStore((state) => state.autoLockMinutes);
  const closeWindowAction = useUiSettingsStore((state) => state.closeWindowAction);
  const autoSftpPathSyncEnabled = useUiSettingsStore((state) => state.autoSftpPathSyncEnabled);
  const setAutoSftpPathSyncEnabled = useUiSettingsStore((state) => state.setAutoSftpPathSyncEnabled);
  const setCloseWindowAction = useUiSettingsStore((state) => state.setCloseWindowAction);
  const hasCompletedOnboarding = useUiSettingsStore((state) => state.hasCompletedOnboarding);
  const hostUsageStats = useUiSettingsStore((state) => state.hostUsageStats);
  const recordHostConnection = useUiSettingsStore((state) => state.recordHostConnection);
  const uiScalePercent = useUiSettingsStore((state) => state.uiScalePercent);
  const contrastMode = useUiSettingsStore((state) => state.contrastMode);
  const snippetsPanelCollapsed = useUiSettingsStore((state) => state.snippetsPanelCollapsed);
  const setSnippetsPanelCollapsed = useUiSettingsStore((state) => state.setSnippetsPanelCollapsed);
  const setTerminalLineHeight = useUiSettingsStore((state) => state.setTerminalLineHeight);
  const mobileBiometricEnabled = useUiSettingsStore((state) => state.mobileBiometricEnabled);
  const applyTransferProgressEvent = useTransferStore((state) => state.applyProgressEvent);
  const appLogs = useAppLogStore((state) => state.logs);
  const clearAppLogs = useAppLogStore((state) => state.clearLogs);

  const activeThemePreset = useMemo(() => resolveThemePreset(themePresetId), [themePresetId]);
  const activeUiPalette = useMemo(() => resolveUiPalette(themePresetId), [themePresetId]);
  const activeTerminalChromePalette = useMemo(
    () => resolveTerminalChromePalette(activeThemePreset, activeUiPalette),
    [activeThemePreset, activeUiPalette]
  );
  const activeSftpPalette = useMemo(
    () => resolveSftpPalette(activeThemePreset, activeUiPalette),
    [activeThemePreset, activeUiPalette]
  );
  const uiText = useMemo(() => resolveAppLocalePack(locale), [locale]);
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);
  const isAndroidClient = useMemo(() => isAndroidRuntime(), []);
  const isMobileRuntime = isMobileLayout || isAndroidClient;

  useEffect(() => {
    const syncLayout = (): void => {
      setIsMobileLayout(detectMobileFormFactor());
    };
    syncLayout();
    window.addEventListener('resize', syncLayout);
    return () => {
      window.removeEventListener('resize', syncLayout);
    };
  }, []);

  useEffect(() => {
    if (!isMobileRuntime) {
      return;
    }
    setIsHostFilterDrawerOpen(false);
    setIsSftpCollapsed(true);
    setIsMetricDetailOpen(false);
    setIsMobileTerminalToolsExpanded(false);
    setIsMobileMetricsExpanded(false);
    setIsMobilePortraitKeyboardInputEnabled(false);
  }, [isMobileRuntime]);

  useEffect(() => {
    if (!isMobileRuntime || typeof window === 'undefined' || !window.visualViewport) {
      setMobileKeyboardInset(0);
      return;
    }
    const viewport = window.visualViewport;
    const syncInset = (): void => {
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      setMobileKeyboardInset(inset);
    };
    syncInset();
    viewport.addEventListener('resize', syncInset);
    viewport.addEventListener('scroll', syncInset);
    return () => {
      viewport.removeEventListener('resize', syncInset);
      viewport.removeEventListener('scroll', syncInset);
      setMobileKeyboardInset(0);
    };
  }, [isMobileRuntime]);

  useEffect(() => {
    if (!isMobileLayout && !isAndroidClient) {
      setIsPrivacyMaskVisible(false);
      return;
    }

    const showMask = (): void => {
      setIsPrivacyMaskVisible(true);
    };
    const hideMask = (): void => {
      window.setTimeout(() => {
        setIsPrivacyMaskVisible(false);
      }, 120);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        showMask();
        return;
      }
      hideMask();
    };

    window.addEventListener('blur', showMask);
    window.addEventListener('focus', hideMask);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('blur', showMask);
      window.removeEventListener('focus', hideMask);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isAndroidClient, isMobileLayout]);

  useEffect(() => {
    if ((!isMobileLayout && !isAndroidClient) || appView !== 'dashboard') {
      return;
    }

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (activeSessions.length === 0) {
        return;
      }
      const currentSessionId = activeTerminalSessionIdRef.current;
      if (currentSessionId) {
        void sshSetPulseActivity(currentSessionId, true).catch(() => {
          // Ignore keep-alive pulse sync failures during resume.
        });
      }
      const tip =
        locale === 'en-US'
          ? 'Resuming terminal sessions...'
          : locale === 'ja-JP'
            ? '端末セッションを再開しています...'
            : locale === 'zh-TW'
              ? '正在恢復終端會話...'
              : '正在恢复终端会话...';
      setReconnectMessage((prev) => prev ?? tip);
      window.setTimeout(() => {
        setReconnectMessage((prev) => (prev === tip ? null : prev));
      }, 1400);
    };

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [activeSessions.length, appView, isAndroidClient, isMobileLayout, locale]);

  const syncLastText = useMemo(() => {
    if (!cloudSyncLastAt) {
      return '--';
    }
    const date = new Date(cloudSyncLastAt);
    if (Number.isNaN(date.getTime())) {
      return '--';
    }
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }, [cloudSyncLastAt, locale]);
  const syncIndicatorTone = useMemo(() => {
    if (!cloudSyncSession) {
      return 'idle';
    }
    if (isSyncingCloud) {
      return 'syncing';
    }
    if (cloudSyncError) {
      return 'error';
    }
    return 'success';
  }, [cloudSyncError, cloudSyncSession, isSyncingCloud]);
  const syncStatusText = useMemo(() => {
    if (syncIndicatorTone === 'success' || syncIndicatorTone === 'syncing') {
      return uiText.navSyncHealthy;
    }
    return uiText.navSyncUnhealthy;
  }, [syncIndicatorTone, uiText.navSyncHealthy, uiText.navSyncUnhealthy]);
  const isProLicenseActive = useMemo(() => {
    const status = (cloudLicenseStatus?.status ?? '').trim().toLowerCase();
    return Boolean(cloudSyncSession && cloudLicenseStatus?.active && status !== 'grace');
  }, [cloudLicenseStatus, cloudSyncSession]);
  const normalizedLicenseFeatures = useMemo(() => {
    const source = cloudLicenseStatus?.features ?? [];
    return new Set(
      source
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item.length > 0)
    );
  }, [cloudLicenseStatus]);
  const canUseKeyDeployFeature = useMemo(() => {
    if (!isProLicenseActive) {
      return false;
    }
    // Open-core hardening: paid capability must be explicitly granted by server.
    // Empty feature set is treated as "not granted" instead of permissive fallback.
    if (normalizedLicenseFeatures.size === 0) {
      return false;
    }
    return normalizedLicenseFeatures.has('key_deploy');
  }, [isProLicenseActive, normalizedLicenseFeatures]);
  const licensedHostLimit = useMemo(() => {
    const raw = Number(cloudLicenseStatus?.maxHosts ?? 0);
    if (!Number.isFinite(raw) || raw <= 0) {
      return 0;
    }
    return Math.floor(raw);
  }, [cloudLicenseStatus]);
  const isLicensedHostLimitReached = useMemo(() => {
    if (!isProLicenseActive || licensedHostLimit <= 0) {
      return false;
    }
    return hosts.length >= licensedHostLimit;
  }, [hosts.length, isProLicenseActive, licensedHostLimit]);
  const accountDisplayName = useMemo(() => {
    if (!cloudSyncSession?.email) {
      return t('settings.offlineMode');
    }
    return cloudSyncSession.email;
  }, [cloudSyncSession, t]);
  const accountAvatarText = useMemo(() => {
    const source = cloudSyncSession?.email?.trim();
    if (!source) {
      return 'OT';
    }
    return source.slice(0, 2).toUpperCase();
  }, [cloudSyncSession]);
  const proExpiryText = useMemo(() => {
    if (!isProLicenseActive || !cloudLicenseStatus) {
      return '--';
    }
    if (cloudLicenseStatus.isLifetime) {
      return uiText.navProLifetime;
    }
    if (!cloudLicenseStatus.expiresAt) {
      return '--';
    }
    const parsedDate = new Date(cloudLicenseStatus.expiresAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return cloudLicenseStatus.expiresAt;
    }
    return parsedDate.toLocaleString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }, [cloudLicenseStatus, isProLicenseActive, locale, uiText.navProLifetime]);
  const proCheckoutUrl = useMemo(() => {
    const domain = cloudSyncPolicy?.defaultSyncDomain?.trim() ?? '';
    if (domain) {
      return `${domain.replace(/\/+$/, '')}/pricing`;
    }
    const policyUrl = cloudSyncPolicy?.proCheckoutUrl?.trim() ?? '';
    if (policyUrl) {
      return policyUrl;
    }
    const bySession = cloudSyncSession?.apiBaseUrl?.trim() ?? '';
    if (bySession) {
      return `${bySession.replace(/\/+$/, '')}/pricing`;
    }
    return '';
  }, [cloudSyncPolicy, cloudSyncSession]);

  const handleOpenProCheckout = useCallback((): void => {
    if (!proCheckoutUrl) {
      toast.error('暂未获取到套餐页面地址，请先连接同步服务。');
      return;
    }
    let checkoutURL = proCheckoutUrl;
    try {
      const parsed = new URL(proCheckoutUrl);
      if (!parsed.searchParams.has('return')) {
        parsed.searchParams.set('return', '/');
      }
      checkoutURL = parsed.toString();
    } catch (_error) {
      checkoutURL = proCheckoutUrl;
    }
    void openExternalLink(checkoutURL);
    setIsProfileMenuOpen(false);
  }, [proCheckoutUrl]);

  const editingHost = useMemo(() => {
    if (!editingHostId) {
      return null;
    }
    return hosts.find((host) => buildHostKey(host) === editingHostId) ?? null;
  }, [editingHostId, hosts]);

  const editingIdentity = useMemo(() => {
    if (!editingHost) {
      return null;
    }
    return identities.find((identity) => identity.id === editingHost.identityId) ?? null;
  }, [editingHost, identities]);

  const editingLinkedHostCount = useMemo(() => {
    if (!editingIdentity) {
      return 0;
    }
    return hosts.filter((host) => host.identityId === editingIdentity.id).length;
  }, [editingIdentity, hosts]);

  const selectedTabHost = useMemo(() => {
    if (!selectedTabHostId) {
      return null;
    }
    return hosts.find((host) => buildHostKey(host) === selectedTabHostId) ?? null;
  }, [hosts, selectedTabHostId]);
  const activeWorkspace = useMemo(() => {
    if (!activeSessionId) {
      return null;
    }
    return splitWorkspaces[activeSessionId] ?? null;
  }, [activeSessionId, splitWorkspaces]);
  const activeTerminalSessionId = useMemo(() => {
    if (!activeSessionId) {
      return null;
    }
    const workspace = splitWorkspaces[activeSessionId];
    if (!workspace) {
      return activeSessionId;
    }
    const activePane = findPaneById(workspace.root, workspace.activePaneId);
    return activePane?.sessionId ?? activeSessionId;
  }, [activeSessionId, splitWorkspaces]);
  useEffect(() => {
    if (!isMobileRuntime) {
      return;
    }
    void applyMobileOrientationMode('portrait');
  }, [isMobileRuntime]);
  useEffect(() => {
    if (!activeSessionId) {
      copyActiveTerminalOutputRef.current = null;
    }
  }, [activeSessionId]);
  const activeTerminalHostId = useMemo(() => {
    if (!activeSessionId) {
      return null;
    }
    const workspace = splitWorkspaces[activeSessionId];
    if (workspace) {
      const activePane = findPaneById(workspace.root, workspace.activePaneId);
      if (activePane) {
        return activePane.hostId;
      }
    }
    return activeSessions.find((session) => session.id === activeSessionId)?.hostId ?? null;
  }, [activeSessionId, activeSessions, splitWorkspaces]);
  const activeTerminalTitle = useMemo(() => {
    if (!activeSessionId) {
      return null;
    }
    const workspace = splitWorkspaces[activeSessionId];
    if (workspace) {
      const activePane = findPaneById(workspace.root, workspace.activePaneId);
      if (activePane) {
        return activePane.title;
      }
    }
    return activeSessions.find((session) => session.id === activeSessionId)?.title ?? null;
  }, [activeSessionId, activeSessions, splitWorkspaces]);
  const activeSessionSysStatus = useMemo(() => {
    if (!activeTerminalSessionId) {
      return null;
    }
    return sysStatusBySession[activeTerminalSessionId] ?? null;
  }, [activeTerminalSessionId, sysStatusBySession]);
  const activeSessionTrend = useMemo(() => {
    if (!activeTerminalSessionId) {
      return [];
    }
    return sysTrendBySession[activeTerminalSessionId] ?? [];
  }, [activeTerminalSessionId, sysTrendBySession]);
  const cpuTrendPoints = useMemo<MetricTrendPoint[]>(
    () =>
      activeSessionTrend.map((sample) => ({
        at: sample.at,
        value: sample.cpu
      })),
    [activeSessionTrend]
  );
  const memoryTrendPoints = useMemo<MetricTrendPoint[]>(
    () =>
      activeSessionTrend.map((sample) => ({
        at: sample.at,
        value: sample.memory
      })),
    [activeSessionTrend]
  );
  const netRxTrendPoints = useMemo<MetricTrendPoint[]>(
    () =>
      activeSessionTrend.map((sample) => ({
        at: sample.at,
        value: sample.rx
      })),
    [activeSessionTrend]
  );
  const netTxTrendPoints = useMemo<MetricTrendPoint[]>(
    () =>
      activeSessionTrend.map((sample) => ({
        at: sample.at,
        value: sample.tx
      })),
    [activeSessionTrend]
  );
  const latencyTrendPoints = useMemo<MetricTrendPoint[]>(
    () =>
      activeSessionTrend.map((sample) => ({
        at: sample.at,
        value: sample.latency
      })),
    [activeSessionTrend]
  );
  const metricDetailWindowOptions = useMemo<Array<{ seconds: number; label: string }>>(() => {
    return [
      {
        seconds: 60,
        label: locale === 'zh-CN' ? '1分钟' : locale === 'zh-TW' ? '1分鐘' : locale === 'ja-JP' ? '1分' : '1m'
      },
      {
        seconds: 300,
        label: locale === 'zh-CN' ? '5分钟' : locale === 'zh-TW' ? '5分鐘' : locale === 'ja-JP' ? '5分' : '5m'
      },
      {
        seconds: 600,
        label: locale === 'zh-CN' ? '10分钟' : locale === 'zh-TW' ? '10分鐘' : locale === 'ja-JP' ? '10分' : '10m'
      }
    ];
  }, [locale]);
  const metricCards = useMemo<
    Array<{
      key: MetricCardKey;
      title: string;
      valueText: string;
      points: MetricTrendPoint[];
      lineColor: string;
      fillColor: string;
      fixedMax?: number;
    }>
  >(
    () => [
      {
        key: 'cpu',
        title: 'CPU',
        valueText: activeSessionSysStatus
          ? `${clampPercent(activeSessionSysStatus.cpuUsagePercent).toFixed(1)}%`
          : '--',
        points: cpuTrendPoints,
        lineColor: '#4fa8ff',
        fillColor: 'rgba(79, 168, 255, 0.18)',
        fixedMax: 100
      },
      {
        key: 'memory',
        title: locale === 'zh-CN' ? '内存' : locale === 'zh-TW' ? '記憶體' : locale === 'ja-JP' ? 'メモリ' : 'Memory',
        valueText: activeSessionSysStatus
          ? `${clampPercent(activeSessionSysStatus.memoryUsagePercent).toFixed(1)}%`
          : '--',
        points: memoryTrendPoints,
        lineColor: '#6cdca1',
        fillColor: 'rgba(108, 220, 161, 0.18)',
        fixedMax: 100
      },
      {
        key: 'rx',
        title: locale === 'zh-CN' ? '下载' : locale === 'zh-TW' ? '下載' : locale === 'ja-JP' ? '受信' : 'Download',
        valueText: formatRate(activeSessionSysStatus?.netRxBytesPerSec ?? 0),
        points: netRxTrendPoints,
        lineColor: '#95b9ff',
        fillColor: 'rgba(149, 185, 255, 0.18)'
      },
      {
        key: 'tx',
        title: locale === 'zh-CN' ? '上传' : locale === 'zh-TW' ? '上傳' : locale === 'ja-JP' ? '送信' : 'Upload',
        valueText: formatRate(activeSessionSysStatus?.netTxBytesPerSec ?? 0),
        points: netTxTrendPoints,
        lineColor: '#ffb279',
        fillColor: 'rgba(255, 178, 121, 0.18)'
      },
      {
        key: 'latency',
        title: locale === 'zh-CN' ? '延迟' : locale === 'zh-TW' ? '延遲' : locale === 'ja-JP' ? '遅延' : 'Latency',
        valueText: formatLatency(activeSessionSysStatus?.latencyMs),
        points: latencyTrendPoints,
        lineColor: '#b89bff',
        fillColor: 'rgba(186, 156, 255, 0.2)'
      }
    ],
    [activeSessionSysStatus, cpuTrendPoints, latencyTrendPoints, locale, memoryTrendPoints, netRxTrendPoints, netTxTrendPoints]
  );
  const activeMetricCard = useMemo(() => {
    return metricCards.find((item) => item.key === metricDetailKey) ?? metricCards[0] ?? null;
  }, [metricCards, metricDetailKey]);
  const profileDraftDirty = useMemo(() => {
    return (
      profileDraftAutoPathSync !== autoSftpPathSyncEnabled ||
      profileDraftCloseAction !== closeWindowAction
    );
  }, [autoSftpPathSyncEnabled, closeWindowAction, profileDraftAutoPathSync, profileDraftCloseAction]);
  const mobileNavTitle = useMemo(() => {
    if (mobileNavTab === 'hosts') {
      return uiText.navHosts;
    }
    if (mobileNavTab === 'sessions') {
      return uiText.navTerminal;
    }
    if (mobileNavTab === 'tools') {
      return locale === 'zh-CN'
        ? '工具'
        : locale === 'zh-TW'
          ? '工具'
          : locale === 'ja-JP'
            ? 'ツール'
            : 'Tools';
    }
    return locale === 'zh-CN'
      ? '设置'
      : locale === 'zh-TW'
        ? '設定'
        : locale === 'ja-JP'
          ? '設定'
          : 'Settings';
  }, [locale, mobileNavTab, uiText.navHosts, uiText.navTerminal]);
  const isMobileTerminalFocusMode =
    isMobileRuntime &&
    appView === 'dashboard' &&
    dashboardSection === 'terminal' &&
    activeSessions.length > 0 &&
    !isSettingsOpen;
  const mobileTopActionButtonClass = isMobileRuntime
    ? 'ot-compact-hit h-[18px] rounded border border-[#5a79a8] bg-[#0f1726] px-2 py-0 text-[11px] leading-[1] font-medium text-[#d7e5ff] hover:bg-[#13203a]'
    : darkPanelButtonClass;
  const terminalDraftActionButtonClass = isMobileRuntime
    ? 'ot-compact-hit h-9 rounded-md border border-[#5a79a8] bg-[#0f1726] px-3 py-0 text-[12px] leading-[1] font-semibold text-[#d7e5ff] hover:bg-[#13203a]'
    : darkPanelButtonClass;
  const allowPreInputKeyboard = !isMobileRuntime || isMobilePortraitKeyboardInputEnabled;
  const draftHistoryPreview = useMemo(() => {
    return [...terminalDraftHistory].slice(-12).reverse();
  }, [terminalDraftHistory]);
  const syncIndicatorDotClass = useMemo(() => {
    if (syncIndicatorTone === 'success') {
      return 'bg-emerald-500';
    }
    if (syncIndicatorTone === 'syncing') {
      return 'bg-amber-500';
    }
    if (syncIndicatorTone === 'error') {
      return 'bg-rose-500';
    }
    return 'bg-slate-400';
  }, [syncIndicatorTone]);
  const previousSessionCountRef = useRef<number>(activeSessions.length);
  const terminalSplitRef = useRef<HTMLElement | null>(null);
  const syncIndicatorRef = useRef<HTMLDivElement | null>(null);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const hostSearchInputRef = useRef<HTMLInputElement | null>(null);
  const splitWorkspacesRef = useRef<Record<string, TabSplitWorkspace>>(splitWorkspaces);
  const manualDetachedClosingRef = useRef<Set<string>>(new Set());
  const allowWindowCloseRef = useRef<boolean>(false);
  const closeWindowActionRef = useRef(closeWindowAction);
  const activeTerminalSessionIdRef = useRef<string | null>(activeTerminalSessionId);
  const terminalInputBufferRef = useRef<Map<string, string>>(new Map());
  const terminalInputWriteBufferRef = useRef<Map<string, string>>(new Map());
  const terminalInputFlushTimersRef = useRef<Map<string, number>>(new Map());
  const terminalPreInputRef = useRef<HTMLTextAreaElement | null>(null);
  const copyActiveTerminalOutputRef = useRef<((scope?: 'visible' | 'all') => Promise<boolean>) | null>(null);
  const terminalTouchStateRef = useRef<{
    startX: number;
    startY: number;
    swipeHandled: boolean;
    pinchDistance: number | null;
    baseFontSize: number;
  } | null>(null);
  const pendingAutoSftpSyncTimersRef = useRef<Map<string, number>>(new Map());
  const sftpPathSyncInFlightRef = useRef<Set<string>>(new Set());
  const lastKnownSftpPathRef = useRef<Map<string, string>>(new Map());
  const sysStatusBufferRef = useRef<Record<string, SessionSysStatus>>({});
  const sysTrendBufferRef = useRef<Record<string, SessionMetricSample[]>>({});
  const sysMetricsFlushTimerRef = useRef<number | null>(null);
  const perfCountersRef = useRef<{
    inputChunks: number;
    inputBytes: number;
    inputFlushes: number;
    sysStatusEvents: number;
    sysUiFlushes: number;
  }>({
    inputChunks: 0,
    inputBytes: 0,
    inputFlushes: 0,
    sysStatusEvents: 0,
    sysUiFlushes: 0
  });

  const flushSysMetricsToUi = useCallback((): void => {
    if (sysMetricsFlushTimerRef.current !== null) {
      window.clearTimeout(sysMetricsFlushTimerRef.current);
      sysMetricsFlushTimerRef.current = null;
    }
    perfCountersRef.current.sysUiFlushes += 1;
    setSysStatusBySession({ ...sysStatusBufferRef.current });
    setSysTrendBySession({ ...sysTrendBufferRef.current });
  }, []);

  const scheduleSysMetricsFlush = useCallback((): void => {
    if (sysMetricsFlushTimerRef.current !== null) {
      return;
    }
    sysMetricsFlushTimerRef.current = window.setTimeout(() => {
      sysMetricsFlushTimerRef.current = null;
      flushSysMetricsToUi();
    }, SYS_METRICS_UI_FLUSH_MS);
  }, [flushSysMetricsToUi]);

  const tagStats = useMemo(() => {
    const map = new Map<string, number>();
    for (const host of hosts) {
      for (const rawTag of host.advancedOptions.tags) {
        const tag = rawTag.trim();
        if (!tag) {
          continue;
        }
        const prev = map.get(tag) ?? 0;
        map.set(tag, prev + 1);
      }
    }
    return Array.from(map.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag, 'zh-CN'));
  }, [hosts]);

  const filteredHosts = useMemo(() => {
    const query = hostSearchQuery.trim().toLowerCase();
    return hosts.filter((host) => {
      if (activeTagFilter !== 'all' && !host.advancedOptions.tags.includes(activeTagFilter)) {
        return false;
      }
      if (!query) {
        return true;
      }
      const searchable = [
        host.basicInfo.name,
        host.basicInfo.address,
        ...host.advancedOptions.tags
      ]
        .join(' ')
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [activeTagFilter, hostSearchQuery, hosts]);

  const filteredHostIds = useMemo(() => {
    return filteredHosts.map((host) => buildHostKey(host));
  }, [filteredHosts]);

  const selectedHostCount = useMemo(() => {
    return Array.from(selectedHostIds).filter((hostId) => hosts.some((host) => buildHostKey(host) === hostId))
      .length;
  }, [hosts, selectedHostIds]);

  useEffect(() => {
    const availableHostIds = new Set(hosts.map((host) => buildHostKey(host)));
    setSelectedHostIds((prev) => {
      const next = new Set<string>();
      for (const hostId of prev) {
        if (availableHostIds.has(hostId)) {
          next.add(hostId);
        }
      }
      if (next.size === prev.size) {
        return prev;
      }
      return next;
    });
  }, [hosts]);

  useEffect(() => {
    return () => {
      if (sysMetricsFlushTimerRef.current !== null) {
        window.clearTimeout(sysMetricsFlushTimerRef.current);
        sysMetricsFlushTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setTerminalPerfSummary({
        ...perfCountersRef.current,
        pendingInputSessions: terminalInputWriteBufferRef.current.size,
        updatedAt: Date.now()
      });
    }, PERF_STATS_FLUSH_MS);
    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  const openSettingsCategory = useCallback((category: SettingsCategory): void => {
    setSettingsCategory(category);
    setSettingsFocusSectionId(null);
    setSettingsFocusSequence((prev) => prev + 1);
    setIsSettingsOpen(true);
    setIsProfileMenuOpen(false);
  }, []);

  const handleMobileTabChange = useCallback(
    (tab: MobileNavTab): void => {
      setMobileNavTab(tab);
      setIsProfileMenuOpen(false);
      setIsSyncPopoverOpen(false);
      if (tab === 'hosts') {
        setIsMobileTerminalToolsExpanded(false);
        setIsSettingsOpen(false);
        setDashboardSection('hosts');
        return;
      }
      if (tab === 'sessions') {
        setIsMobileTerminalToolsExpanded(false);
        setIsSettingsOpen(false);
        setDashboardSection('terminal');
        return;
      }
      if (tab === 'tools') {
        setIsSettingsOpen(false);
        setDashboardSection('terminal');
        setIsMobileTerminalToolsExpanded(true);
        return;
      }
      setIsMobileTerminalToolsExpanded(false);
      openSettingsCategory('settings');
    },
    [openSettingsCategory]
  );

  const handleReturnToMobileApp = useCallback((): void => {
    setIsMobileTerminalToolsExpanded(false);
    setIsMobileMetricsExpanded(false);
    setIsMobilePortraitKeyboardInputEnabled(false);
    setIsMetricDetailOpen(false);
    setIsDraftHistoryOpen(false);
    setIsSettingsOpen(false);
    setDashboardSection('hosts');
    setMobileNavTab('hosts');
  }, []);

  useEffect(() => {
    if (!isMobileRuntime) {
      return;
    }
    if (isSettingsOpen) {
      setMobileNavTab('settings');
      return;
    }
    if (dashboardSection === 'hosts') {
      setMobileNavTab('hosts');
      return;
    }
    setMobileNavTab(isMobileTerminalToolsExpanded ? 'tools' : 'sessions');
  }, [dashboardSection, isMobileRuntime, isSettingsOpen, isMobileTerminalToolsExpanded]);

  useEffect(() => {
    if (!isMobileRuntime || dashboardSection === 'terminal') {
      return;
    }
    setIsMobilePortraitKeyboardInputEnabled(false);
  }, [dashboardSection, isMobileRuntime]);

  const openSettingsSection = useCallback((sectionId: string): void => {
    const category = SETTINGS_SECTION_CATEGORY_MAP[sectionId] ?? 'settings';
    setSettingsCategory(category);
    setSettingsFocusSectionId(sectionId);
    setSettingsFocusSequence((prev) => prev + 1);
    setIsSettingsOpen(true);
    setIsProfileMenuOpen(false);
  }, []);

  const handleCancelProfileDraft = useCallback((): void => {
    setProfileDraftAutoPathSync(autoSftpPathSyncEnabled);
    setProfileDraftCloseAction(closeWindowAction);
    setIsProfileMenuOpen(false);
  }, [autoSftpPathSyncEnabled, closeWindowAction]);

  const handleSaveProfileDraft = useCallback((): void => {
    setAutoSftpPathSyncEnabled(profileDraftAutoPathSync);
    setCloseWindowAction(profileDraftCloseAction);
    setIsProfileMenuOpen(false);
    toast.success('偏好设置已保存。');
  }, [
    profileDraftAutoPathSync,
    profileDraftCloseAction,
    setAutoSftpPathSyncEnabled,
    setCloseWindowAction
  ]);

  const commandPaletteRuntimeItems = useMemo<PaletteRuntimeItem[]>(() => {
    if (appView !== 'dashboard') {
      return [];
    }

    const query = commandPaletteQuery.trim().toLowerCase();
    const results: PaletteRuntimeItem[] = [];
    const now = Date.now();
    const identityById = new Map(identities.map((identity) => [identity.id, identity]));

    for (const host of hosts) {
      const hostId = buildHostKey(host);
      const identity = identityById.get(host.identityId);
      const textScore = scoreSearchFields(query, [
        host.basicInfo.name,
        host.basicInfo.address,
        String(host.basicInfo.port),
        host.basicInfo.description,
        identity?.name ?? '',
        identity?.username ?? '',
        ...host.advancedOptions.tags
      ]);
      if (query && textScore <= 0) {
        continue;
      }

      const usage = hostUsageStats[hostId];
      const usageCountBoost = usage ? Math.min(180, usage.count * 18) : 0;
      const recencyBoost = usage
        ? Math.max(
            0,
            220 - Math.floor((now - usage.lastConnectedAt) / (1000 * 60 * 30)) * 8
          )
        : 0;
      const noQueryBase = query ? 0 : 120;
      const score = textScore + usageCountBoost + recencyBoost + noQueryBase;
      const hostTitle = host.basicInfo.name || `${host.basicInfo.address}:${host.basicInfo.port}`;
      const hostSubtitle = `${identity?.username ?? 'unknown'}@${host.basicInfo.address}:${host.basicInfo.port}`;
      results.push({
        id: `host:${hostId}`,
        kind: 'host',
        title: hostTitle,
        subtitle: hostSubtitle,
        hint: usage ? `连接 ${usage.count} 次` : '一键连接',
        score,
        execute: async () => {
          const success = await openTerminal(host);
          if (success) {
            setDashboardSection('terminal');
            recordHostConnection(hostId);
            setTerminalError(null);
          }
        }
      });
    }

    for (const snippet of snippets) {
      const textScore = scoreSearchFields(query, [snippet.title, snippet.command, ...snippet.tags]);
      if (query && textScore <= 0) {
        continue;
      }
      results.push({
        id: `snippet:${snippet.id}`,
        kind: 'snippet',
        title: snippet.title,
        subtitle: snippet.command,
        hint: '一键执行',
        score: textScore + (query ? 0 : 74),
        execute: async () => {
          if (!activeTerminalSessionId) {
            setDashboardSection('terminal');
            toast.message('请先建立终端连接，再执行指令片段。');
            return;
          }
          try {
            await sshWrite(activeTerminalSessionId, `${snippet.command}\n`);
            setTerminalError(null);
          } catch (error) {
            const fallback = '写入终端失败，连接可能已断开。';
            const message = error instanceof Error ? error.message : fallback;
            setTerminalError(message || fallback);
            toast.error(message || fallback);
          }
        }
      });
    }

    for (const item of PALETTE_SETTINGS_ENTRIES) {
      const textScore = scoreSearchFields(query, [item.title, item.subtitle, ...item.keywords]);
      if (query && textScore <= 0) {
        continue;
      }
      results.push({
        id: `setting:${item.id}`,
        kind: 'setting',
        title: item.title,
        subtitle: item.subtitle,
        hint: '跳转',
        score: textScore + (query ? 0 : 54),
        execute: () => {
          openSettingsSection(item.sectionId);
        }
      });
    }

    const actionCandidates: ReadonlyArray<{
      id: string;
      title: string;
      subtitle: string;
      keywords: string[];
      execute: () => void;
    }> = [
      {
        id: 'action:new-host',
        title: '新增主机',
        subtitle: '打开三步向导创建主机',
        keywords: ['新增', '主机', '向导', 'add host'],
        execute: () => {
          reset();
          setIsHostWizardOpen(true);
          setDashboardSection('hosts');
        }
      },
      {
        id: 'action:new-window',
        title: '新建终端窗口',
        subtitle: '选择主机后创建新会话窗口',
        keywords: ['新建', 'window', '窗口', '会话'],
        execute: () => {
          setIsNewTabModalOpen(true);
          setDashboardSection('terminal');
        }
      },
      {
        id: 'action:ai',
        title: '打开灵思助手',
        subtitle: '呼出 AI 命令助手面板',
        keywords: ['ai', '助手', '灵思', '命令生成'],
        execute: () => {
          setIsAiAssistantOpen(true);
        }
      },
      {
        id: 'action:about',
        title: '关于 OrbitTerm',
        subtitle: '查看版本信息与下载提示',
        keywords: ['关于', '版本', 'release', '更新'],
        execute: () => {
          setIsAboutOpen(true);
        }
      },
      {
        id: 'action:lock',
        title: '立即锁定金库',
        subtitle: '快速回到解锁界面',
        keywords: ['锁定', '金库', '安全', 'lock'],
        execute: () => {
          void lockVault();
        }
      }
    ];

    for (const action of actionCandidates) {
      const textScore = scoreSearchFields(query, [action.title, action.subtitle, ...action.keywords]);
      if (query && textScore <= 0) {
        continue;
      }
      results.push({
        id: action.id,
        kind: 'action',
        title: action.title,
        subtitle: action.subtitle,
        hint: '执行',
        score: textScore + (query ? 0 : 38),
        execute: action.execute
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 40);
  }, [
    activeTerminalSessionId,
    appView,
    commandPaletteQuery,
    hostUsageStats,
    hosts,
    identities,
    lockVault,
    openSettingsSection,
    openTerminal,
    recordHostConnection,
    reset,
    setTerminalError,
    snippets
  ]);

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    return commandPaletteRuntimeItems.map(({ score: _score, execute: _execute, ...item }) => item);
  }, [commandPaletteRuntimeItems]);

  useEffect(() => {
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    const shouldUnlockDocumentScroll = isMobileLayout || isAndroidClient || !hasCompletedOnboarding;
    if (shouldUnlockDocumentScroll) {
      document.documentElement.style.overflow = 'auto';
      document.body.style.overflow = 'auto';
    } else {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, [hasCompletedOnboarding, isAndroidClient, isMobileLayout]);

  useEffect(() => {
    document.body.style.background = activeThemePreset.bodyBackground;
  }, [activeThemePreset.bodyBackground]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--acrylic-blur', `${acrylicBlur}px`);
    root.style.setProperty('--acrylic-saturation', `${acrylicSaturation}%`);
    root.style.setProperty('--acrylic-brightness', `${acrylicBrightness}%`);
  }, [acrylicBlur, acrylicBrightness, acrylicSaturation]);

  const performHealthCheck = async (showOkToast: boolean): Promise<void> => {
    try {
      const report = await runHealthCheck();
      setHealthReport(report);
      const issues = report.items.filter((item) => item.status !== 'ok');
      const criticalIssues = report.items.filter((item) => item.status === 'error');
      if (criticalIssues.length > 0) {
        const firstIssue = criticalIssues[0];
        if (firstIssue) {
          toast.warning(`环境检测异常：${firstIssue.label}`, {
            description: firstIssue.suggestion ?? firstIssue.message
          });
        }
      } else if (showOkToast && issues.length > 0) {
        const firstIssue = issues[0];
        if (firstIssue) {
          toast.warning(`环境检测提示：${firstIssue.label}`, {
            description: firstIssue.suggestion ?? firstIssue.message
          });
        }
      } else if (showOkToast) {
        toast.success('环境健康检查通过');
      }
    } catch (error) {
      const fallback = '环境健康检查失败，请检查系统权限或网络。';
      const message = error instanceof Error ? error.message : fallback;
      toast.warning(message || fallback);
    }
  };

  useEffect(() => {
    void performHealthCheck(false);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (appView !== 'dashboard' || isMobileLayout) {
        return;
      }

      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        if (event.shiftKey) {
          setIsAiAssistantOpen((prev) => !prev);
          return;
        }
        setIsCommandPaletteOpen((prev) => {
          const next = !prev;
          if (next) {
            setCommandPaletteQuery('');
            setCommandPaletteActiveIndex(0);
          }
          return next;
        });
        return;
      }

      if (isCommandPaletteOpen) {
        return;
      }

      if (key === 'w') {
        event.preventDefault();
        void closeTerminal();
      }

      if (key === ',') {
        event.preventDefault();
        if (isSettingsOpen) {
          setIsSettingsOpen(false);
        } else {
          openSettingsCategory('settings');
        }
      }

      if (key === 'f') {
        event.preventDefault();
        setDashboardSection('hosts');
        window.setTimeout(() => {
          hostSearchInputRef.current?.focus();
          hostSearchInputRef.current?.select();
        }, 0);
      }
    };

    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [appView, closeTerminal, isCommandPaletteOpen, isMobileLayout, isSettingsOpen, openSettingsCategory]);

  useEffect(() => {
    if (activeTagFilter === 'all') {
      return;
    }
    const exists = tagStats.some((item) => item.tag === activeTagFilter);
    if (!exists) {
      setActiveTagFilter('all');
    }
  }, [activeTagFilter, tagStats]);

  useEffect(() => {
    if (filteredHosts.length === 0) {
      setHighlightedSearchIndex(-1);
      return;
    }
    setHighlightedSearchIndex((prev) => {
      if (prev < 0) {
        return 0;
      }
      if (prev >= filteredHosts.length) {
        return filteredHosts.length - 1;
      }
      return prev;
    });
  }, [filteredHosts]);

  useEffect(() => {
    splitWorkspacesRef.current = splitWorkspaces;
  }, [splitWorkspaces]);

  useEffect(() => {
    closeWindowActionRef.current = closeWindowAction;
  }, [closeWindowAction]);

  useEffect(() => {
    activeTerminalSessionIdRef.current = activeTerminalSessionId;
  }, [activeTerminalSessionId]);

  useEffect(() => {
    if (!activeTerminalSessionId) {
      setIsMetricDetailOpen(false);
    }
  }, [activeTerminalSessionId]);

  useEffect(() => {
    if (autoSftpPathSyncEnabled) {
      return;
    }
    for (const timerId of pendingAutoSftpSyncTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    pendingAutoSftpSyncTimersRef.current.clear();
    terminalInputBufferRef.current.clear();
  }, [autoSftpPathSyncEnabled]);

  useEffect(() => {
    if (!activeTerminalSessionId) {
      return;
    }
    const knownPath = lastKnownSftpPathRef.current.get(activeTerminalSessionId);
    if (!knownPath) {
      return;
    }
    setSftpSyncRequest({
      sessionId: activeTerminalSessionId,
      path: knownPath,
      nonce: Date.now()
    });
  }, [activeTerminalSessionId]);

  useEffect(() => {
    return () => {
      for (const timerId of terminalInputFlushTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      terminalInputFlushTimersRef.current.clear();
      terminalInputWriteBufferRef.current.clear();

      for (const timerId of pendingAutoSftpSyncTimersRef.current.values()) {
        window.clearTimeout(timerId);
      }
      pendingAutoSftpSyncTimersRef.current.clear();
      terminalInputBufferRef.current.clear();
      sftpPathSyncInFlightRef.current.clear();
      lastKnownSftpPathRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const activeSessionMap = new Map(activeSessions.map((session) => [session.id, session]));
    const detachedToClose: string[] = [];

    setSplitWorkspaces((prev) => {
      const next: Record<string, TabSplitWorkspace> = {};
      for (const session of activeSessions) {
        const existing = prev[session.id];
        if (!existing) {
          next[session.id] = createDefaultWorkspace(session);
          continue;
        }

        const updatedRoot = updatePaneBySessionId(existing.root, session.id, {
          hostId: session.hostId,
          title: session.title
        });
        const hasRootSession = Boolean(findPaneBySessionId(updatedRoot, session.id));
        const ensuredRoot = hasRootSession
          ? updatedRoot
          : {
              type: 'split' as const,
              id: createSplitId(),
              direction: 'horizontal' as const,
              sizes: [48, 52] as [number, number],
              first: createPaneNode({
                id: `pane-${session.id}`,
                sessionId: session.id,
                hostId: session.hostId,
                title: session.title
              }),
              second: updatedRoot
            };

        const panes = collectWorkspacePanes(ensuredRoot);
        const fallbackPaneId =
          panes.find((pane) => pane.sessionId === session.id)?.id ?? panes[0]?.id ?? `pane-${session.id}`;
        const activePaneExists = hasPaneId(ensuredRoot, existing.activePaneId);
        next[session.id] = {
          ...existing,
          root: ensuredRoot,
          activePaneId: activePaneExists ? existing.activePaneId : fallbackPaneId
        };
      }

      for (const [tabId, workspace] of Object.entries(prev)) {
        if (activeSessionMap.has(tabId)) {
          continue;
        }
        for (const pane of collectWorkspacePanes(workspace.root)) {
          if (pane.sessionId !== tabId) {
            detachedToClose.push(pane.sessionId);
          }
        }
      }
      return next;
    });

    for (const paneSessionId of detachedToClose) {
      void sshDisconnect(paneSessionId).catch(() => {
        // Ignore already-closed sessions while pruning workspace.
      });
    }

    const activeSessionIds = new Set(activeSessions.map((session) => session.id));
    for (const [sessionId, timerId] of pendingAutoSftpSyncTimersRef.current.entries()) {
      if (activeSessionIds.has(sessionId)) {
        continue;
      }
      window.clearTimeout(timerId);
      pendingAutoSftpSyncTimersRef.current.delete(sessionId);
    }
    for (const sessionId of terminalInputBufferRef.current.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        terminalInputBufferRef.current.delete(sessionId);
      }
    }
    for (const sessionId of sftpPathSyncInFlightRef.current.values()) {
      if (!activeSessionIds.has(sessionId)) {
        sftpPathSyncInFlightRef.current.delete(sessionId);
      }
    }
    for (const sessionId of lastKnownSftpPathRef.current.keys()) {
      if (!activeSessionIds.has(sessionId)) {
        lastKnownSftpPathRef.current.delete(sessionId);
      }
    }
  }, [activeSessions]);

  useEffect(() => {
    if (!splitMenu) {
      return;
    }
    const closeMenu = (): void => {
      setSplitMenu(null);
    };
    window.addEventListener('pointerdown', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
    };
  }, [splitMenu]);

  useEffect(() => {
    if (!isInspectorOpen) {
      return;
    }

    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen<SshDiagnosticLogEvent>('ssh-diagnostic', (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      setSshDiagnosticLogs((prev) => {
        const next = [...prev, payload];
        if (next.length <= DIAGNOSTIC_LOG_MAX) {
          return next;
        }
        return next.slice(next.length - DIAGNOSTIC_LOG_MAX);
      });
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [isInspectorOpen]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen<SftpTransferProgressEvent>('sftp-transfer-progress', (event) => {
      if (disposed) {
        return;
      }
      applyTransferProgressEvent(event.payload);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [applyTransferProgressEvent]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void listen<SshSysStatusEvent>('ssh-sys-status', (event) => {
      if (disposed) {
        return;
      }
      const payload = event.payload;
      perfCountersRef.current.sysStatusEvents += 1;
      const sampledAt = normalizeSampledAtMs(payload.status.sampledAt);
      sysStatusBufferRef.current[payload.sessionId] = payload.status;

      const currentTrend = sysTrendBufferRef.current[payload.sessionId] ?? [];
      const latency =
        typeof payload.status.latencyMs === 'number' && Number.isFinite(payload.status.latencyMs)
          ? Math.max(0, payload.status.latencyMs)
          : 0;
      const nextSample: SessionMetricSample = {
        at: sampledAt,
        cpu: clampPercent(payload.status.cpuUsagePercent),
        memory: clampPercent(payload.status.memoryUsagePercent),
        rx: Math.max(0, payload.status.netRxBytesPerSec),
        tx: Math.max(0, payload.status.netTxBytesPerSec),
        latency
      };
      const cutoff = sampledAt - SYS_TREND_WINDOW_MS;
      const filtered = [...currentTrend, nextSample]
        .filter((item) => item.at >= cutoff)
        .slice(-SYS_TREND_MAX_SAMPLES);
      sysTrendBufferRef.current[payload.sessionId] = filtered;

      scheduleSysMetricsFlush();
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [scheduleSysMetricsFlush]);

  useEffect(() => {
    const activeIds = new Set<string>();
    for (const session of activeSessions) {
      activeIds.add(session.id);
      const workspace = splitWorkspaces[session.id];
      if (!workspace) {
        continue;
      }
      for (const pane of collectWorkspacePanes(workspace.root)) {
        activeIds.add(pane.sessionId);
      }
    }
    const nextStatus: Record<string, SessionSysStatus> = {};
    for (const [sessionId, status] of Object.entries(sysStatusBufferRef.current)) {
      if (activeIds.has(sessionId)) {
        nextStatus[sessionId] = status;
      }
    }
    const nextTrend: Record<string, SessionMetricSample[]> = {};
    for (const [sessionId, points] of Object.entries(sysTrendBufferRef.current)) {
      if (activeIds.has(sessionId)) {
        nextTrend[sessionId] = points;
      }
    }
    sysStatusBufferRef.current = nextStatus;
    sysTrendBufferRef.current = nextTrend;
    setSysStatusBySession(nextStatus);
    setSysTrendBySession(nextTrend);

    for (const [sessionId, timerId] of terminalInputFlushTimersRef.current.entries()) {
      if (activeIds.has(sessionId)) {
        continue;
      }
      window.clearTimeout(timerId);
      terminalInputFlushTimersRef.current.delete(sessionId);
    }
    for (const sessionId of terminalInputWriteBufferRef.current.keys()) {
      if (!activeIds.has(sessionId)) {
        terminalInputWriteBufferRef.current.delete(sessionId);
      }
    }
  }, [activeSessions, splitWorkspaces]);

  useEffect(() => {
    if (activeSessions.length === 0) {
      return;
    }

    const allSessionIds = new Set<string>();
    for (const session of activeSessions) {
      allSessionIds.add(session.id);
      const workspace = splitWorkspaces[session.id];
      if (workspace) {
        for (const pane of collectWorkspacePanes(workspace.root)) {
          allSessionIds.add(pane.sessionId);
        }
      }
    }

    for (const sessionId of allSessionIds) {
      const isActive = sessionId === activeTerminalSessionId;
      void sshSetPulseActivity(sessionId, isActive).catch(() => {
        // Ignore pulse state sync errors to avoid blocking UI flow.
      });
    }
  }, [activeSessions, activeTerminalSessionId, splitWorkspaces]);

  useEffect(() => {
    if (!isSyncPopoverOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const root = syncIndicatorRef.current;
      if (!root) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!root.contains(target)) {
        setIsSyncPopoverOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isSyncPopoverOpen]);

  useEffect(() => {
    if (!isProfileMenuOpen) {
      return;
    }
    setProfileDraftAutoPathSync(autoSftpPathSyncEnabled);
    setProfileDraftCloseAction(closeWindowAction);
  }, [autoSftpPathSyncEnabled, closeWindowAction, isProfileMenuOpen]);

  useEffect(() => {
    if (!isProfileMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent): void => {
      const root = profileMenuRef.current;
      if (!root) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!root.contains(target)) {
        setIsProfileMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isProfileMenuOpen]);

  useEffect(() => {
    if (isSettingsOpen) {
      setIsProfileMenuOpen(false);
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    const bootstrapDiscover = (): void => {
      void discoverCloudSyncPolicy().catch(() => {
        // Keep startup discovery non-blocking.
      });
    };
    bootstrapDiscover();
    const timer = window.setInterval(bootstrapDiscover, 5 * 60 * 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (appView !== 'dashboard') {
      setIsCloudAuthModalOpen(false);
      setSkippedCloudAuthForCurrentUnlock(false);
      return;
    }
    if (cloudSyncSession) {
      setIsCloudAuthModalOpen(false);
      return;
    }
    if (!skippedCloudAuthForCurrentUnlock) {
      setIsCloudAuthModalOpen(true);
    }
  }, [appView, cloudSyncSession, skippedCloudAuthForCurrentUnlock]);

  useEffect(() => {
    if (appView !== 'dashboard' || !cloudSyncSession) {
      return;
    }

    const runAutoPull = (): void => {
      void (async () => {
        await refreshCloudSyncPolicy({ silent: true });
        await syncPullFromCloud({ source: 'auto' });
      })();
    };

    runAutoPull();
    const intervalId = window.setInterval(runAutoPull, AUTO_PULL_INTERVAL_MS);
    const onFocus = (): void => {
      runAutoPull();
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        runAutoPull();
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [appView, cloudSyncSession, refreshCloudSyncPolicy, syncPullFromCloud]);

  useEffect(() => {
    if (appView !== 'dashboard' || cloudSyncSession) {
      return;
    }
    void discoverCloudSyncPolicy().catch(() => {
      // Keep first-run flow non-blocking. CloudAuthModal will continue handling discovery state.
    });
  }, [appView, cloudSyncSession]);

  const handleToggleWindowMaximize = useCallback(async (): Promise<void> => {
    if (isMobileLayout || isAndroidClient) {
      return;
    }
    try {
      const maximized = await appWindow.isMaximized();
      if (maximized) {
        await appWindow.unmaximize();
        setIsWindowMaximized(false);
      } else {
        await appWindow.maximize();
        setIsWindowMaximized(true);
      }
    } catch (_error) {
      toast.error('窗口状态切换失败，请稍后重试。');
    }
  }, [isAndroidClient, isMobileLayout]);

  useEffect(() => {
    if (isMobileLayout || isAndroidClient) {
      setIsWindowMaximized(false);
      return;
    }
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    const syncMaximizeState = async (): Promise<void> => {
      try {
        const maximized = await appWindow.isMaximized();
        if (!disposed) {
          setIsWindowMaximized(maximized);
        }
      } catch (_error) {
        if (!disposed) {
          setIsWindowMaximized(false);
        }
      }
    };

    void syncMaximizeState();
    void appWindow.onResized(() => {
      void syncMaximizeState();
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [isAndroidClient, isMobileLayout]);

  const forceCloseWindow = useCallback(async (): Promise<void> => {
    if (isMobileLayout || isAndroidClient) {
      return;
    }
    allowWindowCloseRef.current = true;
    setIsCloseWindowPromptOpen(false);

    try {
      await processExit(0);
      return;
    } catch (_exitError) {
      // Continue with window close fallback.
    }

    try {
      await appWindow.close();
    } catch (_error) {
      // Continue to forced exit path.
    }

    try {
      await appWindow.hide();
    } catch (_hideError) {
      // Ignore hide errors and keep fallback checks.
    }

    try {
      const stillVisible = await appWindow.isVisible();
      if (!stillVisible) {
        return;
      }
    } catch (_visibilityError) {
      return;
    }

    try {
      await processExit(0);
      return;
    } catch (_closeError) {
      allowWindowCloseRef.current = false;
      toast.error('退出应用失败，请稍后重试。');
    }
  }, [isAndroidClient, isMobileLayout]);

  useEffect(() => {
    if (isMobileLayout || isAndroidClient) {
      return;
    }
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void appWindow.onCloseRequested((event) => {
      if (allowWindowCloseRef.current) {
        return;
      }
      event.preventDefault();
      const closeAction = closeWindowActionRef.current;
      if (closeAction === 'tray') {
        void appWindow.hide();
        return;
      }
      if (closeAction === 'exit') {
        void forceCloseWindow();
        return;
      }
      setIsCloseWindowPromptOpen(true);
      setRememberCloseActionChoice(false);
    }).then((fn) => {
      if (disposed) {
        fn();
        return;
      }
      unlisten = fn;
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [forceCloseWindow, isAndroidClient, isMobileLayout]);

  const detectDownloadableRelease = useCallback(async (): Promise<void> => {
    const checkedAt = new Date().toISOString();
    try {
      const version = await getAppVersion();
      const result = await checkReleaseAvailability(version);
      const nextNotice: ReleaseNoticeState = result.hasUpdate
        ? {
            hasUpdate: true,
            latestVersion: result.latestVersion ?? null,
            releaseUrl: result.releaseUrl ?? null,
            checkedAt
          }
        : {
            hasUpdate: false,
            latestVersion: null,
            releaseUrl: result.releaseUrl ?? null,
            checkedAt
          };

      writeReleaseNoticeState(nextNotice);
      setReleaseNotice(nextNotice);
    } catch (_error) {
      const previous = readReleaseNoticeState();
      if (previous.checkedAt) {
        return;
      }
      const fallback: ReleaseNoticeState = {
        hasUpdate: previous.hasUpdate,
        latestVersion: previous.latestVersion,
        releaseUrl: previous.releaseUrl,
        checkedAt
      };
      writeReleaseNoticeState(fallback);
      setReleaseNotice(fallback);
    }
  }, []);

  useEffect(() => {
    if (!isNewTabModalOpen) {
      return;
    }
    if (hosts.length === 0) {
      setSelectedTabHostId('');
      return;
    }

    if (selectedTabHostId && hosts.some((host) => buildHostKey(host) === selectedTabHostId)) {
      return;
    }

    const firstHost = hosts[0];
    setSelectedTabHostId(firstHost ? buildHostKey(firstHost) : '');
  }, [hosts, isNewTabModalOpen, selectedTabHostId]);

  useEffect(() => {
    const previous = previousSessionCountRef.current;
    if (previous <= 1 && activeSessions.length > 1) {
      setIsSftpCollapsed(true);
      toast.info('已进入多会话模式，SFTP 面板已自动收起。');
    } else if (activeSessions.length <= 1) {
      setIsSftpCollapsed(false);
    }
    previousSessionCountRef.current = activeSessions.length;
  }, [activeSessions.length]);

  useEffect(() => {
    if (!isResizingSplit) {
      return;
    }

    const onPointerMove = (event: PointerEvent): void => {
      const container = terminalSplitRef.current;
      if (!container) {
        return;
      }
      const rect = container.getBoundingClientRect();
      const available = rect.right - event.clientX;
      const maxWidth = Math.min(SFTP_PANEL_MAX_WIDTH, Math.max(SFTP_PANEL_MIN_WIDTH, rect.width - 320));
      const nextWidth = Math.min(maxWidth, Math.max(SFTP_PANEL_MIN_WIDTH, available));
      setSftpPanelWidth(Math.round(nextWidth));
    };

    const onPointerUp = (): void => {
      setIsResizingSplit(false);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [isResizingSplit]);

  useEffect(() => {
    if (appView !== 'dashboard' || !autoLockEnabled) {
      return;
    }

    const lockAfterMs = autoLockMinutes * 60 * 1000;
    let hiddenTimer: number | null = null;
    let didLock = false;
    let lastActivityAt = Date.now();

    const triggerAutoLock = (description: string): void => {
      if (didLock) {
        return;
      }
      didLock = true;
      void lockVault().then(() => {
        toast.warning('金库已自动锁定', {
          description
        });
        const dayLabel = buildLocalDayLabel(new Date());
        if (wasDailyLockChecked(dayLabel)) {
          return;
        }
        void detectDownloadableRelease().finally(() => {
          rememberDailyLockCheck(dayLabel);
        });
      });
    };

    const markActivity = (): void => {
      lastActivityAt = Date.now();
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        if (hiddenTimer !== null) {
          window.clearTimeout(hiddenTimer);
        }
        hiddenTimer = window.setTimeout(() => {
          triggerAutoLock(`应用已隐藏超过 ${autoLockMinutes} 分钟。`);
        }, lockAfterMs);
      } else {
        if (hiddenTimer !== null) {
          window.clearTimeout(hiddenTimer);
          hiddenTimer = null;
        }
        markActivity();
      }
    };

    const idleCheckTimer = window.setInterval(() => {
      if (Date.now() - lastActivityAt >= lockAfterMs) {
        triggerAutoLock(`检测到闲置超过 ${autoLockMinutes} 分钟。`);
      }
    }, 15000);

    const activityEvents: ReadonlyArray<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'focus'
    ];

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, markActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (hiddenTimer !== null) {
        window.clearTimeout(hiddenTimer);
      }
      window.clearInterval(idleCheckTimer);
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, markActivity);
      }
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [appView, autoLockEnabled, autoLockMinutes, detectDownloadableRelease, lockVault]);

  useEffect(() => {
    if (appView !== 'dashboard' || autoLockEnabled) {
      return;
    }

    let lastActivityAt = Date.now();
    let hasCheckedInCurrentIdleCycle = false;

    const markActivity = (): void => {
      lastActivityAt = Date.now();
      hasCheckedInCurrentIdleCycle = false;
    };

    const timerId = window.setInterval(() => {
      const idleMs = Date.now() - lastActivityAt;
      if (idleMs < IDLE_RELEASE_CHECK_MS || hasCheckedInCurrentIdleCycle) {
        return;
      }
      hasCheckedInCurrentIdleCycle = true;
      void detectDownloadableRelease();
    }, 15000);

    const activityEvents: ReadonlyArray<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'focus'
    ];

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, markActivity, { passive: true });
    }

    return () => {
      window.clearInterval(timerId);
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, markActivity);
      }
    };
  }, [appView, autoLockEnabled, detectDownloadableRelease]);

  useEffect(() => {
    if (!isMobileRuntime || appView !== 'dashboard' || !mobileBiometricEnabled) {
      return;
    }
    let locking = false;
    const lockNow = (): void => {
      if (document.visibilityState !== 'hidden' || locking) {
        return;
      }
      locking = true;
      void lockVault().finally(() => {
        locking = false;
      });
    };
    document.addEventListener('visibilitychange', lockNow);
    window.addEventListener('blur', lockNow);
    return () => {
      document.removeEventListener('visibilitychange', lockNow);
      window.removeEventListener('blur', lockNow);
    };
  }, [appView, isMobileRuntime, lockVault, mobileBiometricEnabled]);

  const sendCommandToTerminal = async (command: string, execute = false): Promise<void> => {
    if (!command.trim()) {
      return;
    }
    if (!activeTerminalSessionId) {
      throw new Error('请先建立一个终端会话。');
    }

    try {
      flushBufferedInputForSession(activeTerminalSessionId);
      const payload = execute ? `${command}\n` : command;
      await sshWrite(activeTerminalSessionId, payload);
      setTerminalError(null);
    } catch (error) {
      const fallback = '写入终端失败，连接可能已断开。';
      const message = error instanceof Error ? error.message : fallback;
      setTerminalError(message || fallback);
      throw new Error(message || fallback);
    }
  };

  const sendRawInputToTerminal = useCallback(
    async (payload: string): Promise<void> => {
      if (!payload) {
        return;
      }
      if (!activeTerminalSessionId) {
        throw new Error('请先建立一个终端会话。');
      }
      try {
        await sshWrite(activeTerminalSessionId, payload);
        setTerminalError(null);
      } catch (error) {
        const fallback = '写入终端失败，连接可能已断开。';
        const message = error instanceof Error ? error.message : fallback;
        setTerminalError(message || fallback);
        throw new Error(message || fallback);
      }
    },
    [activeTerminalSessionId, setTerminalError]
  );

  const fillCommandIntoTerminal = async (command: string): Promise<void> => {
    await sendCommandToTerminal(command, false);
  };

  const runSnippetInTerminal = async (command: string, autoEnter: boolean): Promise<void> => {
    if (!autoEnter) {
      const nextCommand = command.replace(/\r\n/g, '\n').trim();
      if (!nextCommand) {
        return;
      }
      setTerminalDraftCommand((prev) => {
        if (!prev.trim()) {
          return nextCommand;
        }
        return `${prev.replace(/\s+$/g, '')}\n${nextCommand}`;
      });
      setTerminalDraftHistoryCursor(-1);
      setIsDraftHistoryOpen(false);
      return;
    }
    await sendCommandToTerminal(command, autoEnter);
  };

  const switchActiveSessionByOffset = useCallback(
    (offset: number): void => {
      if (!activeSessionId || activeSessions.length <= 1) {
        return;
      }
      const currentIndex = activeSessions.findIndex((session) => session.id === activeSessionId);
      if (currentIndex < 0) {
        return;
      }
      const nextIndex = (currentIndex + offset + activeSessions.length) % activeSessions.length;
      const nextSession = activeSessions[nextIndex];
      if (!nextSession) {
        return;
      }
      setActiveSession(nextSession.id);
    },
    [activeSessionId, activeSessions, setActiveSession]
  );

  const handleTerminalTouchStart = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>): void => {
      if (!isMobileLayout && !isAndroidClient) {
        return;
      }
      if (event.touches.length === 0) {
        return;
      }
      const first = event.touches[0];
      if (!first) {
        return;
      }
      let pinchDistance: number | null = null;
      if (event.touches.length >= 2) {
        const second = event.touches[1];
        if (!second) {
          return;
        }
        const dx = second.clientX - first.clientX;
        const dy = second.clientY - first.clientY;
        pinchDistance = Math.hypot(dx, dy);
      }
      terminalTouchStateRef.current = {
        startX: first.clientX,
        startY: first.clientY,
        swipeHandled: false,
        pinchDistance,
        baseFontSize: terminalFontSize
      };
    },
    [isAndroidClient, isMobileLayout, terminalFontSize]
  );

  const handleTerminalTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>): void => {
      const state = terminalTouchStateRef.current;
      if (!state) {
        return;
      }
      if (event.touches.length >= 2) {
        event.preventDefault();
        const first = event.touches[0];
        const second = event.touches[1];
        if (!first || !second) {
          return;
        }
        const dx = second.clientX - first.clientX;
        const dy = second.clientY - first.clientY;
        const nextDistance = Math.hypot(dx, dy);
        if (state.pinchDistance !== null && state.pinchDistance > 0) {
          const delta = nextDistance - state.pinchDistance;
          if (Math.abs(delta) >= 8) {
            const nextFontSize = state.baseFontSize + delta / 18;
            setTerminalFontSize(nextFontSize);
            state.pinchDistance = nextDistance;
            state.baseFontSize = nextFontSize;
          }
        } else {
          state.pinchDistance = nextDistance;
        }
        return;
      }
      if (event.touches.length !== 1 || state.swipeHandled) {
        return;
      }
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      const deltaX = touch.clientX - state.startX;
      const deltaY = touch.clientY - state.startY;
      if (Math.abs(deltaX) < MOBILE_SESSION_SWIPE_THRESHOLD_PX) {
        return;
      }
      if (Math.abs(deltaY) > MOBILE_SESSION_SWIPE_MAX_Y_DRIFT) {
        return;
      }
      event.preventDefault();
      state.swipeHandled = true;
      if (deltaX < 0) {
        switchActiveSessionByOffset(1);
      } else {
        switchActiveSessionByOffset(-1);
      }
    },
    [setTerminalFontSize, switchActiveSessionByOffset]
  );

  const handleTerminalTouchEnd = useCallback((): void => {
    terminalTouchStateRef.current = null;
  }, []);

  const mobileVirtualKeys = useMemo<
    Array<{
      id: string;
      label: string;
      payload: string;
    }>
  >(
    () => [
      { id: 'esc', label: 'Esc', payload: '\u001b' },
      { id: 'tab', label: 'Tab', payload: '\t' },
      { id: 'space', label: 'Space', payload: ' ' },
      { id: 'enter', label: 'Enter', payload: '\r' },
      { id: 'backspace', label: '⌫', payload: '\u007f' },
      { id: 'ctrl-c', label: 'Ctrl+C', payload: '\u0003' },
      { id: 'ctrl-d', label: 'Ctrl+D', payload: '\u0004' },
      { id: 'ctrl-z', label: 'Ctrl+Z', payload: '\u001a' },
      { id: 'ctrl-l', label: 'Ctrl+L', payload: '\u000c' },
      { id: 'ctrl-r', label: 'Ctrl+R', payload: '\u0012' },
      { id: 'ctrl-a', label: 'Ctrl+A', payload: '\u0001' },
      { id: 'ctrl-e', label: 'Ctrl+E', payload: '\u0005' },
      { id: 'ctrl-u', label: 'Ctrl+U', payload: '\u0015' },
      { id: 'ctrl-k', label: 'Ctrl+K', payload: '\u000b' },
      { id: 'ctrl-w', label: 'Ctrl+W', payload: '\u0017' },
      { id: 'ctrl-y', label: 'Ctrl+Y', payload: '\u0019' },
      { id: 'left', label: '←', payload: '\u001b[D' },
      { id: 'up', label: '↑', payload: '\u001b[A' },
      { id: 'down', label: '↓', payload: '\u001b[B' },
      { id: 'right', label: '→', payload: '\u001b[C' },
      { id: 'home', label: 'Home', payload: '\u001b[H' },
      { id: 'end', label: 'End', payload: '\u001b[F' },
      { id: 'pgup', label: 'PgUp', payload: '\u001b[5~' },
      { id: 'pgdn', label: 'PgDn', payload: '\u001b[6~' },
      { id: 'pipe', label: '|', payload: '|' },
      { id: 'amp', label: '&', payload: '&' },
      { id: 'semicolon', label: ';', payload: ';' },
      { id: 'tilde', label: '~', payload: '~' },
      { id: 'slash', label: '/', payload: '/' },
      { id: 'quote', label: '"', payload: '"' },
      { id: 'single-quote', label: "'", payload: "'" }
    ],
    []
  );

  const handleSendVirtualKey = useCallback(
    async (payload: string): Promise<void> => {
      if (!activeTerminalSessionId) {
        toast.error(
          locale === 'en-US'
            ? 'Please open a terminal session first.'
            : locale === 'ja-JP'
              ? '先に端末セッションを接続してください。'
              : locale === 'zh-TW'
                ? '請先建立終端會話。'
                : '请先建立终端会话。'
        );
        return;
      }
      try {
        await sendRawInputToTerminal(payload);
      } catch (error) {
        const fallback =
          locale === 'en-US'
            ? 'Virtual key send failed.'
            : locale === 'ja-JP'
              ? '仮想キー送信に失敗しました。'
              : locale === 'zh-TW'
                ? '虛擬按鍵發送失敗。'
                : '虚拟按键发送失败。';
        const message = error instanceof Error ? error.message : fallback;
        toast.error(message || fallback);
      }
    },
    [activeTerminalSessionId, locale, sendRawInputToTerminal]
  );

  const executeDraftCommand = async (): Promise<void> => {
    const normalized = terminalDraftCommand.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
    if (!normalized.trim()) {
      return;
    }
    const lines = normalized
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const historyEntry = lines.join('\n');
    const payload = `${normalized}\n`;
    try {
      await sendRawInputToTerminal(payload);
      setTerminalDraftHistory((prev) => {
        const deduped = prev.filter((item) => item !== historyEntry);
        const next = [...deduped, historyEntry];
        if (next.length <= TERMINAL_DRAFT_HISTORY_LIMIT) {
          return next;
        }
        return next.slice(next.length - TERMINAL_DRAFT_HISTORY_LIMIT);
      });
      setTerminalDraftHistoryCursor(-1);
      setTerminalDraftSnapshot('');
      setIsDraftHistoryOpen(false);
      setTerminalDraftCommand('');
    } catch (error) {
      const fallback = '执行命令失败，请检查连接状态。';
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    }
  };

  const handleToggleMobileKeyboardInput = useCallback((): void => {
    setIsMobilePortraitKeyboardInputEnabled((prev) => {
      const next = !prev;
      if (!next) {
        terminalPreInputRef.current?.blur();
      }
      return next;
    });
  }, []);

  const handleCopyTerminalOutput = useCallback(async (scope: 'visible' | 'all' = 'visible'): Promise<void> => {
    const copyFn = copyActiveTerminalOutputRef.current;
    if (!copyFn) {
      toast.message('当前没有可复制的终端输出。');
      return;
    }
    const copied = await copyFn(scope);
    if (!copied) {
      toast.error('复制失败，请稍后重试。');
      return;
    }
    toast.success(scope === 'visible' ? '已复制当前可见区域输出。' : '已复制当前终端全部输出。');
  }, []);

  const handleOpenHostInfo = useCallback(async (): Promise<void> => {
    if (!activeTerminalSessionId) {
      toast.error('请先建立终端连接后再查看主机信息。');
      return;
    }
    setIsHostInfoOpen(true);
    setIsLoadingHostInfo(true);
    setHostInfoError(null);
    try {
      const result = await sshQueryHostInfo(activeTerminalSessionId);
      setHostInfo(result);
    } catch (error) {
      const fallback = '读取主机信息失败，请稍后重试。';
      const message = error instanceof Error ? error.message : fallback;
      setHostInfo(null);
      setHostInfoError(message || fallback);
    } finally {
      setIsLoadingHostInfo(false);
    }
  }, [activeTerminalSessionId]);

  const requestSftpPathSync = useCallback(
    async (
      sessionId: string,
      options?: {
        notify?: boolean;
        force?: boolean;
      }
    ): Promise<void> => {
      if (!sessionId) {
        return;
      }
      if (sftpPathSyncInFlightRef.current.has(sessionId)) {
        return;
      }

      sftpPathSyncInFlightRef.current.add(sessionId);
      try {
        const currentPath = await sshQueryPwd(sessionId);
        const previousPath = lastKnownSftpPathRef.current.get(sessionId);
        if (!options?.force && previousPath === currentPath) {
          return;
        }
        lastKnownSftpPathRef.current.set(sessionId, currentPath);
        if (activeTerminalSessionIdRef.current === sessionId) {
          setSftpSyncRequest({
            sessionId,
            path: currentPath,
            nonce: Date.now()
          });
        }
        if (options?.notify) {
          toast.success(`已同步到路径：${currentPath}`);
        }
      } catch (error) {
        if (options?.notify) {
          const fallback = '路径同步失败，请确认终端仍在线。';
          const message = error instanceof Error ? error.message : fallback;
          toast.error(message || fallback);
        }
      } finally {
        sftpPathSyncInFlightRef.current.delete(sessionId);
      }
    },
    []
  );

  const scheduleAutoSftpPathSync = useCallback(
    (sessionId: string, delayMs = AUTO_SFTP_SYNC_DEBOUNCE_MS): void => {
      if (!sessionId) {
        return;
      }
      const timers = pendingAutoSftpSyncTimersRef.current;
      const existing = timers.get(sessionId);
      if (existing) {
        window.clearTimeout(existing);
      }
      const timerId = window.setTimeout(() => {
        timers.delete(sessionId);
        if (activeTerminalSessionIdRef.current !== sessionId) {
          return;
        }
        void requestSftpPathSync(sessionId);
      }, delayMs);
      timers.set(sessionId, timerId);
    },
    [requestSftpPathSync]
  );

  const consumeTerminalInputForAutoSftpSync = useCallback(
    (sessionId: string, data: string): void => {
      if (!data || activeTerminalSessionIdRef.current !== sessionId) {
        return;
      }
      const sanitizedInput = data
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\u001b./g, '');

      let buffer = terminalInputBufferRef.current.get(sessionId) ?? '';
      let shouldSync = false;

      for (const char of sanitizedInput) {
        if (char === '\r' || char === '\n') {
          if (shouldTriggerAutoSftpPathSync(buffer)) {
            shouldSync = true;
          }
          buffer = '';
          continue;
        }
        if (char === '\u007f' || char === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (char === '\u0003' || char === '\u0015' || char === '\u0018') {
          buffer = '';
          continue;
        }
        if (char >= ' ' && char !== '\u007f') {
          buffer += char;
          if (buffer.length > TERMINAL_INPUT_BUFFER_LIMIT) {
            buffer = buffer.slice(buffer.length - TERMINAL_INPUT_BUFFER_LIMIT);
          }
        }
      }

      if (buffer) {
        terminalInputBufferRef.current.set(sessionId, buffer);
      } else {
        terminalInputBufferRef.current.delete(sessionId);
      }

      if (shouldSync) {
        scheduleAutoSftpPathSync(sessionId);
      }
    },
    [scheduleAutoSftpPathSync]
  );

  const handleSyncPathToSftp = async (): Promise<void> => {
    if (!activeTerminalSessionId) {
      toast.error('请先建立终端会话，再执行路径同步。');
      return;
    }
    if (isSyncingPath) {
      return;
    }

    setIsSyncingPath(true);
    try {
      await requestSftpPathSync(activeTerminalSessionId, { notify: true, force: true });
    } catch (_error) {
      // Error feedback is handled inside requestSftpPathSync when notify is true.
    } finally {
      setIsSyncingPath(false);
    }
  };

  const tryAutoReconnect = async (closedSession: { hostId: string; title: string }): Promise<void> => {
    const targetHost = hosts.find((host) => buildHostKey(host) === closedSession.hostId);
    if (!targetHost) {
      toast.error('自动重连失败：未找到原始主机配置。');
      return;
    }

    const maxAttempts = 4;
    const baseDelayMs = 1000;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setReconnectMessage('网络离线，等待网络恢复后自动重连...');
        const restored = await waitForBrowserOnline(AUTO_RECONNECT_WAIT_ONLINE_MS);
        if (!restored) {
          continue;
        }
      }
      setReconnectMessage(`正在尝试自动重连...（第 ${attempt}/${maxAttempts} 次）`);
      const success = await openTerminal(targetHost);
      if (success) {
        setReconnectMessage(null);
        toast.success(`已自动重连：${closedSession.title}`);
        return;
      }

      if (attempt < maxAttempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 350);
        await new Promise((resolve) => window.setTimeout(resolve, delay));
      }
    }

    setReconnectMessage(null);
    toast.error(`自动重连失败：${closedSession.title}`);
  };

  const handleAskAiForSshFix = async (errorMessage: string, logContext: string[]) => {
    return aiExplainSshError(errorMessage, logContext);
  };

  const handleDeleteHost = async (hostId: string, hostName: string): Promise<void> => {
    const shouldDelete = window.confirm(`确认删除主机「${hostName}」吗？该操作会同步更新本地金库。`);
    if (!shouldDelete) {
      return;
    }

    try {
      await deleteHost(hostId);
    } catch (error) {
      const fallback = '删除主机失败，请稍后重试。';
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    }
  };

  const handleSaveHostEdit = async (values: HostEditFormValues): Promise<void> => {
    if (!editingHostId) {
      return;
    }

    try {
      await updateHostAndIdentity(editingHostId, {
        basicInfo: {
          name: values.name,
          address: values.address,
          port: values.port,
          description: values.description,
          tagsText: values.tagsText
        },
        identity: {
          name: values.identityName,
          username: values.identityUsername,
          authConfig:
            values.method === 'password'
              ? {
                  method: 'password',
                  password: values.password?.trim() ?? '',
                  privateKey: '',
                  passphrase: ''
                }
              : {
                  method: 'privateKey',
                  password: '',
                  privateKey: values.privateKey?.trim() ?? '',
                  passphrase: values.passphrase ?? ''
                }
        }
      });
      setEditingHostId(null);
    } catch (error) {
      const fallback = '保存主机编辑失败，请稍后重试。';
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    }
  };

  const handleOpenHostWizard = (): void => {
    if (isLicensedHostLimitReached) {
      toast.error(`当前授权最多支持 ${licensedHostLimit} 台主机，请删除旧主机或升级套餐后再新增。`);
      return;
    }
    reset();
    setIsHostWizardOpen(true);
  };

  const handleCloseHostWizard = (): void => {
    setIsHostWizardOpen(false);
  };

  const handleConnectFromHostList = async (hostId: string): Promise<void> => {
    const target = hosts.find((host) => buildHostKey(host) === hostId);
    if (!target) {
      toast.error('未找到目标主机，请刷新后重试。');
      return;
    }

    setConnectingHostId(hostId);
    try {
      const success = await openTerminal(target);
      if (success) {
        setDashboardSection('terminal');
        recordHostConnection(hostId);
        setTerminalError(null);
      }
    } finally {
      setConnectingHostId((current) => (current === hostId ? null : current));
    }
  };

  const deployPublicKeyToHost = async (
    hostId: string,
    options?: { showToast?: boolean }
  ): Promise<{ ok: boolean; hostName: string; error?: string }> => {
    const showToast = options?.showToast !== false;
    const target = hosts.find((host) => buildHostKey(host) === hostId);
    const targetName = target?.basicInfo.name || (target ? `${target.basicInfo.address}:${target.basicInfo.port}` : hostId);
    if (!target) {
      const message = '未找到目标设备，请刷新后重试。';
      if (showToast) {
        toast.error(message);
      }
      return { ok: false, hostName: targetName, error: message };
    }
    if (!cloudSyncSession) {
      const message = '请先登录同步账号并激活专业版后再使用密钥部署。';
      if (showToast) {
        toast.error(message);
      }
      return { ok: false, hostName: targetName, error: message };
    }
    if (!canUseKeyDeployFeature) {
      const message = '当前授权不包含“密钥部署”能力，请先激活或升级专业版。';
      if (showToast) {
        toast.error(message);
      }
      return { ok: false, hostName: targetName, error: message };
    }

    const linkedIdentity = identities.find((identity) => identity.id === target.identityId) ?? null;
    if (!linkedIdentity) {
      const message = '未找到该设备绑定的身份配置。';
      if (showToast) {
        toast.error(message);
      }
      return { ok: false, hostName: targetName, error: message };
    }

    const allPrivateKeyIdentities = identities.filter((identity) => {
      const privateKey = identity.authConfig.privateKey?.trim() ?? '';
      return identity.authConfig.method === 'privateKey' && privateKey.length > 0;
    });
    const linkedPrivateKey = linkedIdentity.authConfig.privateKey?.trim() ?? '';
    const sameUserIdentity = allPrivateKeyIdentities.find(
      (identity) => identity.username.trim() === linkedIdentity.username.trim()
    );
    const deploymentIdentity =
      linkedPrivateKey.length > 0 ? linkedIdentity : sameUserIdentity ?? allPrivateKeyIdentities[0] ?? null;
    if (!deploymentIdentity) {
      const message = '没有可用私钥可部署，请先在“身份管理 · SSH 密钥”里生成或导入私钥。';
      if (showToast) {
        toast.error(message);
      }
      return { ok: false, hostName: targetName, error: message };
    }

    const privateKey = deploymentIdentity.authConfig.privateKey?.trim() ?? '';
    if (!privateKey) {
      const message = '选定身份未包含私钥，无法部署。';
      if (showToast) {
        toast.error(message);
      }
      return { ok: false, hostName: targetName, error: message };
    }

    setDeployingHostId(hostId);
    try {
      let sessionId =
        [...activeSessions]
          .reverse()
          .find((session) => session.hostId === hostId)
          ?.id ?? null;

      if (!sessionId) {
        setConnectingHostId(hostId);
        const connected = await openTerminal(target);
        setConnectingHostId((current) => (current === hostId ? null : current));
        if (!connected) {
          const message = '连接目标主机失败，无法执行密钥部署。';
          return { ok: false, hostName: targetName, error: message };
        }
        setDashboardSection('terminal');
        recordHostConnection(hostId);
        setTerminalError(null);
        sessionId =
          [...useHostStore.getState().activeSessions]
            .reverse()
            .find((session) => session.hostId === hostId)
            ?.id ?? null;
      }

      if (!sessionId) {
        const message = '设备连接已建立，但未拿到可用会话，请重试一次。';
        if (showToast) {
          toast.error(message);
        }
        return { ok: false, hostName: targetName, error: message };
      }

      const derived = await sshDerivePublicKey(privateKey);
      await sshDeployPublicKey(sessionId, derived.publicKey);

      if (showToast) {
        toast.success(`已完成「${targetName}」密钥部署`, {
          description:
            deploymentIdentity.id === linkedIdentity.id
              ? derived.fingerprint
              : `使用身份：${deploymentIdentity.name} · ${derived.fingerprint}`
        });
      }
      return { ok: true, hostName: targetName };
    } catch (error) {
      const fallback = '部署密钥失败，请检查目标系统类型与账号权限后重试。';
      const message = error instanceof Error ? error.message : fallback;
      if (showToast) {
        toast.error(message || fallback);
      }
      return { ok: false, hostName: targetName, error: message || fallback };
    } finally {
      setDeployingHostId((current) => (current === hostId ? null : current));
    }
  };

  const handleDeployPublicKeyFromHostList = async (hostId: string): Promise<void> => {
    await deployPublicKeyToHost(hostId, { showToast: true });
  };

  const toggleHostSelection = (hostId: string): void => {
    setSelectedHostIds((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) {
        next.delete(hostId);
      } else {
        next.add(hostId);
      }
      return next;
    });
  };

  const handleSelectAllFilteredHosts = (): void => {
    setSelectedHostIds((prev) => {
      const next = new Set(prev);
      for (const hostId of filteredHostIds) {
        next.add(hostId);
      }
      return next;
    });
  };

  const handleClearHostSelection = (): void => {
    setSelectedHostIds(new Set());
  };

  const handleBatchDeployPublicKeys = async (): Promise<void> => {
    if (selectedHostIds.size === 0) {
      toast.error('请先选择至少一台主机后再批量部署。');
      return;
    }
    if (!cloudSyncSession) {
      toast.error('请先登录同步账号并激活专业版后再使用密钥部署。');
      return;
    }
    if (!canUseKeyDeployFeature) {
      toast.error('当前授权不包含“密钥部署”能力，请先激活或升级专业版。');
      return;
    }

    const queue = Array.from(selectedHostIds).filter((hostId) => hosts.some((host) => buildHostKey(host) === hostId));
    if (queue.length === 0) {
      toast.error('未找到可部署的主机，请刷新后重试。');
      return;
    }

    setIsBatchDeploying(true);
    let successCount = 0;
    const failedHosts: string[] = [];
    for (const hostId of queue) {
      // 串行执行可避免并发连接时的资源争抢与提示刷屏。
      const result = await deployPublicKeyToHost(hostId, { showToast: false });
      if (result.ok) {
        successCount += 1;
      } else {
        failedHosts.push(result.hostName);
      }
    }
    setIsBatchDeploying(false);

    if (failedHosts.length === 0) {
      setSelectedHostIds(new Set());
      toast.success(`批量部署完成：成功 ${successCount} 台。`);
      return;
    }
    const failPreview =
      failedHosts.length <= 3 ? failedHosts.join('、') : `${failedHosts.slice(0, 3).join('、')} 等 ${failedHosts.length} 台`;
    toast.warning(`批量部署完成：成功 ${successCount} 台，失败 ${failedHosts.length} 台。`, {
      description: failPreview
    });
  };

  const handleHostSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (filteredHosts.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedSearchIndex((prev) => {
        const next = prev < 0 ? 0 : prev + 1;
        return next >= filteredHosts.length ? 0 : next;
      });
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedSearchIndex((prev) => {
        if (prev <= 0) {
          return filteredHosts.length - 1;
        }
        return prev - 1;
      });
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const index = highlightedSearchIndex < 0 ? 0 : highlightedSearchIndex;
      const target = filteredHosts[index];
      if (!target) {
        return;
      }
      const hostId = buildHostKey(target);
      void handleConnectFromHostList(hostId);
    }
  };

  const handleConnectFromNewTabModal = async (): Promise<void> => {
    if (!selectedTabHost) {
      toast.error('请选择一台主机后再新建终端窗口。');
      return;
    }

    const success = await openTerminal(selectedTabHost);
    if (success) {
      setDashboardSection('terminal');
      recordHostConnection(buildHostKey(selectedTabHost));
      setTerminalError(null);
      setIsNewTabModalOpen(false);
    }
  };

  const handleManualPullSync = async (): Promise<void> => {
    if (!cloudSyncSession) {
      toast.message('请先登录私有云同步账号。');
      setIsCloudAuthModalOpen(true);
      return;
    }

    await syncPullFromCloud({ source: 'manual', force: true });
  };

  const handleManualForcePushSync = async (): Promise<void> => {
    if (!cloudSyncSession) {
      toast.message('请先登录私有云同步账号。');
      setIsCloudAuthModalOpen(true);
      return;
    }

    await syncPushToCloud({ source: 'manual', force: true });
  };

  const setActivePane = useCallback((tabSessionId: string, paneId: string): void => {
    setSplitWorkspaces((prev) => {
      const workspace = prev[tabSessionId];
      if (!workspace) {
        return prev;
      }
      if (!hasPaneId(workspace.root, paneId)) {
        return prev;
      }
      if (workspace.activePaneId === paneId) {
        return prev;
      }
      return {
        ...prev,
        [tabSessionId]: {
          ...workspace,
          activePaneId: paneId
        }
      };
    });
  }, []);

  const handleToggleSyncInput = useCallback((): void => {
    if (!activeSessionId) {
      return;
    }
    setSplitWorkspaces((prev) => {
      const workspace = prev[activeSessionId];
      if (!workspace) {
        return prev;
      }
      return {
        ...prev,
        [activeSessionId]: {
          ...workspace,
          syncInput: !workspace.syncInput
        }
      };
    });
  }, [activeSessionId]);

  const flushBufferedInputForSession = useCallback(
    (sessionId: string): void => {
      const timers = terminalInputFlushTimersRef.current;
      const timerId = timers.get(sessionId);
      if (timerId) {
        window.clearTimeout(timerId);
        timers.delete(sessionId);
      }

      const payload = terminalInputWriteBufferRef.current.get(sessionId);
      if (!payload) {
        return;
      }
      terminalInputWriteBufferRef.current.delete(sessionId);

      perfCountersRef.current.inputFlushes += 1;
      void sshWrite(sessionId, payload).catch(() => {
        setTerminalError('发送输入失败，连接可能已断开。');
      });
    },
    [setTerminalError]
  );

  const queueBufferedInputForSession = useCallback(
    (sessionId: string, data: string): void => {
      if (!sessionId || !data) {
        return;
      }

      const buffer = terminalInputWriteBufferRef.current;
      const existing = buffer.get(sessionId) ?? '';
      const next = `${existing}${data}`;
      buffer.set(sessionId, next);

      const shouldFlushNow =
        shouldFlushTerminalInputImmediately(data) || next.length >= TERMINAL_INPUT_MAX_BUFFER_CHARS;
      if (shouldFlushNow) {
        flushBufferedInputForSession(sessionId);
        return;
      }

      const timers = terminalInputFlushTimersRef.current;
      if (timers.has(sessionId)) {
        return;
      }
      const timerId = window.setTimeout(() => {
        timers.delete(sessionId);
        flushBufferedInputForSession(sessionId);
      }, TERMINAL_INPUT_FLUSH_MS);
      timers.set(sessionId, timerId);
    },
    [flushBufferedInputForSession]
  );

  const handlePaneInput = useCallback(
    (tabSessionId: string, sourceSessionId: string, data: string): void => {
      if (!data) {
        return;
      }
      if (isMobileRuntime) {
        return;
      }

      if (autoSftpPathSyncEnabled) {
        consumeTerminalInputForAutoSftpSync(sourceSessionId, data);
      }

      const workspace = splitWorkspacesRef.current[tabSessionId];
      const targets = workspace && workspace.syncInput
        ? Array.from(
            new Set(collectWorkspacePanes(workspace.root).map((pane) => pane.sessionId))
          )
        : [sourceSessionId];

      perfCountersRef.current.inputChunks += 1;
      perfCountersRef.current.inputBytes += data.length;
      for (const targetSessionId of targets) {
        queueBufferedInputForSession(targetSessionId, data);
      }
    },
    [autoSftpPathSyncEnabled, consumeTerminalInputForAutoSftpSync, isMobileRuntime, queueBufferedInputForSession]
  );

  const handlePaneSessionClosed = useCallback(
    (tabSessionId: string, paneId: string, sessionId: string): void => {
      const workspace = splitWorkspacesRef.current[tabSessionId];
      const pane =
        workspace ? findPaneById(workspace.root, paneId) ?? findPaneBySessionId(workspace.root, sessionId) : null;
      if (!pane) {
        return;
      }

      if (pane.sessionId === tabSessionId) {
        const closeReason = handleSessionClosed(tabSessionId);
        if (closeReason === 'manual') {
          return;
        }
        toast.warning(`SSH 会话中断：${pane.title}`);
        void tryAutoReconnect({
          hostId: pane.hostId,
          title: pane.title
        });
        return;
      }

      const wasManual = manualDetachedClosingRef.current.delete(pane.sessionId);
      setSplitWorkspaces((prev) => {
        const workspace = prev[tabSessionId];
        if (!workspace) {
          return prev;
        }
        const removeResult = removePaneFromLayout(workspace.root, pane.id);
        if (!removeResult.removedPane || !removeResult.nextNode) {
          return prev;
        }
        const remainingPanes = collectWorkspacePanes(removeResult.nextNode);
        const fallbackPaneId = remainingPanes[0]?.id ?? `pane-${tabSessionId}`;
        const nextActivePaneId =
          workspace.activePaneId === pane.id || !hasPaneId(removeResult.nextNode, workspace.activePaneId)
            ? fallbackPaneId
            : workspace.activePaneId;
        return {
          ...prev,
          [tabSessionId]: {
            ...workspace,
            root: removeResult.nextNode,
            activePaneId: nextActivePaneId
          }
        };
      });

      if (!wasManual) {
        toast.warning(`分屏会话中断：${pane.title}`);
      }
    },
    [handleSessionClosed]
  );

  const handleClosePane = useCallback(async (tabSessionId: string, paneId: string): Promise<void> => {
    const workspace = splitWorkspacesRef.current[tabSessionId];
    const pane = workspace ? findPaneById(workspace.root, paneId) : null;
    if (!workspace || !pane) {
      return;
    }

    if (pane.sessionId === tabSessionId) {
      toast.message('主会话请通过“关闭当前”按钮关闭。');
      return;
    }

    manualDetachedClosingRef.current.add(pane.sessionId);
    setSplitWorkspaces((prev) => {
      const target = prev[tabSessionId];
      if (!target) {
        return prev;
      }
      const removeResult = removePaneFromLayout(target.root, paneId);
      if (!removeResult.removedPane || !removeResult.nextNode) {
        return prev;
      }
      const remainingPanes = collectWorkspacePanes(removeResult.nextNode);
      const fallbackPaneId = remainingPanes[0]?.id ?? `pane-${tabSessionId}`;
      const nextActivePaneId =
        target.activePaneId === paneId || !hasPaneId(removeResult.nextNode, target.activePaneId)
          ? fallbackPaneId
          : target.activePaneId;
      return {
        ...prev,
        [tabSessionId]: {
          ...target,
          root: removeResult.nextNode,
          activePaneId: nextActivePaneId
        }
      };
    });

    try {
      await sshDisconnect(pane.sessionId);
    } catch (_error) {
      toast.warning('分屏会话关闭时出现异常，已在本地移除该分屏。');
    } finally {
      window.setTimeout(() => {
        manualDetachedClosingRef.current.delete(pane.sessionId);
      }, 1200);
    }
  }, []);

  const handleSplitFromMenu = useCallback(
    async (direction: SplitDirection): Promise<void> => {
      if (isMobileRuntime) {
        return;
      }
      if (!splitMenu) {
        return;
      }

      const { tabSessionId, paneId } = splitMenu;
      setSplitMenu(null);

      const workspace = splitWorkspacesRef.current[tabSessionId];
      const sourcePane = workspace ? findPaneById(workspace.root, paneId) : null;
      if (!workspace || !sourcePane) {
        toast.error('分屏目标不存在，请重试。');
        return;
      }

      try {
        const detachedSession = await openDetachedSession(sourcePane.hostId);
        const nextPane: TerminalSplitPane = {
          id: createPaneId(tabSessionId),
          sessionId: detachedSession.id,
          hostId: sourcePane.hostId,
          title: detachedSession.title
        };
        setSplitWorkspaces((prev) => {
          const target = prev[tabSessionId];
          if (!target || !hasPaneId(target.root, paneId)) {
            return prev;
          }
          const nextRoot = replacePaneWithSplit(target.root, paneId, direction, nextPane);
          return {
            ...prev,
            [tabSessionId]: {
              ...target,
              root: nextRoot,
              activePaneId: nextPane.id
            }
          };
        });
        setActiveSession(tabSessionId);
      } catch (error) {
        const fallback = '创建分屏失败，请检查网络与认证状态。';
        const message = error instanceof Error ? error.message : fallback;
        toast.error(message || fallback);
      }
    },
    [isMobileRuntime, openDetachedSession, setActiveSession, splitMenu]
  );

  const handlePaneContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    tabSessionId: string,
    paneId: string
  ): void => {
    if (isMobileRuntime) {
      return;
    }
    event.preventDefault();
    setActiveSession(tabSessionId);
    setActivePane(tabSessionId, paneId);
    setSplitMenu({
      x: event.clientX,
      y: event.clientY,
      tabSessionId,
      paneId
    });
  };

  const splitMenuTargetPane = useMemo(() => {
    if (!splitMenu) {
      return null;
    }
    const workspace = splitWorkspaces[splitMenu.tabSessionId];
    if (!workspace) {
      return null;
    }
    return findPaneById(workspace.root, splitMenu.paneId);
  }, [splitMenu, splitWorkspaces]);

  const splitMenuCanCloseCurrent = useMemo(() => {
    if (!splitMenu || !splitMenuTargetPane) {
      return false;
    }
    if (splitMenuTargetPane.sessionId === splitMenu.tabSessionId) {
      return false;
    }
    const workspace = splitWorkspaces[splitMenu.tabSessionId];
    if (!workspace) {
      return false;
    }
    return collectWorkspacePanes(workspace.root).length > 1;
  }, [splitMenu, splitMenuTargetPane, splitWorkspaces]);

  const handleCommandPaletteClose = (): void => {
    setIsCommandPaletteOpen(false);
    setCommandPaletteQuery('');
    setCommandPaletteActiveIndex(0);
  };

  const handleCommandPaletteConfirm = (item: CommandPaletteItem): void => {
    const runtimeItem = commandPaletteRuntimeItems.find((entry) => entry.id === item.id);
    if (!runtimeItem) {
      return;
    }
    handleCommandPaletteClose();
    void Promise.resolve(runtimeItem.execute()).catch((error) => {
      const fallback = '命令面板执行失败，请稍后重试。';
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    });
  };

  const appScaleStyle = useMemo(() => {
    if (uiScalePercent === 100) {
      return undefined;
    }
    return {
      fontSize: `${uiScalePercent}%`
    };
  }, [uiScalePercent]);
  const mobileBottomNavReservePx =
    isMobileRuntime && appView === 'dashboard' && !isMobileTerminalFocusMode ? 84 : 0;
  const appShellStyle = useMemo(() => {
    return {
      ...(appScaleStyle ?? {}),
      paddingTop: isMobileRuntime ? 'env(safe-area-inset-top)' : undefined,
      paddingBottom:
        isMobileRuntime
          ? `calc(env(safe-area-inset-bottom) + ${Math.max(0, mobileKeyboardInset)}px + ${mobileBottomNavReservePx}px)`
          : undefined
    };
  }, [appScaleStyle, isMobileRuntime, mobileKeyboardInset, mobileBottomNavReservePx]);
  const shellContainerStyle = useMemo(
    () => ({
      borderColor: isMobileRuntime ? activeUiPalette.panelBorder : 'transparent',
      background: activeUiPalette.shellBackground,
      boxShadow: 'none',
      transition: 'none'
    }),
    [activeUiPalette.panelBorder, activeUiPalette.shellBackground, isMobileRuntime]
  );
  const terminalAreaStyle = useMemo(
    () => ({
      background: `linear-gradient(145deg, ${toRgba(activeThemePreset.terminalSurfaceHex, 0.94)} 0%, ${toRgba(
        activeThemePreset.terminalSurfaceHex,
        0.72
      )} 100%)`
    }),
    [activeThemePreset]
  );

  const appContrastClassName = contrastMode === 'high' ? 'contrast-[1.08] saturate-[1.03]' : '';

  if (!hasCompletedOnboarding) {
    return (
      <>
        <FirstRunOnboarding isMobileView={isMobileRuntime} />
        <Toaster
          closeButton
          expand
          position="bottom-center"
          richColors
          toastOptions={{
            className: 'rounded-2xl border border-slate-200/80 bg-white/96 px-3 py-2 shadow-xl',
            descriptionClassName: 'text-slate-600'
          }}
          visibleToasts={5}
        />
      </>
    );
  }

  if (appView === 'locked') {
    return (
      <>
        <UnlockScreen isMobileView={isMobileRuntime} />
        <Toaster
          closeButton
          expand
          position="bottom-center"
          richColors
          toastOptions={{
            className: 'rounded-2xl border border-slate-200/80 bg-white/96 px-3 py-2 shadow-xl',
            descriptionClassName: 'text-slate-600'
          }}
          visibleToasts={5}
        />
      </>
    );
  }

  return (
    <main
      className={`m-0 h-screen w-screen overflow-hidden ${isMobileRuntime ? 'p-1' : 'p-0'} ${appContrastClassName}`}
      style={appShellStyle}
    >
      <section
        className={`glass-card flex h-full w-full flex-col overflow-hidden ${
          isMobileRuntime ? 'rounded-[18px] border ring-0 shadow-[0_10px_30px_rgba(10,20,40,0.28)]' : 'rounded-none border-0 ring-0'
        }`}
        style={shellContainerStyle}
      >
        {!isMobileTerminalFocusMode && (
          <header
            className="shrink-0 border-b px-2.5 py-1.5 sm:px-3 sm:py-2"
            style={{
              background: activeUiPalette.headerBackground,
              borderColor: activeUiPalette.headerBorder
            }}
          >
          <div className="flex min-w-0 items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5">
              {isMobileLayout ? (
                <div
                  className="inline-flex min-h-11 items-center rounded-lg border px-3 py-1.5 text-xs font-semibold"
                  style={{
                    borderColor: activeUiPalette.panelBorder,
                    background: activeUiPalette.panelBackground,
                    color: activeUiPalette.textPrimary
                  }}
                >
                  {mobileNavTitle}
                </div>
              ) : (
                <>
                  <button
                    className={`${toolbarButtonClass} ${
                      dashboardSection === 'hosts' ? '' : 'opacity-85'
                    }`}
                    onClick={() => setDashboardSection('hosts')}
                    style={
                      dashboardSection === 'hosts'
                        ? {
                            borderColor: activeUiPalette.accent,
                            background: activeUiPalette.accentSoft,
                            color: activeUiPalette.textPrimary
                          }
                        : undefined
                    }
                    type="button"
                  >
                    {uiText.navHosts}
                  </button>
                  <button
                    className={`${toolbarButtonClass} ${
                      dashboardSection === 'terminal' ? '' : 'opacity-85'
                    }`}
                    onClick={() => setDashboardSection('terminal')}
                    style={
                      dashboardSection === 'terminal'
                        ? {
                            borderColor: activeUiPalette.accent,
                            background: activeUiPalette.accentSoft,
                            color: activeUiPalette.textPrimary
                          }
                        : undefined
                    }
                    type="button"
                  >
                    {uiText.navTerminal}
                  </button>
                  <button
                    className={toolbarButtonClass}
                    onClick={() => {
                      setCommandPaletteQuery('');
                      setCommandPaletteActiveIndex(0);
                      setIsCommandPaletteOpen(true);
                    }}
                    type="button"
                  >
                    {uiText.navPalette}
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <div className="group relative" ref={syncIndicatorRef}>
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg border bg-white/86 px-2 py-1 text-[11px] text-slate-600 hover:bg-white"
                  onClick={() => {
                    setIsSyncPopoverOpen((prev) => !prev);
                    setIsProfileMenuOpen(false);
                  }}
                  style={{ borderColor: toRgba(activeThemePreset.terminalBorder, 0.34) }}
                  title={`${uiText.navLastSync}: ${syncLastText}`}
                  type="button"
                >
                  <span className={`inline-flex h-2 w-2 rounded-full ${syncIndicatorDotClass}`} />
                  <span>{uiText.navSync}</span>
                </button>
                <div className="pointer-events-none absolute right-0 top-[calc(100%+8px)] z-20 min-w-[220px] rounded-md border border-slate-200 bg-slate-900/95 px-2.5 py-1.5 text-[11px] text-slate-100 opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100">
                  {uiText.navLastSync}: {syncLastText}
                </div>
                {isSyncPopoverOpen && (
                  <div
                    className="absolute right-0 top-[calc(100%+8px)] z-30 w-56 rounded-xl border bg-white/95 p-2 shadow-xl backdrop-blur"
                    style={{
                      borderColor: activeUiPalette.panelBorder,
                      background: activeUiPalette.panelBackground
                    }}
                  >
                    <p className="px-1 text-[11px]" style={{ color: activeUiPalette.textMuted }}>
                      {uiText.navLastSync}: {syncLastText}
                    </p>
                    <p className="mt-1 px-1 text-[11px]" style={{ color: activeUiPalette.textMuted }}>
                      {uiText.navSyncStatus}: {syncStatusText}
                    </p>
                    <div className="mt-2 grid gap-1.5">
                      <button
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isSyncingCloud || !cloudSyncSession}
                        onClick={() => {
                          void handleManualPullSync().finally(() => {
                            setIsSyncPopoverOpen(false);
                          });
                        }}
                        type="button"
                      >
                        {uiText.navPullNow}
                      </button>
                      <button
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isSyncingCloud || !cloudSyncSession}
                        onClick={() => {
                          void handleManualForcePushSync().finally(() => {
                            setIsSyncPopoverOpen(false);
                          });
                        }}
                        type="button"
                      >
                        {uiText.navPushNow}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <button
                className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
                onClick={() => {
                  void lockVault();
                }}
                type="button"
                title={uiText.navLockNow}
              >
                {isMobileLayout ? '🔒' : uiText.navLockNow}
              </button>

              <div className="relative" ref={profileMenuRef}>
                <button
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white/90 px-2 py-1 text-[11px] text-slate-700 hover:bg-white"
                  onClick={() => {
                    setIsProfileMenuOpen((prev) => {
                      const next = !prev;
                      if (next) {
                        setProfileDraftAutoPathSync(autoSftpPathSyncEnabled);
                        setProfileDraftCloseAction(closeWindowAction);
                      }
                      return next;
                    });
                    setIsSyncPopoverOpen(false);
                  }}
                  type="button"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-[#8fb1df] bg-[#285793] text-[11px] font-semibold text-white">
                    {accountAvatarText}
                  </span>
                  <span className="hidden max-w-[140px] truncate sm:inline">{accountDisplayName}</span>
                </button>

                {isProfileMenuOpen && (
                  <div className="absolute right-0 top-[calc(100%+8px)] z-30 w-[min(92vw,20rem)] rounded-xl border border-slate-200 bg-white/95 p-2.5 shadow-xl backdrop-blur sm:w-80">
                    <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2">
                      <p className="truncate text-xs font-semibold text-slate-800">{accountDisplayName}</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        {uiText.navSyncStatus}: {syncStatusText}
                      </p>
                    </div>
                    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
                      {!isProLicenseActive ? (
                        <button
                          className="w-full rounded-lg border border-[#2f6df4] bg-[#2f6df4] px-3 py-1.5 text-left text-xs font-semibold text-white hover:bg-[#245ad0]"
                          onClick={() => {
                            handleOpenProCheckout();
                          }}
                          type="button"
                        >
                          {uiText.navUpgradePro}
                        </button>
                      ) : (
                        <div className="space-y-2">
                          <p className="text-[11px] font-semibold text-emerald-700">
                            {uiText.navProExpires}: {proExpiryText}
                          </p>
                          <button
                            className="w-full rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-left text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                            onClick={() => {
                              handleOpenProCheckout();
                            }}
                            type="button"
                          >
                            {uiText.navRenewPro}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
                      <p className="text-[11px] font-semibold text-slate-600">{uiText.navQuickPrefs}</p>
                      <label className="mt-2 flex items-center gap-2 text-xs text-slate-700">
                        <input
                          checked={profileDraftAutoPathSync}
                          className="h-3.5 w-3.5"
                          onChange={(event) => {
                            setProfileDraftAutoPathSync(event.target.checked);
                          }}
                          type="checkbox"
                        />
                        {uiText.navAutoPathSync}
                      </label>
                      <label className="mt-2 block text-xs text-slate-700">
                        {uiText.navCloseAction}
                        <select
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 outline-none focus:border-[#90b6ec]"
                          onChange={(event) => {
                            setProfileDraftCloseAction(event.target.value as CloseWindowAction);
                          }}
                          value={profileDraftCloseAction}
                        >
                          <option value="ask">{uiText.navCloseActionAsk}</option>
                          <option value="tray">{uiText.navCloseActionTray}</option>
                          <option value="exit">{uiText.navCloseActionExit}</option>
                        </select>
                      </label>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          className="rounded-lg border border-[#4f78af] bg-[#0a3a78] px-3 py-1 text-xs font-semibold text-white hover:bg-[#0d4b98] disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={!profileDraftDirty}
                          onClick={handleSaveProfileDraft}
                          type="button"
                        >
                          {uiText.navSave}
                        </button>
                        <button
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-100"
                          onClick={handleCancelProfileDraft}
                          type="button"
                        >
                          {uiText.navCancel}
                        </button>
                      </div>
                    </div>

                    <div className="mt-2 space-y-1.5">
                      <p className="px-1 text-[11px] font-semibold text-slate-500">{t('settings.category.profile')}</p>
                      <button
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          if (cloudSyncSession) {
                            openSettingsSection('settings-sync');
                            return;
                          }
                          setIsCloudAuthModalOpen(true);
                          setIsProfileMenuOpen(false);
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN' ? '账号与同步' : locale === 'zh-TW' ? '帳號與同步' : locale === 'ja-JP' ? 'アカウントと同期' : 'Account & Sync'}
                      </button>
                      <button
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          openSettingsSection('settings-devices');
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN'
                          ? '登录设备管理'
                          : locale === 'zh-TW'
                            ? '登入裝置管理'
                            : locale === 'ja-JP'
                              ? 'ログイン端末管理'
                              : 'Device Sessions'}
                      </button>
                    </div>

                    <div className="mt-2 space-y-1.5">
                      <p className="px-1 text-[11px] font-semibold text-slate-500">{t('settings.category.settings')}</p>
                      <button
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          openSettingsSection('settings-font');
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN' ? '字体与外观' : locale === 'zh-TW' ? '字型與外觀' : locale === 'ja-JP' ? 'フォントと外観' : 'Font & Appearance'}
                      </button>
                      <button
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          openSettingsSection('settings-theme');
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN' ? '主题与安全' : locale === 'zh-TW' ? '主題與安全' : locale === 'ja-JP' ? 'テーマとセキュリティ' : 'Theme & Security'}
                      </button>
                    </div>

                    <div className="mt-2 space-y-1.5">
                      <p className="px-1 text-[11px] font-semibold text-slate-500">{t('settings.category.files')}</p>
                      <button
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          openSettingsSection('settings-identity');
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN'
                          ? '身份与 SSH 密钥'
                          : locale === 'zh-TW'
                            ? '身份與 SSH 金鑰'
                            : locale === 'ja-JP'
                              ? 'ID と SSH 鍵'
                              : 'Identity & SSH Keys'}
                      </button>
                    </div>

                    <div className="mt-2 space-y-1.5">
                      <p className="px-1 text-[11px] font-semibold text-slate-500">{t('settings.category.other')}</p>
                      <button
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          openSettingsSection('settings-about');
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN' ? '关于 OrbitTerm' : locale === 'zh-TW' ? '關於 OrbitTerm' : locale === 'ja-JP' ? 'OrbitTerm について' : 'About OrbitTerm'}
                      </button>
                      <button
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-50"
                        onClick={() => {
                          openSettingsCategory('settings');
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN'
                          ? '打开设置中心 (Cmd/Ctrl+,)'
                          : locale === 'zh-TW'
                            ? '開啟設定中心 (Cmd/Ctrl+,)'
                            : locale === 'ja-JP'
                              ? '設定センターを開く (Cmd/Ctrl+,)'
                              : 'Open Settings (Cmd/Ctrl+,)'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          </header>
        )}

        <div
          className={`min-h-0 flex-1 overflow-hidden ${
            isMobileRuntime
              ? isMobileTerminalFocusMode
                ? 'px-1 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-0'
                : 'px-1 pb-[calc(4.8rem+env(safe-area-inset-bottom))] pt-1'
              : 'p-0'
          }`}
        >
          {saveError && (
            <p className="mb-3 rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-sm text-rose-700">
              {saveError}
            </p>
          )}

          {dashboardSection === 'hosts' && (
            <section className="relative flex h-full min-h-0 gap-2 rounded-none p-0" style={{ background: activeUiPalette.softSurface }}>
              <aside
                className={`${
                  isHostFilterDrawerOpen
                    ? 'translate-x-0 opacity-100 pointer-events-auto'
                    : '-translate-x-3 opacity-0 pointer-events-none sm:translate-x-0 sm:opacity-100 sm:pointer-events-auto'
                } absolute left-2 top-2 z-20 h-[calc(100%-1rem)] w-44 shrink-0 rounded-xl p-3 shadow-xl transition sm:static sm:h-auto sm:w-40 sm:opacity-100`}
                style={{
                  background: activeUiPalette.panelBackground,
                  border: `1px solid ${activeUiPalette.panelBorder}`
                }}
              >
                <p
                  className="text-xs font-semibold uppercase tracking-[0.16em]"
                  style={{ color: activeUiPalette.textMuted }}
                >
                  {uiText.hostFilterTitle}
                </p>
                <div className="mt-3 space-y-1.5">
                  <button
                    className="flex w-full items-center justify-between rounded-lg border px-2 py-1.5 text-xs transition"
                    onClick={() => {
                      setActiveTagFilter('all');
                      setHighlightedSearchIndex(0);
                    }}
                    style={
                      activeTagFilter === 'all'
                        ? {
                            borderColor: activeUiPalette.accent,
                            background: activeUiPalette.accentSoft,
                            color: activeUiPalette.textPrimary
                          }
                        : {
                            borderColor: activeUiPalette.panelBorder,
                            background: activeUiPalette.panelBackground,
                            color: activeUiPalette.textPrimary
                          }
                    }
                    type="button"
                  >
                    <span>🧭 {uiText.hostFilterAll}</span>
                    <span>{hosts.length}</span>
                  </button>
                  {tagStats.map((item) => (
                    <button
                      className="flex w-full items-center justify-between rounded-lg border px-2 py-1.5 text-xs transition"
                      key={item.tag}
                      onClick={() => {
                        setActiveTagFilter(item.tag);
                        setHighlightedSearchIndex(0);
                      }}
                      style={
                        activeTagFilter === item.tag
                          ? {
                              borderColor: activeUiPalette.accent,
                              background: activeUiPalette.accentSoft,
                              color: activeUiPalette.textPrimary
                            }
                          : {
                              borderColor: activeUiPalette.panelBorder,
                              background: activeUiPalette.panelBackground,
                              color: activeUiPalette.textPrimary
                            }
                      }
                      type="button"
                    >
                      <span className="truncate">
                        {resolveTagMicroIcon(item.tag)} {item.tag}
                      </span>
                      <span>{item.count}</span>
                    </button>
                  ))}
                </div>
              </aside>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold" style={{ color: activeUiPalette.textPrimary }}>
                    {uiText.hostTitle}
                  </h2>
                  <div className="flex items-center gap-2">
                    <button
                      className={`${toolbarButtonClass} sm:hidden`}
                      onClick={() => {
                        setIsHostFilterDrawerOpen((prev) => !prev);
                      }}
                      type="button"
                    >
                      {uiText.hostFilterTitle}
                    </button>
                    <button
                      className={toolbarButtonClass}
                      disabled={isLicensedHostLimitReached}
                      onClick={handleOpenHostWizard}
                      type="button"
                      title={
                        isLicensedHostLimitReached && licensedHostLimit > 0
                          ? `当前授权最多支持 ${licensedHostLimit} 台主机`
                          : undefined
                      }
                    >
                      {uiText.hostAdd}
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[240px] flex-1">
                    <span
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs"
                      style={{ color: activeUiPalette.textMuted }}
                    >
                      🔍
                    </span>
                    <input
                      className="w-full rounded-xl border py-2 pl-8 pr-24 text-sm outline-none transition"
                      onChange={(event) => {
                        setHostSearchQuery(event.target.value);
                        setHighlightedSearchIndex(0);
                      }}
                      onKeyDown={handleHostSearchKeyDown}
                      placeholder={uiText.hostSearchPlaceholder}
                      ref={hostSearchInputRef}
                      style={{
                        borderColor: activeUiPalette.panelBorder,
                        background: activeUiPalette.panelBackground,
                        color: activeUiPalette.textPrimary
                      }}
                      value={hostSearchQuery}
                    />
                    <span
                      className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-md border px-1.5 py-0.5 text-[10px]"
                      style={{
                        borderColor: activeUiPalette.panelBorder,
                        color: activeUiPalette.textMuted
                      }}
                    >
                      Ctrl+F
                    </span>
                  </div>
                  <span
                    className="rounded-lg border px-2.5 py-1 text-xs"
                    style={{
                      borderColor: activeUiPalette.panelBorder,
                      background: activeUiPalette.panelBackground,
                      color: activeUiPalette.textMuted
                    }}
                  >
                    {locale === 'zh-CN'
                      ? '结果'
                      : locale === 'zh-TW'
                        ? '結果'
                        : locale === 'ja-JP'
                          ? '結果'
                          : 'Results'}{' '}
                    {filteredHosts.length} / {hosts.length}
                  </span>
                  {licensedHostLimit > 0 && (
                    <span
                      className={`rounded-lg border px-2.5 py-1 text-xs ${
                        isLicensedHostLimitReached
                          ? 'border-amber-300 bg-amber-50 text-amber-700'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      }`}
                    >
                      {locale === 'en-US'
                        ? `Host limit ${hosts.length}/${licensedHostLimit}`
                        : locale === 'ja-JP'
                          ? `ホスト上限 ${hosts.length}/${licensedHostLimit}`
                          : locale === 'zh-TW'
                            ? `主機上限 ${hosts.length}/${licensedHostLimit}`
                            : `主机上限 ${hosts.length}/${licensedHostLimit}`}
                    </span>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    className={toolbarButtonClass}
                    disabled={filteredHostIds.length === 0 || isBatchDeploying}
                    onClick={handleSelectAllFilteredHosts}
                    type="button"
                  >
                    {uiText.hostSelectAll}
                  </button>
                  <button
                    className={toolbarButtonClass}
                    disabled={selectedHostIds.size === 0 || isBatchDeploying}
                    onClick={handleClearHostSelection}
                    type="button"
                  >
                    {uiText.hostClearSelection}
                  </button>
                  <button
                    className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={selectedHostIds.size === 0 || isBatchDeploying}
                    onClick={() => {
                      void handleBatchDeployPublicKeys();
                    }}
                    type="button"
                  >
                    {isBatchDeploying ? uiText.hostBatchDeploying : uiText.hostBatchDeployKey}
                  </button>
                  <span
                    className="rounded-lg border px-2.5 py-1 text-xs"
                    style={{
                      borderColor: activeUiPalette.panelBorder,
                      background: activeUiPalette.panelBackground,
                      color: activeUiPalette.textMuted
                    }}
                  >
                    {uiText.hostSelectedCount} {selectedHostCount}
                  </span>
                </div>

                <div className="mt-3 min-h-0 h-[calc(100%-132px)] space-y-3 overflow-auto pr-1">
                  {hosts.length === 0 && (
                    <p
                      className="rounded-xl border border-dashed px-4 py-3 text-sm"
                      style={{
                        borderColor: activeUiPalette.panelBorder,
                        background: activeUiPalette.panelBackground,
                        color: activeUiPalette.textMuted
                      }}
                    >
                      {uiText.hostNoItems}
                    </p>
                  )}

                  {hosts.length > 0 && filteredHosts.length === 0 && (
                    <p
                      className="rounded-xl border border-dashed px-4 py-3 text-sm"
                      style={{
                        borderColor: activeUiPalette.panelBorder,
                        background: activeUiPalette.panelBackground,
                        color: activeUiPalette.textMuted
                      }}
                    >
                      {uiText.hostNoResults}
                    </p>
                  )}

                  {filteredHosts.map((host, index) => {
                    const hostId = buildHostKey(host);
                    const identity = identities.find((item) => item.id === host.identityId);
                    const isHighlighted = index === highlightedSearchIndex;
                    const isSelected = selectedHostIds.has(hostId);
                    return (
                      <article
                        className="rounded-xl border px-4 py-3"
                        key={`${host.basicInfo.address}-${host.identityId}-${index}`}
                        onMouseEnter={() => setHighlightedSearchIndex(index)}
                        style={
                          isHighlighted || isSelected
                            ? {
                                borderColor: activeUiPalette.accent,
                                background: activeUiPalette.panelBackground,
                                boxShadow: `0 0 0 2px ${activeUiPalette.accentSoft}`
                              }
                            : {
                                borderColor: activeUiPalette.panelBorder,
                                background: activeUiPalette.panelBackground
                              }
                        }
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-[220px] flex-1">
                            <label
                              className="mb-1 inline-flex cursor-pointer items-center gap-2 text-[11px]"
                              style={{ color: activeUiPalette.textMuted }}
                            >
                              <input
                                checked={isSelected}
                                onChange={() => {
                                  toggleHostSelection(hostId);
                                }}
                                type="checkbox"
                              />
                              {uiText.hostSelectedCount}
                            </label>
                            <p className="text-sm font-semibold" style={{ color: activeUiPalette.textPrimary }}>
                              {host.basicInfo.name || `${host.basicInfo.address}:${host.basicInfo.port}`}
                            </p>
                            <p className="mt-1 text-xs" style={{ color: activeUiPalette.textMuted }}>
                              {(identity?.username ?? 'unknown')}@{host.basicInfo.address}:{host.basicInfo.port}
                            </p>
                            <p className="mt-1 text-[11px]" style={{ color: activeUiPalette.textMuted }}>
                              {uiText.hostIdentity}: {identity?.name ?? uiText.hostIdentityMissing}
                            </p>
                            {host.basicInfo.description.trim() && (
                              <p className="mt-1 text-[11px]" style={{ color: activeUiPalette.textMuted }}>
                                {uiText.hostRemark}: {host.basicInfo.description}
                              </p>
                            )}
                            {host.advancedOptions.tags.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {host.advancedOptions.tags.map((tag) => (
                                  <button
                                    className="rounded-md border px-2 py-0.5 text-[11px]"
                                    key={`${hostId}-${tag}`}
                                    onClick={() => {
                                      setActiveTagFilter(tag);
                                      setHighlightedSearchIndex(0);
                                    }}
                                    style={{
                                      borderColor: activeUiPalette.accent,
                                      background: activeUiPalette.accentSoft,
                                      color: activeUiPalette.textPrimary
                                    }}
                                    type="button"
                                  >
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              className="rounded-lg border border-slate-300 bg-white/85 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={deployingHostId === hostId || isBatchDeploying}
                              onClick={() => {
                                void handleDeployPublicKeyFromHostList(hostId);
                              }}
                              type="button"
                            >
                              {deployingHostId === hostId ? uiText.hostDeployingKey : `🔐 ${uiText.hostDeployKey}`}
                            </button>
                            <button
                              className="rounded-lg border border-slate-300 bg-white/85 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              onClick={() => {
                                setEditingHostId(hostId);
                              }}
                              type="button"
                            >
                              ✏️ {uiText.hostEdit}
                            </button>
                            <button
                              className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
                              onClick={() => {
                                void handleDeleteHost(
                                  hostId,
                                  host.basicInfo.name || `${host.basicInfo.address}:${host.basicInfo.port}`
                                );
                              }}
                              type="button"
                            >
                              {uiText.hostDelete}
                            </button>
                            <button
                              className="rounded-lg border border-[#4f78af] bg-[#0a3a78] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#0d4b98] disabled:cursor-not-allowed disabled:opacity-60"
                              disabled={isConnectingTerminal}
                              onClick={() => {
                                void handleConnectFromHostList(hostId);
                              }}
                              type="button"
                            >
                              {isConnectingTerminal && connectingHostId === hostId
                                ? uiText.hostConnecting
                                : uiText.hostConnect}
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
              {isHostFilterDrawerOpen && (
                <button
                  aria-label="close-host-filter-drawer"
                  className="absolute inset-0 z-10 bg-black/10 sm:hidden"
                  onClick={() => {
                    setIsHostFilterDrawerOpen(false);
                  }}
                  type="button"
                />
              )}
            </section>
          )}

          <section
            className={`relative h-full min-h-0 overflow-hidden rounded-xl bg-[#05080f]/92 p-0 ${
              dashboardSection === 'terminal' ? 'flex flex-col' : 'hidden'
            }`}
            ref={terminalSplitRef}
            style={terminalAreaStyle}
          >
            <div
              className={`shrink-0 rounded-lg border ${isMobileRuntime ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
              style={{
                borderColor: toRgba(activeThemePreset.terminalBorder, 0.74),
                background: toRgba(activeThemePreset.terminalSurfaceHex, 0.84)
              }}
            >
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <h2 className="text-[11px] font-semibold text-[#d7e5ff]">{uiText.terminalTitle}</h2>
                  {!isMobileRuntime ? (
                    <>
                      <button
                        className={darkPanelButtonClass}
                        onClick={() => {
                          setIsNewTabModalOpen(true);
                        }}
                        type="button"
                      >
                        {uiText.terminalNewWindow}
                      </button>
                      <button
                        className={darkPanelButtonClass}
                        onClick={() => {
                          setIsInspectorOpen(true);
                        }}
                        type="button"
                      >
                        {uiText.terminalLogs}
                      </button>
                      {activeTerminalSessionId && (
                        <button
                          className={darkPanelButtonClass}
                          onClick={() => {
                            void handleOpenHostInfo();
                          }}
                          type="button"
                        >
                          主机信息
                        </button>
                      )}
                      {activeTerminalSessionId && (
                        <button
                          className={`${darkPanelButtonClass} ${
                            autoSftpPathSyncEnabled ? 'border-[#5cc89a] bg-[#123826] text-[#c9f4de] hover:bg-[#174932]' : ''
                          }`}
                          onClick={() => {
                            setAutoSftpPathSyncEnabled(!autoSftpPathSyncEnabled);
                          }}
                          title="开启后，终端执行 cd/pushd/popd 时会自动同步 SFTP 目录"
                          type="button"
                        >
                          {uiText.terminalPathSync}:
                          {autoSftpPathSyncEnabled ? ` ${uiText.terminalPathSyncOn}` : ` ${uiText.terminalPathSyncOff}`}
                        </button>
                      )}
                      {activeTerminalSessionId && (
                        <button
                          className={`${darkPanelButtonClass} disabled:cursor-not-allowed disabled:opacity-55`}
                          disabled={isSyncingPath}
                          onClick={() => {
                            void handleSyncPathToSftp();
                          }}
                          type="button"
                        >
                          {isSyncingPath ? uiText.terminalSyncing : uiText.terminalSyncNow}
                        </button>
                      )}
                      {activeSessionId && (
                        <button
                          className={`${darkPanelButtonClass} ${
                            activeWorkspace?.syncInput
                              ? 'border-[#5cc89a] bg-[#123826] text-[#c9f4de] hover:bg-[#174932]'
                              : ''
                          }`}
                          onClick={handleToggleSyncInput}
                          title="开启后，当前标签下所有分屏将同步输入"
                          type="button"
                        >
                          {uiText.terminalInputSync}:
                          {activeWorkspace?.syncInput
                            ? ` ${uiText.terminalPathSyncOn}`
                            : ` ${uiText.terminalPathSyncOff}`}
                        </button>
                      )}
                      {activeSessionId && (
                        <button
                          className={darkPanelButtonClass}
                          onClick={() => {
                            void handleToggleWindowMaximize();
                          }}
                          type="button"
                        >
                          {isWindowMaximized ? uiText.terminalRestore : uiText.terminalMaximize}
                        </button>
                      )}
                      {activeSessionId && (
                        <button
                          className={darkPanelButtonClass}
                          onClick={() => {
                            void closeTerminal();
                          }}
                          type="button"
                        >
                          {uiText.terminalCloseCurrent}
                        </button>
                      )}
                      {activeSessions.length > 1 && (
                        <button
                          className="rounded-lg border border-amber-500 bg-amber-200/90 px-2 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                          onClick={() => {
                            setIsSftpCollapsed((prev) => !prev);
                          }}
                          type="button"
                        >
                          {isSftpCollapsed ? uiText.terminalExpandSftp : uiText.terminalCollapseSftp}
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-1">
                      <button
                        className={mobileTopActionButtonClass}
                        onClick={handleReturnToMobileApp}
                        type="button"
                      >
                        返回应用
                      </button>
                      {!isMobileLandscape && (
                        <>
                          <button
                            className={mobileTopActionButtonClass}
                            onClick={() => {
                              setIsMobileTerminalToolsExpanded((prev) => !prev);
                            }}
                            type="button"
                          >
                            {isMobileTerminalToolsExpanded ? '隐藏工具' : '展开工具'}
                          </button>
                          <button
                            className={mobileTopActionButtonClass}
                            onClick={() => {
                              setIsMobileMetricsExpanded((prev) => !prev);
                              if (isMetricDetailOpen) {
                                setIsMetricDetailOpen(false);
                              }
                            }}
                            type="button"
                          >
                            {isMobileMetricsExpanded ? '隐藏监控' : '展开监控'}
                          </button>
                          <button
                            className={mobileTopActionButtonClass}
                            onClick={() => {
                              setSnippetsPanelCollapsed(!snippetsPanelCollapsed);
                            }}
                            type="button"
                          >
                            {snippetsPanelCollapsed ? uiText.terminalSnippetOpen : uiText.terminalSnippetClose}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {isMobileRuntime && isMobileTerminalToolsExpanded && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md border border-[#385780] bg-[#0a1322]/80 p-1.5">
                  <button
                    className={compactDarkPanelButtonClass}
                    onClick={() => {
                      setIsNewTabModalOpen(true);
                    }}
                    type="button"
                  >
                    {uiText.terminalNewWindow}
                  </button>
                  <button
                    className={compactDarkPanelButtonClass}
                    onClick={() => {
                      setIsInspectorOpen(true);
                    }}
                    type="button"
                  >
                    {uiText.terminalLogs}
                  </button>
                  {activeTerminalSessionId && (
                    <button
                      className={compactDarkPanelButtonClass}
                      onClick={() => {
                        void handleOpenHostInfo();
                      }}
                      type="button"
                    >
                      主机信息
                    </button>
                  )}
                  {activeTerminalSessionId && (
                    <button
                      className={`${compactDarkPanelButtonClass} ${
                        autoSftpPathSyncEnabled ? 'border-[#5cc89a] bg-[#123826] text-[#c9f4de] hover:bg-[#174932]' : ''
                      }`}
                      onClick={() => {
                        setAutoSftpPathSyncEnabled(!autoSftpPathSyncEnabled);
                      }}
                      type="button"
                    >
                      {uiText.terminalPathSync}:
                      {autoSftpPathSyncEnabled ? ` ${uiText.terminalPathSyncOn}` : ` ${uiText.terminalPathSyncOff}`}
                    </button>
                  )}
                  {activeTerminalSessionId && (
                    <button
                      className={`${compactDarkPanelButtonClass} disabled:cursor-not-allowed disabled:opacity-55`}
                      disabled={isSyncingPath}
                      onClick={() => {
                        void handleSyncPathToSftp();
                      }}
                      type="button"
                    >
                      {isSyncingPath ? uiText.terminalSyncing : uiText.terminalSyncNow}
                    </button>
                  )}
                  {activeSessionId && (
                    <button
                      className={`${compactDarkPanelButtonClass} ${
                        activeWorkspace?.syncInput
                          ? 'border-[#5cc89a] bg-[#123826] text-[#c9f4de] hover:bg-[#174932]'
                          : ''
                      }`}
                      onClick={handleToggleSyncInput}
                      type="button"
                    >
                      {uiText.terminalInputSync}:
                      {activeWorkspace?.syncInput ? ` ${uiText.terminalPathSyncOn}` : ` ${uiText.terminalPathSyncOff}`}
                    </button>
                  )}
                  {activeSessionId && (
                    <button
                      className={compactDarkPanelButtonClass}
                      onClick={() => {
                        void closeTerminal();
                      }}
                      type="button"
                    >
                      {uiText.terminalCloseCurrent}
                    </button>
                  )}
                  {activeSessionId && (
                    <button
                      className={compactDarkPanelButtonClass}
                      onClick={() => {
                        void handleCopyTerminalOutput('visible');
                      }}
                      type="button"
                    >
                      复制可见
                    </button>
                  )}
                  {activeSessionId && (
                    <button
                      className={compactDarkPanelButtonClass}
                      onClick={() => {
                        void handleCopyTerminalOutput('all');
                      }}
                      type="button"
                    >
                      复制全部
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-1 rounded-md border border-[#3f5c86] bg-[#0a1322]/80 p-1">
                    <span className="text-[10px] text-[#b8c9e6]">Aa {terminalFontSize}px</span>
                    <button
                      className={compactDarkPanelButtonClass}
                      onClick={() => {
                        setTerminalFontSize(Math.max(9, terminalFontSize - 1));
                      }}
                      type="button"
                    >
                      A-
                    </button>
                    <button
                      className={compactDarkPanelButtonClass}
                      onClick={() => {
                        setTerminalFontSize(Math.min(20, terminalFontSize + 1));
                      }}
                      type="button"
                    >
                      A+
                    </button>
                  </div>
                </div>
              )}
              {isMobileRuntime && !isMobileTerminalToolsExpanded && (
                <p className="mt-1 text-[10px] text-[#9bb2d5]">
                  移动端默认聚焦终端与预输入体验，扩展功能可按需展开。
                </p>
              )}
              {(!isMobileRuntime || isMobileMetricsExpanded) && (
                <div className="mt-1 overflow-x-auto">
                  <div className="grid min-w-[620px] grid-cols-5 gap-1 md:min-w-[800px]">
                    {metricCards.map((metric) => (
                      <button
                        className="rounded-md text-left ring-1 ring-transparent transition hover:ring-[#6ea8ff]/55 focus:outline-none focus:ring-[#6ea8ff]"
                        key={metric.key}
                        onClick={() => {
                          setMetricDetailKey(metric.key);
                          setIsMetricDetailOpen(true);
                        }}
                        title={
                          locale === 'zh-CN'
                            ? `查看 ${metric.title} 详细趋势`
                            : locale === 'zh-TW'
                              ? `查看 ${metric.title} 詳細趨勢`
                              : locale === 'ja-JP'
                                ? `${metric.title} の詳細トレンドを表示`
                                : `View ${metric.title} trend details`
                        }
                        type="button"
                      >
                        <MetricTrendChart
                          fillColor={metric.fillColor}
                          fixedMax={metric.fixedMax}
                          lineColor={metric.lineColor}
                          points={metric.points}
                          title={metric.title}
                          valueText={metric.valueText}
                        />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {(!isMobileRuntime || isMobileMetricsExpanded) && isMetricDetailOpen && activeMetricCard && (
                <div
                  className="mt-1 rounded-lg border px-2 py-1.5"
                  style={{
                    borderColor: toRgba(activeThemePreset.terminalBorder, 0.72),
                    background: toRgba(activeThemePreset.terminalSurfaceHex, 0.72)
                  }}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold text-[#dbe9ff]">
                        {locale === 'zh-CN'
                          ? `${activeMetricCard.title} 详细视图`
                          : locale === 'zh-TW'
                            ? `${activeMetricCard.title} 詳細視圖`
                            : locale === 'ja-JP'
                              ? `${activeMetricCard.title} 詳細ビュー`
                              : `${activeMetricCard.title} Detail`}
                      </p>
                      <p className="text-[11px] text-[#8fa5c7]">
                        {locale === 'zh-CN'
                          ? '支持 1 分钟 / 5 分钟 / 10 分钟趋势，时间刻度 5 秒。'
                          : locale === 'zh-TW'
                            ? '支援 1 分鐘 / 5 分鐘 / 10 分鐘趨勢，時間刻度 5 秒。'
                            : locale === 'ja-JP'
                              ? '1分 / 5分 / 10分の推移。時間目盛りは5秒。'
                              : 'Trend windows: 1m / 5m / 10m, with 5-second ticks.'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {metricDetailWindowOptions.map((item) => (
                        <button
                          className={`rounded border px-2 py-1 text-[11px] ${
                            metricDetailWindowSeconds === item.seconds
                              ? 'border-[#7bb1ff] bg-[#1d3f6d] text-[#e8f2ff]'
                              : 'border-[#4f6f9d] bg-[#0f1726] text-[#b9cae4] hover:bg-[#13203a]'
                          }`}
                          key={item.seconds}
                          onClick={() => {
                            setMetricDetailWindowSeconds(item.seconds);
                          }}
                          type="button"
                        >
                          {item.label}
                        </button>
                      ))}
                      <button
                        className="rounded border border-[#4f6f9d] bg-[#0f1726] px-2 py-1 text-[11px] text-[#d7e5ff] hover:bg-[#13203a]"
                        onClick={() => {
                          setIsMetricDetailOpen(false);
                        }}
                        type="button"
                      >
                        {locale === 'zh-CN' ? '收起' : locale === 'zh-TW' ? '收起' : locale === 'ja-JP' ? '閉じる' : 'Close'}
                      </button>
                    </div>
                  </div>
                  <MetricTrendChart
                    chartHeight={120}
                    className="mt-1 min-w-0 bg-[#081321]/90 px-2 py-1.5 ring-[#38507b]"
                    fillColor={activeMetricCard.fillColor}
                    fixedMax={activeMetricCard.fixedMax}
                    lineColor={activeMetricCard.lineColor}
                    points={activeMetricCard.points}
                    tickSeconds={5}
                    title={activeMetricCard.title}
                    titleClassName="text-[11px]"
                    valueClassName="text-[11px]"
                    valueText={activeMetricCard.valueText}
                    windowSeconds={metricDetailWindowSeconds}
                  />
                </div>
              )}
            </div>

            <div className={`min-h-0 flex flex-1 gap-2.5 ${isMobileRuntime ? 'flex-col' : ''}`}>
              <div
                className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl p-1.5"
                style={{
                  background: toRgba(activeThemePreset.terminalSurfaceHex, 0.72),
                  boxShadow: `inset 0 0 0 1px ${toRgba(activeThemePreset.terminalBorder, 0.18)}`
                }}
              >
                <SnippetsPanel
                  hasActiveSession={Boolean(activeTerminalSessionId)}
                  isMobileView={isMobileRuntime}
                  onCreateSnippet={addSnippet}
                  onDeleteSnippet={deleteSnippet}
                  onQuickKeyPress={handleSendVirtualKey}
                  onRunSnippet={runSnippetInTerminal}
                  onUpdateSnippet={updateSnippet}
                  quickKeys={isMobileRuntime ? mobileVirtualKeys : []}
                  snippets={snippets}
                />

                {terminalError && (
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <p className="text-xs text-rose-400">{terminalError}</p>
                    <button
                      className="rounded border border-rose-300 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-500/20"
                      onClick={() => {
                        setIsInspectorOpen(true);
                      }}
                      type="button"
                    >
                      {t('inspector.askAi')}
                    </button>
                  </div>
                )}
                {reconnectMessage && <p className="mb-1 text-xs text-amber-300">{reconnectMessage}</p>}

                <div className={`${isMobileRuntime ? 'mb-0.5 flex flex-wrap gap-1' : 'mb-1 flex flex-wrap gap-1.5'}`}>
                  {activeSessions.length === 0 ? (
                    <p className="text-xs text-[#8ca2c5]">{uiText.terminalNoSession}</p>
                  ) : (
                    activeSessions.map((session) => (
                      <div
                        className={`flex items-center gap-1 rounded-md border ${
                          isMobileRuntime ? 'h-[18px] px-2 py-0 text-[11px] leading-[1]' : 'h-[20px] px-1 py-0 text-[9px] leading-[1]'
                        } ${
                          activeSessionId === session.id
                            ? 'border-[#4f6f9d] bg-[#11203a] text-[#d7e5ff]'
                            : 'border-[#2a3f61] bg-[#0a1220] text-[#8fa5c7]'
                        }`}
                        key={session.id}
                      >
                        <button
                          className={`ot-compact-hit ${isMobileRuntime ? 'max-w-[150px]' : 'max-w-[180px]'} truncate px-1 text-left`}
                          onClick={() => {
                            setActiveSession(session.id);
                          }}
                          title={session.title}
                          type="button"
                        >
                          {session.title}
                        </button>
                        <button
                          className="ot-compact-hit rounded px-1 hover:bg-[#1b2d4a]"
                          onClick={() => {
                            void closeSession(session.id);
                          }}
                          title="关闭标签"
                          type="button"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className={`min-h-0 flex-1 ${isMobileRuntime && isMobileLandscape ? 'flex gap-1.5' : 'flex flex-col'}`}>
                  <div
                    className={`min-h-0 overflow-hidden ${
                      isMobileRuntime && isMobileLandscape
                        ? 'w-1/2 shrink-0'
                        : `flex-1 ${isMobileRuntime ? 'min-h-[46vh]' : ''}`
                    }`}
                    onTouchEnd={handleTerminalTouchEnd}
                    onTouchMove={handleTerminalTouchMove}
                    onTouchStart={handleTerminalTouchStart}
                  >
                    {activeSessions.length > 0 ? (
                      <div className="h-full min-h-0">
                        {activeSessions.map((session) => {
                          const workspace = splitWorkspaces[session.id] ?? createDefaultWorkspace(session);
                          const isTabActive = activeSessionId === session.id;
                          const mobileFocusedPane =
                            findPaneById(workspace.root, workspace.activePaneId) ??
                            collectWorkspacePanes(workspace.root)[0] ??
                            null;
                          const displayLayout =
                            isMobileRuntime && mobileFocusedPane
                              ? ({
                                  type: 'pane',
                                  pane: mobileFocusedPane
                                } as TerminalLayoutNode)
                              : workspace.root;
                          return (
                            <div
                              className={`${isTabActive ? 'block' : 'hidden'} h-full min-h-0`}
                              key={session.id}
                            >
                              <div
                                className="h-full min-h-0 overflow-hidden rounded-lg"
                                style={{
                                  background: toRgba(activeThemePreset.terminalSurfaceHex, 0.6)
                                }}
                              >
                                <OrbitTerminal
                                  activePaneId={workspace.activePaneId}
                                  blurPx={terminalBlur}
                                  borderColor={activeThemePreset.terminalBorder}
                                  chromePalette={activeTerminalChromePalette}
                                  disableInteractiveInput={isMobileRuntime}
                                  hidePaneHeader={isMobileRuntime}
                                  fontFamily={terminalFontFamily}
                                  fontSize={terminalFontSize}
                                  isTabActive={isTabActive}
                                  layout={displayLayout}
                                  lineHeight={terminalLineHeight}
                                  allowPaneContextActions={!isMobileRuntime}
                                  onActivePaneChange={(paneId) => {
                                    setActiveSession(session.id);
                                    setActivePane(session.id, paneId);
                                  }}
                                  onPaneContextMenu={(event, paneId) => {
                                    handlePaneContextMenu(event, session.id, paneId);
                                  }}
                                  onPaneInput={(paneSessionId, data) => {
                                    handlePaneInput(session.id, paneSessionId, data);
                                  }}
                                onPaneSessionClosed={(paneId, paneSessionId) => {
                                  handlePaneSessionClosed(session.id, paneId, paneSessionId);
                                }}
                                onCopyActiveOutputReady={(copyFn) => {
                                  if (isTabActive) {
                                    copyActiveTerminalOutputRef.current = copyFn;
                                  } else if (!copyFn && copyActiveTerminalOutputRef.current) {
                                    copyActiveTerminalOutputRef.current = null;
                                  }
                                }}
                                onTerminalError={(message) => {
                                  setTerminalError(message);
                                }}
                                  surfaceHex={activeThemePreset.terminalSurfaceHex}
                                  surfaceOpacity={terminalOpacity}
                                  theme={activeThemePreset.terminalTheme}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="flex h-full items-center justify-center rounded-2xl border border-dashed border-[#2b4264] bg-[#060b13] text-sm text-[#7f94b4]">
                        {uiText.terminalNoSessionPlaceholder}
                      </div>
                    )}
                  </div>

                  <div
                    className={`rounded-lg border-t px-2 pt-2 ${
                      isMobileRuntime && !isMobileLandscape
                        ? 'mt-1 sticky bottom-0 z-30 shrink-0 pb-[calc(0.5rem+env(safe-area-inset-bottom))]'
                        : 'min-h-0 flex-1 pb-2'
                    }`}
                    style={{
                      borderColor: toRgba(activeThemePreset.terminalBorder, 0.38),
                      background: toRgba(activeThemePreset.terminalSurfaceHex, 0.76)
                    }}
                  >
                    <div className={`flex ${isMobileRuntime && isMobileLandscape ? 'h-full flex-col' : 'items-end'} gap-2`}>
                      <div className="min-w-0 flex-1">
                        <label
                          className="mb-1 block text-[11px]"
                          htmlFor="terminal-pre-input"
                          style={{ color: toRgba(activeThemePreset.terminalBorder, 0.95) }}
                        >
                          {isMobileRuntime
                            ? `${uiText.terminalPreInputLabel}（Enter 发送，Shift+Enter 换行）`
                            : uiText.terminalPreInputLabel}
                        </label>
                        <textarea
                          className={`w-full resize-none rounded-md border px-3 py-1.5 outline-none placeholder:text-slate-400 ${
                            isMobileRuntime ? 'text-sm leading-6' : 'text-xs'
                          }`}
                          disabled={!activeTerminalSessionId}
                          id="terminal-pre-input"
                          readOnly={!allowPreInputKeyboard}
                          ref={terminalPreInputRef}
                          onChange={(event) => {
                            setTerminalDraftCommand(event.target.value);
                            setTerminalDraftHistoryCursor(-1);
                            setIsDraftHistoryOpen(false);
                          }}
                          onClick={(event) => {
                            if (isMobileRuntime && !allowPreInputKeyboard) {
                              event.preventDefault();
                              toast.message('请先点击“键盘输入”按钮，再点击输入栏调出系统键盘。');
                            }
                          }}
                          onPointerDown={(event) => {
                            if (isMobileRuntime && !allowPreInputKeyboard) {
                              event.preventDefault();
                              event.stopPropagation();
                            }
                          }}
                          onTouchStart={(event) => {
                            if (isMobileRuntime && !allowPreInputKeyboard) {
                              event.preventDefault();
                              event.stopPropagation();
                            }
                          }}
                          onFocus={() => {
                            if (isMobileRuntime && !allowPreInputKeyboard) {
                              terminalPreInputRef.current?.blur();
                              return;
                            }
                            if (!isMobileRuntime) {
                              return;
                            }
                            window.setTimeout(() => {
                              terminalPreInputRef.current?.scrollIntoView({
                                behavior: 'smooth',
                                block: 'nearest',
                                inline: 'nearest'
                              });
                            }, 80);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'ArrowUp') {
                              if (terminalDraftHistory.length === 0) {
                                return;
                              }
                              event.preventDefault();
                              const nextCursor =
                                terminalDraftHistoryCursor < 0
                                  ? terminalDraftHistory.length - 1
                                  : Math.max(0, terminalDraftHistoryCursor - 1);
                              if (terminalDraftHistoryCursor < 0) {
                                setTerminalDraftSnapshot(terminalDraftCommand);
                              }
                              setTerminalDraftHistoryCursor(nextCursor);
                              const nextCommand = terminalDraftHistory[nextCursor] ?? '';
                              setTerminalDraftCommand(nextCommand);
                              return;
                            }
                            if (event.key === 'ArrowDown') {
                              if (terminalDraftHistory.length === 0 || terminalDraftHistoryCursor < 0) {
                                return;
                              }
                              event.preventDefault();
                              if (terminalDraftHistoryCursor >= terminalDraftHistory.length - 1) {
                                setTerminalDraftHistoryCursor(-1);
                                setTerminalDraftCommand(terminalDraftSnapshot);
                                return;
                              }
                              const nextCursor = Math.min(
                                terminalDraftHistory.length - 1,
                                terminalDraftHistoryCursor + 1
                              );
                              setTerminalDraftHistoryCursor(nextCursor);
                              setTerminalDraftCommand(terminalDraftHistory[nextCursor] ?? '');
                              return;
                            }
                            if (event.key === 'Enter' && !event.shiftKey) {
                              event.preventDefault();
                              void executeDraftCommand();
                            }
                          }}
                          placeholder={
                            activeTerminalSessionId
                              ? uiText.terminalPreInputPlaceholder
                              : uiText.terminalPreInputDisabled
                          }
                          style={{
                            borderColor: toRgba(activeThemePreset.terminalBorder, 0.68),
                            background: toRgba(activeThemePreset.terminalSurfaceHex, 0.68),
                            color: activeThemePreset.terminalTheme.foreground ?? '#dce9ff'
                          }}
                          value={terminalDraftCommand}
                          rows={isMobileRuntime ? (isMobileLandscape ? 8 : 4) : 1}
                        />
                        {isMobileRuntime && (
                          <p className="mt-1 text-[11px] text-[#a8bcde]">
                            {terminalDraftCommand.trim()
                              ? `已输入 ${terminalDraftCommand.length} 个字符`
                              : '在此输入命令，发送后会逐行执行。'}
                          </p>
                        )}
                        {isDraftHistoryOpen && draftHistoryPreview.length > 0 && (
                          <div
                            className="mt-1.5 max-h-44 overflow-auto rounded-md border p-1 text-[11px]"
                            style={{
                              borderColor: toRgba(activeThemePreset.terminalBorder, 0.52),
                              background: toRgba(activeThemePreset.terminalSurfaceHex, 0.86)
                            }}
                          >
                            {draftHistoryPreview.map((item, index) => (
                              <button
                                className="block w-full truncate rounded px-2 py-1 text-left hover:bg-white/10"
                                key={`${item}-${index}`}
                                onClick={() => {
                                  setTerminalDraftCommand(item);
                                  setTerminalDraftHistoryCursor(-1);
                                  setIsDraftHistoryOpen(false);
                                }}
                                style={{ color: activeThemePreset.terminalTheme.foreground ?? '#dce9ff' }}
                                type="button"
                              >
                                {item}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className={`flex shrink-0 ${isMobileRuntime && isMobileLandscape ? 'flex-wrap' : 'flex-col'} gap-1`}>
                        {isMobileRuntime && (
                          <div className="flex items-center gap-1">
                            <button
                              className={terminalDraftActionButtonClass}
                              onClick={() => {
                                void handleCopyTerminalOutput('visible');
                              }}
                              type="button"
                            >
                              复制可见
                            </button>
                            <button
                              className={terminalDraftActionButtonClass}
                              onClick={() => {
                                void handleCopyTerminalOutput('all');
                              }}
                              type="button"
                            >
                              复制全部
                            </button>
                          </div>
                        )}
                        <button
                          className={isMobileRuntime ? terminalDraftActionButtonClass : darkPanelButtonClass}
                          onClick={() => {
                            setIsDraftHistoryOpen((prev) => !prev);
                          }}
                          type="button"
                        >
                          历史命令
                        </button>
                        <button
                          className={`${
                            isMobileRuntime ? terminalDraftActionButtonClass : darkPanelButtonClass
                          } disabled:cursor-not-allowed disabled:opacity-55`}
                          disabled={!activeTerminalSessionId || !terminalDraftCommand.trim()}
                          onClick={() => {
                            void executeDraftCommand();
                          }}
                          type="button"
                        >
                          发送执行
                        </button>
                        {isMobileRuntime && (
                          <button
                            className={terminalDraftActionButtonClass}
                            onClick={() => {
                              handleToggleMobileKeyboardInput();
                            }}
                            type="button"
                          >
                            {isMobilePortraitKeyboardInputEnabled ? '关闭键盘' : '键盘输入'}
                          </button>
                        )}
                        {!isMobileRuntime && (
                          <div className="flex items-center gap-1">
                            <button
                              className={darkPanelButtonClass}
                              onClick={() => {
                                setTerminalLineHeight(Math.max(1, terminalLineHeight - 0.1));
                              }}
                              type="button"
                            >
                              行距-
                            </button>
                            <span className="min-w-[52px] text-center text-[11px] text-[#b8c9e6]">
                              {terminalLineHeight.toFixed(2)}x
                            </span>
                            <button
                              className={darkPanelButtonClass}
                              onClick={() => {
                                setTerminalLineHeight(Math.min(2.4, terminalLineHeight + 0.1));
                              }}
                              type="button"
                            >
                              行距+
                            </button>
                          </div>
                        )}
                        {!isMobileRuntime && (
                          <button
                            className={darkPanelButtonClass}
                            onClick={() => {
                              setSnippetsPanelCollapsed(!snippetsPanelCollapsed);
                            }}
                            type="button"
                          >
                            {snippetsPanelCollapsed ? uiText.terminalSnippetOpen : uiText.terminalSnippetClose}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {!isSftpCollapsed && !isMobileRuntime && (
                <>
                  {!isMobileLayout && (
                    <div
                      aria-label="调整终端与 SFTP 分栏宽度"
                      className={`relative h-full w-2 shrink-0 rounded bg-[#223756] transition hover:bg-[#355a89] ${
                        isResizingSplit ? 'cursor-col-resize bg-[#4e78ab]' : 'cursor-col-resize'
                      }`}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        setIsResizingSplit(true);
                      }}
                      role="separator"
                    />
                  )}
                  <div
                    className={`overflow-hidden ${isMobileLayout ? 'h-[42%] w-full shrink-0' : 'h-full shrink-0'}`}
                    style={isMobileLayout ? undefined : { width: `${sftpPanelWidth}px` }}
                  >
                    <SftpManager
                      className="h-full"
                      onSendToTerminal={sendCommandToTerminal}
                      palette={activeSftpPalette}
                      sessionId={activeTerminalSessionId}
                      syncRequest={sftpSyncRequest}
                    />
                  </div>
                </>
              )}
            </div>

            {splitMenu && !isMobileRuntime && (
              <div
                className="fixed z-[140] min-w-[180px] rounded-xl border border-[#385780] bg-[#0b1628]/95 p-1.5 shadow-2xl backdrop-blur"
                onClick={(event) => {
                  event.stopPropagation();
                }}
                style={{
                  left: splitMenu.x,
                  top: splitMenu.y
                }}
              >
                <button
                  className="block w-full rounded-lg border border-[#2d4870] bg-transparent px-2.5 py-1.5 text-left text-xs text-[#d8e8ff] hover:bg-[#173051]"
                  onClick={() => {
                    void handleSplitFromMenu('horizontal');
                  }}
                  type="button"
                >
                  向右分屏
                </button>
                <button
                  className="mt-1 block w-full rounded-lg border border-[#2d4870] bg-transparent px-2.5 py-1.5 text-left text-xs text-[#d8e8ff] hover:bg-[#173051]"
                  onClick={() => {
                    void handleSplitFromMenu('vertical');
                  }}
                  type="button"
                >
                  向下分屏
                </button>
                <button
                  className={`mt-1 block w-full rounded-lg border px-2.5 py-1.5 text-left text-xs ${
                    splitMenuCanCloseCurrent
                      ? 'border-[#2d4870] bg-transparent text-[#ffd7d7] hover:bg-[#3a1e2e]'
                      : 'cursor-not-allowed border-[#2b3d5a] bg-[#0c1524] text-[#6d83a6]'
                  }`}
                  disabled={!splitMenuCanCloseCurrent}
                  onClick={() => {
                    if (!splitMenuCanCloseCurrent || !splitMenu) {
                      return;
                    }
                    void handleClosePane(splitMenu.tabSessionId, splitMenu.paneId).finally(() => {
                      setSplitMenu(null);
                    });
                  }}
                  type="button"
                >
                  关闭当前分屏
                </button>
              </div>
            )}
          </section>
        </div>
      </section>

      {isMobileRuntime && appView === 'dashboard' && !isMobileTerminalFocusMode && (
        <MobileLayout
          activeTab={mobileNavTab}
          locale={locale}
          onTabChange={handleMobileTabChange}
          palette={activeUiPalette}
        />
      )}

      {isHostInfoOpen && (
        <div className="fixed inset-0 z-[135] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
          <div
            className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border p-0"
            style={{
              borderColor: toRgba(activeThemePreset.terminalBorder, 0.62),
              background: toRgba(activeThemePreset.terminalSurfaceHex, 0.94)
            }}
          >
            <div
              className="flex items-center justify-between border-b px-4 py-3"
              style={{ borderColor: toRgba(activeThemePreset.terminalBorder, 0.5) }}
            >
              <div>
                <h3 className="text-sm font-semibold text-[#d7e5ff]">主机信息</h3>
                <p className="text-[11px] text-[#9cb4d8]">
                  查看当前连接服务器的 CPU、内存、Swap、硬盘与系统详情
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className={darkPanelButtonClass}
                  disabled={!activeTerminalSessionId || isLoadingHostInfo}
                  onClick={() => {
                    void handleOpenHostInfo();
                  }}
                  type="button"
                >
                  {isLoadingHostInfo ? '刷新中...' : '刷新'}
                </button>
                <button
                  className={darkPanelButtonClass}
                  onClick={() => {
                    setIsHostInfoOpen(false);
                  }}
                  type="button"
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {isLoadingHostInfo && (
                <p className="text-xs text-[#9cb4d8]">正在读取主机信息...</p>
              )}
              {!isLoadingHostInfo && hostInfoError && (
                <p className="text-xs text-rose-300">{hostInfoError}</p>
              )}
              {!isLoadingHostInfo && !hostInfoError && hostInfo && (
                <div className="space-y-3 text-xs text-[#d7e5ff]">
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">主机名称</p>
                      <p className="mt-1">{hostInfo.hostname || '--'}</p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">操作系统</p>
                      <p className="mt-1">{hostInfo.osName || '--'}</p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">系统版本</p>
                      <p className="mt-1">{hostInfo.osVersion || '--'}</p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">内核</p>
                      <p className="mt-1">{hostInfo.kernelName || '--'}</p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">内核版本</p>
                      <p className="mt-1">{hostInfo.kernelRelease || '--'}</p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">内核构建号</p>
                      <p className="mt-1">{hostInfo.kernelVersion || '--'}</p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">硬件架构</p>
                      <p className="mt-1">{hostInfo.architecture || '--'}</p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2 md:col-span-2">
                      <p className="text-[11px] text-[#8ea4c7]">CPU 信息</p>
                      <p className="mt-1">
                        {hostInfo.cpuModel || '--'} ({hostInfo.cpuCores || 0} cores)
                      </p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">内存</p>
                      <p className="mt-1">
                        {formatBytes(hostInfo.memoryTotalBytes - hostInfo.memoryAvailableBytes)} /{' '}
                        {formatBytes(hostInfo.memoryTotalBytes)}
                      </p>
                    </div>
                    <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                      <p className="text-[11px] text-[#8ea4c7]">Swap</p>
                      <p className="mt-1">
                        {formatBytes(hostInfo.swapTotalBytes - hostInfo.swapFreeBytes)} /{' '}
                        {formatBytes(hostInfo.swapTotalBytes)}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/15 bg-white/5 p-2">
                    <p className="mb-2 text-[11px] text-[#8ea4c7]">硬盘信息</p>
                    <div className="overflow-auto">
                      <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                        <thead>
                          <tr className="text-[#9cb4d8]">
                            <th className="border-b border-white/15 px-2 py-1">挂载点</th>
                            <th className="border-b border-white/15 px-2 py-1">文件系统</th>
                            <th className="border-b border-white/15 px-2 py-1">已用/总量</th>
                            <th className="border-b border-white/15 px-2 py-1">可用</th>
                            <th className="border-b border-white/15 px-2 py-1">使用率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {hostInfo.disks.length === 0 && (
                            <tr>
                              <td className="px-2 py-2 text-[#9cb4d8]" colSpan={5}>
                                暂未读取到硬盘信息
                              </td>
                            </tr>
                          )}
                          {hostInfo.disks.map((disk) => (
                            <tr key={`${disk.mountPoint}-${disk.fsType}`}>
                              <td className="border-b border-white/10 px-2 py-1">{disk.mountPoint}</td>
                              <td className="border-b border-white/10 px-2 py-1">{disk.fsType}</td>
                              <td className="border-b border-white/10 px-2 py-1">
                                {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                              </td>
                              <td className="border-b border-white/10 px-2 py-1">
                                {formatBytes(disk.availableBytes)}
                              </td>
                              <td className="border-b border-white/10 px-2 py-1">
                                {disk.usedPercent || '--'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isPrivacyMaskVisible && (isMobileLayout || isAndroidClient) && (
        <div className="pointer-events-none fixed inset-0 z-[210] flex items-center justify-center bg-slate-950/60 backdrop-blur-2xl">
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-white/20 bg-black/25 px-6 py-5">
            <BrandLogo className="h-14 w-14 rounded-2xl border border-white/35 shadow-[0_16px_38px_rgba(15,23,42,0.36)]" />
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/75">OrbitTerm Vault</p>
          </div>
        </div>
      )}

      <TransferCenter />

      {isHostWizardOpen && (
        <div
          className={`fixed inset-0 z-[128] flex bg-black/45 backdrop-blur-sm ${
            isMobileLayout ? 'items-end justify-center p-0' : 'items-center justify-center p-4'
          }`}
        >
          <div
            className={`flex flex-col overflow-hidden border border-white/45 bg-[#f1f7ff]/95 shadow-2xl backdrop-blur-2xl ${
              isMobileLayout
                ? 'h-[calc(100%-env(safe-area-inset-top))] w-full rounded-t-3xl border-x-0 border-b-0'
                : 'h-[min(88vh,860px)] w-full max-w-5xl rounded-3xl'
            }`}
          >
            <div className="flex items-center justify-between border-b border-white/60 px-5 py-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">新增主机向导</p>
                <p className="mt-1 text-sm text-slate-700">按步骤填写连接信息，保存后自动写入本地加密金库。</p>
              </div>
              <button
                className={toolbarButtonClass}
                onClick={handleCloseHostWizard}
                type="button"
              >
                关闭
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
              <StepIndicator currentStep={currentStep} />

              <div className="mt-4 rounded-2xl border border-white/65 bg-white/60 p-5">
                {currentStep === 1 && <Step1 />}
                {currentStep === 2 && <Step2 />}
                {currentStep === 3 && <Step3 />}
              </div>

              {submittedHost && (
                <div className="mt-4 space-y-3 rounded-2xl border border-emerald-200/70 bg-emerald-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold text-emerald-900">主机配置已保存</h2>
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-xl border border-emerald-300 bg-white/80 px-3 py-1.5 text-xs font-medium text-emerald-800"
                        onClick={() => {
                          reset();
                        }}
                        type="button"
                      >
                        新建另一台主机
                      </button>
                      <button
                        className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                        onClick={() => {
                          setIsHostWizardOpen(false);
                          setDashboardSection('hosts');
                        }}
                        type="button"
                      >
                        完成并关闭
                      </button>
                    </div>
                  </div>
                  <pre className="overflow-auto rounded-xl bg-slate-900/90 p-3 text-xs leading-6 text-slate-100">
                    {JSON.stringify(submittedHost, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isNewTabModalOpen && (
        <div
          className={`fixed inset-0 z-[129] flex bg-black/45 backdrop-blur-sm ${
            isMobileLayout ? 'items-end justify-center p-0' : 'items-center justify-center p-4'
          }`}
        >
          <div
            className={`w-full border border-white/35 bg-[#0c1627]/92 p-5 text-[#dceaff] shadow-2xl backdrop-blur-2xl ${
              isMobileLayout
                ? 'h-[72vh] rounded-t-3xl border-x-0 border-b-0'
                : 'max-w-2xl rounded-3xl'
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#8fb2e6]">新建窗口</p>
                <p className="mt-1 text-sm text-[#b8cae6]">选择一台主机，创建新的终端会话窗口。</p>
              </div>
              <button
                className="rounded-lg border border-[#39537a] bg-[#0f1726] px-3 py-1.5 text-xs font-medium text-[#d7e5ff] hover:bg-[#13203a]"
                onClick={() => {
                  setIsNewTabModalOpen(false);
                }}
                type="button"
              >
                关闭
              </button>
            </div>

            {hosts.length === 0 ? (
              <div className="mt-4 rounded-xl border border-[#28405f] bg-[#0a1629] p-4 text-sm text-[#a8c0e3]">
                当前没有可连接主机，请先新增主机。
                <div className="mt-3">
                  <button
                    className="rounded-lg border border-[#3f5b82] bg-[#11223a] px-3 py-1.5 text-xs font-medium text-[#e1eeff] hover:bg-[#193152]"
                    onClick={() => {
                      setIsNewTabModalOpen(false);
                      setIsHostWizardOpen(true);
                    }}
                    type="button"
                  >
                    前往新增主机
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-4 max-h-[320px] space-y-2 overflow-auto pr-1">
                  {hosts.map((host, index) => {
                    const hostId = buildHostKey(host);
                    const identity = identities.find((item) => item.id === host.identityId);
                    const isSelected = selectedTabHostId === hostId;
                    return (
                      <button
                        className={`w-full rounded-xl border px-3 py-2 text-left transition ${
                          isSelected
                            ? 'border-[#4d76ab] bg-[#1a3254]'
                            : 'border-[#2a3f5d] bg-[#0d1a2b]/75 hover:bg-[#13243f]'
                        }`}
                        key={`${hostId}-${index}`}
                        onClick={() => {
                          setSelectedTabHostId(hostId);
                        }}
                        type="button"
                      >
                        <p className="text-sm font-medium text-[#e1eeff]">
                          {host.basicInfo.name || `${host.basicInfo.address}:${host.basicInfo.port}`}
                        </p>
                        <p className="mt-1 text-xs text-[#9fb5d7]">
                          {(identity?.username ?? 'unknown')}@{host.basicInfo.address}:{host.basicInfo.port}
                        </p>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    className="rounded-lg border border-[#39537a] bg-[#0f1726] px-3 py-1.5 text-xs font-medium text-[#d7e5ff] hover:bg-[#13203a]"
                    onClick={() => {
                      setIsNewTabModalOpen(false);
                    }}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="rounded-lg border border-[#4d76ab] bg-[#1a3254] px-3 py-1.5 text-xs font-semibold text-[#e2efff] hover:bg-[#24426b] disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!selectedTabHost || isConnectingTerminal}
                    onClick={() => {
                      void handleConnectFromNewTabModal();
                    }}
                    type="button"
                  >
                    {isConnectingTerminal ? '连接中...' : '创建并连接'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <CommandPalette
        activeIndex={commandPaletteActiveIndex}
        items={commandPaletteItems}
        onActiveIndexChange={setCommandPaletteActiveIndex}
        onClose={handleCommandPaletteClose}
        onConfirm={handleCommandPaletteConfirm}
        onQueryChange={(value) => {
          setCommandPaletteQuery(value);
          setCommandPaletteActiveIndex(0);
        }}
        open={isCommandPaletteOpen}
        query={commandPaletteQuery}
      />

      <OrbitAiAssistant
        onClose={() => {
          setIsAiAssistantOpen(false);
        }}
        onFill={fillCommandIntoTerminal}
        open={isAiAssistantOpen}
        sessionId={activeTerminalSessionId}
      />

      <OrbitInspector
        appLogs={appLogs}
        healthReport={healthReport}
        logs={sshDiagnosticLogs}
        onAskAi={handleAskAiForSshFix}
        onClearAppLogs={clearAppLogs}
        onClose={() => {
          setIsInspectorOpen(false);
        }}
        onRefreshHealth={async () => {
          await performHealthCheck(true);
        }}
        open={isInspectorOpen}
        perfSummary={terminalPerfSummary}
        sessionId={activeTerminalSessionId}
        terminalError={terminalError}
      />

      <SettingsDrawer
        activeTerminalHostId={activeTerminalHostId}
        activeTerminalSessionId={activeTerminalSessionId}
        activeTerminalTitle={activeTerminalTitle}
        activeCategory={settingsCategory}
        focusSectionId={settingsFocusSectionId}
        focusSequence={settingsFocusSequence}
        isMobileView={isMobileRuntime}
        onClose={() => {
          setIsSettingsOpen(false);
        }}
        onCategoryChange={(category) => {
          setSettingsCategory(category);
          setSettingsFocusSectionId(null);
          setSettingsFocusSequence((prev) => prev + 1);
        }}
        onOpenAbout={() => {
          setIsAboutOpen(true);
        }}
        onOpenCloudAuth={() => {
          setIsCloudAuthModalOpen(true);
          setSkippedCloudAuthForCurrentUnlock(false);
          setIsSettingsOpen(false);
        }}
        open={isSettingsOpen}
      />

      <AboutOrbitTermModal
        onClose={() => {
          setIsAboutOpen(false);
        }}
        open={isAboutOpen}
        releaseNotice={releaseNotice}
      />

      <HostEditDialog
        host={editingHost}
        identity={editingIdentity}
        isSaving={isSavingVault}
        linkedHostCount={editingLinkedHostCount}
        onClose={() => {
          setEditingHostId(null);
        }}
        onSubmit={handleSaveHostEdit}
        open={Boolean(editingHost)}
      />

      <CloudAuthModal
        onSkip={() => {
          setIsCloudAuthModalOpen(false);
          setSkippedCloudAuthForCurrentUnlock(true);
        }}
        onSuccess={() => {
          setIsCloudAuthModalOpen(false);
          setSkippedCloudAuthForCurrentUnlock(false);
        }}
        open={isCloudAuthModalOpen}
      />

      {isCloseWindowPromptOpen && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-white/45 bg-[#f1f7ff]/95 p-5 shadow-2xl backdrop-blur-2xl">
            <h3 className="text-base font-semibold text-slate-900">关闭 OrbitTerm</h3>
            <p className="mt-2 text-sm text-slate-600">
              {isMobileLayout || isAndroidClient
                ? '你希望本次关闭窗口后直接退出应用吗？'
                : '你希望本次关闭窗口后“驻留系统托盘”还是“直接退出应用”？'}
            </p>
            <label className="mt-3 inline-flex items-center gap-2 text-xs text-slate-700">
              <input
                checked={rememberCloseActionChoice}
                className="h-4 w-4 accent-[#2f6df4]"
                onChange={(event) => setRememberCloseActionChoice(event.target.checked)}
                type="checkbox"
              />
              记住我的选择并设为默认
            </label>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => {
                  setIsCloseWindowPromptOpen(false);
                }}
                type="button"
              >
                取消
              </button>
              {!isMobileLayout && !isAndroidClient && (
                <button
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    if (rememberCloseActionChoice) {
                      setCloseWindowAction('tray');
                    }
                    setIsCloseWindowPromptOpen(false);
                    void appWindow.hide();
                  }}
                  type="button"
                >
                  驻留系统托盘
                </button>
              )}
              <button
                className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                onClick={() => {
                  if (rememberCloseActionChoice) {
                    setCloseWindowAction('exit');
                  }
                  void forceCloseWindow();
                }}
                type="button"
              >
                直接退出
              </button>
            </div>
          </div>
        </div>
      )}

      <Toaster
        closeButton
        expand
        position="bottom-center"
        richColors
        toastOptions={{
          className: 'rounded-2xl border border-slate-200/80 bg-white/96 px-3 py-2 shadow-xl',
          descriptionClassName: 'text-slate-600'
        }}
        visibleToasts={5}
      />
    </main>
  );
}

export default App;
