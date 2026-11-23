const fs = require('fs');
const path = require('path');
const dir = 'D:/file/software/XingYunChuang/resources/web-dist/assets';
const files = fs.readdirSync(dir).filter(f => /^(app-|index-).*\.js$/.test(f));
const cn = /[\u4e00-\u9fff]/;
const strings = new Map(); // literal -> count
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  // 粗略抽取引号字符串字面量
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const s = m[2];
    if (s.length < 2 || s.length > 60) continue;
    if (!cn.test(s)) continue;
    // 过滤明显是代码的（含箭头/大括号/分号）
    if (/[{}<>;=]/.test(s)) continue;
    strings.set(s, (strings.get(s) || 0) + 1);
  }
}
const all = [...strings.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
console.log('files:', files.join(', '));
console.log('unique CN strings:', all.length);
// 按关键词分组抽样
const themes = {
  '对话/聊天': /对话|聊天|消息|发送|输入|提问|回答/,
  '画布/节点': /画布|节点|连线|拖拽|画板|缩放/,
  '流程/工作流': /流程|工作流|编排|运行|执行|步骤/,
  '模型/智能体': /模型|智能体|Agent|agent|提示词|参数/,
  '设置/偏好': /设置|偏好|主题|语言|快捷键|外观/,
  '错误/提示': /错误|失败|超时|重试|请稍|无法|不支持/,
  '积分/额度': /积分|额度|余额|充值|套餐|VIP|会员/,
};
for (const [name, re] of Object.entries(themes)) {
  const hits = all.filter(([s]) => re.test(s)).slice(0, 12).map(([s, c]) => `${s}(${c})`);
  console.log(`\n## ${name} [${all.filter(([s]) => re.test(s)).length}]`);
  console.log(hits.join(' | '));
}
