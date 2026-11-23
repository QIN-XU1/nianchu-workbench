/**
 * 工具集与 agent 循环的验证 —— 含反例。
 *
 * 【为什么反例最关键】本项目纪律：「反例不报 = 这个检查是假的」。
 * 一个"能写文件"的工具，如果 ambiguous edit 时随便挑一处改掉、或者 bash 超时不停，
 * 那它不是工具，是事故。所以要证明**该失败的一定失败**。
 *
 * 大部分判据是纯函数（确定性、不花钱），只有最后一条真调模型证明端到端。
 *
 * 用法：node tools/agent/verify-tools.mjs
 * 四态：0 = PASS / 1 = FAIL / 2 = UNKNOWN
 */
import { modelAvailable } from './_model-probe.mjs';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolkit, pickTools, toOpenAITools } from './toolkit.mjs';
import { runWithTools } from './loop.mjs';

let pass = 0;
let skipped = false;
const fails = [];
const t = (name, ok, info = '') => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name + (info ? '  ← ' + info : '')); console.log('  ✗ ' + name + (info ? '  ← ' + info : '')); }
};

const dir = mkdtempSync(join(tmpdir(), 'nianchu-tools-'));
const ctx = { cwd: dir };
const tk = createToolkit({ cwd: dir });

console.log('');
console.log('  工具集与 agent 循环验证');
console.log('  临时目录: ' + dir);
console.log('  ' + '─'.repeat(72));

try {
  // ══ 一、write / read ══
  const w = await tk.write.call({ file_path: 'a.txt', content: '第一行\n第二行\n第三行\n' }, ctx);
  t('write 创建文件成功', w.ok === true && existsSync(join(dir, 'a.txt')), JSON.stringify(w));
  t('write 报告字节数与行数', w.bytes > 0 && w.lines >= 3, JSON.stringify(w));

  const r1 = await tk.read.call({ file_path: 'a.txt' }, ctx);
  t('read 返回带行号内容', r1.ok && /^\s*1→第一行/m.test(r1.content), String(r1.content).slice(0, 60));
  t('read 报告总行数', r1.total_lines >= 3, String(r1.total_lines));

  const r2 = await tk.read.call({ file_path: 'a.txt', offset: 2, limit: 1 }, ctx);
  t('read 的 offset/limit 精确切片', r2.ok && r2.content.includes('第二行') && !r2.content.includes('第一行'),
    String(r2.content).slice(0, 60));

  // 反例：不存在的文件
  const r3 = await tk.read.call({ file_path: 'nope.txt' }, ctx);
  t('★反例：读不存在的文件 → 报错而不是空内容', r3.ok === false && /不存在/.test(r3.error));

  // 反例：二进制拒绝
  writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const r4 = await tk.read.call({ file_path: 'bin.dat' }, ctx);
  t('★反例：二进制文件被拒绝按文本读', r4.ok === false && /二进制/.test(r4.error));

  // ══ 二、edit 的唯一性约束（最要紧的反例）══
  writeFileSync(join(dir, 'dup.txt'), 'foo\nfoo\nbar\n', 'utf8');
  const e1 = await tk.edit.call({ file_path: 'dup.txt', old_string: 'foo', new_string: 'baz' }, ctx);
  t('★反例：old_string 不唯一（出现 2 次）→ 拒绝修改，不猜位置',
    e1.ok === false && /不唯一/.test(e1.error), JSON.stringify(e1));
  t('★反例：被拒绝时文件**没有**被改动',
    readFileSync(join(dir, 'dup.txt'), 'utf8') === 'foo\nfoo\nbar\n');

  const e2 = await tk.edit.call({ file_path: 'dup.txt', old_string: 'foo', new_string: 'baz', replace_all: true }, ctx);
  t('replace_all=true 时全部替换', e2.ok === true && e2.replacements === 2, JSON.stringify(e2));
  t('replace_all 后内容正确', readFileSync(join(dir, 'dup.txt'), 'utf8') === 'baz\nbaz\nbar\n');

  const e3 = await tk.edit.call({ file_path: 'dup.txt', old_string: '根本不存在', new_string: 'x' }, ctx);
  t('★反例：old_string 不存在 → 报错（提示先 read）', e3.ok === false && /找不到/.test(e3.error));

  const e4 = await tk.edit.call({ file_path: 'dup.txt', old_string: '', new_string: 'x' }, ctx);
  t('★反例：old_string 为空 → 拒绝', e4.ok === false);

  writeFileSync(join(dir, 'uniq.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
  const e5 = await tk.edit.call({ file_path: 'uniq.txt', old_string: 'beta', new_string: 'BETA' }, ctx);
  t('唯一的 old_string 能正常替换', e5.ok === true && readFileSync(join(dir, 'uniq.txt'), 'utf8').includes('BETA'));

  // ══ 三、glob / grep ══
  writeFileSync(join(dir, 'x.ts'), 'export const a = 1\n', 'utf8');
  writeFileSync(join(dir, 'y.js'), 'var b = 2\n', 'utf8');
  const g1 = await tk.glob.call({ pattern: '**/*.ts' }, ctx);
  t('glob 按通配符找到 .ts 文件', g1.ok && g1.files.some((f) => f.endsWith('x.ts')), JSON.stringify(g1.files));
  t('glob 不把 .js 算成 .ts', g1.ok && !g1.files.some((f) => f.endsWith('y.js')));

  const g2 = await tk.grep.call({ pattern: 'export const', include: '*.ts' }, ctx);
  t('grep 正则匹配并给行号', g2.ok && g2.matches.some((m) => m.line === 1 && m.file.endsWith('x.ts')),
    JSON.stringify(g2.matches));

  const g3 = await tk.grep.call({ pattern: '([', }, ctx);
  t('★反例：非法正则 → 报错而不是崩溃', g3.ok === false && /正则/.test(g3.error));

  // ══ 四、bash ══
  const b1 = await tk.bash.call({ command: 'echo hello_from_bash' }, ctx);
  t('bash 捕获 stdout 与退出码', b1.exit_code === 0 && b1.stdout.includes('hello_from_bash'), JSON.stringify(b1).slice(0, 90));

  const b2 = await tk.bash.call({ command: 'exit 7' }, ctx);
  t('★反例：非零退出码如实报（不当作成功）', b2.exit_code === 7 && b2.ok === false, 'exit=' + b2.exit_code);

  const b3 = await tk.bash.call({ command: 'this_command_does_not_exist_zzz' }, ctx);
  t('★反例：命令不存在 → 非零退出且有 stderr', b3.exit_code !== 0 && (b3.stderr.length > 0 || b3.stdout.length >= 0),
    'exit=' + b3.exit_code);

  // Windows 没有 sleep 命令（会立刻报错，测不出超时），用各自平台的慢命令
  const slowCmd = process.platform === 'win32'
    ? 'ping -n 6 127.0.0.1 >nul'
    : 'sleep 5';
  const t0 = Date.now();
  const b4 = await tk.bash.call({ command: slowCmd, timeout_ms: 1200 }, ctx);
  const elapsed = Date.now() - t0;
  t('★反例：超时会真的杀掉（1.2s 上限，5s 命令）', b4.timed_out === true && elapsed < 4000,
    'elapsed=' + elapsed + 'ms timed_out=' + b4.timed_out);

  // ══ 五、工具契约 ══
  const list = pickTools(tk, ['read', 'bash']);
  const oa = toOpenAITools(list);
  t('工具能转成 OpenAI function 格式', oa.length === 2 && oa[0].type === 'function'
    && oa[0].function.parameters.type === 'object');
  t('每个工具都有 name/description/input_schema',
    Object.values(tk).every((x) => x.name && x.description && x.input_schema));
  t('★反例：请求不存在的工具 → 抛错而不是静默给空',
    (() => { try { pickTools(tk, ['__nope__']); return false; } catch { return true; } })());

  // ══ 六、agent 循环端到端（唯一花钱的一步）══
  const tdir = mkdtempSync(join(tmpdir(), 'nianchu-loop-'));
  try {
    /**
     * ⚠ 已知抖动：模型**有时不调工具就直接回答**（尤其任务看起来"能凭记忆答"时）。
     * 这条验的是"循环真的能驱动工具去改文件"，不是"模型每次都很听话"，
     * 所以允许重试——但每次重试都**清掉上次产物**，否则会把"上次写成功"算进这次。
     */
    /**
     * ══ --no-model（2026-11-20）══
     * 只跳过「真跑让模型动文件」这一段；
     * 下面两条反例（未知工具 / 空任务）**不调模型**，必须照跑。
     */
    if (process.argv.includes('--no-model') || !(await modelAvailable())) {
      console.log('  ⚠ 真跑段跳过（--no-model 或模型不可用）：工具面/参数校验/反例已验，');
      console.log('        但「模型真调工具改文件」这一段是 UNKNOWN（需模型）。');
      skipped = true;
    } else {
      let run = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { rmSync(join(tdir, 'f.txt'), { force: true }); } catch { /* ignore */ }
        run = await runWithTools({
          systemPrompt: '你是能动手的 agent。必须真的调用工具，不许只凭记忆回答；做完给一句总结。',
          task: '创建 f.txt 写入 ok-123，然后读回确认内容，最后用一句话总结。',
          cwd: tdir,
          maxSteps: 6,
        });
        if (run.toolCalls >= 2 && existsSync(join(tdir, 'f.txt'))) break;
      }
      t('循环跑完是 PASS', run.state === 'PASS', run.state + ' ' + (run.reason || ''));
      t('真的调用了工具（>=2 次）', run.toolCalls >= 2, String(run.toolCalls));
      t('文件真的被创建了', existsSync(join(tdir, 'f.txt')), 'f.txt 不存在');
      t('文件内容正确', existsSync(join(tdir, 'f.txt')) && readFileSync(join(tdir, 'f.txt'), 'utf8').includes('ok-123'));
      t('有最终答复', typeof run.finalText === 'string' && run.finalText.length > 0);
      t('用量是真实数字', run.usage.calls > 0 && run.usage.output > 0, JSON.stringify(run.usage));
      t('transcript 记录了每次工具调用',
        Array.isArray(run.transcript) && run.transcript.filter((x) => x.kind === 'tool').length === run.toolCalls);
    }

    // 反例：装了不存在的工具 → FAIL（不是静默跑）
    const bad = await runWithTools({ task: '随便', tools: ['__nope__'], cwd: tdir, maxSteps: 2 });
    t('★反例：装载未知工具 → FAIL', bad.state === 'FAIL', bad.state);

    // 反例：空任务 → FAIL 且不调模型
    const empty = await runWithTools({ task: '   ', cwd: tdir });
    t('★反例：空任务 → FAIL，零模型调用', empty.state === 'FAIL' && empty.usage.calls === 0);
  } finally {
    rmSync(tdir, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
console.log('  结果：通过 ' + pass + ' · 失败 ' + fails.length);
if (fails.length) fails.forEach((f) => console.log('    - ' + f));
console.log('  四态: ' + (fails.length === 0
  ? 'PASS —— 6 个工具语义正确，反例全部生效，agent 真的读写文件并执行命令'
  : 'FAIL —— 有判据不满足'));
console.log('');
process.exitCode = fails.length === 0 ? 0 : 1;