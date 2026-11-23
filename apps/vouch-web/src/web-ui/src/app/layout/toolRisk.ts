/**
 * 命令风险分级（纯展示，不拦截）
 *
 * 为什么要有：动手模式的工具卡会把 `bash({"command":"rm -rf ..."})` 原样摆出来，
 * 用户得自己读命令才知道这条会不会毁东西。CodeBuddy CN 的做法是给三级提示
 * （高风险命令，可能影响系统稳定性 / 中风险命令，请谨慎执行）。
 *
 * 边界（刻意）：**只分级、不拦截、不确认**——`总纲.md:18` 把「越界拦截类安全机制」
 * 列为非目标，所以这里最多给一个徽标，绝不阻断执行。
 *
 * 判定原则：**不确定就返回 null**。给「低风险」一个假结论，比不给更危险——
 * 用户会因此放心执行一条其实会毁数据的命令。
 */

export type ToolRiskLevel = 'high' | 'medium' | 'low';

export interface ToolRisk {
  level: ToolRiskLevel;
  /** 命中的那条规则（给 title 用，让用户知道凭什么）。 */
  rule: string;
  /** 一句人话解释。 */
  reason: string;
}

/** 只有这些工具是「执行命令」，其它工具（read/glob/write…）不参与分级。 */
const COMMAND_TOOL_RE = /^(bash|shell|sh|zsh|pwsh|powershell|cmd|exec|execute|execute_command|run_command|terminal)$/i;

interface Rule {
  level: ToolRiskLevel;
  /** 命中即算。全部按小写命令匹配。 */
  test: RegExp;
  rule: string;
  reason: string;
}

/**
 * 顺序即优先级：先判高危，再判中危，最后才是只读白名单。
 * 例如 `rm -rf` 同时命中 `rm` 与 `rm -rf`，必须落在 high。
 */
const RULES: readonly Rule[] = [
  { level: 'high', test: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/, rule: 'rm -rf', reason: '递归强制删除，删掉的文件不进回收站' },
  { level: 'high', test: /\bdel\s+\/[fsq]\b/, rule: 'del /f /s /q', reason: 'Windows 递归强制删除' },
  { level: 'high', test: /\brd\s+\/s\b|\brmdir\s+\/s\b/, rule: 'rd /s', reason: 'Windows 递归删除目录' },
  { level: 'high', test: /\bformat\s+[a-z]:/, rule: 'format', reason: '格式化磁盘分区' },
  { level: 'high', test: /\bshutdown\b/, rule: 'shutdown', reason: '关机/重启' },
  { level: 'high', test: /\breg\s+delete\b/, rule: 'reg delete', reason: '删除注册表项' },
  { level: 'high', test: /\bgit\s+reset\s+--hard\b/, rule: 'git reset --hard', reason: '丢弃所有未提交改动' },
  { level: 'high', test: /\bgit\s+clean\s+-[a-z]*f/, rule: 'git clean -f', reason: '删除未跟踪文件' },
  { level: 'high', test: /\bdd\s+if=/, rule: 'dd if=', reason: '按块覆写设备/文件，写错盘即毁' },
  { level: 'high', test: /\bmkfs(\.\w+)?\b/, rule: 'mkfs', reason: '重新制作文件系统' },
  { level: 'high', test: /\bchmod\s+-R\s+777\b|\bchmod\s+777\b/, rule: 'chmod 777', reason: '把权限放到所有人可写可执行' },
  { level: 'high', test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, rule: 'curl | sh', reason: '把远端脚本直接交给 shell 执行' },
  { level: 'high', test: /\bdrop\s+table\b/, rule: 'DROP TABLE', reason: '删除整张数据表' },
  { level: 'high', test: /\btruncate\s+(table\s+)?\w+/, rule: 'truncate', reason: '清空表/文件内容' },

  // 裸 rm / rm -r（不带 -f）比 -rf 轻：仍会删除，但至少不是「强制递归」一步到位。
  { level: 'medium', test: /\brm\s+/, rule: 'rm', reason: '删除文件（不进回收站，无法恢复）' },
  { level: 'medium', test: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b/, rule: '包管理器安装', reason: '会写 node_modules 并可能触发安装脚本' },
  { level: 'medium', test: /\bpip3?\s+install\b/, rule: 'pip install', reason: '会改动 Python 环境' },
  { level: 'medium', test: /\bgit\s+push\b/, rule: 'git push', reason: '推送到远端，影响他人' },
  { level: 'medium', test: /\bgit\s+checkout\s+--\s/, rule: 'git checkout --', reason: '丢弃指定文件的改动' },
  { level: 'medium', test: /\bgit\s+commit\s+--amend\b/, rule: 'git commit --amend', reason: '改写上一条提交' },
  { level: 'medium', test: /\bmv\b/, rule: 'mv', reason: '移动/改名，可能覆盖目标' },
  { level: 'medium', test: /\bcp\s+-[a-z]*r/, rule: 'cp -r', reason: '递归复制，可能覆盖目标' },
  { level: 'medium', test: /\bdocker\s+(rm|rmi|down)\b/, rule: 'docker rm/down', reason: '删除容器/镜像' },
  { level: 'medium', test: /\bsetx\b/, rule: 'setx', reason: '写系统环境变量' },
  { level: 'medium', test: /\bchmod\s+/, rule: 'chmod', reason: '修改文件权限' },
  { level: 'medium', test: /\b(taskkill|kill)\b/, rule: 'kill/taskkill', reason: '结束进程' },
];

/** 只读白名单：命中才算 low；不命中任何规则且不在白名单 → null（不猜）。 */
const READONLY_RE = /^\s*(ls|dir|cat|type|head|tail|grep|rg|find|fd|pwd|cd|echo|which|where|stat|wc|du|df|tree|git\s+(status|log|diff|show|branch|remote|rev-parse)|node\s+-v|npm\s+-v|pnpm\s+-v)\b/;

function extractCommand(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'cmd', 'script', 'input', 'args']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        return (value as string[]).join(' ');
      }
    }
  }
  return null;
}

/**
 * 给一条工具调用分级。
 *
 * @param tool 工具名（`bash` / `read` / …）
 * @param input 工具入参（对象或命令串）
 * @returns 分级结果；非命令类工具、空命令、无法判定时返回 null
 */
export function classifyToolRisk(tool: string | undefined | null, input: unknown): ToolRisk | null {
  if (!tool || !COMMAND_TOOL_RE.test(String(tool).trim())) return null;
  const command = extractCommand(input);
  if (!command) return null;
  // 只看前 4KB：超长命令分级没意义，也避免正则在大串上回溯。
  const text = command.slice(0, 4096).toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(text)) return { level: rule.level, rule: rule.rule, reason: rule.reason };
  }
  if (READONLY_RE.test(text)) {
    return { level: 'low', rule: '只读命令', reason: '只读取信息，不改动文件或系统状态' };
  }
  return null;
}

/** 徽标文案（符号 + 文字，不只靠颜色）。 */
export const TOOL_RISK_LABEL: Record<ToolRiskLevel, string> = {
  high: '⛔ 高风险',
  medium: '⚠ 中风险',
  low: '○ 只读',
};
