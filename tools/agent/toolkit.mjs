#!/usr/bin/env node
/**
 * 念初 · 工具集（照搬 Claude Code / openclaude 的工具契约与语义）
 *
 * ══ 为什么是这几个工具、为什么这么定义 ══════════════════════════
 * 参照 D:/refs/openclaude（TypeScript 版 Claude Code，3514 个 ts 文件）。
 * 它的工具实现深度耦合自己的 analytics / LSP / 权限栈，逐文件搬会拖进几十个模块，
 * 所以这里搬的是**契约和语义**，不是源码：
 *
 *   工具        语义要点（直接对齐 openclaude 的 prompt 描述）
 *   ────────────────────────────────────────────────────────────
 *   bash        在 cwd 里执行 shell，返回 stdout/stderr/exit_code，超时与输出截断
 *   read        按行读取，带行号；offset 是 1 基行号，limit 是行数
 *   write       整文件写入（覆盖），自动建父目录
 *   edit        **old_string 必须在文件里唯一**，否则失败；replace_all 用于全局替换
 *   glob        按通配符找文件
 *   grep        按正则搜内容，带行号与文件名
 *
 * 忠实保留的关键约束：edit 的非唯一性必须**报错**而不是猜一个位置改
 * （这是 Claude Code 的原话：「The edit will FAIL if old_string is not unique」）。
 *
 * ══ 安全边界如实说 ═════════════════════════════════════════════
 * 本项目硬约束是「越界拦截类安全机制不做」，且用户明确只自用。
 * 所以这里**没有**做路径沙箱：bash 能跑任何命令，文件工具能读写任何路径。
 * 只做了操作本身必要的防护（超时、输出上限、二进制文件拒读），不是安全隔离。
 */

import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, statSync, mkdirSync, existsSync, readdirSync,
} from 'node:fs';
import { dirname, join, isAbsolute, resolve, relative, sep } from 'node:path';
import { addNetTools, sniffImageMime } from './toolkit-net.mjs';
import { prepareEnv } from './session.mjs';
export { sniffImageMime };
import { load as memLoad, save as memSave, put as memPut } from '../memory/store.mjs';
import { recallMemory } from './context.mjs';

const MAX_OUTPUT_CHARS = 30000;
const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 260000;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_RESULTS = 250;

/** 二进制探测：前 8KB 里有 NUL 就当二进制，不按文本读 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function truncate(text, cap = MAX_OUTPUT_CHARS) {
  if (typeof text !== 'string') return { text: String(text ?? ''), truncated: false };
  if (text.length <= cap) return { text, truncated: false };
  const head = text.slice(0, cap);
  return {
    text: head + '\n\n[...输出过长，已截断。原始 ' + text.length + ' 字符，仅显示前 ' + cap + ' 字符]',
    truncated: true,
  };
}

function resolvePath(p, cwd) {
  if (!p) return cwd;
  return isAbsolute(p) ? p : resolve(cwd, p);
}

// ── 通配符 → 正则（支持 * ? ** ）──
function globToRegExp(pattern) {
  const norm = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') {
        // ** 匹配任意层级
        re += '.*';
        i++;
        if (norm[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$');
}

/** 递归遍历（跳过 .git / node_modules 之类的重目录时由调用方决定） */
function walk(root, opts = {}) {
  const { skipDirs = new Set(['.git', 'node_modules', '.venv', '__pycache__']), maxFiles = 20000 } = opts;
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

/**
 * 工具定义。每个都是 {name, description, input_schema, readOnly, call(input, ctx)}
 * input_schema 用 JSON Schema（喂给模型的 function.parameters）。
 * ctx = { cwd }
 */
/**
 * 执行环境隔离（A2 终端执行的一部分）。
 *
 * ══ 为什么要有它 ═════════════════════════════════════════════
 * 原来 bash 用 `spawn(..., { shell: true })` **继承全部父环境变量** —— 也就是说
 * 任何 API key / token / 密码只要在宿主进程里，跑一条 `echo` 就能读出来并写进 transcript。
 * 这是"执行"层最容易被忽视的泄漏面。
 *
 * 所以改成**白名单**：只给子进程系统必需的那些变量，凡是名字像密钥的一律剥掉。
 *
 * ══ 诚实边界（重要）══════════════════════════════════════════
 * 这**不是沙箱**。它只做环境变量隔离，不做：
 *   · 文件系统边界（`cd ..` 之后照样能读写上级目录）
 *   · 网络隔离、CPU/内存限额
 *   · 系统调用过滤
 * 真正的 OS 级沙箱（seatbelt / bubblewrap / 容器）本轮**没有实现**，
 * 所以 A2 的「沙箱」这一半我仍判「部分」，不吹成「有」。
 */
export function buildSandboxEnv(parentEnv = process.env) {
  /** 系统必需：不给这些，连 `node` 都跑不起来 */
  const KEEP = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR',
    'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'LANG', 'LC_ALL', 'SHELL', 'TERM', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
    'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  ];
  const SENSITIVE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;
  const out = {};
  for (const [k, v] of Object.entries(parentEnv || {})) {
    if (v === undefined) continue;
    if (SENSITIVE.test(k)) continue;            // 像密钥的一律不给
    if (KEEP.includes(k)) out[k] = v;
  }
  // 兜底：至少要有 PATH，否则命令全找不到
  if (!out.PATH && !out.Path) out.PATH = parentEnv?.PATH || '/usr/bin:/bin';
  return out;
}

export function createToolkit({ cwd = process.cwd(), changeset = null, subagentDepth = 0, subagentDepthLimit = 2 } = {}) {
  /**
   * changeset 是可选钩子 {before(abs), after(abs)}。
   * 给了就在**真正写盘之前**抓原内容，之后记新内容 —— 这样一次 agent 运行
   * 就能算出一份 diff，并且能整体回滚。没给就只是普通读写（自检/测试用）。
   */
  const csBefore = (abs) => { try { changeset?.before?.(abs); } catch { /* 记录失败不影响写 */ } };
  const csAfter = (abs) => { try { changeset?.after?.(abs); } catch { /* ignore */ } };
  const tools = {};

  // ── bash ──────────────────────────────────────────────────
  tools.bash = {
    name: 'bash',
    readOnly: false,
    description: [
      '在项目目录里执行 shell 命令。用于跑构建、测试、git、查看目录等。',
      '返回 stdout、stderr 和退出码。命令有超时保护，输出过长会被截断。',
      '不要用它读写文件内容（用 read/write/edit 工具）。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeout_ms: { type: 'number', description: '超时毫秒，默认 120000，最大 600000' },
        session: { type: 'string', description: '可选：会话快照名。执行前会重放该快照的环境变量' },
        env_kind: { type: 'string', enum: ['local', 'scratch'], description: '可选：local=真实 HOME；scratch=隔离临时 HOME/工作目录' },
      },
      required: ['command'],
    },
    call: (input, ctx) => new Promise((res) => {
      const timeout = Math.min(Math.max(Number(input.timeout_ms) || 120000, 1000), 600000);
      /**
       * A2：执行环境 = 白名单 env + 可选会话快照重放 + 可选 scratch 隔离目录。
       * prepareEnv 是同步的（快照读盘），所以直接在 Promise 执行器里算。
       */
      const prep = prepareEnv({
        kind: input.env_kind === 'scratch' ? 'scratch' : 'local',
        session: input.session || (ctx && ctx.session) || null,
        cwd: ctx.cwd,
        baseEnv: process.env,
      });
      const child = spawn(String(input.command), {
        shell: true,
        cwd: prep.cwd,
        windowsHide: true,
        env: prep.env,
      });
      let out = '';
      let err = '';
      let killed = false;
      /**
       * Windows 上 child.kill() 只杀 shell 本身，杀不掉孙子进程
       * （实测：`ping -n 6` 在 cmd 里，1.2s 超时后仍挂满 5s 才返回）。
       * 所以 Windows 用 taskkill /T /F 杀整棵进程树。
       */
      const timer = setTimeout(() => {
        killed = true;
        if (process.platform === 'win32' && child.pid) {
          try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
              .on('error', () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } });
          } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
        } else {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, timeout);
      child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT_CHARS * 2) out += d.toString(); });
      child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT_CHARS * 2) err += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(timer);
        res({ ok: false, exit_code: -1, stdout: '', stderr: '启动失败: ' + e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const so = truncate(out);
        const se = truncate(err);
        res({
          envKind: prep.kind,
          session: prep.session ? prep.session.name : null,
          scratchDir: prep.scratchDir,
          envWarnings: prep.warnings,
          ok: !killed && code === 0,
          exit_code: killed ? -1 : code,
          stdout: so.text,
          stderr: se.text,
          truncated: so.truncated || se.truncated,
          timed_out: killed,
        });
      });
    }),
  };

  // ── read ──────────────────────────────────────────────────
  tools.read = {
    name: 'read',
    readOnly: true,
    description: [
      '读取文本文件。返回带行号的内容（形如 "   12→..."）。',
      'offset 是起始行号（1 基，默认 1），limit 是读取行数（默认 2000）。',
      '二进制文件会被拒绝。文件很大时请用 offset/limit 分段读。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径（绝对或相对 cwd）' },
        offset: { type: 'number', description: '起始行号，1 基，默认 1' },
        limit: { type: 'number', description: '读取行数，默认 2000' },
      },
      required: ['file_path'],
    },
    call: (input, ctx) => {
      const p = resolvePath(String(input.file_path), ctx.cwd);
      if (!existsSync(p)) return { ok: false, error: '文件不存在: ' + p };
      const st = statSync(p);
      if (st.isDirectory()) return { ok: false, error: '这是目录，不是文件: ' + p };
      let buf;
      try { buf = readFileSync(p); } catch (e) { return { ok: false, error: '读不了: ' + e.message }; }
      if (looksBinary(buf)) return { ok: false, error: '看起来是二进制文件，拒绝按文本读取: ' + p };

      const text = buf.toString('utf8');
      const allLines = text.split('\n');
      const total = allLines.length;
      const offset = Math.max(1, Number(input.offset) || 1);
      const limit = Math.min(Math.max(Number(input.limit) || MAX_READ_LINES, 1), MAX_READ_LINES);
      const slice = allLines.slice(offset - 1, offset - 1 + limit);

      let body = '';
      let chars = 0;
      let cut = false;
      for (let i = 0; i < slice.length; i++) {
        const line = String(offset + i).padStart(6, ' ') + '→' + slice[i] + '\n';
        if (chars + line.length > MAX_READ_CHARS) { cut = true; break; }
        body += line;
        chars += line.length;
      }
      return {
        ok: true,
        file_path: p,
        total_lines: total,
        offset,
        limit,
        shown_lines: cut ? null : slice.length,
        content: body,
        truncated: cut || offset - 1 + limit < total,
      };
    },
  };

  // ── write ─────────────────────────────────────────────────
  tools.write = {
    name: 'write',
    readOnly: false,
    description: [
      '把内容整体写入文件（覆盖已存在文件，不存在则创建）。会自动创建父目录。',
      '如果只想改文件的一小部分，请用 edit 工具，不要整份重写。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['file_path', 'content'],
    },
    call: (input, ctx) => {
      const p = resolvePath(String(input.file_path), ctx.cwd);
      const content = String(input.content ?? '');
      try {
        mkdirSync(dirname(p), { recursive: true });
        csBefore(p);
        writeFileSync(p, content, 'utf8');
        csAfter(p);
      } catch (e) {
        return { ok: false, error: '写入失败: ' + e.message };
      }
      return {
        ok: true,
        file_path: p,
        bytes: Buffer.byteLength(content, 'utf8'),
        lines: content.split('\n').length,
      };
    },
  };

  // ── edit ──────────────────────────────────────────────────
  tools.edit = {
    name: 'edit',
    readOnly: false,
    description: [
      '在文件里替换一段文本。old_string 必须在文件中**唯一**出现，否则会失败 ——',
      '失败时请提供更多上下文让 old_string 唯一，或用 replace_all 全局替换。',
      '替换后的 new_string 会原样写回，注意保留缩进。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换的原文（必须唯一）' },
        new_string: { type: 'string', description: '替换成什么' },
        replace_all: { type: 'boolean', description: '是否替换所有出现处，默认 false' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
    call: (input, ctx) => {
      const p = resolvePath(String(input.file_path), ctx.cwd);
      if (!existsSync(p)) return { ok: false, error: '文件不存在: ' + p };
      let text;
      try { text = readFileSync(p, 'utf8'); } catch (e) { return { ok: false, error: '读不了: ' + e.message }; }

      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      if (oldStr === '') return { ok: false, error: 'old_string 不能为空' };
      if (oldStr === newStr) return { ok: false, error: 'old_string 与 new_string 相同，没有意义' };

      // 统计出现次数
      let count = 0;
      let idx = 0;
      while (true) {
        const found = text.indexOf(oldStr, idx);
        if (found < 0) break;
        count++;
        idx = found + oldStr.length;
        if (count > 10000) break;
      }
      if (count === 0) {
        return { ok: false, error: '文件里找不到 old_string。请先 read 确认原文（注意空白与缩进）。' };
      }
      if (count > 1 && !input.replace_all) {
        return {
          ok: false,
          error: 'old_string 在文件里出现 ' + count + ' 次，不唯一，拒绝修改。'
            + '请提供更多上下文让它唯一，或显式传 replace_all=true。',
          occurrences: count,
        };
      }

      const next = input.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, newStr);
      try {
        csBefore(p);
        writeFileSync(p, next, 'utf8');
        csAfter(p);
      } catch (e) { return { ok: false, error: '写入失败: ' + e.message }; }
      return {
        ok: true,
        file_path: p,
        replacements: input.replace_all ? count : 1,
        bytes: Buffer.byteLength(next, 'utf8'),
      };
    },
  };

  // ── glob ──────────────────────────────────────────────────
  tools.glob = {
    name: 'glob',
    readOnly: true,
    description: [
      '按通配符查找文件，例如 "**/*.ts"、"src/**/*.json"。',
      '返回匹配的文件路径（相对 cwd）。默认跳过 .git/node_modules。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '通配符，如 **/*.ts' },
        path: { type: 'string', description: '搜索根目录，默认 cwd' },
      },
      required: ['pattern'],
    },
    call: (input, ctx) => {
      const root = resolvePath(input.path ? String(input.path) : '', ctx.cwd);
      if (!existsSync(root)) return { ok: false, error: '目录不存在: ' + root };
      const re = globToRegExp(String(input.pattern));
      const files = walk(root);
      const hits = [];
      for (const f of files) {
        const rel = relative(root, f).split(sep).join('/');
        const base = f.split(/[\\/]/).pop();
        // 同时尝试匹配相对路径和纯文件名（"*.ts" 这类只写名字的也能命中）
        if (re.test(rel) || re.test(base)) hits.push(rel);
        if (hits.length >= MAX_GLOB_RESULTS) break;
      }
      hits.sort();
      return {
        ok: true,
        root,
        pattern: String(input.pattern),
        count: hits.length,
        files: hits,
        truncated: hits.length >= MAX_GLOB_RESULTS,
      };
    },
  };

  // ── grep ──────────────────────────────────────────────────
  tools.grep = {
    name: 'grep',
    readOnly: true,
    description: [
      '按正则表达式搜索文件内容，返回「文件:行号: 内容」。',
      'include 用通配符限定文件，例如 "*.ts"。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索根目录，默认 cwd' },
        include: { type: 'string', description: '只搜匹配此通配符的文件，如 *.ts' },
        ignore_case: { type: 'boolean', description: '是否忽略大小写' },
      },
      required: ['pattern'],
    },
    call: (input, ctx) => {
      const root = resolvePath(input.path ? String(input.path) : '', ctx.cwd);
      if (!existsSync(root)) return { ok: false, error: '目录不存在: ' + root };
      let re;
      try {
        re = new RegExp(String(input.pattern), input.ignore_case ? 'i' : '');
      } catch (e) {
        return { ok: false, error: '正则不合法: ' + e.message };
      }
      const includeRe = input.include ? globToRegExp(String(input.include)) : null;
      const files = walk(root);
      const hits = [];
      for (const f of files) {
        const base = f.split(/[\\/]/).pop();
        if (includeRe && !includeRe.test(base) && !includeRe.test(f.split(/[\\/]/).join('/'))) continue;
        let buf;
        try { buf = readFileSync(f); } catch { continue; }
        if (buf.length > 4 * 1024 * 1024) continue;
        if (looksBinary(buf)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push({
              file: relative(root, f).split(sep).join('/'),
              line: i + 1,
              text: lines[i].slice(0, 300),
            });
            if (hits.length >= MAX_GREP_RESULTS) break;
          }
        }
        if (hits.length >= MAX_GREP_RESULTS) break;
      }
      return {
        ok: true,
        root,
        pattern: String(input.pattern),
        count: hits.length,
        matches: hits,
        truncated: hits.length >= MAX_GREP_RESULTS,
      };
    },
  };

  // ── remember / recall（跨会话记忆，读写两侧）───────────────
  /**
   * 让 agent **主动**把值得长期记住的事实写进记忆库。
   *
   * 这是 A6「跨会话记忆」的另一半：光读不够，得能写。
   * 写的是带 key 的短事实（部署地址、约定、偏好），不是整段对话。
   */
  tools.remember = {
    name: 'remember',
    readOnly: false,
    description: [
      '把一条值得跨会话记住的事实写入长期记忆。',
      'key 用短标签（如 deploy.target / user.prefers），value 写一句完整事实。',
      '只记稳定信息（约定、地址、偏好）；不要记临时推理过程或整段对话。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '短标签，如 deploy.target' },
        value: { type: 'string', description: '一句事实' },
        ttl_sec: { type: 'number', description: '可选：多少秒后过期（不填=长期）' },
      },
      required: ['key', 'value'],
    },
    call: (input) => {
      const key = String(input.key || '').trim();
      const value = String(input.value || '').trim();
      if (!key || !value) return { ok: false, error: 'key 和 value 都不能为空' };
      try {
        const db = memLoad();
        memPut(db, {
          key, value, source: 'agent', by: 'agent', onConflict: 'supersede',
          ttlSec: input.ttl_sec ? Number(input.ttl_sec) : null,
        });
        memSave(db);
        return { ok: true, key, stored: true };
      } catch (e) {
        return { ok: false, error: '写入记忆失败: ' + (e && e.message ? e.message : String(e)) };
      }
    },
  };

  tools.recall = {
    name: 'recall',
    readOnly: true,
    description: '按关键词检索长期记忆，返回相关事实（key + value）。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词' },
        limit: { type: 'number', description: '最多几条，默认 6' },
      },
      required: ['query'],
    },
    call: (input) => {
      const r = recallMemory(String(input.query || ''), { limit: Number(input.limit) || 6 });
      return {
        ok: true,
        count: r.hits.length,
        hits: r.hits,
        note: r.block ? '已找到相关记忆' : '没有相关记忆（不是错误，只是没记过）',
      };
    },
  };

  // ── todo_write（计划图层，对标 dsh tool-todo / Qoder 计划面板）──
  /**
   * 维护「本次任务的计划清单」。
   *
   * 契约照 dsh 的 todo 工具：**整表替换**（不是追加）、三项状态、
   * 同一时刻最多一项 in_progress。之所以要整表替换：模型的增量编辑
   * 很容易和上一版对不上（漏改、重排），整表提交每次都自洽。
   *
   * 校验都在这里做，**不静默纠正** —— 错了就把原因喂回模型让它重写，
   * 否则界面上会出现一份「看起来对、其实和模型想的不一样」的计划。
   */
  tools.todo_write = {
    name: 'todo_write',
    readOnly: false,
    description: [
      '维护本次任务的计划清单（整表替换，不是追加）。',
      '每项 {content, status}，status 只能是 pending / in_progress / completed。',
      '同一时刻最多一项 in_progress：做完一项先标 completed，再开下一项。',
      '多步骤任务开始前先写计划；用户会从计划面板看到进度。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整计划清单（整表替换）',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '一项具体工作，一句话说清' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    call: (input) => {
      const raw = Array.isArray(input && input.todos) ? input.todos : null;
      if (!raw) return { ok: false, error: 'todos 必须是数组' };
      const todos = [];
      const seen = new Set();
      for (let i = 0; i < raw.length; i++) {
        const t = raw[i] || {};
        const content = String(t.content || '').trim();
        const status = String(t.status || 'pending');
        if (!content) return { ok: false, error: `第 ${i + 1} 项 content 为空` };
        if (content.length > 200) return { ok: false, error: `第 ${i + 1} 项 content 超过 200 字` };
        if (!['pending', 'in_progress', 'completed'].includes(status)) {
          return { ok: false, error: `第 ${i + 1} 项 status 非法：${status}（只能是 pending/in_progress/completed）` };
        }
        if (seen.has(content)) return { ok: false, error: '计划里有重复项：' + content };
        seen.add(content);
        todos.push({ content, status });
      }
      const inProgress = todos.filter((t) => t.status === 'in_progress').length;
      if (inProgress > 1) {
        return { ok: false, error: `同一时刻只能有一项 in_progress，现在是 ${inProgress} 项` };
      }
      const completed = todos.filter((t) => t.status === 'completed').length;
      return {
        ok: true,
        todos,
        counts: { total: todos.length, completed, inProgress, pending: todos.length - completed - inProgress },
        allDone: todos.length > 0 && completed === todos.length,
      };
    },
  };

  // ── spawn_subagent（A8：隔离上下文 + 深度上限）──────────────
  /**
   * 让 agent 按需开一个**子代理**去干一件独立的事。
   * 契约照 dsh（subagent-spawn-in-process）：子代理**看不到当前对话**（fresh context），
   * 递归有深度上限。所以适合「这块我不想自己啃，派个人查清楚再回来」。
   */
  tools.spawn_subagent = {
    name: 'spawn_subagent',
    readOnly: false,
    description: [
      '开一个子代理去做一件相对独立的事，它看不到当前对话（全新上下文），只拿到你写的任务描述。',
      '适合：需要独立核实的事实、可以并行推进的一段工作。',
      '你必须把必要背景写进 task，否则子代理不知道上下文。',
      '有递归深度上限：到上限会被拒绝（不是静默降级）。',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给子代理的任务，必须自包含' },
        system_prompt: { type: 'string', description: '可选：子代理的角色设定' },
        depth_limit: { type: 'number', description: '可选：递归深度上限，默认 2' },
      },
      required: ['task'],
    },
    call: async (input, ctx2) => {
      const { spawnSubagent } = await import('./subagent.mjs');
      const depth = Number(ctx2 && ctx2.subagentDepth) || 0;
      const r = await spawnSubagent({
        task: input.task,
        systemPrompt: input.system_prompt,
        depth,
        depthLimit: Number(input.depth_limit) || (ctx2 && ctx2.subagentDepthLimit) || 2,
        cwd: (ctx2 && ctx2.cwd) || process.cwd(),
        // 子代理继承除 spawn 外的工具，避免无限套娃靠 depth 兜底
        tools: ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'remember', 'recall'],
      });
      return {
        ok: r.state === 'PASS',
        state: r.state,
        depth: r.depth,
        reason: r.reason,
        summary: r.finalText ? String(r.finalText).slice(0, 1500) : null,
        toolCalls: r.toolCalls,
        // 子代理内部的工具流（供界面下钻）：只留 tool/ok/ms，最多 20 条。
        // 不返回完整 output —— 父上下文不该被子代理的中间输出撑爆，界面只展示「它调了哪些工具」。
        innerSteps: (Array.isArray(r.transcript) ? r.transcript : [])
          .filter((s) => s && s.kind === 'tool')
          .slice(0, 20)
          .map((s) => ({
            tool: String(s.tool || 'tool'),
            ok: s.ok !== false,
            ms: typeof s.ms === 'number' ? s.ms : null,
          })),
      };
    },
  };

  // 联网与图像工具拆在 toolkit-net.mjs（单文件 32KB 红线）
  addNetTools(tools);

  return tools;
}

/** 某组工具名 → 工具定义数组 */
export function pickTools(all, names) {
  return names.map((n) => {
    const t = all[n];
    if (!t) throw new Error('未知工具: ' + n);
    return t;
  });
}

/** 转成网关要的 OpenAI tools 格式 */
export function toOpenAITools(toolList) {
  return toolList.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}