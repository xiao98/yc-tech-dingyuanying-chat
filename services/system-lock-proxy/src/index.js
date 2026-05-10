// SYSTEM_LOCK_PROXY_HOOK
// YC TECH 丁元英 Chat — P2b sidecar reverse proxy.
//
// Enforces messages[0] = {role:'system', content:<SKILL.md>} on every
// OpenAI-compatible chat-completion request before forwarding upstream.
// All other paths are byte-passthrough. Streaming responses are piped, not
// buffered, so SSE chunks reach the client in realtime.

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const DEFAULT_SKILL_PATH = '/etc/system-lock-proxy/skill.md';
const DEFAULT_LISTEN_PORT = 8080;
const CHAT_PATH = '/v1/chat/completions';

function loadSkillOrDie(skillPath) {
  let raw;
  try {
    raw = fs.readFileSync(skillPath, 'utf8');
  } catch (err) {
    console.error(
      `[system-lock-proxy] FATAL: cannot read SKILL.md at "${skillPath}": ${err.message}`
    );
    process.exit(1);
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    console.error(
      `[system-lock-proxy] FATAL: SKILL.md at "${skillPath}" is empty after trim`
    );
    process.exit(1);
  }
  return trimmed;
}

function rewriteMessages(parsed, lockedSystem) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    parsed = {};
  }
  const incoming = Array.isArray(parsed.messages) ? parsed.messages : [];
  const nonSystem = incoming.filter(
    (m) => !(m && typeof m === 'object' && m.role === 'system')
  );
  parsed.messages = [
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: lockedSystem,
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    ...nonSystem,
  ];
  return parsed;
}

function sanitizeForwardHeaders(reqHeaders, newBodyByteLength) {
  const rewriting = newBodyByteLength != null;
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    const lk = k.toLowerCase();
    // Always-drop: hop-by-hop and host (we set our own).
    if (
      lk === 'host' ||
      lk === 'connection' ||
      lk === 'expect' ||
      lk === 'upgrade' ||
      lk === 'proxy-connection' ||
      lk === 'keep-alive' ||
      lk === 'te' ||
      lk === 'trailer'
    ) {
      continue;
    }
    // When rewriting body, content-length and transfer-encoding will be reset
    // from the new body. In passthrough mode, preserve them as-is.
    if (rewriting && (lk === 'content-length' || lk === 'transfer-encoding')) {
      continue;
    }
    out[k] = v;
  }
  if (rewriting) {
    out['content-length'] = String(newBodyByteLength);
  }
  return out;
}

function sanitizeResponseHeaders(upstreamHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(upstreamHeaders)) {
    const lk = k.toLowerCase();
    // Don't echo connection-management headers; let Node handle framing.
    if (
      lk === 'connection' ||
      lk === 'transfer-encoding' ||
      lk === 'keep-alive' ||
      lk === 'proxy-connection' ||
      lk === 'te' ||
      lk === 'trailer' ||
      lk === 'upgrade'
    ) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (limitBytes != null && total > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pickTransport(urlObj) {
  return urlObj.protocol === 'https:' ? https : http;
}

function send(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function buildUpstreamOptions(upstreamBaseUrl, req, forwardHeaders) {
  const base = new URL(upstreamBaseUrl);
  // Compose target path: base.pathname (without trailing slash) + req.url
  const basePath = base.pathname.replace(/\/+$/, '');
  const upstreamUrl = new URL(basePath + req.url, base);
  return {
    transport: pickTransport(upstreamUrl),
    options: {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
      path: upstreamUrl.pathname + upstreamUrl.search,
      method: req.method,
      headers: forwardHeaders,
    },
  };
}

function pipeUpstream({ transport, options, body, req, res, timeoutMs = 600000 }) {
  const upstreamReq = transport.request(options, (upstreamRes) => {
    res.statusCode = upstreamRes.statusCode || 502;
    const cleaned = sanitizeResponseHeaders(upstreamRes.headers);
    for (const [k, v] of Object.entries(cleaned)) {
      try {
        res.setHeader(k, v);
      } catch (_) {
        // ignore invalid headers
      }
    }
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => {
      try { res.destroy(); } catch (_) {}
    });
  });

  upstreamReq.setTimeout(timeoutMs, () => {
    upstreamReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
  });

  upstreamReq.on('error', (err) => {
    if (res.headersSent) {
      try { res.destroy(); } catch (_) {}
      return;
    }
    if (err && err.code === 'ETIMEDOUT') {
      send(res, 504, { error: 'upstream timeout' });
    } else {
      send(res, 502, { error: 'upstream connection failed' });
    }
  });

  // Abort upstream if client closes its response side prematurely.
  res.on('close', () => {
    if (!res.writableFinished && !upstreamReq.destroyed) {
      try { upstreamReq.destroy(); } catch (_) {}
    }
  });

  if (body != null) upstreamReq.write(body);
  upstreamReq.end();
}

function isChatCompletionsPath(reqUrl) {
  // Match /v1/chat/completions and any query string.
  const path = reqUrl.split('?')[0];
  return path === CHAT_PATH;
}

function makeHandler({ lockedSystem, upstreamBaseUrl, maxBodyBytes }) {
  return async function handler(req, res) {
    try {
      // Only POST /v1/chat/completions gets rewritten.
      if (req.method === 'POST' && isChatCompletionsPath(req.url)) {
        let bodyBuf;
        try {
          bodyBuf = await readRequestBody(req, maxBodyBytes);
        } catch (err) {
          if (err && err.code === 'TOO_LARGE') {
            send(res, 413, { error: 'payload too large' });
            return;
          }
          send(res, 400, { error: 'failed to read request body' });
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(bodyBuf.toString('utf8'));
        } catch (_) {
          send(res, 400, { error: 'invalid json body' });
          return;
        }

        const rewritten = rewriteMessages(parsed, lockedSystem);
        const newBody = Buffer.from(JSON.stringify(rewritten), 'utf8');
        const forwardHeaders = sanitizeForwardHeaders(req.headers, newBody.length);
        const { transport, options } = buildUpstreamOptions(
          upstreamBaseUrl,
          req,
          forwardHeaders
        );
        pipeUpstream({ transport, options, body: newBody, req, res });
        return;
      }

      // Everything else: byte-passthrough — do not parse, do not buffer.
      const forwardHeaders = sanitizeForwardHeaders(req.headers, null);
      const { transport, options } = buildUpstreamOptions(
        upstreamBaseUrl,
        req,
        forwardHeaders
      );
      const upstreamReq = transport.request(options, (upstreamRes) => {
        res.statusCode = upstreamRes.statusCode || 502;
        const cleaned = sanitizeResponseHeaders(upstreamRes.headers);
        for (const [k, v] of Object.entries(cleaned)) {
          try {
            res.setHeader(k, v);
          } catch (_) {}
        }
        upstreamRes.pipe(res);
      });
      upstreamReq.setTimeout(600000, () => {
        upstreamReq.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' }));
      });
      upstreamReq.on('error', (err) => {
        if (res.headersSent) {
          try { res.destroy(); } catch (_) {}
          return;
        }
        if (err && err.code === 'ETIMEDOUT') {
          send(res, 504, { error: 'upstream timeout' });
        } else {
          send(res, 502, { error: 'upstream connection failed' });
        }
      });
      res.on('close', () => {
        if (!res.writableFinished && !upstreamReq.destroyed) {
          try { upstreamReq.destroy(); } catch (_) {}
        }
      });
      req.pipe(upstreamReq);
    } catch (err) {
      console.error('[system-lock-proxy] handler error:', err);
      if (!res.headersSent) {
        send(res, 500, { error: 'internal proxy error' });
      } else {
        try { res.destroy(); } catch (_) {}
      }
    }
  };
}

function createServer({ skillPath, upstreamBaseUrl, maxBodyBytes = 10 * 1024 * 1024 }) {
  if (!upstreamBaseUrl) {
    throw new Error('UPSTREAM_BASE_URL is required');
  }
  const lockedSystem = loadSkillOrDie(skillPath);
  const handler = makeHandler({ lockedSystem, upstreamBaseUrl, maxBodyBytes });
  const server = http.createServer(handler);
  return { server, lockedSystem };
}

function main() {
  const skillPath = process.env.SKILL_MD_PATH || DEFAULT_SKILL_PATH;
  const upstreamBaseUrl = process.env.UPSTREAM_BASE_URL;
  const port = Number(process.env.LISTEN_PORT || DEFAULT_LISTEN_PORT);

  if (!upstreamBaseUrl) {
    console.error('[system-lock-proxy] FATAL: UPSTREAM_BASE_URL env var is required');
    process.exit(1);
  }

  const { server, lockedSystem } = createServer({ skillPath, upstreamBaseUrl });
  server.listen(port, () => {
    console.log(
      `[system-lock-proxy] listening on :${port} → upstream ${upstreamBaseUrl} ` +
        `(SKILL.md ${lockedSystem.length} chars from ${skillPath})`
    );
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  createServer,
  rewriteMessages,
  loadSkillOrDie,
  isChatCompletionsPath,
};
