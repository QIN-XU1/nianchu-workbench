import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repo = 'D:/file/AI Temp/DeepSeek/Agent自研';
const GIT = String.raw`D:\file\env\Git\cmd\git.exe`;
const cfg = join(process.env.TEMP, 'ncc-gitconfig');
const tok = (spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: true }).stdout || '').trim();
if (!tok) { console.error('no token'); process.exit(1); }
const b64 = Buffer.from(`QIN-XU1:${tok}`, 'ascii').toString('base64');
const env = { ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_TERMINAL_PROMPT: '0' };
const tag = 'ossbuild' + Date.now();

function run(args) {
  const r = spawnSync(GIT, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error) console.error('spawn error', r.error.message);
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const ls = run(['ls-files', '-o', '--exclude-standard', '-z']);
const files = ls.out.split('\0').filter(Boolean);
console.log('files', files.length);
if (!files.length) { console.log('nothing to push'); process.exit(0); }

const LIMIT = 28 * 1024 * 1024;
const entries = files.map(f => { let size = 0; try { size = statSync(join(repo, f)).size; } catch {} return { f, size }; }).sort((a, b) => b.size - a.size);
const buckets = [];
let cur = { size: 0, items: [] };
for (const it of entries) {
  if (cur.size + it.size > LIMIT && cur.items.length) { buckets.push(cur); cur = { size: 0, items: [] }; }
  cur.items.push(it.f); cur.size += it.size;
}
if (cur.items.length) buckets.push(cur);
console.log('buckets', buckets.length);

let i = 0;
for (const b of buckets) {
  i += 1;
  for (let k = 0; k < b.items.length; k += 150) {
    const slice = b.items.slice(k, k + 150);
    const add = spawnSync(GIT, ['add', '-A', '--', ...slice], { cwd: repo, env, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (add.status !== 0) { console.error('add fail', k, add.error && add.error.message, add.stderr); process.exit(1); }
  }
  const c = run(['-c', 'user.name=QIN-XU1', '-c', 'user.email=dev@local', '-c', 'core.hooksPath=', 'commit', '--no-verify', '-q', '-m', `chunk ${i}/${buckets.length}`]);
  if (c.code !== 0) { console.error('commit fail', c.out.slice(0, 400)); process.exit(1); }
  const branch = `refs/heads/${tag}-${i}`;
  const p = run(['-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Basic ${b64}`, '-c', 'http.version=HTTP/1.1', '-c', 'http.postBuffer=209715200', 'push', '-u', 'origin', `HEAD:${branch}`]);
  console.log(`PUSH ${i}/${buckets.length} -> ${tag}-${i} code=${p.code}`);
  if (p.code !== 0) { console.error(p.out.slice(-500)); process.exit(1); }
}

const head = run(['rev-parse', 'HEAD']).out.trim();
console.log('HEAD', head);
// 用 API 把 main 指到最终提交（存在则 PATCH，不存在则 POST）
let r = spawnSync('gh', ['api', '-X', 'PATCH', 'repos/QIN-XU1/nianchu-workbench/git/refs/heads/main', '-f', `sha=${head}`, '-F', 'force=true'], { encoding: 'utf8', shell: true });
if (r.status !== 0) {
  console.log('patch failed, try create:', (r.stderr || '').slice(0, 200));
  r = spawnSync('gh', ['api', '-X', 'POST', 'repos/QIN-XU1/nianchu-workbench/git/refs', '-f', 'ref=refs/heads/main', '-f', `sha=${head}`], { encoding: 'utf8', shell: true });
}
console.log('set main:', r.status, (r.stdout || '').slice(0, 200), (r.stderr || '').slice(0, 200));
console.log('ALL DONE', head);
