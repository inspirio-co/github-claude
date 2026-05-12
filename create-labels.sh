#!/bin/bash
# GitHub 라벨 생성 스크립트
# 사용법: GITHUB_OWNER=xxx GITHUB_REPO=xxx GITHUB_TOKEN=xxx ./create-labels.sh

set -e

OWNER="${GITHUB_OWNER:?GITHUB_OWNER is required}"
REPO="${GITHUB_REPO:?GITHUB_REPO is required}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"

API="https://api.github.com/repos/$OWNER/$REPO/labels"

create_label() {
  local name="$1"
  local color="$2"
  local description="$3"

  echo "Creating label: $name"
  curl -s -X POST "$API" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    -d "{\"name\":\"$name\",\"color\":\"$color\",\"description\":\"$description\"}" \
    | jq -r '.name // .message' 2>/dev/null || true
}

create_label "auto-fix"            "5319e7" "Claude 자동 수정 트리거"
create_label "status/in-progress"  "fbca04" "자동 처리 진행 중"
create_label "status/done"         "0e8a16" "자동 처리 완료"
create_label "status/needs-review" "d93f0b" "수동 검토 필요"

echo "Done!"
