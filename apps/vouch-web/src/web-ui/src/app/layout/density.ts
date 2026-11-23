/**
 * 界面密度（D2 信息密度）
 *
 * ══ 对标依据 ═════════════════════════════════════════════════
 * omp-studio 的做法（matrix D2 记录，omp-aion.md:58,99）：
 *   「三档可调密度 `--density-scale` compact 0.85 / 1 / cozy 1.15，
 *     只缩间距、不动字号与布局度量，并设 `--tap-min: 24px` 守 WCAG 命中区」
 * orca 的做法是终端原生高密度（10px 字号、状态栏 10 段并列）。
 *
 * 我们原来**没有密度概念**：间距写死，用户要么嫌挤要么嫌松。
 *
 * ══ 这里做什么 ═════════════════════════════════════════════
 *   · 三档：compact(0.78) / cozy(1) / comfy(1.18)，只影响间距与行高，**不动字号**
 *   · `--nb-tap-min: 24px` 硬守命中区：无论多紧，可点目标不小于 24px
 *   · 可通过 URL 深链指定（`#tab=do&density=compact`），也记住用户上次选择
 *
 * ══ 诚实边界 ═════════════════════════════════════════════════
 * · 只覆盖**我们自己写的 agent 面板**（NianchuChat / DoPanel / TeamPanel）。
 *   宿主外壳（OpenBitFun 基座）的间距不在本机制内 —— 它有自己的设计系统。
 * · 密度调的是**间距**，不是信息量；要真提高信息密度得加内容，那是产品决策。
 */

export type DensityLevel = 'compact' | 'cozy' | 'comfy';

/** 三档的间距系数（只乘间距，不乘字号） */
export const DENSITY_SCALE: Record<DensityLevel, number> = {
  compact: 0.78,
  cozy: 1,
  comfy: 1.18,
};

/** WCAG 2.5.8 最小命中区（CSS 像素） */
export const TAP_MIN_PX = 24;

const KEY = 'nianchu.density';

export function normalizeDensity(v: unknown): DensityLevel | null {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'compact' || s === 'cozy' || s === 'comfy') return s;
  return null;
}

/** 从 URL（hash 或 query）与 localStorage 里解析当前密度 */
export function resolveDensity(search = '', hash = '', stored: string | null = null): DensityLevel {
  const fromHash = /(?:^|[#&])density=(compact|cozy|comfy)\b/.exec(hash || '');
  if (fromHash) return normalizeDensity(fromHash[1]) as DensityLevel;
  const fromQuery = /[?&]density=(compact|cozy|comfy)\b/.exec(search || '');
  if (fromQuery) return normalizeDensity(fromQuery[1]) as DensityLevel;
  return normalizeDensity(stored) || 'cozy';
}

/**
 * 把密度写到根元素。
 *
 * ⚠ **属性名必须是 `data-nb-density`，不能叫 `data-density`** ——
 * 2026-11-19 实测踩坑：本仓库里 `data-density` 是**既有约定**，
 * WelcomeScene 按宽度档位设置它、AgentCompanionDesktopPet.scss 的
 * `:where([data-density='compact'])` 也在读它。用同一个名字会互相覆盖，
 * 结果三档全被读成 compact（验证时三档 DOM 属性一模一样才发现）。
 * 自己的机制用自己的命名空间。
 */

export function applyDensity(level: DensityLevel, root?: HTMLElement | null): DensityLevel {
  const lv = normalizeDensity(level) || 'cozy';
  const el = root || (typeof document !== 'undefined' ? document.documentElement : null);
  if (el) {
    el.dataset.nbDensity = lv;
    el.style.setProperty('--nb-dens', String(DENSITY_SCALE[lv]));
    el.style.setProperty('--nb-tap-min', TAP_MIN_PX + 'px');
  }
  try { localStorage.setItem(KEY, lv); } catch { /* 隐私模式下写不了，忽略 */ }
  return lv;
}

/** 页面加载时应用一次（在 app 入口调用） */
export function initDensity(): DensityLevel {
  if (typeof window === 'undefined') return 'cozy';
  let stored: string | null = null;
  try { stored = localStorage.getItem(KEY); } catch { stored = null; }
  const lv = resolveDensity(window.location.search, window.location.hash, stored);
  return applyDensity(lv);
}