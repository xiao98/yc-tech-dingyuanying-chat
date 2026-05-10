// SYSTEM_LOCK_PROXY_TRANSLATE
// YC TECH 丁元英 Chat — P5 protocol translator.
//
// When LibreChat sends an OpenAI-compat chat-completion request whose user
// message content array contains a `{type:'document', source:{...}}` block,
// YCAPI's `/v1/chat/completions` endpoint silently drops the block. We
// detect this on the sidecar, translate the request to the Anthropic
// `/v1/messages` shape, forward it, and translate the response back into
// OpenAI shape (both streaming and non-streaming).

'use strict';

const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

function hasDocumentBlock(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part && typeof part === 'object' && part.type === 'document') {
        return true;
      }
    }
  }
  return false;
}

function extractSystemBlocks(messages) {
  const systemBlocks = [];
  const remaining = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system') {
      const content = msg.content;
      if (typeof content === 'string') {
        systemBlocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part && typeof part === 'object' && part.type === 'text') {
            const block = { type: 'text', text: part.text };
            if (part.cache_control) block.cache_control = part.cache_control;
            systemBlocks.push(block);
          }
        }
      }
      continue;
    }
    remaining.push(msg);
  }
  return { systemBlocks, remaining };
}

function normalizeUserContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    out.push(part);
  }
  return out;
}

function normalizeAssistantContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text });
    }
  }
  if (out.length === 0) return '';
  return out;
}

/**
 * Translate an OpenAI-compat chat-completion body to an Anthropic
 * `/v1/messages` body. Caller has already stripped system messages via
 * extractSystemBlocks.
 */
function buildAnthropicBody(openaiBody, systemBlocks) {
  const out = {
    model: openaiBody.model,
    max_tokens: openaiBody.max_tokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: [],
  };
  if (typeof openaiBody.temperature === 'number') {
    out.temperature = openaiBody.temperature;
  }
  if (typeof openaiBody.top_p === 'number') {
    out.top_p = openaiBody.top_p;
  }
  if (openaiBody.stream === true) {
    out.stream = true;
  }
  if (Array.isArray(systemBlocks) && systemBlocks.length > 0) {
    out.system = systemBlocks;
  }
  for (const msg of openaiBody.messages || []) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'user') {
      out.messages.push({ role: 'user', content: normalizeUserContent(msg.content) });
    } else if (msg.role === 'assistant') {
      out.messages.push({ role: 'assistant', content: normalizeAssistantContent(msg.content) });
    }
  }
  return out;
}

function mapStopReason(anthropicStopReason) {
  if (anthropicStopReason === 'end_turn' || anthropicStopReason === 'stop_sequence') {
    return 'stop';
  }
  if (anthropicStopReason === 'max_tokens') return 'length';
  if (anthropicStopReason === 'tool_use') return 'tool_calls';
  return anthropicStopReason || 'stop';
}

function translateAnthropicResponse(anthropicResp, model) {
  const id = anthropicResp.id || `msg_${Date.now()}`;
  let text = '';
  if (Array.isArray(anthropicResp.content)) {
    for (const part of anthropicResp.content) {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        text += part.text;
      }
    }
  }
  const usage = anthropicResp.usage || {};
  const promptTokens =
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const out = {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: anthropicResp.model || model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: mapStopReason(anthropicResp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: promptTokens + (usage.output_tokens || 0),
      cached_input_tokens:
        usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : undefined,
    },
  };
  if (out.usage.cached_input_tokens === undefined) delete out.usage.cached_input_tokens;
  return out;
}

/**
 * Stateful Anthropic SSE → OpenAI SSE translator.
 * Anthropic events: message_start, content_block_start, content_block_delta,
 *                   content_block_stop, message_delta, message_stop, ping
 * Each emits a corresponding OpenAI `data: {...}\n\n` chunk (or none for ping).
 * Always emit a leading role chunk on message_start, and a final
 * `data: [DONE]\n\n` once the upstream stream ends.
 */
function createSseTranslator({ model }) {
  let buffer = '';
  let messageId = `chatcmpl_${Date.now()}`;
  let resolvedModel = model;
  let stopReason = null;

  function emitChunk(delta, finishReason) {
    const payload = {
      id: messageId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: resolvedModel,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason || null,
        },
      ],
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  function processEvent(eventType, dataLine) {
    if (!dataLine) return '';
    let parsed;
    try {
      parsed = JSON.parse(dataLine);
    } catch (_) {
      return '';
    }
    const type = parsed.type || eventType;
    if (type === 'message_start') {
      if (parsed.message) {
        if (parsed.message.id) messageId = parsed.message.id;
        if (parsed.message.model) resolvedModel = parsed.message.model;
      }
      return emitChunk({ role: 'assistant', content: '' });
    }
    if (type === 'content_block_delta') {
      const d = parsed.delta || {};
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        return emitChunk({ content: d.text });
      }
      return '';
    }
    if (type === 'message_delta') {
      if (parsed.delta && parsed.delta.stop_reason) {
        stopReason = parsed.delta.stop_reason;
      }
      return '';
    }
    if (type === 'message_stop') {
      return emitChunk({}, mapStopReason(stopReason || 'end_turn'));
    }
    return '';
  }

  return {
    push(chunkBuf) {
      buffer += chunkBuf.toString('utf8');
      let out = '';
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let eventType = '';
        let dataLine = '';
        for (const rawLine of block.split('\n')) {
          const line = rawLine.replace(/\r$/, '');
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLine += line.slice(5).trim();
          }
        }
        if (dataLine) out += processEvent(eventType, dataLine);
      }
      return out;
    },
    flush() {
      return 'data: [DONE]\n\n';
    },
  };
}

module.exports = {
  hasDocumentBlock,
  extractSystemBlocks,
  buildAnthropicBody,
  translateAnthropicResponse,
  createSseTranslator,
  mapStopReason,
};
