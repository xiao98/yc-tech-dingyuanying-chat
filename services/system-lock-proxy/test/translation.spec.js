'use strict';

const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../src/index');
const {
  hasDocumentBlock,
  extractSystemBlocks,
  buildAnthropicBody,
  translateAnthropicResponse,
  createSseTranslator,
} = require('../src/translate');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'skill.md');

function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const records = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const record = { method: req.method, url: req.url, headers: req.headers, rawBody };
        records.push(record);
        try {
          handler(record, req, res);
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end(String(err && err.message));
          }
        }
      });
      req.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        records,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function startProxy({ upstreamBaseUrl, skillPath = FIXTURE_PATH }) {
  return new Promise((resolve) => {
    const { server } = createServer({ upstreamBaseUrl, skillPath });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function rawRequest({ port, method = 'POST', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: p, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

describe('translate.js unit tests', () => {
  test('hasDocumentBlock detects type:document in message content array', () => {
    expect(
      hasDocumentBlock([
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } },
            { type: 'text', text: 'hello' },
          ],
        },
      ])
    ).toBe(true);
    expect(hasDocumentBlock([{ role: 'user', content: 'plain text' }])).toBe(false);
    expect(
      hasDocumentBlock([
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,X' } }],
        },
      ])
    ).toBe(false);
  });

  test('extractSystemBlocks pulls system role + cache_control out and leaves rest in order', () => {
    const { systemBlocks, remaining } = extractSystemBlocks([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'LOCKED', cache_control: { type: 'ephemeral' } },
        ],
      },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
    expect(systemBlocks).toEqual([
      { type: 'text', text: 'LOCKED', cache_control: { type: 'ephemeral' } },
    ]);
    expect(remaining).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  test('buildAnthropicBody preserves cache_control system block + sets max_tokens default', () => {
    const out = buildAnthropicBody(
      {
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        temperature: 0.7,
      },
      [{ type: 'text', text: 'SKILL', cache_control: { type: 'ephemeral' } }]
    );
    expect(out.model).toBe('gpt-5');
    expect(out.max_tokens).toBe(4096);
    expect(out.stream).toBe(true);
    expect(out.temperature).toBe(0.7);
    expect(out.system).toEqual([
      { type: 'text', text: 'SKILL', cache_control: { type: 'ephemeral' } },
    ]);
    expect(out.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  test('translateAnthropicResponse → OpenAI shape with finish_reason map and cached_input_tokens', () => {
    const out = translateAnthropicResponse(
      {
        id: 'msg_abc',
        model: 'claude-x',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 40,
          output_tokens: 25,
        },
      },
      'claude-x'
    );
    expect(out.id).toBe('msg_abc');
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0].message).toEqual({ role: 'assistant', content: 'hello world' });
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage.prompt_tokens).toBe(140);
    expect(out.usage.completion_tokens).toBe(25);
    expect(out.usage.cached_input_tokens).toBe(40);
  });

  test('createSseTranslator emits leading role chunk + content deltas + final stop chunk', () => {
    const t = createSseTranslator({ model: 'gpt-5' });
    const out1 = t.push(
      Buffer.from(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-x"}}\n\n'
      )
    );
    expect(out1).toMatch(/"role":"assistant"/);
    const out2 = t.push(
      Buffer.from(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"丁元英"}}\n\n'
      )
    );
    expect(out2).toMatch(/"content":"丁元英"/);
    const out3 = t.push(
      Buffer.from('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n')
    );
    expect(out3).toBe('');
    const out4 = t.push(Buffer.from('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
    expect(out4).toMatch(/"finish_reason":"stop"/);
    expect(t.flush()).toBe('data: [DONE]\n\n');
  });
});

describe('system-lock-proxy P5 protocol translation', () => {
  test('case A: messages with document block → forwarded to /v1/messages with Anthropic body shape', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5',
          content: [{ type: 'text', text: 'I read your PDF.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      );
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
              },
              { type: 'text', text: '请总结这份 PDF' },
            ],
          },
        ],
        stream: false,
      });
      const resp = await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body,
      });
      expect(resp.statusCode).toBe(200);
      expect(upstream.records.length).toBe(1);
      const rec = upstream.records[0];
      expect(rec.url).toBe('/v1/messages');
      expect(rec.headers['x-api-key']).toBe('sk-test');
      expect(rec.headers['anthropic-version']).toBe('2023-06-01');
      expect(rec.headers.authorization).toBeUndefined();

      const sentBody = JSON.parse(rec.rawBody.toString('utf8'));
      expect(sentBody.model).toBe('gpt-5');
      expect(sentBody.max_tokens).toBeGreaterThan(0);
      // System extracted with cache_control preserved (P2b lock).
      expect(Array.isArray(sentBody.system)).toBe(true);
      expect(sentBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
      // Document block survives intact.
      expect(sentBody.messages[0].role).toBe('user');
      const userParts = sentBody.messages[0].content;
      expect(userParts[0].type).toBe('document');
      expect(userParts[0].source.media_type).toBe('application/pdf');
      expect(userParts[1]).toEqual({ type: 'text', text: '请总结这份 PDF' });

      // Response body translated to OpenAI shape.
      const parsedResp = JSON.parse(resp.body);
      expect(parsedResp.choices[0].message.content).toBe('I read your PDF.');
      expect(parsedResp.choices[0].finish_reason).toBe('stop');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case B: pure-text messages still go to /v1/chat/completions (no translation)', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'cmpl_x', choices: [] }));
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'plain' }],
      });
      const resp = await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body,
      });
      expect(resp.statusCode).toBe(200);
      const rec = upstream.records[0];
      expect(rec.url).toBe('/v1/chat/completions');
      expect(rec.headers.authorization).toBe('Bearer sk-test');
      expect(rec.headers['x-api-key']).toBeUndefined();
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case C: streaming Anthropic SSE → translated to OpenAI delta SSE w/ [DONE]', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"gpt-5"}}\n\n'
      );
      setTimeout(() => {
        res.write(
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
        );
      }, 30);
      setTimeout(() => {
        res.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n'
        );
      }, 60);
      setTimeout(() => {
        res.write(
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n'
        );
      }, 100);
      setTimeout(() => {
        res.write(
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
        );
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
      }, 140);
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-5',
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'AAA=' },
              },
              { type: 'text', text: 'summarize' },
            ],
          },
        ],
      });
      const chunks = [];
      const resp = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: proxy.port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
          },
          (res) => {
            res.on('data', (c) => chunks.push(c.toString('utf8')));
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers }));
            res.on('error', reject);
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers['content-type']).toMatch(/text\/event-stream/);
      const joined = chunks.join('');
      const dataChunks = joined.match(/^data: .+$/gm) || [];
      expect(dataChunks.length).toBeGreaterThanOrEqual(3);
      expect(joined).toMatch(/data: \[DONE\]/);
      // Confirm content deltas were translated.
      expect(joined).toMatch(/"content":"Hello "/);
      expect(joined).toMatch(/"content":"world"/);
      // Final chunk has finish_reason stop.
      expect(joined).toMatch(/"finish_reason":"stop"/);
      // Concatenated text equals the upstream concat.
      const matches = [...joined.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      const totalContent = matches.join('');
      expect(totalContent).toContain('Hello world');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case D: non-streaming → choices[0].message.content shape', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'msg_y',
          type: 'message',
          role: 'assistant',
          model: 'gpt-5',
          content: [{ type: 'text', text: 'OK doc read.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 },
        })
      );
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-5',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'AAA=' },
              },
              { type: 'text', text: 'q' },
            ],
          },
        ],
      });
      const resp = await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body,
      });
      expect(resp.statusCode).toBe(200);
      const json = JSON.parse(resp.body);
      expect(json.object).toBe('chat.completion');
      expect(json.choices[0].message.content).toBe('OK doc read.');
      expect(json.choices[0].finish_reason).toBe('stop');
      expect(json.usage.cached_input_tokens).toBe(2);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case E: path /chat/completions (no /v1) is canonicalized when forwarded', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      });
      await rawRequest({
        port: proxy.port,
        path: '/chat/completions',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body,
      });
      const rec = upstream.records[0];
      expect(rec.url).toBe('/v1/chat/completions');
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });
});
