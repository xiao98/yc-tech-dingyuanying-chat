#!/usr/bin/env bash
# admin-balance.sh — YC TECH 丁元英 Chat (P4 followup).
#
# Local admin tool for managing LibreChat user credit balance directly via
# mongo. Wraps the recurring `db.balances.updateOne` / `findOne` pattern so
# you don't have to remember mongosh syntax + ObjectId casting + the
# "admin lives in mongo, New-API consumption is decoupled" caveat.
#
# Usage:
#   admin-balance.sh list                              # show all users + balance
#   admin-balance.sh get   <email>                     # show one user's balance
#   admin-balance.sh set   <email> <credits>           # absolute set
#   admin-balance.sh add   <email> <credits>           # relative (+ or -)
#   admin-balance.sh topup <email> <rmb>               # convenience: <rmb> 元 → ratio×100×rmb credits
#
# All output is JSON-ish lines. Read top of file for the credits-to-money
# math (1 credit ≈ 1 micro-USD; 1 RMB ≈ 14000 credits at current 5x markup).
#
# Runs over ssh from the local machine to the deploy host. Reads the host
# from $HOST or defaults to dyy.youchun.tech. Auths via the dedicated
# deploy key at $KEY (default: ~/.ssh/dingyuanying/deploy_key).

set -euo pipefail

HOST="${HOST:-5.175.188.106}"
KEY="${KEY:-$HOME/.ssh/dingyuanying/deploy_key}"
DB="LibreChat"
RATIO_RMB_CENTS_TO_CREDITS=280  # matches librechat.yaml topup.channels.alipay.cny

usage() {
  sed -n '5,18p' "$0" | sed 's/^# \?//'
  exit 1
}

remote() {
  ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "root@$HOST" "$@"
}

mongosh_exec() {
  local script="$1"
  remote "docker exec ycchat-mongo mongosh '$DB' --quiet --eval \"$script\""
}

case "${1:-}" in
  list)
    mongosh_exec "
      const users = db.users.find({}, {email:1, role:1}).toArray();
      const balances = {};
      db.balances.find({}).forEach(b => { balances[b.user.toString()] = b.tokenCredits; });
      users.forEach(u => print((u.email||'(no-email)') + '\t' + (u.role||'USER') + '\t' + (balances[u._id.toString()]||0)));
    "
    ;;
  get)
    [[ -z "${2:-}" ]] && usage
    mongosh_exec "
      const u = db.users.findOne({email:'$2'}, {_id:1, email:1, role:1});
      if (!u) { print('not found'); quit(1); }
      const b = db.balances.findOne({user: u._id}) || {tokenCredits: 0};
      print(JSON.stringify({email:u.email, role:u.role, userId:u._id.toString(), tokenCredits:b.tokenCredits}));
    "
    ;;
  set)
    [[ $# -ne 3 ]] && usage
    mongosh_exec "
      const u = db.users.findOne({email:'$2'}, {_id:1});
      if (!u) { print('not found'); quit(1); }
      const r = db.balances.updateOne({user: u._id}, {\$set: {tokenCredits: NumberInt($3)}}, {upsert: true});
      print(JSON.stringify({email:'$2', tokenCredits:$3, modified:r.modifiedCount, upserted:r.upsertedCount}));
    "
    ;;
  add)
    [[ $# -ne 3 ]] && usage
    mongosh_exec "
      const u = db.users.findOne({email:'$2'}, {_id:1});
      if (!u) { print('not found'); quit(1); }
      const r = db.balances.findOneAndUpdate(
        {user: u._id},
        {\$inc: {tokenCredits: NumberInt($3)}},
        {upsert: true, returnDocument: 'after'}
      );
      print(JSON.stringify({email:'$2', delta:$3, newBalance: (r && r.tokenCredits) || (db.balances.findOne({user:u._id})||{}).tokenCredits}));
    "
    ;;
  topup)
    [[ $# -ne 3 ]] && usage
    rmb="$3"
    credits=$(awk "BEGIN{printf \"%d\", $rmb * 100 * $RATIO_RMB_CENTS_TO_CREDITS}")
    mongosh_exec "
      const u = db.users.findOne({email:'$2'}, {_id:1});
      if (!u) { print('not found'); quit(1); }
      const r = db.balances.findOneAndUpdate(
        {user: u._id},
        {\$inc: {tokenCredits: NumberInt($credits)}},
        {upsert: true, returnDocument: 'after'}
      );
      print(JSON.stringify({email:'$2', rmb:$rmb, addedCredits:$credits, newBalance: (r && r.tokenCredits) || (db.balances.findOne({user:u._id})||{}).tokenCredits}));
    "
    ;;
  *)
    usage
    ;;
esac
