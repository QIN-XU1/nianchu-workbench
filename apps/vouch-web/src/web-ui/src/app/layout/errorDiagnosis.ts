/**
 * 错误分类：把一句原始报错翻成「是哪一类 + 下一步做什么」。
 *
 * 为什么要有：界面上原本只有一行 `fetch failed` / `请求失败`。用户既不知道是自己的网络、
 * 代理、DNS，还是模型侧的问题，也不知道该干什么。对标 CodeBuddy CN 的四类（网络/代理/
 * DNS/模型）与 Cherry 的「每类给下一步」。
 *
 * 判定原则：
 *   · 只按**错误串里的确定性证据**分类（枚举的错误码/状态码），不猜。
 *   · 认不出来就返回 null —— 界面退回显示原始报错，**不臆断成某一类**。
 *   · detail 永远保留原始错误串（不吞原文），供用户复盘/反馈。
 */

export type ErrorCategory = 'network' | 'proxy' | 'dns' | 'timeout' | 'model';

export interface ErrorDiagnosis {
  category: ErrorCategory;
  /** 徽标（符号 + 文字，不只靠颜色）。 */
  badge: string;
  /** 一句话：这是什么问题。 */
  title: string;
  /** 用户能立刻做的一件事。 */
  nextStep: string;
  /** 原始错误串（原样保留）。 */
  detail: string;
}

interface Rule {
  category: ErrorCategory;
  badge: string;
  title: string;
  nextStep: string;
  test: RegExp;
}

/**
 * 顺序即优先级。
 *
 * `proxy` / `dns` 必须排在 `network` 前面 —— 它们本质上也是网络故障，
 * 但用户要采取的动作完全不同（改代理 vs 改 DNS），混成「网络错误」等于没说。
 */
const RULES: readonly Rule[] = [
  {
    category: 'proxy',
    badge: '🔀 代理',
    title: '代理层报错',
    nextStep: '检查系统或环境变量里的代理地址与端口；确认代理没有拦截 localhost / 127.0.0.1。',
    test: /\bproxy\b|econnreset.*proxy|407\b|proxyconnect|tunnel/i,
  },
  {
    category: 'dns',
    badge: '🧭 DNS',
    title: '域名解析失败',
    nextStep: '域名没解析出来：检查 DNS 设置，或改用 IP / 内网地址重试。',
    test: /enotfound|eai_again|getaddrinfo|name_not_resolved|dns/i,
  },
  {
    category: 'timeout',
    badge: '⏱ 超时',
    title: '请求超时',
    nextStep: '先重试一次；长任务可减少上下文或拆成几步再跑。',
    test: /etimedout|timed?\s?out|timeout|abort(ed)?\b|已中止|超时/i,
  },
  {
    category: 'network',
    badge: '🌐 网络',
    title: '连不上（网络层）',
    nextStep: '确认网络可用、宿主进程在线（端口 47124 可访问）；必要时重启宿主后重试。',
    test: /fetch failed|failed to fetch|econnrefused|econnreset|socket hang up|networkerror|network error|websocket[^]*?(fail|clos|error|disconnect)|连接宿主失败|宿主没有响应|offline/i,
  },
  {
    category: 'model',
    badge: '🤖 模型',
    title: '模型侧报错',
    nextStep: '确认模型名在当前服务端存在、额度足够、上下文没超限；换一个可用模型重试。',
    // 状态码必须带语境（status/http/code/error + 码，或码 + 后面跟已知英文短语），
    // 否则「跑了 403 步」这种裸数字会被误判成模型错误。
    test: /\b(?:status|http|code|error)[\s:：]*(401|403|429)\b|\b(401|403|429)\b\s*(?:too many|unauthorized|forbidden|error)\b|model_not_found|context_length|context length|insufficient_quota|invalid_api_key|rate.?limit|模型.*(失败|不存在|不可用|超限)/i,
  },
];

/**
 * 诊断一条错误串。
 *
 * @returns 分类结果；无法归类返回 null（界面显示原文，不硬套类别）
 */
export function diagnoseError(input: unknown): ErrorDiagnosis | null {
  const detail = String(input ?? '').trim();
  if (!detail) return null;
  for (const rule of RULES) {
    if (rule.test.test(detail)) {
      return {
        category: rule.category,
        badge: rule.badge,
        title: rule.title,
        nextStep: rule.nextStep,
        detail,
      };
    }
  }
  return null;
}

/** 所有类别（判据脚本用来断言「每类都有下一步」，避免新增类别漏写文案）。 */
export const ERROR_CATEGORIES: readonly ErrorCategory[] = ['network', 'proxy', 'dns', 'timeout', 'model'];
