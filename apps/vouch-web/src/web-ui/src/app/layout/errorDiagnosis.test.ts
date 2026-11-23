// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { ERROR_CATEGORIES, diagnoseError } from './errorDiagnosis';

describe('diagnoseError · 分类', () => {
  it('network：fetch failed', () => {
    expect(diagnoseError('TypeError: fetch failed')?.category).toBe('network');
  });
  it('network：ECONNREFUSED', () => {
    expect(diagnoseError('connect ECONNREFUSED 127.0.0.1:47124')?.category).toBe('network');
  });
  it('network：连接宿主失败', () => {
    expect(diagnoseError('连接宿主失败：WebSocket closed')?.category).toBe('network');
  });
  it('network：WebSocket connection failed（产品实测遇到的原话）', () => {
    expect(diagnoseError('WebSocket connection failed')?.category).toBe('network');
  });

  it('proxy：407 要求代理认证', () => {
    expect(diagnoseError('HTTP 407 Proxy Authentication Required')?.category).toBe('proxy');
  });
  it('proxy：环境变量代理报错', () => {
    expect(diagnoseError('proxyconnect tcp: dial tcp 127.0.0.1:7890: connect: connection refused')?.category).toBe('proxy');
  });

  it('dns：ENOTFOUND', () => {
    expect(diagnoseError('getaddrinfo ENOTFOUND api.example.com')?.category).toBe('dns');
  });
  it('dns：EAI_AGAIN', () => {
    expect(diagnoseError('getaddrinfo EAI_AGAIN')?.category).toBe('dns');
  });

  it('timeout：ETIMEDOUT', () => {
    expect(diagnoseError('connect ETIMEDOUT 1.2.3.4:443')?.category).toBe('timeout');
  });
  it('timeout：中文「超时」', () => {
    expect(diagnoseError('请求超时，请稍后重试')?.category).toBe('timeout');
  });

  it('model：401 / 429', () => {
    expect(diagnoseError('request failed with status 401')?.category).toBe('model');
    expect(diagnoseError('429 Too Many Requests')?.category).toBe('model');
  });
  it('model：model_not_found', () => {
    expect(diagnoseError('{"error":{"code":"model_not_found"}}')?.category).toBe('model');
  });
  it('model：上下文超限', () => {
    expect(diagnoseError("This model's maximum context length is 8192 tokens")?.category).toBe('model');
  });
});

describe('diagnoseError · 优先级（不许把可行动的信息吞成「网络错误」）', () => {
  it('★proxy 优先于 network（ENOTFOUND 之外，含 proxy 字样按代理处理）', () => {
    expect(diagnoseError('proxy error: socket hang up')?.category).toBe('proxy');
  });
  it('★dns 优先于 network', () => {
    expect(diagnoseError('fetch failed: getaddrinfo ENOTFOUND')?.category).toBe('dns');
  });
});

describe('diagnoseError · 反例（不确定就不猜）', () => {
  it('普通文案 → null', () => {
    expect(diagnoseError('这是一段普通的提示，不是报错')).toBeNull();
  });
  it('空串 / null / undefined → null', () => {
    expect(diagnoseError('')).toBeNull();
    expect(diagnoseError(null)).toBeNull();
    expect(diagnoseError(undefined)).toBeNull();
  });
  it('★裸数字不算状态码（「跑了 403 步」不误判成模型错误）', () => {
    expect(diagnoseError('跑了 403 步')).toBeNull();
  });
  it('不要把自己的产品名/正常句子误判', () => {
    expect(diagnoseError('本次会话累计 1200 tokens')).toBeNull();
  });
});

describe('diagnoseError · 每类都必须有下一步（文案完整性）', () => {
  const sample = {
    network: 'fetch failed',
    proxy: 'HTTP 407 proxy',
    dns: 'getaddrinfo ENOTFOUND x',
    timeout: 'ETIMEDOUT',
    model: '429 too many requests',
  } as const;
  for (const category of ERROR_CATEGORIES) {
    it(category + ' 有 title / nextStep / badge / 保留原文', () => {
      const d = diagnoseError(sample[category]);
      expect(d?.category).toBe(category);
      expect(d?.title).toBeTruthy();
      expect(d?.nextStep).toBeTruthy();
      expect(d?.badge).toBeTruthy();
      expect(d?.detail).toBe(sample[category]);
    });
  }
});
