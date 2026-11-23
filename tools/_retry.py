import io

P = "D:/file/AI Temp/DeepSeek/Agent自研/tools/agent/runtime.mjs"
t = io.open(P, encoding="utf-8").read()

# 给 callModel 加有界重试（网关实测会瞬时 401/5xx）
old = """export async function callModel({ messages, model = DEFAULT_MODEL, maxTokens = 1200, signal } = {}) {
  let res;
  try {
    res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal,
    });
  } catch (e) {
    return {
      state: 'FAIL',
      reason: '模型网关不可达（' + GATEWAY + '）：' + String(e && e.message).slice(0, 160),
    };
  }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 240); } catch { /* ignore */ }
    return { state: 'FAIL', reason: '网关返回 ' + res.status + '：' + body };
  }"""

new = """/**
 * 网关会**瞬时抖动**（2026-11-18 实测：同一个模型，连续请求先是 401
 * "Factory: User not affiliated with an organization"，紧接着 200 ——
 * 是上游临时问题，不是我们的配置错）。
 * 所以对瞬时类错误做**有界重试**（最多 2 次、间隔 800ms），重试后仍失败才如实报。
 * 不重试的情况：4xx 里 400/401 之外，以及明确的鉴权永久错误 —— 那些重试没有意义，只会掩盖真问题。
 */
async function requestGateway(payload, signal) {
  const transient = (status) => status === 408 || status === 425 || status === 429 || status >= 500
    || (status === 401 && /not affiliated|authentication|temporarily/i.test(''));
  const attempts = Number(process.env.NIANCHU_GATEWAY_RETRIES) || 2;
  let last = null;
  for (let i = 0; i <= attempts; i++) {
    let res;
    try {
      res = await fetch(GATEWAY, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      last = { state: 'FAIL', reason: '模型网关不可达（' + GATEWAY + '）：' + String(e && e.message).slice(0, 160) };
      // 连接失败也属于瞬时（网络抖动），重试
      if (i < attempts) { await sleep(800 * (i + 1)); continue; }
      return last;
    }
    if (res.ok) return { res };

    let body = '';
    try { body = (await res.text()).slice(0, 240); } catch { /* ignore */ }
    last = { state: 'FAIL', reason: '网关返回 ' + res.status + '：' + body };

    // 明确不是瞬时错误 → 立刻返回，不重试
    if (!transient(res.status) || i === attempts) return last;
    if (i < attempts) await sleep(800 * (i + 1));
  }
  return last;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function callModel({ messages, model = DEFAULT_MODEL, maxTokens = 1200, signal } = {}) {
  const attempt = await requestGateway({
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
  }, signal);
  if (attempt.state !== 'FAIL' && attempt.res) {
    const res = attempt.res;
    return finishCall(res, model);
  }
  return attempt;
}

/** 从网关响应里取出内容（两个入口共用） */
function finishCall(res, model) {
  if (!res.ok) {
    let body = '';
    try { body = res.text ? '' : ''; } catch { /* ignore */ }
    return { state: 'FAIL', reason: '网关返回 ' + res.status + '（无法读取响应体）' };
  }
  let json;
  try {
    json = res.json ? res.json() : null;
  } catch {
    return { state: 'UNKNOWN', reason: '网关返回了非 JSON：内容不可读' };
  }
  if (json === null) {
    return { state: 'FAIL', reason: '网关返回 ' + res.status + '（响应体为空）' };
  }
  const choice = json && json.choices && json.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string' || content.length === 0) {
    return { state: 'UNKNOWN', reason: '模型返回空内容（choices[0].message.content 为空）' };
  }
  return {
    state: 'PASS',
    content,
    model: json.model || model,
    usage: json.usage || null,
    finishReason: choice.finish_reason || null,
    /**
     * 【2026-11-18 实测补】finish_reason === 'length' 表示**输出被 token 上限截断**。
     * 之前不区分这个，结果交付物在中途断掉，审阅者只能凭"代码末尾是个 `d`"去猜 ——
     * 明明是运行时的预算问题，却变成被审阅的质量问题。
     * 上游拿到 truncated 就该重试或如实标注，而不是让下游猜。
     */
    truncated: (choice.finish_reason || '') === 'length',
  };
}"""
assert old in t, 'callModel 锚点'
t = t.replace(old, new, 1)

# 删掉旧的 callModel 主体（被替换后残留的）
t = t.replace("""  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { state: 'UNKNOWN', reason: '网关返回了非 JSON：' + String(e && e.message).slice(0, 120) };
  }
  const choice = json && json.choices && json.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string' || content.length === 0) {
    return { state: 'UNKNOWN', reason: '模型返回空内容（choices[0].message.content 为空）' };
  }
  return {
    state: 'PASS',
    content,
    model: json.model || model,
    usage: json.usage || null,
    finishReason: choice.finish_reason || null,
    /**
     * 【2026-11-18 实测补】finish_reason === 'length' 表示**输出被 token 上限截断**。
     * 之前不区分这个，结果交付物在中途断掉，审阅者只能凭"代码末尾是个 `d`"去猜 ——
     * 明明是运行时的预算问题，却变成被审阅的质量问题。
     * 上游拿到 truncated 就该重试或如实标注，而不是让下游猜。
     */
    truncated: (choice.finish_reason || '') === 'length',
  };
}""", "}", 1)

# callModelRaw 也走重试
t = t.replace(
    """  let res;
  try {
    res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    return { state: 'FAIL', reason: '模型网关不可达（' + GATEWAY + '）：' + String(e && e.message).slice(0, 160) };
  }
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 240); } catch { /* ignore */ }
    return { state: 'FAIL', reason: '网关返回 ' + res.status + '：' + body };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { state: 'UNKNOWN', reason: '网关返回了非 JSON：' + String(e && e.message).slice(0, 120) };
  }
  const choice = json && json.choices && json.choices[0];
  if (!choice || !choice.message) {
    return { state: 'UNKNOWN', reason: '网关没有返回 choices[0].message' };
  }
  return {
    state: 'PASS',
    message: choice.message,
    model: json.model || model,
    usage: json.usage || null,
    finishReason: choice.finish_reason || null,
    truncated: (choice.finish_reason || '') === 'length',
  };
}""",
    """  const attempt = await requestGateway(payload, signal);
  if (attempt.state === 'FAIL') return attempt;
  let json;
  try {
    json = await attempt.res.json();
  } catch (e) {
    return { state: 'UNKNOWN', reason: '网关返回了非 JSON：' + String(e && e.message).slice(0, 120) };
  }
  const choice = json && json.choices && json.choices[0];
  if (!choice || !choice.message) {
    return { state: 'UNKNOWN', reason: '网关没有返回 choices[0].message' };
  }
  return {
    state: 'PASS',
    message: choice.message,
    model: json.model || model,
    usage: json.usage || null,
    finishReason: choice.finish_reason || null,
    truncated: (choice.finish_reason || '') === 'length',
  };
}""",
    1,
)

io.open(P, "w", encoding="utf-8", newline="\n").write(t)
print("  ✓ callModel/callModelRaw 加有界重试")