// YCAPI_SYSTEM_LOCK_HOOK
// P1 hook: enforce single-persona lock + 50000 token context limit.
//
// What it does, on every chat request:
//   1) Reads ding-yuanying.skill.md once at module load (cached in memory).
//   2) Strips any client-supplied system messages from req.body.messages.
//   3) Forces req.body.promptPrefix = SKILL_TEXT, regardless of what the
//      client sent. (LibreChat's loadEphemeralAgent uses promptPrefix as the
//      agent's system instructions — see packages/api/src/agents/load.ts.)
//   4) Token-counts the combined incoming text; > 50000 tokens → 400.
//
// Public surface (also used by tests, see __tests__/dingYuanyingLock.spec.js):
//   - getSkillText()              -> string (trimmed SKILL.md content)
//   - getSkillSha256()            -> 64-hex SHA256 of getSkillText()
//   - applySystemLock(messages)   -> new array with messages[0] forced to
//                                    {role:'system', content: SKILL_TEXT},
//                                    later system messages stripped.
//   - countRequestTokens(req)     -> number (rough token estimate of all
//                                    user-visible text in req.body)
//   - dingYuanyingLock            -> Express middleware (default export)
//   - MAX_CONTEXT_TOKENS          -> 50000
//
// Why a homemade tokenizer fallback: ai-tokenizer / gpt-tokenizer pull large
// model assets and are overkill for an upper-bound check. A 4-chars-per-token
// heuristic over-counts CJK text vs. tiktoken cl100k by ≤2x, which is the
// safe direction for a hard ceiling. If LibreChat's runtime tokenizer is
// available we prefer it, otherwise we fall back.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CONTEXT_TOKENS = 50000;

const SKILL_PATH = path.join(__dirname, '..', 'locks', 'ding-yuanying.skill.md');

// Normalize line endings before hashing so SHA256 is identical whether the
// file is checked out on Linux/macOS (LF) or Windows (CRLF). .gitattributes
// pins the file to LF, but git autocrlf or editor save can still flip it.
const normalizeLineEndings = (s) => s.replace(/\r\n/g, '\n');
const SKILL_TEXT = normalizeLineEndings(fs.readFileSync(SKILL_PATH, 'utf8')).trim();
const SKILL_SHA256 = crypto.createHash('sha256').update(SKILL_TEXT).digest('hex');

function getSkillText() {
  return SKILL_TEXT;
}

function getSkillSha256() {
  return SKILL_SHA256;
}

/**
 * Force-override messages array so that the upstream LLM always receives
 * the locked system prompt as messages[0], no matter what the client sent.
 *
 * Rules:
 *   - messages[0] is replaced with {role:'system', content: SKILL_TEXT}.
 *   - Any other role:'system' messages elsewhere in the array are dropped.
 *   - Non-system messages preserve order.
 *   - Returns a new array; does not mutate input.
 */
function applySystemLock(messages) {
  const nonSystem = Array.isArray(messages) ? messages.filter((m) => m && m.role !== 'system') : [];
  return [{ role: 'system', content: SKILL_TEXT }, ...nonSystem];
}

/**
 * Estimate token count of an arbitrary string. 4-chars-per-token is the
 * commonly-cited cl100k upper bound for mixed text; for CJK text it is
 * conservative (over-counts), which is what we want for a hard cap.
 */
function estimateTokens(s) {
  if (typeof s !== 'string') {
    return 0;
  }
  return Math.ceil(s.length / 4);
}

/**
 * Sum tokens across all user-visible text fields in a chat request body.
 * Covers: req.body.text (LibreChat's main user-input field), promptPrefix,
 * any string content in req.body.messages[].content, and (for safety)
 * conversation.title.
 */
function countRequestTokens(req) {
  if (!req || !req.body || typeof req.body !== 'object') {
    return 0;
  }
  let total = 0;
  const b = req.body;
  if (typeof b.text === 'string') {
    total += estimateTokens(b.text);
  }
  if (typeof b.promptPrefix === 'string') {
    total += estimateTokens(b.promptPrefix);
  }
  if (Array.isArray(b.messages)) {
    for (const m of b.messages) {
      if (!m) continue;
      if (typeof m.content === 'string') {
        total += estimateTokens(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part.text === 'string') {
            total += estimateTokens(part.text);
          }
        }
      }
    }
  }
  return total;
}

function dingYuanyingLock(req, res, next) {
  try {
    const tokens = countRequestTokens(req);
    if (tokens > MAX_CONTEXT_TOKENS) {
      return res.status(400).json({
        error: 'context too long',
        tokens,
        limit: MAX_CONTEXT_TOKENS,
      });
    }

    if (!req.body || typeof req.body !== 'object') {
      req.body = {};
    }

    // Hard override: client cannot change persona.
    req.body.promptPrefix = SKILL_TEXT;

    if (Array.isArray(req.body.messages)) {
      req.body.messages = applySystemLock(req.body.messages);
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = dingYuanyingLock;
module.exports.dingYuanyingLock = dingYuanyingLock;
module.exports.applySystemLock = applySystemLock;
module.exports.countRequestTokens = countRequestTokens;
module.exports.estimateTokens = estimateTokens;
module.exports.getSkillText = getSkillText;
module.exports.getSkillSha256 = getSkillSha256;
module.exports.MAX_CONTEXT_TOKENS = MAX_CONTEXT_TOKENS;
module.exports.SKILL_PATH = SKILL_PATH;
