import type { ITheme } from 'xterm';

export type OrbitThemePresetId = 'abyss' | 'basalt_dark' | 'mossy_ink' | 'warm_parchment';

export interface OrbitThemePreset {
  id: OrbitThemePresetId;
  name: string;
  description: string;
  bodyBackground: string;
  terminalSurfaceHex: string;
  terminalBorder: string;
  terminalTheme: ITheme;
}

export interface OrbitUiPalette {
  shellBackground: string;
  shellBorder: string;
  headerBackground: string;
  headerBorder: string;
  softSurface: string;
  panelBackground: string;
  panelBorder: string;
  accent: string;
  accentSoft: string;
  textPrimary: string;
  textMuted: string;
}

export interface OrbitTerminalChromePalette {
  paneBackgroundFocused: string;
  paneBackgroundIdle: string;
  titleActiveBackground: string;
  titleActiveText: string;
  titleActiveRing: string;
  titleIdleBackground: string;
  titleIdleText: string;
  titleIdleRing: string;
  hintText: string;
  contextMenuBackground: string;
  contextMenuBorder: string;
  contextMenuItemText: string;
  contextMenuItemHoverBackground: string;
  contextMenuDisabledText: string;
  splitterColor: string;
  splitterHoverColor: string;
}

export interface OrbitSftpPalette {
  panelBackground: string;
  panelBorder: string;
  softBackground: string;
  softBorder: string;
  tableBackground: string;
  rowHoverBackground: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  buttonBackground: string;
  buttonBorder: string;
  buttonText: string;
  buttonHoverBackground: string;
  menuBackground: string;
  menuBorder: string;
  menuItemHoverBackground: string;
  editorOverlayBackground: string;
  editorBackground: string;
  editorBorder: string;
  editorHeaderBorder: string;
  editorTagBackground: string;
  editorTagBorder: string;
  editorTagText: string;
  actionPrimaryBackground: string;
  actionPrimaryBorder: string;
  actionPrimaryText: string;
  actionPrimaryHoverBackground: string;
  successBadgeBackground: string;
  successBadgeBorder: string;
  successBadgeText: string;
  warningBadgeBackground: string;
  warningBadgeBorder: string;
  warningBadgeText: string;
  monacoTheme: 'vs' | 'vs-dark';
}

export interface OrbitCommandHighlightPalette {
  query: string;
  createMove: string;
  editModify: string;
  dangerDelete: string;
  symbol: string;
}

const ABYSS_THEME: OrbitThemePreset = {
  id: 'abyss',
  name: 'Abyss Default',
  description: '默认主题，深蓝冷调，平衡信息密度与观感。',
  bodyBackground:
    'radial-gradient(circle at 10% 16%, rgba(88, 166, 255, 0.48), transparent 34%), radial-gradient(circle at 84% 12%, rgba(48, 120, 220, 0.38), transparent 32%), radial-gradient(circle at 52% 86%, rgba(126, 198, 255, 0.48), transparent 42%), linear-gradient(135deg, #dce9ff 0%, #c9ddff 50%, #ecf4ff 100%)',
  terminalSurfaceHex: '#0b1220',
  terminalBorder: '#2e4670',
  terminalTheme: {
    background: '#0b1220',
    foreground: '#dbe7ff',
    cursor: '#7ab7ff',
    selectionBackground: '#29456d88',
    black: '#1a2435',
    red: '#ff7f9a',
    green: '#7fecc0',
    yellow: '#f5dc83',
    blue: '#6fa8ff',
    magenta: '#9c9dff',
    cyan: '#73e0ff',
    white: '#dbe7ff',
    brightBlack: '#647089',
    brightRed: '#ff9db2',
    brightGreen: '#a3f4d5',
    brightYellow: '#ffedb3',
    brightBlue: '#9ac2ff',
    brightMagenta: '#b9bbff',
    brightCyan: '#a0ecff',
    brightWhite: '#f2f7ff'
  }
};

export const ORBIT_THEME_PRESETS: ReadonlyArray<OrbitThemePreset> = [
  ABYSS_THEME,
  {
    id: 'basalt_dark',
    name: '玄武岩石 (Basalt Dark)',
    description: '沉浸式极客办公：深石墨基底，低眩光高可读。',
    bodyBackground:
      'radial-gradient(circle at 12% 16%, rgba(112, 192, 232, 0.16), transparent 36%), radial-gradient(circle at 86% 18%, rgba(255, 158, 100, 0.14), transparent 34%), linear-gradient(136deg, #1a1d22 0%, #1e2227 56%, #171a1f 100%)',
    terminalSurfaceHex: '#1e2227',
    terminalBorder: '#3a414c',
    terminalTheme: {
      background: '#1e2227',
      foreground: '#e3e8ef',
      cursor: '#70c0e8',
      selectionBackground: '#3a4c6190',
      black: '#181a1f',
      red: '#ff9e64',
      green: '#70c0e8',
      yellow: '#e5c07b',
      blue: '#70c0e8',
      magenta: '#c678dd',
      cyan: '#6ad6ff',
      white: '#dfe5ee',
      brightBlack: '#7a8598',
      brightRed: '#ffb485',
      brightGreen: '#8fd4ef',
      brightYellow: '#efd39a',
      brightBlue: '#8bcfee',
      brightMagenta: '#d59be6',
      brightCyan: '#91e2ff',
      brightWhite: '#f3f6fb'
    }
  },
  {
    id: 'mossy_ink',
    name: '青苔古砚 (Mossy Ink)',
    description: '极致护眼专注：暗绿墨底色，长时间阅读更稳。',
    bodyBackground:
      'radial-gradient(circle at 14% 16%, rgba(152, 195, 121, 0.16), transparent 36%), radial-gradient(circle at 82% 20%, rgba(97, 175, 239, 0.14), transparent 34%), linear-gradient(136deg, #1c211d 0%, #222924 55%, #171d19 100%)',
    terminalSurfaceHex: '#222924',
    terminalBorder: '#3f4b43',
    terminalTheme: {
      background: '#222924',
      foreground: '#dce6dd',
      cursor: '#98c379',
      selectionBackground: '#3d4f4292',
      black: '#1c211d',
      red: '#e06c75',
      green: '#98c379',
      yellow: '#d19a66',
      blue: '#61afef',
      magenta: '#8bbf7a',
      cyan: '#66c2b4',
      white: '#dce6dd',
      brightBlack: '#5c6370',
      brightRed: '#e58b92',
      brightGreen: '#add088',
      brightYellow: '#ddb084',
      brightBlue: '#86c0f2',
      brightMagenta: '#9fd18f',
      brightCyan: '#85d3c8',
      brightWhite: '#eef5ef'
    }
  },
  {
    id: 'warm_parchment',
    name: '暖阳宣纸 (Warm Parchment)',
    description: '清晰阅读模式：暖白纸感，减少数字屏疲劳。',
    bodyBackground:
      'radial-gradient(circle at 15% 12%, rgba(226, 193, 127, 0.22), transparent 38%), radial-gradient(circle at 82% 16%, rgba(152, 104, 1, 0.18), transparent 36%), linear-gradient(135deg, #2f2922 0%, #2a231d 58%, #241e18 100%)',
    terminalSurfaceHex: '#2c241d',
    terminalBorder: '#6e5b46',
    terminalTheme: {
      background: '#2c241d',
      foreground: '#f6ead8',
      cursor: '#e2c17f',
      selectionBackground: '#8b6f4a88',
      black: '#241e18',
      red: '#d98fa8',
      green: '#d6c084',
      yellow: '#e2c17f',
      blue: '#8db6ff',
      magenta: '#cfa8dd',
      cyan: '#9ccac1',
      white: '#f6ead8',
      brightBlack: '#8f7a62',
      brightRed: '#e5a4bc',
      brightGreen: '#e3cf9b',
      brightYellow: '#ecd29a',
      brightBlue: '#a8c7ff',
      brightMagenta: '#dcbbe8',
      brightCyan: '#b2d8d0',
      brightWhite: '#ffffff'
    }
  }
];

export const resolveThemePreset = (id: OrbitThemePresetId): OrbitThemePreset => {
  return ORBIT_THEME_PRESETS.find((preset) => preset.id === id) ?? ABYSS_THEME;
};

export const toRgba = (hex: string, alpha: number): string => {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) {
    return `rgba(0, 0, 0, ${alpha})`;
  }

  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const normalizeHex = (value: string): string | null => {
  const input = value.trim();
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(input);
  if (shortMatch) {
    const shortHex = shortMatch[1];
    if (!shortHex) {
      return null;
    }
    const expanded = shortHex
      .split('')
      .map((ch) => `${ch}${ch}`)
      .join('');
    return `#${expanded.toLowerCase()}`;
  }
  const longMatch = /^#([0-9a-fA-F]{6})$/.exec(input);
  if (longMatch) {
    const longHex = longMatch[1];
    if (!longHex) {
      return null;
    }
    return `#${longHex.toLowerCase()}`;
  }
  return null;
};

const hexToRgb = (value: string): { r: number; g: number; b: number } | null => {
  const normalized = normalizeHex(value);
  if (!normalized) {
    return null;
  }
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16)
  };
};

const channelToLinear = (value: number): number => {
  const normalized = value / 255;
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }
  return ((normalized + 0.055) / 1.055) ** 2.4;
};

const luminanceOfHex = (hex: string): number | null => {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    return null;
  }
  const r = channelToLinear(rgb.r);
  const g = channelToLinear(rgb.g);
  const b = channelToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const resolvePresetTone = (preset: OrbitThemePreset): 'light' | 'dark' => {
  const background = preset.terminalTheme.background ?? preset.terminalSurfaceHex;
  const luminance = luminanceOfHex(background);
  if (luminance === null) {
    return 'dark';
  }
  return luminance > 0.52 ? 'light' : 'dark';
};

export const resolveTerminalChromePalette = (
  preset: OrbitThemePreset,
  uiPalette: OrbitUiPalette
): OrbitTerminalChromePalette => {
  const tone = resolvePresetTone(preset);
  if (tone === 'light') {
    return {
      paneBackgroundFocused: 'rgba(255, 255, 255, 0.8)',
      paneBackgroundIdle: 'rgba(255, 255, 255, 0.62)',
      titleActiveBackground: toRgba(preset.terminalBorder, 0.18),
      titleActiveText: '#1f2937',
      titleActiveRing: toRgba(uiPalette.accent, 0.44),
      titleIdleBackground: 'rgba(241, 245, 249, 0.84)',
      titleIdleText: '#475569',
      titleIdleRing: 'rgba(148, 163, 184, 0.45)',
      hintText: 'rgba(71, 85, 105, 0.9)',
      contextMenuBackground: 'rgba(255, 255, 255, 0.96)',
      contextMenuBorder: 'rgba(148, 163, 184, 0.52)',
      contextMenuItemText: '#1f2937',
      contextMenuItemHoverBackground: 'rgba(226, 232, 240, 0.85)',
      contextMenuDisabledText: '#94a3b8',
      splitterColor: toRgba(preset.terminalBorder, 0.5),
      splitterHoverColor: toRgba(uiPalette.accent, 0.62)
    };
  }
  return {
    paneBackgroundFocused: toRgba(preset.terminalSurfaceHex, 0.88),
    paneBackgroundIdle: toRgba(preset.terminalSurfaceHex, 0.72),
    titleActiveBackground: toRgba(preset.terminalBorder, 0.3),
    titleActiveText: '#eaf2ff',
    titleActiveRing: toRgba(uiPalette.accent, 0.55),
    titleIdleBackground: toRgba(preset.terminalBorder, 0.14),
    titleIdleText: '#9bb2d2',
    titleIdleRing: toRgba(preset.terminalBorder, 0.42),
    hintText: '#86a2ca',
    contextMenuBackground: toRgba(preset.terminalSurfaceHex, 0.95),
    contextMenuBorder: toRgba(preset.terminalBorder, 0.66),
    contextMenuItemText: '#dcebff',
    contextMenuItemHoverBackground: toRgba(preset.terminalBorder, 0.34),
    contextMenuDisabledText: '#6f85a7',
    splitterColor: toRgba(preset.terminalBorder, 0.5),
    splitterHoverColor: toRgba(uiPalette.accent, 0.68)
  };
};

export const resolveSftpPalette = (
  preset: OrbitThemePreset,
  uiPalette: OrbitUiPalette
): OrbitSftpPalette => {
  const tone = resolvePresetTone(preset);
  if (tone === 'light') {
    return {
      panelBackground: 'rgba(255, 255, 255, 0.9)',
      panelBorder: 'rgba(148, 163, 184, 0.52)',
      softBackground: 'rgba(248, 250, 252, 0.94)',
      softBorder: 'rgba(148, 163, 184, 0.4)',
      tableBackground: 'rgba(255, 255, 255, 0.94)',
      rowHoverBackground: 'rgba(241, 245, 249, 0.86)',
      textPrimary: '#1f2937',
      textSecondary: '#334155',
      textMuted: '#64748b',
      buttonBackground: 'rgba(255, 255, 255, 0.9)',
      buttonBorder: 'rgba(148, 163, 184, 0.52)',
      buttonText: '#1f2937',
      buttonHoverBackground: 'rgba(241, 245, 249, 0.95)',
      menuBackground: 'rgba(255, 255, 255, 0.97)',
      menuBorder: 'rgba(148, 163, 184, 0.58)',
      menuItemHoverBackground: 'rgba(226, 232, 240, 0.9)',
      editorOverlayBackground: 'rgba(15, 23, 42, 0.52)',
      editorBackground: 'rgba(255, 255, 255, 0.98)',
      editorBorder: 'rgba(148, 163, 184, 0.56)',
      editorHeaderBorder: 'rgba(148, 163, 184, 0.44)',
      editorTagBackground: 'rgba(248, 250, 252, 0.95)',
      editorTagBorder: 'rgba(148, 163, 184, 0.5)',
      editorTagText: '#334155',
      actionPrimaryBackground: toRgba(uiPalette.accent, 0.92),
      actionPrimaryBorder: toRgba(uiPalette.accent, 0.94),
      actionPrimaryText: '#ffffff',
      actionPrimaryHoverBackground: toRgba(uiPalette.accent, 0.98),
      successBadgeBackground: 'rgba(16, 185, 129, 0.14)',
      successBadgeBorder: 'rgba(16, 185, 129, 0.5)',
      successBadgeText: '#047857',
      warningBadgeBackground: 'rgba(245, 158, 11, 0.16)',
      warningBadgeBorder: 'rgba(245, 158, 11, 0.52)',
      warningBadgeText: '#b45309',
      monacoTheme: 'vs'
    };
  }
  return {
    panelBackground: toRgba(preset.terminalSurfaceHex, 0.9),
    panelBorder: toRgba(preset.terminalBorder, 0.58),
    softBackground: toRgba(preset.terminalSurfaceHex, 0.76),
    softBorder: toRgba(preset.terminalBorder, 0.44),
    tableBackground: toRgba(preset.terminalSurfaceHex, 0.84),
    rowHoverBackground: toRgba(preset.terminalBorder, 0.26),
    textPrimary: '#d9e9ff',
    textSecondary: '#c6d9f6',
    textMuted: '#8ea5c7',
    buttonBackground: toRgba(preset.terminalSurfaceHex, 0.7),
    buttonBorder: toRgba(preset.terminalBorder, 0.55),
    buttonText: '#dceaff',
    buttonHoverBackground: toRgba(preset.terminalBorder, 0.28),
    menuBackground: toRgba(preset.terminalSurfaceHex, 0.97),
    menuBorder: toRgba(preset.terminalBorder, 0.68),
    menuItemHoverBackground: toRgba(preset.terminalBorder, 0.32),
    editorOverlayBackground: 'rgba(2, 6, 23, 0.62)',
    editorBackground: toRgba(preset.terminalSurfaceHex, 0.98),
    editorBorder: toRgba(preset.terminalBorder, 0.72),
    editorHeaderBorder: toRgba(preset.terminalBorder, 0.44),
    editorTagBackground: toRgba(preset.terminalBorder, 0.26),
    editorTagBorder: toRgba(preset.terminalBorder, 0.5),
    editorTagText: '#d2e2fb',
    actionPrimaryBackground: toRgba(uiPalette.accent, 0.92),
    actionPrimaryBorder: toRgba(uiPalette.accent, 0.96),
    actionPrimaryText: '#ffffff',
    actionPrimaryHoverBackground: toRgba(uiPalette.accent, 1),
    successBadgeBackground: 'rgba(16, 185, 129, 0.2)',
    successBadgeBorder: 'rgba(16, 185, 129, 0.55)',
    successBadgeText: '#a7f3d0',
    warningBadgeBackground: 'rgba(245, 158, 11, 0.18)',
    warningBadgeBorder: 'rgba(245, 158, 11, 0.52)',
    warningBadgeText: '#fde68a',
    monacoTheme: 'vs-dark'
  };
};

export const resolveUiPalette = (id: OrbitThemePresetId): OrbitUiPalette => {
  switch (id) {
    case 'basalt_dark':
      return {
        shellBackground: 'linear-gradient(140deg, rgba(25, 28, 34, 0.95) 0%, rgba(30, 34, 39, 0.96) 56%, rgba(23, 26, 31, 0.95) 100%)',
        shellBorder: 'rgba(88, 97, 110, 0.46)',
        headerBackground: 'rgba(24, 27, 33, 0.88)',
        headerBorder: 'rgba(88, 97, 110, 0.38)',
        softSurface: 'rgba(34, 39, 46, 0.82)',
        panelBackground: 'rgba(28, 32, 38, 0.92)',
        panelBorder: 'rgba(88, 97, 110, 0.32)',
        accent: '#70C0E8',
        accentSoft: 'rgba(112, 192, 232, 0.18)',
        textPrimary: '#E6ECF4',
        textMuted: '#ABB2BF'
      };
    case 'mossy_ink':
      return {
        shellBackground: 'linear-gradient(140deg, rgba(29, 34, 30, 0.95) 0%, rgba(34, 41, 36, 0.95) 56%, rgba(23, 29, 25, 0.95) 100%)',
        shellBorder: 'rgba(95, 113, 100, 0.46)',
        headerBackground: 'rgba(28, 33, 29, 0.88)',
        headerBorder: 'rgba(95, 113, 100, 0.38)',
        softSurface: 'rgba(40, 48, 42, 0.82)',
        panelBackground: 'rgba(33, 40, 35, 0.92)',
        panelBorder: 'rgba(95, 113, 100, 0.32)',
        accent: '#98C379',
        accentSoft: 'rgba(152, 195, 121, 0.18)',
        textPrimary: '#E4ECE4',
        textMuted: '#A9B7AA'
      };
    case 'warm_parchment':
      return {
        shellBackground: 'linear-gradient(138deg, rgba(50, 42, 34, 0.96) 0%, rgba(43, 35, 28, 0.95) 55%, rgba(37, 30, 24, 0.96) 100%)',
        shellBorder: 'rgba(142, 120, 90, 0.52)',
        headerBackground: 'rgba(58, 48, 38, 0.9)',
        headerBorder: 'rgba(142, 120, 90, 0.4)',
        softSurface: 'rgba(70, 58, 46, 0.84)',
        panelBackground: 'rgba(47, 39, 31, 0.92)',
        panelBorder: 'rgba(142, 120, 90, 0.34)',
        accent: '#E2C17F',
        accentSoft: 'rgba(226, 193, 127, 0.16)',
        textPrimary: '#F4EBDD',
        textMuted: '#CDBDA7'
      };
    case 'abyss':
    default:
      return {
        shellBackground: 'linear-gradient(140deg, rgba(236,244,255,0.88) 0%, rgba(220,233,255,0.92) 52%, rgba(241,247,255,0.9) 100%)',
        shellBorder: 'rgba(112, 146, 198, 0.42)',
        headerBackground: 'rgba(239, 246, 255, 0.9)',
        headerBorder: 'rgba(116, 149, 202, 0.34)',
        softSurface: 'rgba(231, 241, 255, 0.78)',
        panelBackground: 'rgba(247, 251, 255, 0.88)',
        panelBorder: 'rgba(123, 154, 206, 0.28)',
        accent: '#2f6df4',
        accentSoft: 'rgba(47, 109, 244, 0.12)',
        textPrimary: '#1f3557',
        textMuted: '#4b6489'
      };
  }
};

export const resolveCommandHighlightPalette = (id: OrbitThemePresetId): OrbitCommandHighlightPalette => {
  switch (id) {
    case 'basalt_dark':
      return {
        query: '#70C0E8',
        createMove: '#C678DD',
        editModify: '#E5C07B',
        dangerDelete: '#FF9E64',
        symbol: '#ABB2BF'
      };
    case 'mossy_ink':
      return {
        query: '#98C379',
        createMove: '#61AFEF',
        editModify: '#D19A66',
        dangerDelete: '#E06C75',
        symbol: '#5C6370'
      };
    case 'warm_parchment':
      return {
        query: '#006666',
        createMove: '#4078F2',
        editModify: '#986801',
        dangerDelete: '#A626A1',
        symbol: '#A0A1A7'
      };
    case 'abyss':
    default:
      return {
        query: '#6FA8FF',
        createMove: '#9C9DFF',
        editModify: '#F5DC83',
        dangerDelete: '#FF7F9A',
        symbol: '#9AAFD2'
      };
  }
};
