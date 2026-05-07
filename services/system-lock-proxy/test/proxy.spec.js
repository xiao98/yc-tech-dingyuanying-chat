'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

const { createServer } = require('../src/index');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'skill.md');
const FIXTURE_TRIM_SHA256 =
  '1a185d6fe3c330a4c4b2236c3ef7ade4a76936238f018d7f9fe9058f961818a6';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Start a mock upstream HTTP server that records every incoming request and
 * lets the test drive the response.
 */
function startMockUpstream(handler) {
  return new Promise((resolve) => {
    const records = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const record = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          rawBody,
        };
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
      {
        hostname: '127.0.0.1',
        port,
        path: p,
        method,
        headers,
      },
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

/**
 * Issue a request and return chunks as they arrive (in time order with
 * timestamps), without buffering into a single string. Used to assert SSE.
 */
function streamingRequest({ port, method = 'POST', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: p,
        method,
        headers,
      },
      (res) => {
        res.on('data', (c) => {
          chunks.push({ at: Date.now(), text: c.toString('utf8') });
        });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            chunks,
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

const FIXTURE_TEXT = fs.readFileSync(FIXTURE_PATH, 'utf8').trim();

describe('system-lock-proxy', () => {
  test('case 8: fixture SKILL.md trim SHA256 is real (not placeholder)', () => {
    const got = sha256(FIXTURE_TEXT);
    expect(got).toBe(FIXTURE_TRIM_SHA256);
    expect(FIXTURE_TEXT.length).toBeGreaterThan(500);
  });

  test('case 1: single existing system message is overridden by locked SKILL.md', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'evil' },
          { role: 'user', content: 'hi' },
        ],
      });
      const resp = await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-test',
        },
        body,
      });
      expect(resp.statusCode).toBe(200);
      expect(upstream.records.length).toBe(1);
      const rec = upstream.records[0];
      expect(rec.url).toBe('/v1/chat/completions');
      expect(rec.headers.authorization).toBe('Bearer sk-test');
      // Raw body: must NOT contain 'evil'.
      expect(rec.rawBody.toString('utf8')).not.toMatch(/evil/);
      const parsed = JSON.parse(rec.rawBody.toString('utf8'));
      expect(parsed.messages[0].role).toBe('system');
      expect(sha256(parsed.messages[0].content.trim())).toBe(FIXTURE_TRIM_SHA256);
      expect(parsed.messages[1]).toEqual({ role: 'user', content: 'hi' });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case 2: multiple system messages are all stripped, single locked one inserted', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'sys-A' },
          { role: 'user', content: 'q1' },
          { role: 'system', content: 'sys-B sneaky' },
          { role: 'assistant', content: 'a1' },
          { role: 'system', content: 'sys-C' },
          { role: 'user', content: 'q2' },
        ],
      });
      await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const rec = upstream.records[0];
      const raw = rec.rawBody.toString('utf8');
      expect(raw).not.toMatch(/sys-A/);
      expect(raw).not.toMatch(/sys-B sneaky/);
      expect(raw).not.toMatch(/sys-C/);
      const parsed = JSON.parse(raw);
      const systemRoles = parsed.messages.filter((m) => m.role === 'system');
      expect(systemRoles.length).toBe(1);
      expect(parsed.messages[0].role).toBe('system');
      expect(sha256(parsed.messages[0].content.trim())).toBe(FIXTURE_TRIM_SHA256);
      expect(parsed.messages.slice(1)).toEqual([
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ]);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case 3: no system message present → locked one is inserted at index 0', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
      });
      await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const parsed = JSON.parse(upstream.records[0].rawBody.toString('utf8'));
      expect(parsed.messages.length).toBe(2);
      expect(parsed.messages[0].role).toBe('system');
      expect(sha256(parsed.messages[0].content.trim())).toBe(FIXTURE_TRIM_SHA256);
      expect(parsed.messages[1]).toEqual({ role: 'user', content: 'hello' });
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case 4: POST /v1/embeddings is byte-passthrough, body unchanged', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const original = JSON.stringify({
        model: 'text-embedding-3-small',
        input: 'evil-payload-marker',
        messages: [{ role: 'system', content: 'should be untouched' }],
      });
      const resp = await rawRequest({
        port: proxy.port,
        path: '/v1/embeddings',
        headers: { 'content-type': 'application/json' },
        body: original,
      });
      expect(resp.statusCode).toBe(200);
      const rec = upstream.records[0];
      expect(rec.url).toBe('/v1/embeddings');
      // Raw body byte-for-byte equals what client sent.
      expect(rec.rawBody.toString('utf8')).toBe(original);
      // The locked SKILL.md must NOT have been injected here.
      expect(rec.rawBody.toString('utf8')).not.toMatch(/丁元英/);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case 5: SSE streaming chunks arrive in real time (not buffered)', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      // Write 3 SSE events spaced 80ms apart, then close.
      res.write('data: {"chunk":1}\n\n');
      setTimeout(() => res.write('data: {"chunk":2}\n\n'), 80);
      setTimeout(() => res.write('data: {"chunk":3}\n\n'), 160);
      setTimeout(() => res.end('data: [DONE]\n\n'), 240);
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const body = JSON.stringify({
        model: 'gpt-4',
        stream: true,
        messages: [{ role: 'user', content: 'streamy' }],
      });
      const resp = await streamingRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers['content-type']).toMatch(/text\/event-stream/);
      // Concatenate and confirm payload integrity.
      const joined = resp.chunks.map((c) => c.text).join('');
      expect(joined).toMatch(/data: \{"chunk":1\}/);
      expect(joined).toMatch(/data: \{"chunk":2\}/);
      expect(joined).toMatch(/data: \{"chunk":3\}/);
      expect(joined).toMatch(/data: \[DONE\]/);
      // Streaming assertion: at least 2 distinct chunk-arrival timestamps,
      // and the gap between first and last is at least ~120ms (we wrote with
      // 80/160/240ms scheduling — buffered response would all arrive together).
      expect(resp.chunks.length).toBeGreaterThanOrEqual(2);
      const first = resp.chunks[0].at;
      const last = resp.chunks[resp.chunks.length - 1].at;
      expect(last - first).toBeGreaterThan(100);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case 6: invalid JSON body on chat path → 400', async () => {
    const upstream = await startMockUpstream((rec, req, res) => {
      res.statusCode = 200;
      res.end('{}');
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl });
    try {
      const resp = await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: '{not valid json',
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body)).toEqual({ error: 'invalid json body' });
      // Upstream must NOT have been hit at all.
      expect(upstream.records.length).toBe(0);
    } finally {
      await proxy.close();
      await upstream.close();
    }
  });

  test('case 7: upstream unreachable → 502', async () => {
    // Bind+immediately close to grab a definitely-free port.
    const tmp = http.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const deadPort = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    const proxy = await startProxy({
      upstreamBaseUrl: `http://127.0.0.1:${deadPort}`,
    });
    try {
      const body = JSON.stringify({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'will fail' }],
      });
      const resp = await rawRequest({
        port: proxy.port,
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(resp.statusCode).toBe(502);
      expect(JSON.parse(resp.body)).toEqual({ error: 'upstream connection failed' });
    } finally {
      await proxy.close();
    }
  });
});
