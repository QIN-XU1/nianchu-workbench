import { appearanceService } from '@/infrastructure/appearance';
import { createLogger } from '@/shared/utils/logger';
import {
  deriveThemeMode,
  resolveColorScheme,
  themeModeToAppearanceSelectionId,
} from './mapping';
import type { ResolvedColorScheme, ThemeMode, ThemePreference } from '../types';

const log = createLogger('ThemePreferenceService');

const DARK_QUERY = '(prefers-color-scheme: dark)';

export type ThemeChangeListener = (
  preference: ThemePreference,
  resolved: ResolvedColorScheme,
) => void;

/** 面板需要的一屏状态。同一组值复用同一个对象，`useSyncExternalStore` 才不会空转。 */
export interface ThemePreferenceState {
  mode: ThemeMode;
  resolved: ResolvedColorScheme;
  /** 外观包正在应用（或还没初始化）时控件必须禁用，避免连点排队。 */
  busy: boolean;
}

function systemPrefersDark(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * 主题模式的读写门面 —— appearance 系统之上的三档翻译层。
 *
 * 它**不**写 `document.documentElement`，也**不**持久化配置：
 *
 * - `data-color-scheme` 由 `OpenBitFunDesignSystemProvider` 从
 *   `appearance.current.mode` 落下（`index.html` 只负责首屏那一笔）；
 * - 选择本身由 `AppearanceService` 写进同步配置。
 *
 * 早先的实现两边各写一份，结果出现「属性是 dark、token 还是浅色」的撕裂。
 * 现在这里只做两件事：把当前选择读成三档模式，把三档模式翻译成一次
 * `appearanceService.select(...)`。
 */
export class ThemePreferenceService {
  private readonly listeners = new Set<ThemeChangeListener>();
  private unsubscribeAppearance: (() => void) | null = null;
  private cachedState: ThemePreferenceState | null = null;

  /**
   * 幂等：挂上 appearance 快照订阅，并保证它被初始化。
   *
   * 同步返回，调用方（启动流程 / 设置页）不必等一次 host 配置往返。
   */
  initialize(): void {
    if (this.unsubscribeAppearance) return;
    void appearanceService.initialize().catch((error) => {
      log.error('Failed to initialize appearance for theme mode', error);
    });
    this.unsubscribeAppearance = appearanceService.subscribe(() => this.emit());
    // 让缓存跟着 appearance 的首个快照失效。
    this.cachedState = null;
    this.emit();
    log.debug('Theme mode adapter initialized', { mode: this.getMode() });
  }

  /**
   * 兼容启动流程里的调用点。
   *
   * 持久化选择由 appearance 自己恢复，这里只需要等它完成，避免设置页在
   * 外观包还没落地时读到半截状态。
   */
  async reconcile(): Promise<void> {
    this.initialize();
    try {
      await appearanceService.initialize();
    } catch (error) {
      log.warn('Failed to reconcile theme mode with appearance', error);
    }
  }

  getMode(): ThemeMode {
    const snapshot = appearanceService.getSnapshot();
    return deriveThemeMode(snapshot.selectedAppearanceId, snapshot.current?.mode);
  }

  /** 界面真正在用的配色：外观包已落地就用它的 mode，否则按模式问操作系统。 */
  getResolvedColorScheme(): ResolvedColorScheme {
    const snapshot = appearanceService.getSnapshot();
    return snapshot.current?.mode ?? resolveColorScheme(this.getMode(), systemPrefersDark());
  }

  isBusy(): boolean {
    const snapshot = appearanceService.getSnapshot();
    return !snapshot.initialized || snapshot.status === 'applying';
  }

  getState(): ThemePreferenceState {
    const next: ThemePreferenceState = {
      mode: this.getMode(),
      resolved: this.getResolvedColorScheme(),
      busy: this.isBusy(),
    };
    const cached = this.cachedState;
    if (
      cached
      && cached.mode === next.mode
      && cached.resolved === next.resolved
      && cached.busy === next.busy
    ) {
      return cached;
    }
    this.cachedState = next;
    return next;
  }

  getPreference(): ThemePreference {
    return { mode: this.getMode() };
  }

  /**
   * 切换模式 = 切换外观包。
   *
   * 失败时 appearance 会自己回滚到上一个选择并重新发快照，所以这里不需要
   * 再做一次本地回滚；调用方拿到 rejection 后自行提示即可。
   *
   * 已经处于目标模式时直接返回：选择的自定义深色皮肤（例如 `openbitfun-cyber`）
   * 同样算「深色」，再点一次深色不应该把用户的皮肤换回默认深色包。这也意味着
   * 「深色」是配色档位，不是某个具体外观包 —— 要换皮肤请用上方「内置主题」。
   */
  async setMode(mode: ThemeMode): Promise<void> {
    if (mode === this.getMode()) return;
    await appearanceService.select(themeModeToAppearanceSelectionId(mode));
  }

  subscribe(listener: ThemeChangeListener): () => void {
    // 设置页可能在启动流程之前就挂载（例如独立 story/单测），这里兜底订阅，
    // `initialize` 本身幂等。
    this.initialize();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 测试/卸载用：断开 appearance 订阅。 */
  dispose(): void {
    this.unsubscribeAppearance?.();
    this.unsubscribeAppearance = null;
    this.cachedState = null;
    this.listeners.clear();
  }

  private emit(): void {
    const preference = this.getPreference();
    const resolved = this.getResolvedColorScheme();
    this.listeners.forEach((listener) => {
      try {
        listener(preference, resolved);
      } catch (error) {
        log.error('Theme listener failed', error);
      }
    });
  }
}

export const themePreferenceService = new ThemePreferenceService();
