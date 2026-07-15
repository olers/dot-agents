#!/usr/bin/env bash
# 一键发版：测试 → 升版本打 tag → 发官方 npm → 推送。
# 用法：scripts/release.sh [patch|minor|major] [OTP]（缺省 patch；账号开了 2FA 就带 6 位验证码）
# 换源无感：publishConfig 钉了官方 registry + public，本地全局是什么镜像源都不影响。
# 登录只需一次：npm login --registry=https://registry.npmjs.org
# 想永久免 OTP：npmjs.com → Access Tokens → 生成 Automation 型 granular token，
#   写入 ~/.npmrc 一行 //registry.npmjs.org/:_authToken=<token>
set -euo pipefail
cd "$(dirname "$0")/.."
LEVEL="${1:-patch}"
OTP="${2:-}"

[ -z "$(git status --porcelain)" ] || { echo "✗ 工作区不干净，先提交再发版"; exit 1; }
npm whoami --registry=https://registry.npmjs.org >/dev/null 2>&1 \
  || { echo "✗ 未登录官方 npm，先跑一次：npm login --registry=https://registry.npmjs.org"; exit 1; }

npm test
npm version "$LEVEL"     # 改 version + commit + tag
npm publish ${OTP:+--otp="$OTP"}   # prepare 钩子会先 build，包内只有 dist
git push --follow-tags

echo "✓ 已发布 @linemagic/dot-agents@$(node -p "require('./package.json').version")"
