/**
 * Claude dark palette — 移植自开源项目 dsh-claude-style 的 Claude 暗色卡
 * （`palette.cards[claude]`：accent `#d97757`、canvas `#191919`、text `#fdfdfd`→
 *  这里取 Claude 品牌暖白 `#faf9f5`、sidebar `#1f1f1f`、bubble 白 6%）。
 */
import { AppearancePalette } from './AppearancePalette';
import {
  createAccentScale,
  createDarkNeutralBorder,
  createDarkNeutralElement,
  createDarkNeutralScrollbar,
  createGitColors,
  createSecondaryAccentScale,
  createSemanticColors,
  createStandardEasing,
  createStandardRadius,
  createStandardSpacing,
  overlayWhite,
} from './paletteHelpers';

const CLAUDE_ACCENT = '#d97757';
const CLAUDE_ACCENT_HOVER = '#e08a6d';
const CLAUDE_CANVAS = '#191919';
const CLAUDE_SIDEBAR = '#1f1f1f';
const CLAUDE_TEXT = '#faf9f5';

export const claudeDarkPalette: AppearancePalette = {
  id: 'claude-dark',
  name: 'Claude Dark',
  type: 'dark',
  description: 'Claude Code Desktop 暗色 - 近黑底、暖白字、橙棕强调（移植自 dsh-claude-style）',
  author: 'Nwflower / dsh-claude-style (ported)',
  version: '1.0.0',

  layout: { sceneViewportBorder: false },

  colors: {
    background: {
      primary: CLAUDE_CANVAS,
      secondary: CLAUDE_SIDEBAR,
      tertiary: '#232323',
      elevated: CLAUDE_SIDEBAR,
      workbench: CLAUDE_SIDEBAR,
      scene: CLAUDE_CANVAS,
      chrome: CLAUDE_SIDEBAR,
    },
    text: {
      primary: CLAUDE_TEXT,
      secondary: '#d4d2cc',
      muted: '#9a9a94',
      disabled: '#6a6a66',
    },
    accent: createAccentScale({ base: CLAUDE_ACCENT, hover: CLAUDE_ACCENT_HOVER }),
    purple: createSecondaryAccentScale({ base: '#b8a9e0', hover: '#a495d0' }),
    semantic: createSemanticColors('dark'),
    border: createDarkNeutralBorder(),
    element: createDarkNeutralElement(),
    git: createGitColors('dark', { branch: CLAUDE_ACCENT, branchBg: 'rgba(217, 119, 87, 0.14)' }),
    scrollbar: createDarkNeutralScrollbar(),
  },

  effects: {
    shadow: {
      xs: `0 1px 2px ${overlayWhite(0.06)}`,
      sm: `0 2px 4px ${overlayWhite(0.07)}`,
      base: `0 4px 10px ${overlayWhite(0.08)}`,
      lg: `0 8px 20px ${overlayWhite(0.1)}`,
      xl: `0 14px 32px ${overlayWhite(0.12)}`,
    },
    blur: { subtle: 'blur(4px) saturate(1.05) brightness(0.98)', base: 'blur(8px) saturate(1.08) brightness(0.98)' },
    radius: createStandardRadius(),
    spacing: createStandardSpacing(),
    opacity: { disabled: 0.5, hover: 0.75, focus: 0.85 },
  },

  motion: {
    duration: { instant: '0.08s', fast: '0.12s', base: '0.2s', slow: '0.4s' },
    easing: createStandardEasing(),
  },

  components: {
    button: {
      primary: {
        default: { background: CLAUDE_ACCENT, color: '#ffffff', border: 'transparent', shadow: 'none' },
        hover: { background: CLAUDE_ACCENT_HOVER, color: '#ffffff', border: 'transparent', shadow: 'none', transform: 'none' },
        active: { background: CLAUDE_ACCENT_HOVER, color: '#ffffff', border: 'transparent', shadow: 'none', transform: 'none' },
      },
      ghost: {
        default: { color: '#9a9a94' },
        hover: { background: overlayWhite(0.08), color: CLAUDE_TEXT, border: 'transparent' },
      },
    },
  },

  monaco: {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '9a9a94', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'e0a184' },
      { token: 'string', foreground: '9ccf9f' },
      { token: 'number', foreground: 'c3b1ec' },
    ],
    colors: {
      background: CLAUDE_CANVAS,
      foreground: CLAUDE_TEXT,
      lineHighlight: overlayWhite(0.05),
      selection: 'rgba(217, 119, 87, 0.22)',
      cursor: '#e0a184',
    },
  },
};
