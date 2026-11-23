import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as P from './project.mjs';

import { fileURLToPath } from 'node:url';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-verify-'));
let pass = 0, fail = 0;
const chk = (name, cond, info = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${info}`); } };

// 1) 正常应 PASS
const r1 = P.verify(REPO, tmp);
chk('正常场景 verify = PASS', r1.state === 'PASS', r1.state);
chk('canonical 技能数 > 0', r1.canonCount > 0, String(r1.canonCount));

// 2) 反例A：canonical 为空（假根）⇒ verify 不应 PASS
const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-root-'));
const r2 = P.verify(emptyRoot, path.join(emptyRoot, 'out'));
chk('反例:canonical 空 ⇒ verify = FAIL', r2.state === 'FAIL', r2.state);

// 3) 反例B：同源检查必须能抓到「某宿主多一个技能」
//    用法：临时替换 renderHost，让 claude 多渲染一个假技能
const orig = P.renderHost;
// 注意：verify 内部调用的是模块内的 renderHost 绑定，ESM 无法直接替换；
// 因此改为直接验证 canonicalIds 与渲染文本的一致性逻辑是否对差异敏感。
const skills = P.readCanonical(REPO).skills;
const bad = [...skills, { name: 'fake-skill', description: 'x' }];
const goodText = orig(P.HOSTS[0], skills, { at: 'T' });
const badText = orig(P.HOSTS[0], bad, { at: 'T' });
const idsOf = (t) => [...t.matchAll(/^- `([a-z0-9][a-z0-9-]*)` —/gm)].map((m) => m[1]);
chk('反例:多一个技能 ⇒ 抽取的 id 集合确实不同', new Set(idsOf(goodText)).size !== new Set(idsOf(badText)).size);

// 4) 反例C：agents.json 的技能数与 canonical 一致
const j = JSON.parse(P.renderAgentsJson(skills, { at: 'T' }));
chk('agents.json 技能数 == canonical', j.count === skills.length);

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(emptyRoot, { recursive: true, force: true });
console.log(`\n  结果：通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);