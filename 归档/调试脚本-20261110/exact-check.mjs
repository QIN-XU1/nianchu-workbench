const CDP_PORT = 9333;

function CDP(u) {
  let ws = null, id = 1; const p = new Map();
  return {
    async connect() {
      return new Promise((res, rej) => {
        ws = new WebSocket(u);
        const t = setTimeout(() => rej(new Error('超时')), 5000);
        ws.addEventListener('open', () => { clearTimeout(t); res(); });
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('失败')); });
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch { return; }
          if (m.id && p.has(m.id)) { const { resolve, reject } = p.get(m.id); p.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
        });
      });
    },
    send(method, params = {}) {
      const i = id++;
      return new Promise((res, rej) => { p.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (p.has(i)) { p.delete(i); rej(new Error('超时')); } }, 20000); });
    },
    async eval(e) {
      const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 错误');
      return r.result?.value;
    },
    close() { try { ws.close(); } catch { /* ignore */ } }
  };
}

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
const engWv = targets.filter(t => t.type === 'webview' && t.url.includes('3080'));
const cdp = CDP(engWv[0].webSocketDebuggerUrl);
await cdp.connect();

try {
  console.log('=== 精确判定：真的收到 AI 回复了吗 ===');
  const r = await cdp.eval(`(function(){
    var text = document.body.innerText || '';

    // 找所有消息块
    var msgs = [];
    document.querySelectorAll('[class*="message"], [class*="Message"], [data-role], [class*="turn"]').forEach(function(el){
      var t = (el.textContent || '').trim();
      if (t && t.length > 3 && t.length < 500) {
        msgs.push({ cls: String(el.className).slice(0, 25), text: t.slice(0, 100) });
      }
    });

    return {
      // 关键判据：出现「网关测试成功」且不在我的提问里
      // 提问是我发的：「请只回复"网关测试成功"五个字」
      // 回复应该是纯「网关测试成功」
      hasBareReply: /^网关测试成功$/m.test(text),
      // 是否还有 QUOTA
      quotaCount: (text.match(/额度已用尽/g) || []).length,
      // 助手回复的特征
      assistantBlocks: msgs.filter(function(m){ return /assistant|reply|answer|markdown/i.test(m.cls); }).length,
      messageBlocks: msgs.slice(0, 8),
      // 最后 300 字
      tail: text.slice(-300),
      // 有没有"处理失败"
      failCount: (text.match(/处理失败/g) || []).length,
    };
  })()`);

  console.log('  纯"网关测试成功"出现: ' + r.hasBareReply);
  console.log('  QUOTA 出现次数     : ' + r.quotaCount);
  console.log('  "处理失败"次数     : ' + r.failCount);
  console.log('  助手消息块         : ' + r.assistantBlocks);
  console.log();
  console.log('  消息块:');
  for (const m of r.messageBlocks) {
    console.log(`    .${m.cls.padEnd(26)} "${m.text}"`);
  }
  console.log();
  console.log('  界面尾部:');
  console.log(r.tail);

  console.log();
  console.log('=== 结论 ===');
  if (r.hasBareReply && r.failCount === 0) {
    console.log('  ✓ 网关真的通了！AI 回复了「网关测试成功」');
  } else if (r.quotaCount > 0 && r.failCount > 0) {
    console.log('  ✗ 仍是 QUOTA 错误 —— 网关模型未真正生效');
    console.log('     （之前 hasSuccess=true 是误报：匹配到了我自己的提问文本）');
  } else {
    console.log('  ? 状态不明');
  }
} finally {
  cdp.close();
}
