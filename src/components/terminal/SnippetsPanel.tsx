import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  builtinSnippetTemplates,
  type BuiltinSnippetCategory
} from '../../services/snippetLibrary';
import { useUiSettingsStore } from '../../store/useUiSettingsStore';
import type { Snippet } from '../../types/host';
import { normalizeAppLanguage, type AppLanguage } from '../../i18n/core';

interface SnippetsPanelProps {
  snippets: Snippet[];
  hasActiveSession: boolean;
  className?: string;
  onRunSnippet: (command: string, autoEnter: boolean) => Promise<void>;
  onCreateSnippet: (payload: { title: string; command: string; tags: string[] }) => Promise<void>;
  onUpdateSnippet: (
    snippetId: string,
    payload: { title: string; command: string; tags: string[] }
  ) => Promise<void>;
  onDeleteSnippet: (snippetId: string) => Promise<void>;
}

interface SnippetFormState {
  title: string;
  command: string;
  tagsText: string;
}

interface SnippetListItem {
  id: string;
  title: string;
  command: string;
  tags: string[];
  description?: string;
  kind: 'custom' | 'builtin';
  category: 'custom' | BuiltinSnippetCategory;
}

type SnippetLibraryView = BuiltinSnippetCategory | 'custom';

interface SnippetLocalePack {
  libraryTitle: string;
  librarySubtitle: string;
  collapseButton: string;
  viewOptions: Record<SnippetLibraryView, { label: string; desc: string }>;
  searchPlaceholder: string;
  emptyCustom: string;
  emptyBuiltin: string;
  editAction: string;
  fillAction: string;
  runAction: string;
  copyAction: string;
  copyLoading: string;
  deleteAction: string;
  editorExpand: string;
  editorCollapse: string;
  editorNewTitle: string;
  editorEditTitle: string;
  titlePlaceholder: string;
  commandPlaceholder: string;
  tagsPlaceholder: string;
  saveLoading: string;
  saveCreate: string;
  saveUpdate: string;
  resetAction: string;
  toastNeedTitle: string;
  toastNeedCommand: string;
  toastNeedSession: string;
  toastWriteFailed: string;
  toastCopyFailed: string;
  toastDeleteFailed: string;
  toastCreateFailed: string;
  toastUpdateFailed: string;
  toastCopiedToMine: string;
  toastFilledPrefix: string;
  toastRunPrefix: string;
}

const initialFormState: SnippetFormState = {
  title: '',
  command: '',
  tagsText: ''
};

const SNIPPET_LOCALE_PACKS: Record<AppLanguage, SnippetLocalePack> = {
  'zh-Hans': {
    libraryTitle: '指令库',
    librarySubtitle: '先选择系统，再执行或复制常用指令',
    collapseButton: '收起',
    viewOptions: {
      ubuntu: { label: 'Ubuntu', desc: '系统维护与排障' },
      debian: { label: 'Debian', desc: '服务与日志巡检' },
      alpine: { label: 'Alpine', desc: '轻量系统运维' },
      huawei: { label: 'Huawei', desc: '交换机/路由器' },
      custom: { label: '我的指令', desc: '自定义命令库' }
    },
    searchPlaceholder: '搜索 {{label}} 指令（标题/命令/标签）',
    emptyCustom: '你还没有自定义指令，点击下方“展开我的指令编辑器”即可新增。',
    emptyBuiltin: '当前系统分类下没有匹配指令，请尝试调整关键词。',
    editAction: '编辑',
    fillAction: '填入',
    runAction: '执行',
    copyAction: '复制到我的',
    copyLoading: '复制中...',
    deleteAction: '删除',
    editorExpand: '展开我的指令编辑器',
    editorCollapse: '收起我的指令编辑器',
    editorNewTitle: '新建我的指令',
    editorEditTitle: '编辑我的指令',
    titlePlaceholder: '标题，例如：查看 80 端口',
    commandPlaceholder: '指令内容，例如：lsof -i :80',
    tagsPlaceholder: '标签，逗号分隔：排障, 端口',
    saveLoading: '保存中...',
    saveCreate: '添加指令',
    saveUpdate: '更新指令',
    resetAction: '重置',
    toastNeedTitle: '请输入指令标题。',
    toastNeedCommand: '请输入指令内容。',
    toastNeedSession: '请先创建并激活终端会话。',
    toastWriteFailed: '写入终端失败，请检查连接状态。',
    toastCopyFailed: '复制内置指令失败，请稍后重试。',
    toastDeleteFailed: '删除指令失败。',
    toastCreateFailed: '新增指令失败。',
    toastUpdateFailed: '更新指令失败。',
    toastCopiedToMine: '已复制到“我的指令”。',
    toastFilledPrefix: '已填入：',
    toastRunPrefix: '已执行：'
  },
  'zh-Hant': {
    libraryTitle: '指令庫',
    librarySubtitle: '先選擇系統，再執行或複製常用指令',
    collapseButton: '收起',
    viewOptions: {
      ubuntu: { label: 'Ubuntu', desc: '系統維護與排障' },
      debian: { label: 'Debian', desc: '服務與日誌巡檢' },
      alpine: { label: 'Alpine', desc: '輕量系統運維' },
      huawei: { label: 'Huawei', desc: '交換機/路由器' },
      custom: { label: '我的指令', desc: '自訂命令庫' }
    },
    searchPlaceholder: '搜尋 {{label}} 指令（標題/命令/標籤）',
    emptyCustom: '你還沒有自訂指令，點擊下方「展開我的指令編輯器」即可新增。',
    emptyBuiltin: '目前分類下沒有匹配指令，請調整關鍵字。',
    editAction: '編輯',
    fillAction: '填入',
    runAction: '執行',
    copyAction: '複製到我的',
    copyLoading: '複製中...',
    deleteAction: '刪除',
    editorExpand: '展開我的指令編輯器',
    editorCollapse: '收起我的指令編輯器',
    editorNewTitle: '新建我的指令',
    editorEditTitle: '編輯我的指令',
    titlePlaceholder: '標題，例如：查看 80 端口',
    commandPlaceholder: '指令內容，例如：lsof -i :80',
    tagsPlaceholder: '標籤，逗號分隔：排障, 端口',
    saveLoading: '儲存中...',
    saveCreate: '新增指令',
    saveUpdate: '更新指令',
    resetAction: '重置',
    toastNeedTitle: '請輸入指令標題。',
    toastNeedCommand: '請輸入指令內容。',
    toastNeedSession: '請先建立並啟用終端會話。',
    toastWriteFailed: '寫入終端失敗，請檢查連線狀態。',
    toastCopyFailed: '複製內建指令失敗，請稍後再試。',
    toastDeleteFailed: '刪除指令失敗。',
    toastCreateFailed: '新增指令失敗。',
    toastUpdateFailed: '更新指令失敗。',
    toastCopiedToMine: '已複製到「我的指令」。',
    toastFilledPrefix: '已填入：',
    toastRunPrefix: '已執行：'
  },
  en: {
    libraryTitle: 'Snippet Library',
    librarySubtitle: 'Pick a system first, then run or copy common commands',
    collapseButton: 'Collapse',
    viewOptions: {
      ubuntu: { label: 'Ubuntu', desc: 'Ops and troubleshooting' },
      debian: { label: 'Debian', desc: 'Service and logs' },
      alpine: { label: 'Alpine', desc: 'Lightweight environments' },
      huawei: { label: 'Huawei', desc: 'Switches/Routers' },
      custom: { label: 'My Snippets', desc: 'Custom command library' }
    },
    searchPlaceholder: 'Search {{label}} snippets (title/command/tag)',
    emptyCustom: 'No custom snippets yet. Click "Expand my snippet editor" below to create one.',
    emptyBuiltin: 'No snippets matched this system category. Try another keyword.',
    editAction: 'Edit',
    fillAction: 'Fill',
    runAction: 'Run',
    copyAction: 'Copy to Mine',
    copyLoading: 'Copying...',
    deleteAction: 'Delete',
    editorExpand: 'Expand my snippet editor',
    editorCollapse: 'Collapse my snippet editor',
    editorNewTitle: 'Create my snippet',
    editorEditTitle: 'Edit my snippet',
    titlePlaceholder: 'Title, e.g. Check port 80',
    commandPlaceholder: 'Command, e.g. lsof -i :80',
    tagsPlaceholder: 'Tags, comma-separated: troubleshoot, port',
    saveLoading: 'Saving...',
    saveCreate: 'Add snippet',
    saveUpdate: 'Update snippet',
    resetAction: 'Reset',
    toastNeedTitle: 'Please enter a snippet title.',
    toastNeedCommand: 'Please enter a command.',
    toastNeedSession: 'Create and activate a terminal session first.',
    toastWriteFailed: 'Failed to write to terminal. Check the connection status.',
    toastCopyFailed: 'Failed to copy built-in snippet. Please try again.',
    toastDeleteFailed: 'Failed to delete snippet.',
    toastCreateFailed: 'Failed to create snippet.',
    toastUpdateFailed: 'Failed to update snippet.',
    toastCopiedToMine: 'Copied to "My Snippets".',
    toastFilledPrefix: 'Filled: ',
    toastRunPrefix: 'Executed: '
  },
  ja: {
    libraryTitle: 'スニペットライブラリ',
    librarySubtitle: '先にOSを選択し、よく使うコマンドを実行またはコピー',
    collapseButton: '折りたたむ',
    viewOptions: {
      ubuntu: { label: 'Ubuntu', desc: '運用とトラブル対応' },
      debian: { label: 'Debian', desc: 'サービスとログ確認' },
      alpine: { label: 'Alpine', desc: '軽量環境の運用' },
      huawei: { label: 'Huawei', desc: 'スイッチ/ルーター' },
      custom: { label: 'マイスニペット', desc: 'カスタムコマンド集' }
    },
    searchPlaceholder: '{{label}} スニペットを検索（タイトル/コマンド/タグ）',
    emptyCustom: 'カスタムスニペットはまだありません。下の「マイスニペット編集を展開」から追加できます。',
    emptyBuiltin: 'このカテゴリに一致するスニペットがありません。検索語を変更してください。',
    editAction: '編集',
    fillAction: '入力',
    runAction: '実行',
    copyAction: 'マイにコピー',
    copyLoading: 'コピー中...',
    deleteAction: '削除',
    editorExpand: 'マイスニペット編集を展開',
    editorCollapse: 'マイスニペット編集を折りたたむ',
    editorNewTitle: 'マイスニペットを新規作成',
    editorEditTitle: 'マイスニペットを編集',
    titlePlaceholder: 'タイトル（例：80番ポート確認）',
    commandPlaceholder: 'コマンド（例：lsof -i :80）',
    tagsPlaceholder: 'タグ（カンマ区切り）：troubleshoot, port',
    saveLoading: '保存中...',
    saveCreate: '追加',
    saveUpdate: '更新',
    resetAction: 'リセット',
    toastNeedTitle: 'スニペットのタイトルを入力してください。',
    toastNeedCommand: 'コマンドを入力してください。',
    toastNeedSession: '先にターミナルセッションを作成・有効化してください。',
    toastWriteFailed: 'ターミナルへの書き込みに失敗しました。接続状態を確認してください。',
    toastCopyFailed: '内蔵スニペットのコピーに失敗しました。後でもう一度お試しください。',
    toastDeleteFailed: 'スニペットの削除に失敗しました。',
    toastCreateFailed: 'スニペットの追加に失敗しました。',
    toastUpdateFailed: 'スニペットの更新に失敗しました。',
    toastCopiedToMine: '「マイスニペット」にコピーしました。',
    toastFilledPrefix: '入力済み: ',
    toastRunPrefix: '実行済み: '
  }
};

const parseTags = (value: string): string[] => {
  if (!value.trim()) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );
};

const previewCommand = (command: string): string => {
  const trimmed = command.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 64) {
    return trimmed;
  }
  return `${trimmed.slice(0, 64)}...`;
};

export function SnippetsPanel({
  snippets,
  hasActiveSession,
  className,
  onRunSnippet,
  onCreateSnippet,
  onUpdateSnippet,
  onDeleteSnippet
}: SnippetsPanelProps): JSX.Element | null {
  const collapsed = useUiSettingsStore((state) => state.snippetsPanelCollapsed);
  const setCollapsed = useUiSettingsStore((state) => state.setSnippetsPanelCollapsed);
  const language = useUiSettingsStore((state) => state.language);

  const [search, setSearch] = useState<string>('');
  const [activeView, setActiveView] = useState<SnippetLibraryView>('ubuntu');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SnippetFormState>(initialFormState);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [runningSnippetId, setRunningSnippetId] = useState<string | null>(null);
  const [copyingBuiltinId, setCopyingBuiltinId] = useState<string | null>(null);
  const [isCustomEditorOpen, setIsCustomEditorOpen] = useState<boolean>(false);
  const locale = normalizeAppLanguage(language);
  const uiText = SNIPPET_LOCALE_PACKS[locale];
  const viewOptions = useMemo<Array<{ id: SnippetLibraryView; label: string; desc: string }>>(
    () =>
      (Object.entries(uiText.viewOptions) as Array<[SnippetLibraryView, { label: string; desc: string }]>).map(
        ([id, option]) => ({
          id,
          label: option.label,
          desc: option.desc
        })
      ),
    [uiText]
  );

  const customItems = useMemo<SnippetListItem[]>(() => {
    return snippets.map((snippet) => ({
      id: snippet.id,
      title: snippet.title,
      command: snippet.command,
      tags: snippet.tags,
      kind: 'custom',
      category: 'custom'
    }));
  }, [snippets]);

  const builtinItems = useMemo<SnippetListItem[]>(() => {
    return builtinSnippetTemplates.map((item) => ({
      id: item.id,
      title: item.title,
      command: item.command,
      tags: item.tags,
      description: item.description,
      kind: 'builtin',
      category: item.category
    }));
  }, []);

  const filteredBuiltinItems = useMemo(() => {
    if (activeView === 'custom') {
      return [];
    }
    const query = search.trim().toLowerCase();
    return builtinItems.filter((snippet) => {
      if (snippet.category !== activeView) {
        return false;
      }
      if (!query) {
        return true;
      }
      const searchable = [snippet.title, snippet.command, snippet.description ?? '', ...snippet.tags]
        .join(' ')
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [activeView, builtinItems, search]);

  const filteredCustomItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return customItems.filter((snippet) => {
      if (!query) {
        return true;
      }
      const searchable = [snippet.title, snippet.command, ...snippet.tags].join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }, [customItems, search]);

  const editingSnippet = useMemo(() => {
    if (!editingId) {
      return null;
    }
    return snippets.find((item) => item.id === editingId) ?? null;
  }, [editingId, snippets]);

  const resetForm = (): void => {
    setForm(initialFormState);
    setEditingId(null);
  };

  const handleStartCreate = (): void => {
    setEditingId(null);
    setForm(initialFormState);
  };

  const handleStartEdit = (snippet: Snippet): void => {
    setEditingId(snippet.id);
    setForm({
      title: snippet.title,
      command: snippet.command,
      tagsText: snippet.tags.join(', ')
    });
    if (!isCustomEditorOpen) {
      setIsCustomEditorOpen(true);
    }
  };

  const handleSaveSnippet = async (): Promise<void> => {
    const title = form.title.trim();
    const command = form.command.trim();
    if (!title) {
      toast.error(uiText.toastNeedTitle);
      return;
    }
    if (!command) {
      toast.error(uiText.toastNeedCommand);
      return;
    }

    setIsSubmitting(true);
    const payload = {
      title,
      command,
      tags: parseTags(form.tagsText)
    };

    try {
      if (editingSnippet) {
        await onUpdateSnippet(editingSnippet.id, payload);
      } else {
        await onCreateSnippet(payload);
      }
      resetForm();
    } catch (error) {
      const fallback = editingSnippet ? uiText.toastUpdateFailed : uiText.toastCreateFailed;
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (snippet: Snippet): Promise<void> => {
    const confirmText =
      locale === 'en'
        ? `Delete snippet "${snippet.title}"?`
        : locale === 'ja'
          ? `スニペット「${snippet.title}」を削除しますか？`
          : locale === 'zh-Hant'
            ? `確認刪除指令「${snippet.title}」嗎？`
            : `确认删除指令「${snippet.title}」吗？`;
    const confirmed = window.confirm(confirmText);
    if (!confirmed) {
      return;
    }

    try {
      await onDeleteSnippet(snippet.id);
      if (editingId === snippet.id) {
        resetForm();
      }
    } catch (error) {
      const fallback = uiText.toastDeleteFailed;
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    }
  };

  const handleRunSnippet = async (
    snippet: Pick<SnippetListItem, 'id' | 'title' | 'command'>,
    autoEnter: boolean
  ): Promise<void> => {
    if (!hasActiveSession) {
      toast.error(uiText.toastNeedSession);
      return;
    }
    setRunningSnippetId(snippet.id);
    try {
      await onRunSnippet(snippet.command, autoEnter);
      toast.success(`${autoEnter ? uiText.toastRunPrefix : uiText.toastFilledPrefix}${snippet.title}`);
    } catch (error) {
      const fallback = uiText.toastWriteFailed;
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    } finally {
      setRunningSnippetId(null);
    }
  };

  const handleCopyBuiltin = async (snippet: SnippetListItem): Promise<void> => {
    if (snippet.kind !== 'builtin') {
      return;
    }
    setCopyingBuiltinId(snippet.id);
    try {
      await onCreateSnippet({
        title: snippet.title,
        command: snippet.command,
        tags: Array.from(new Set([snippet.category, ...snippet.tags]))
      });
      toast.success(uiText.toastCopiedToMine);
    } catch (error) {
      const fallback = uiText.toastCopyFailed;
      const message = error instanceof Error ? error.message : fallback;
      toast.error(message || fallback);
    } finally {
      setCopyingBuiltinId(null);
    }
  };

  if (collapsed) {
    return null;
  }

  const showCustom = activeView === 'custom';
  const displayItems = showCustom ? filteredCustomItems : filteredBuiltinItems;
  const currentViewLabel = uiText.viewOptions[activeView].label;
  const searchPlaceholder = uiText.searchPlaceholder.replace('{{label}}', currentViewLabel);

  return (
    <aside
      className={`absolute bottom-20 right-3 z-20 flex h-[min(560px,calc(100%-7.6rem))] w-[356px] flex-col overflow-hidden rounded-2xl border border-[#314f77] bg-[#0b1320]/95 shadow-xl backdrop-blur ${
        className ?? ''
      }`}
    >
      <div className="flex items-center justify-between border-b border-[#233856] px-3 py-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#83a9da]">{uiText.libraryTitle}</p>
          <p className="text-xs text-[#bfd3ef]">{uiText.librarySubtitle}</p>
        </div>
        <button
          className="rounded-md border border-[#4c719f] px-2 py-1 text-[11px] text-[#d3e3ff] hover:bg-[#15253f]"
          onClick={() => {
            setCollapsed(true);
          }}
          type="button"
        >
          {uiText.collapseButton}
        </button>
      </div>

      <div className="space-y-2 border-b border-[#223754] p-3">
        <div className="grid grid-cols-2 gap-1.5">
          {viewOptions.map((option) => {
            const active = option.id === activeView;
            return (
              <button
                className={`rounded-lg border px-2 py-1.5 text-left transition ${
                  active
                    ? 'border-[#6a90c6] bg-[#1a355b] text-[#eff5ff]'
                    : 'border-[#36557f] bg-[#0f1c30] text-[#b8ceee] hover:bg-[#152944]'
                }`}
                key={option.id}
                onClick={() => {
                  setActiveView(option.id);
                }}
                type="button"
              >
                <p className="text-[11px] font-semibold">{option.label}</p>
                <p className="mt-0.5 text-[10px] opacity-80">{option.desc}</p>
              </button>
            );
          })}
        </div>
        <input
          className="w-full rounded-lg border border-[#35557f] bg-[#09101c] px-3 py-2 text-xs text-[#d9e7ff] outline-none placeholder:text-[#7290b4] focus:border-[#6a90c6]"
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          placeholder={searchPlaceholder}
          type="search"
          value={search}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        {displayItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#2f4a70] bg-[#0d1728]/70 px-3 py-4 text-xs text-[#9ab5d8]">
            {showCustom ? uiText.emptyCustom : uiText.emptyBuiltin}
          </div>
        ) : (
          <div className="space-y-2">
            {displayItems.map((snippet) => {
              const isRunning = runningSnippetId === snippet.id;
              const isBuiltin = snippet.kind === 'builtin';
              const isCopying = copyingBuiltinId === snippet.id;
              const customSnippet = isBuiltin
                ? null
                : snippets.find((item) => item.id === snippet.id) ?? null;
              return (
                <article className="rounded-xl border border-[#2f486e] bg-[#0e1a2b] p-3" key={snippet.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[#d8e6ff]">{snippet.title}</p>
                      <p className="mt-1 truncate text-[11px] text-[#8aa7ca]">{previewCommand(snippet.command)}</p>
                      {snippet.description && <p className="mt-1 text-[11px] text-[#a9c3e6]">{snippet.description}</p>}
                    </div>
                    {!isBuiltin && customSnippet && (
                      <button
                        className="rounded border border-[#496a97] px-1.5 py-0.5 text-[10px] text-[#c9dcfb] hover:bg-[#182945]"
                        onClick={() => {
                          handleStartEdit(customSnippet);
                        }}
                        type="button"
                      >
                        {uiText.editAction}
                      </button>
                    )}
                  </div>

                  {snippet.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {snippet.tags.map((tag) => (
                        <span
                          className="rounded border border-[#355784] bg-[#10233d] px-1.5 py-0.5 text-[10px] text-[#9ec0ee]"
                          key={`${snippet.id}-${tag}`}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      className="rounded-md border border-[#4d6f9f] bg-[#13253f] px-2 py-1 text-[11px] text-[#d6e6ff] hover:bg-[#183255]"
                      disabled={isRunning}
                      onClick={() => {
                        void handleRunSnippet(snippet, false);
                      }}
                      type="button"
                    >
                      {uiText.fillAction}
                    </button>
                    <button
                      className="rounded-md border border-[#4f77ac] bg-[#1d3f69] px-2 py-1 text-[11px] text-[#f0f6ff] hover:bg-[#245188]"
                      disabled={isRunning}
                      onClick={() => {
                        void handleRunSnippet(snippet, true);
                      }}
                      type="button"
                    >
                      {uiText.runAction}
                    </button>
                    {isBuiltin ? (
                      <button
                        className="rounded-md border border-[#5e82b5] bg-[#15315a] px-2 py-1 text-[11px] text-[#dceaff] hover:bg-[#1d4377] disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={isCopying}
                        onClick={() => {
                          void handleCopyBuiltin(snippet);
                        }}
                        type="button"
                      >
                        {isCopying ? uiText.copyLoading : uiText.copyAction}
                      </button>
                    ) : (
                      customSnippet && (
                        <button
                          className="rounded-md border border-rose-400/70 bg-rose-600/15 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-600/25"
                          disabled={isRunning}
                          onClick={() => {
                            void handleDelete(customSnippet);
                          }}
                          type="button"
                        >
                          {uiText.deleteAction}
                        </button>
                      )
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {showCustom && (
        <div className="border-t border-[#223754] bg-[#0b1525] p-3">
          <button
            className="w-full rounded-lg border border-[#4e76aa] bg-[#11223a] px-3 py-1.5 text-left text-xs font-semibold text-[#e4f0ff] hover:bg-[#173257]"
            onClick={() => {
              setIsCustomEditorOpen((prev) => !prev);
            }}
            type="button"
          >
            {isCustomEditorOpen ? uiText.editorCollapse : uiText.editorExpand}
          </button>

          {isCustomEditorOpen && (
            <div className="mt-2 space-y-2">
              <p className="text-xs font-semibold text-[#d1e3ff]">
                {editingSnippet ? uiText.editorEditTitle : uiText.editorNewTitle}
              </p>
              <input
                className="w-full rounded-lg border border-[#35557f] bg-[#09101c] px-3 py-1.5 text-xs text-[#d9e7ff] outline-none placeholder:text-[#7290b4] focus:border-[#6a90c6]"
                maxLength={64}
                onChange={(event) => {
                  setForm((prev) => ({ ...prev, title: event.target.value }));
                }}
                placeholder={uiText.titlePlaceholder}
                type="text"
                value={form.title}
              />
              <textarea
                className="h-20 w-full resize-none rounded-lg border border-[#35557f] bg-[#09101c] px-3 py-2 text-xs text-[#d9e7ff] outline-none placeholder:text-[#7290b4] focus:border-[#6a90c6]"
                onChange={(event) => {
                  setForm((prev) => ({ ...prev, command: event.target.value }));
                }}
                placeholder={uiText.commandPlaceholder}
                value={form.command}
              />
              <input
                className="w-full rounded-lg border border-[#35557f] bg-[#09101c] px-3 py-1.5 text-xs text-[#d9e7ff] outline-none placeholder:text-[#7290b4] focus:border-[#6a90c6]"
                onChange={(event) => {
                  setForm((prev) => ({ ...prev, tagsText: event.target.value }));
                }}
                placeholder={uiText.tagsPlaceholder}
                type="text"
                value={form.tagsText}
              />
              <div className="flex items-center gap-2">
                <button
                  className="rounded-lg border border-[#4e76aa] bg-[#1d3f69] px-3 py-1.5 text-xs font-semibold text-[#f0f6ff] hover:bg-[#25538a] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSubmitting}
                  onClick={() => {
                    void handleSaveSnippet();
                  }}
                  type="button"
                >
                  {isSubmitting ? uiText.saveLoading : editingSnippet ? uiText.saveUpdate : uiText.saveCreate}
                </button>
                {(editingSnippet || form.title || form.command || form.tagsText) && (
                  <button
                    className="rounded-lg border border-[#4b6993] px-3 py-1.5 text-xs text-[#cde0ff] hover:bg-[#16253f]"
                    onClick={handleStartCreate}
                    type="button"
                  >
                    {uiText.resetAction}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
