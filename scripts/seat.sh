#!/usr/bin/env bash
# 既存の niho-experience-paneB-1〜4 を安全に再利用する。
set -euo pipefail

top="$(git rev-parse --show-toplevel)"
top_name="$(basename "$top")"
if [[ "$top_name" =~ ^niho-experience-paneB-[0-9]+$ ]]; then
  repo_root="$(dirname "$top")/niho-experience"
else
  repo_root="$top"
fi
repo_root="$(cd "$repo_root" && pwd)"
seat_count=4

seat_path() {
  printf '%s-paneB-%s' "$repo_root" "$1"
}

branch_name() {
  git -C "$1" branch --show-current
}

dirty_count() {
  git -C "$1" status --porcelain | wc -l | tr -d ' '
}

detached_unreachable_count() {
  git -C "$1" rev-list --count HEAD --not --remotes
}

require_seat() {
  local path
  path="$(seat_path "$1")"
  if [[ ! -d "$path" ]] || ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "seat $1 がありません。worktree を新設せず、既存 seat を選んでください。" >&2
    exit 1
  fi
  printf '%s' "$path"
}

show_status() {
  local n path branch dirty unreachable label
  for n in $(seq 1 "$seat_count"); do
    path="$(seat_path "$n")"
    if [[ ! -d "$path" ]] || ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      printf 'paneB-%s  なし（新設しない）\n' "$n"
      continue
    fi
    branch="$(branch_name "$path")"
    dirty="$(dirty_count "$path")"
    unreachable=0
    if [[ -z "$branch" ]]; then
      unreachable="$(detached_unreachable_count "$path")"
    fi
    if (( dirty > 0 )); then
      label="変更あり・保護"
    elif [[ -n "$branch" ]]; then
      label="再利用可・branch保持"
    elif (( unreachable > 0 )); then
      label="要確認・branchなしcommit $unreachable 件"
    else
      label="空き"
    fi
    printf 'paneB-%s  %-23s %s\n' "$n" "$label" "${branch:-（detached）}"
  done
}

start_topic() {
  local n="$1" topic="$2" path branch
  path="$(require_seat "$n")"
  if [[ ! "$top_name" =~ ^niho-experience-paneB-[0-9]+$ ]] || [[ "$top" != "$path" ]]; then
    echo "start は対象 seat の中で実行してください: $path" >&2
    exit 1
  fi
  [[ "$topic" =~ ^[a-z0-9][a-z0-9-]{1,59}$ ]] || {
    echo "topic は英小文字・数字・ハイフンで指定してください。" >&2
    exit 2
  }
  [[ "$(dirty_count "$path")" == "0" ]] || {
    echo "作業差分があります。内容を保護するため中断しました。" >&2
    git -C "$path" status -sb
    exit 1
  }
  git -C "$path" fetch --quiet origin
  branch="paneB-$n/$topic"
  git check-ref-format --branch "$branch" >/dev/null
  if git -C "$path" show-ref --verify --quiet "refs/heads/$branch" ||
     git -C "$path" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    echo "branch が既にあります: $branch（既存 ref は自動で上書きしません）" >&2
    exit 1
  fi
  if [[ -z "$(branch_name "$path")" ]] && (( $(detached_unreachable_count "$path") > 0 )); then
    echo "detached HEAD に remote 未到達の commit があります。branch を付けて保護してください。" >&2
    exit 1
  fi
  git -C "$path" switch --quiet --no-track -c "$branch" origin/main
  echo "$branch を origin/main から作成しました。前の branch ref は残しています。"
}

release_seat() {
  local n="$1" path
  path="$(require_seat "$n")"
  if [[ "$top_name" != "$(basename "$path")" ]] || [[ "$top" != "$path" ]]; then
    echo "release は対象 seat の中で実行してください: $path" >&2
    exit 1
  fi
  [[ "$(dirty_count "$path")" == "0" ]] || {
    echo "作業差分があります。内容を保護するため中断しました。" >&2
    git -C "$path" status -sb
    exit 1
  }
  git -C "$path" fetch --quiet origin
  if [[ -z "$(branch_name "$path")" ]] && (( $(detached_unreachable_count "$path") > 0 )); then
    echo "detached HEAD に remote 未到達の commit があります。branch を付けて保護してください。" >&2
    exit 1
  fi
  git -C "$path" switch --quiet --detach origin/main
  echo "paneB-$n を origin/main に戻しました。既存 branch ref は削除していません。"
}

case "${1:-status}" in
  status)
    show_status
    ;;
  start)
    [[ $# -eq 3 ]] || { echo "usage: scripts/seat.sh start <1-4> <topic>" >&2; exit 2; }
    [[ "$2" =~ ^[1-4]$ ]] || { echo "seat は 1〜4 を指定してください。" >&2; exit 2; }
    start_topic "$2" "$3"
    ;;
  release)
    [[ $# -eq 2 ]] || { echo "usage: scripts/seat.sh release <1-4>" >&2; exit 2; }
    [[ "$2" =~ ^[1-4]$ ]] || { echo "seat は 1〜4 を指定してください。" >&2; exit 2; }
    release_seat "$2"
    ;;
  *)
    echo "usage: scripts/seat.sh status | start <1-4> <topic> | release <1-4>" >&2
    exit 2
    ;;
esac
