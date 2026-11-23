/**
 * 最小 OpenAI 兼容 mock 服务。
 * 目的：让 dsh 的 llm-pi-ai adapter 连到这里，从而**不接触任何真实凭据**就能驱动一个真实会话。
 * 只实现 /v1/chat/completions（非流式 + 流式 SSE），返回一段固定文本。
 */
const http = require('node:http');

const PORT = Number(process.argv[2] || 8899);
let requestCount = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'mock' }],
    }));
    return;
  }

  if (req.url && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      requestCount++;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const stream = parsed.stream === true;
      const reply = `MOCK-OK #${requestCount} (stream=${stream})`;

      const payload = {
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 0,
        model: 'mock-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: reply },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };

      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      const done = {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'mock-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found', code: 404 } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm listening on http://127.0.0.1:${PORT}`);
});
