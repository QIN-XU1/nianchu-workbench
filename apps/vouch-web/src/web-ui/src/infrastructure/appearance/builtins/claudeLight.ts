/**
 * Claude light palette — 移植自开源项目 dsh-claude-style 的 Claude 配色卡
 * （`packages/client/src/theme/tokens.json` 的 `palette.cards[claude]`：
 *  accent `#d97757`、canvas `#ffffff`、text `#161616`、sidebar `#fafafa`、
 *  bubble `#f4f2f3`、link `#184f95`）。
 *
 * 为什么单独建一套而不是改 openbitfun-light：用户明确喜欢 Claude Code Desktop 那套
 * 「墨黑字 + 橙棕强调 + 近白底」的观感，需要在 设置→外观 里作为一等选项出现，
 * 同时不破坏原默认浅色（回归风险隔离）。
 *
 * 边界：只移植「配色/语义色/圆角间距」，不照抄对方的 DOM/CSS 结构（两边组件树不同）。
 */
import { AppearancePalette } from './AppearancePalette';
import {
  createAccentScale,
  createGitColors,
  createSecondaryAccentScale,
  createSemanticColors,
  createStandardEasing,
  createStandardRadius,
  createStandardSpacing,
} from './paletteHelpers';

const CLAUDE_ACCENT = '#d97757';
const CLAUDE_ACCENT_HOVER = '#c2603f';
const CLAUDE_CANVAS = '#ffffff';
const CLAUDE_SIDEBAR = '#fafafa';
const CLAUDE_BUBBLE = '#f4f2f3';
const CLAUDE_TEXT = '#161616';

export const claudeLightPalette: AppearancePalette = {
  id: 'claude-light',
  name: 'Claude',
  type: 'light',
  description: 'Claude Code Desktop 风格 - 近白底、墨黑字、橙棕强调（移植自 dsh-claude-style）',
  author: 'Nwflower / dsh-claude-style (ported)',
  version: '1.0.0',

  layout: { sceneViewportBorder: false },

  colors: {
    background: {
      primary: CLAUDE_CANVAS,
      secondary: CLAUDE_SIDEBAR,
      tertiary: CLAUDE_BUBBLE,
      elevated: CLAUDE_CANVAS,
      workbench: '#f7f7f6',
      scene: CLAUDE_CANVAS,
      chrome: CLAUDE_SIDEBAR,
    },
    text: {
      primary: CLAUDE_TEXT,
      secondary: '#3d3d3a',
      muted: '#6b6b66',
      disabled: '#a8a8a2',
    },
    accent: createAccentScale({ base: CLAUDE_ACCENT, hover: CLAUDE_ACCENT_HOVER }),
    purple: createSecondaryAccentScale({ base: '#8a7ab8', hover: '#7466a0' }),
    semantic: createSemanticColors('light'),
    border: {
      subtle: 'rgba(22, 22, 22, 0.08)',
      base: 'rgba(22, 22, 22, 0.12)',
      medium: 'rgba(22, 22, 22, 0.16)',
      strong: 'rgba(22, 22, 22, 0.22)',
      prominent: 'rgba(22, 22, 22, 0.30)',
    },
    element: {
      subtle: 'rgba(22, 22, 22, 0.03)',
      soft: 'rgba(22, 22, 22, 0.04)',
      base: 'rgba(22, 22, 22, 0.05)',
      medium: 'rgba(22, 22, 22, 0.07)',
      strong: 'rgba(22, 22, 22, 0.10)',
    },
    git: createGitColors('light', { branch: CLAUDE_ACCENT, branchBg: 'rgba(217, 119, 87, 0.10)' }),
    scrollbar: { thumb: 'rgba(22, 22, 22, 0.16)', thumbHover: 'rgba(22, 22, 22, 0.28)' },
  },

  effects: {
    shadow: {
      xs: '0 1px 2px rgba(22, 22, 22, 0.06)',
      sm: '0 2px 4px rgba(22, 22, 22, 0.07)',
      base: '0 4px 10px rgba(22, 22, 22, 0.08)',
      lg: '0 8px 20px rgba(22, 22, 22, 0.10)',
      xl: '0 14px 32px rgba(22, 22, 22, 0.12)',
    },
    blur: { subtle: 'blur(4px) saturate(1.02)', base: 'blur(8px) saturate(1.04)' },
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
        default: { color: '#6b6b66' },
        hover: { background: 'rgba(22, 22, 22, 0.06)', color: CLAUDE_TEXT, border: 'transparent' },
      },
    },
  },

  monaco: {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b6b66', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'b5562f' },
      { token: 'string', foreground: '2f7d4f' },
      { token: 'number', foreground: '7a5cc0' },
    ],
    colors: {
      background: '#ffffff',
      foreground: CLAUDE_TEXT,
      lineHighlight: 'rgba(22, 22, 22, 0.04)',
      selection: 'rgba(217, 119, 87, 0.16)',
      cursor: CLAUDE_TEXT,
    },
  },
};
