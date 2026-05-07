const express = require('express');
const { generateCheckAccess, skipAgentCheck } = require('@librechat/api');
const { PermissionTypes, Permissions, PermissionBits } = require('librechat-data-provider');
const {
  moderateText,
  // validateModel,
  validateConvoAccess,
  buildEndpointOption,
  canAccessAgentFromBody,
} = require('~/server/middleware');
// YCAPI_SYSTEM_LOCK_HOOK — single-persona lock + 50k token cap (P1).
const dingYuanyingLock = require('~/server/middleware/dingYuanyingLock');
// BALANCE_GATE_HOOK — 402 if balance ≤ 0, BEFORE sub-key decrypt (P3b).
const balanceGate = require('~/server/middleware/balanceGate');
// NEWAPI_PROVISIONING_HOOK — per-user upstream sub-key on req.upstreamApiKey (P2a).
const attachSubkey = require('~/server/middleware/attachSubkey');
const { initializeClient } = require('~/server/services/Endpoints/agents');
const AgentController = require('~/server/controllers/agents/request');
const addTitle = require('~/server/services/Endpoints/agents/title');
const { getRoleByName } = require('~/models');

const router = express.Router();

const checkAgentAccess = generateCheckAccess({
  permissionType: PermissionTypes.AGENTS,
  permissions: [Permissions.USE],
  skipCheck: skipAgentCheck,
  getRoleByName,
});
const checkAgentResourceAccess = canAccessAgentFromBody({
  requiredPermission: PermissionBits.VIEW,
});

// YCAPI_SYSTEM_LOCK_HOOK: enforce token cap + force promptPrefix to SKILL.md
// before buildEndpointOption (which reads req.body.promptPrefix into the
// ephemeral agent's instructions in packages/api/src/agents/load.ts).
router.use(dingYuanyingLock);
// BALANCE_GATE_HOOK: pre-flight 402 if balance ≤ 0. Runs before
// attachSubkey so a zero-balance user never causes us to decrypt their
// upstream sub-key — defense-in-depth + matches Goal criterion 4.3.
router.use(balanceGate);
// NEWAPI_PROVISIONING_HOOK: decrypt user's per-user sub-key onto
// req.upstreamApiKey before initializeCustom reads it.
router.use(attachSubkey);
router.use(moderateText);
router.use(checkAgentAccess);
router.use(checkAgentResourceAccess);
router.use(validateConvoAccess);
router.use(buildEndpointOption);

const controller = async (req, res, next) => {
  await AgentController(req, res, next, initializeClient, addTitle);
};

/**
 * @route POST / (regular endpoint)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/', controller);

/**
 * @route POST /:endpoint (ephemeral agents)
 * @desc Chat with an assistant
 * @access Public
 * @param {express.Request} req - The request object, containing the request data.
 * @param {express.Response} res - The response object, used to send back a response.
 * @returns {void}
 */
router.post('/:endpoint', controller);

module.exports = router;
