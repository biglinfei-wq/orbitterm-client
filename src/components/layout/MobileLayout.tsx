import type { OrbitUiPalette } from '../../theme/orbitTheme';

export type MobileNavTab = 'hosts' | 'sessions' | 'tools' | 'settings';

interface MobileLayoutProps {
  activeTab: MobileNavTab;
  locale: string;
  palette: OrbitUiPalette;
  onTabChange: (tab: MobileNavTab) => void;
}

interface TabItem {
  id: MobileNavTab;
  icon: string;
  label: string;
}

const resolveTabItems = (locale: string): TabItem[] => {
  if (locale === 'zh-TW') {
    return [
      { id: 'hosts', icon: '🧭', label: '資產' },
      { id: 'sessions', icon: '⌨️', label: '會話' },
      { id: 'tools', icon: '🧰', label: '工具' },
      { id: 'settings', icon: '⚙️', label: '設定' }
    ];
  }
  if (locale === 'ja-JP') {
    return [
      { id: 'hosts', icon: '🧭', label: 'ホスト' },
      { id: 'sessions', icon: '⌨️', label: 'セッション' },
      { id: 'tools', icon: '🧰', label: 'ツール' },
      { id: 'settings', icon: '⚙️', label: '設定' }
    ];
  }
  if (locale === 'en-US') {
    return [
      { id: 'hosts', icon: '🧭', label: 'Hosts' },
      { id: 'sessions', icon: '⌨️', label: 'Sessions' },
      { id: 'tools', icon: '🧰', label: 'Tools' },
      { id: 'settings', icon: '⚙️', label: 'Settings' }
    ];
  }
  return [
    { id: 'hosts', icon: '🧭', label: '资产' },
    { id: 'sessions', icon: '⌨️', label: '会话' },
    { id: 'tools', icon: '🧰', label: '工具' },
    { id: 'settings', icon: '⚙️', label: '设置' }
  ];
};

export function MobileLayout({
  activeTab,
  locale,
  palette,
  onTabChange
}: MobileLayoutProps): JSX.Element {
  const tabItems = resolveTabItems(locale);

  return (
    <nav
      className="fixed bottom-2 left-2 right-2 z-[220] grid grid-cols-4 gap-1 rounded-2xl border p-1.5 shadow-2xl backdrop-blur-xl"
      style={{
        borderColor: palette.panelBorder,
        background: palette.panelBackground,
        paddingBottom: 'max(0.4rem, env(safe-area-inset-bottom))'
      }}
    >
      {tabItems.map((item) => {
        const active = item.id === activeTab;
        return (
          <button
            className={`inline-flex min-h-11 flex-col items-center justify-center rounded-xl px-2 py-2 text-[11px] font-semibold ${
              active ? 'text-white' : 'text-[#d8e8ff]'
            }`}
            key={item.id}
            onClick={() => {
              onTabChange(item.id);
            }}
            style={
              active
                ? {
                    background: palette.accent
                  }
                : {
                    background: 'rgba(255,255,255,0.08)'
                  }
            }
            type="button"
          >
            <span className="text-sm">{item.icon}</span>
            <span className="mt-0.5">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
