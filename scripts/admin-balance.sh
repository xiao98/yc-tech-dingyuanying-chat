#!/usr/bin/env bash
# admin-balance.sh — YC TECH 丁元英 Chat (P4 followup).
#
# Local admin tool for LibreChat user credit balance via mongo.
# Pipes JS into mongosh stdin (over ssh) so $set / $inc don't get eaten by
# triple-layered shell quoting.
#
# Usage:
#   admin-balance.sh list                           # all users + balance
#   admin-balance.sh get   <email>                  # one user's balance
#   admin-balance.sh set   <email> <credits>        # absolute set
#   admin-balance.sh add   <email> <credits>        # delta (negative ok)
#   admin-balance.sh topup <email> <rmb>            # rmb→credits via ratio
#
# 1 RMB ≈ 28000 credits (after 5x markup, see librechat.yaml topup.alipay.cny)

set -euo pipefail

HOST="${HOST:-5.175.188.106}"
KEY="${KEY:-$HOME/.ssh/dingyuanying/deploy_key}"
DB="LibreChat"
RATIO_RMB_CENTS_TO_CREDITS=280

usage() {
  sed -n '5,17p' "$0" | sed 's/^# \?//'
  exit 1
}

# Pipe JS to remote mongosh via stdin — no shell escape headaches.
mongo_pipe() {
  ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST" \
    "docker exec -i ycchat-mongo mongosh '$DB' --quiet"
}

case "${1:-}" in
  list)
    mongo_pipe <<'JSEOF'
const balances = {};
db.balances.find({}).forEach(function(b) { balances[b.user.toString()] = b.tokenCredits; });
db.users.find({}, {email:1, role:1}).forEach(function(u) {
  print((u.email || '(no-email)') + '\t' + (u.role || 'USER') + '\t' + (balances[u._id.toString()] || 0));
});
JSEOF
    ;;
  get)
    [[ -z "${2:-}" ]] && usage
    mongo_pipe <<JSEOF
const u = db.users.findOne({email: '$2'}, {_id:1, email:1, role:1});
if (!u) { print('not found'); quit(1); }
const b = db.balances.findOne({user: u._id}) || {tokenCredits: 0};
print(JSON.stringify({email: u.email, role: u.role, userId: u._id.toString(), tokenCredits: b.tokenCredits}));
JSEOF
    ;;
  set)
    [[ $# -ne 3 ]] && usage
    mongo_pipe <<JSEOF
const u = db.users.findOne({email: '$2'}, {_id:1});
if (!u) { print('not found'); quit(1); }
const r = db.balances.updateOne({user: u._id}, {\$set: {tokenCredits: NumberInt($3)}}, {upsert: true});
print(JSON.stringify({email: '$2', tokenCredits: $3, modified: r.modifiedCount, upserted: r.upsertedCount}));
JSEOF
    ;;
  add)
    [[ $# -ne 3 ]] && usage
    mongo_pipe <<JSEOF
const u = db.users.findOne({email: '$2'}, {_id:1});
if (!u) { print('not found'); quit(1); }
const r = db.balances.findOneAndUpdate({user: u._id}, {\$inc: {tokenCredits: NumberInt($3)}}, {upsert: true, returnDocument: 'after'});
const cur = (r && r.tokenCredits) || (db.balances.findOne({user: u._id}) || {}).tokenCredits;
print(JSON.stringify({email: '$2', delta: $3, newBalance: cur}));
JSEOF
    ;;
  topup)
    [[ $# -ne 3 ]] && usage
    rmb="$3"
    credits=$(awk "BEGIN{printf \"%d\", $rmb * 100 * $RATIO_RMB_CENTS_TO_CREDITS}")
    mongo_pipe <<JSEOF
const u = db.users.findOne({email: '$2'}, {_id:1});
if (!u) { print('not found'); quit(1); }
const r = db.balances.findOneAndUpdate({user: u._id}, {\$inc: {tokenCredits: NumberInt($credits)}}, {upsert: true, returnDocument: 'after'});
const cur = (r && r.tokenCredits) || (db.balances.findOne({user: u._id}) || {}).tokenCredits;
print(JSON.stringify({email: '$2', rmb: $rmb, addedCredits: $credits, newBalance: cur}));
JSEOF
    ;;
  *)
    usage
    ;;
esac
