/**
 * 完成提示（对标 Claude Code / Codex 的 sound-cues、attention-notifications）。
 *
 * 两个独立开关（默认都关，不主动打扰）：
 *  - sound ：一轮回复结束时播放两声短提示音（WebAudio 合成，不依赖音频文件）；
 *  - notify：页面在后台/最小化时弹桌面通知（需用户授权）。
 *
 * 纯逻辑（开关持久化、该不该响）与副作用（AudioContext / Notification）分开，
 * 便于单测在 node 环境里 mock。
 */

export type CueSettings = { sound: boolean; notify: boolean };

const STORAGE_KEY = 'nianchu.completionCues.v1';
export const DEFAULT_CUE_SETTINGS: CueSettings = { sound: false, notify: false };

/** 读取开关；存储损坏/无 localStorage 时回退默认值。 */
export function readCueSettings(storage?: Pick<Storage, 'getItem'> | null): CueSettings {
  try {
    const raw = (storage ?? (typeof localStorage !== 'undefined' ? localStorage : null))?.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CUE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<CueSettings> | null;
    return { sound: parsed?.sound === true, notify: parsed?.notify === true };
  } catch {
    return { ...DEFAULT_CUE_SETTINGS };
  }
}

/** 写开关（合并写）。 */
export function writeCueSettings(patch: Partial<CueSettings>, storage?: Pick<Storage, 'setItem'> | null): CueSettings {
  const next = { ...readCueSettings(storage as never), ...patch };
  try {
    (storage ?? (typeof localStorage !== 'undefined' ? localStorage : null))?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式写不进：内存里生效即可，不打断用户 */
  }
  return next;
}

/**
 * 该不该为这次状态变化响提示：
 * 只在「RUNNING → PASS」这一条边上响一次；失败/中断不响（避免误报成功）。
 */
export function shouldCueTurn(prevState: string | null | undefined, nextState: string | null | undefined): boolean {
  return prevState === 'RUNNING' && nextState === 'PASS';
}

/** 两声短提示（880Hz→660Hz，各 120ms，带淡出）；浏览器不支持/被策略拦截时静默返回 false。 */
export function playCompletionCue(win?: { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }): boolean {
  try {
    const w = win ?? (typeof window !== 'undefined' ? (window as never) : undefined);
    const Ctx = w?.AudioContext ?? w?.webkitAudioContext;
    if (!Ctx) return false;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 660].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = now + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.15);
    }
    setTimeout(() => { void ctx.close?.(); }, 600);
    return true;
  } catch {
    return false;
  }
}

/** 页面在后台时弹桌面通知；未授权/不支持时返回 false（不弹权限框）。 */
export function notifyCompletion(title: string, body: string): boolean {
  try {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission !== 'granted') return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return false;
    new Notification(title, { body: body.slice(0, 120), silent: true });
    return true;
  } catch {
    return false;
  }
}

/** 用户点开关时申请通知权限（只在开启 notify 时调用）。 */
export async function requestNotifyPermission(): Promise<boolean> {
  try {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}
