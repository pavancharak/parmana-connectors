#!/bin/bash

# Stop hook: refuses to let a session end while the repository has work that
# is not yet on the remote. Installed to /root/.claude/stop-hook-git-check.sh by
# the environment's setup script. Exit 2 blocks the stop and prints the reason.

# Read all of the JSON input from stdin, so the writer never sees a closed pipe.
# read -N starts no process, unlike cat, but needs bash 4.1 (macOS ships 3.2);
# comparing only the major version is simpler.
if ((BASH_VERSINFO[0] >= 5)); then
  input=
  while IFS= builtin read -r -N 65536 chunk; do
    input+="$chunk"
  done
  input+="$chunk"
else
  input=$(cat)
fi

# Exit before starting jq or git where git could not find a repository. Like
# git, look for .git, or HEAD (a bare repository), in the real working directory
# and each parent. The subshell keeps this script's PWD, which git reads. It
# asks /proc/self/cwd because an inherited PWD can name a bind mount of this
# directory, whose parents git never walks.
may_be_in_git_repository() (
  [[ -n "${GIT_DIR:-}" ]] && exit 0
  builtin cd -P /proc/self/cwd 2>/dev/null || builtin cd -P . 2>/dev/null || exit 0
  dir="$PWD"
  # Without /proc, a deleted working directory leaves PWD relative, and the loop would never end.
  [[ "$dir" == /* ]] || exit 0
  while [[ -n "$dir" ]]; do
    [[ -e "$dir/.git" || -L "$dir/.git" || -e "$dir/HEAD" || -L "$dir/HEAD" ]] && exit 0
    dir="${dir%/*}"
  done
  [[ -e /.git || -L /.git || -e /HEAD || -L /HEAD ]]
)
if ! may_be_in_git_repository; then
  exit 0
fi

# Check if stop hook is already active (recursion prevention)
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active')
if [[ "$stop_hook_active" = "true" ]]; then
  exit 0
fi

# Check if we're in a git repository - bail if not
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# Bail if there's no remote to push to. Every error path below asks the user
# to "push to the remote branch" — meaningless without a remote, and
# unsatisfiable if signing also requires a source. This case arises when CCR
# was launched against a local repo with no github remote (sources=[]) and
# the container's cwd has a leftover .git from a cached resume.
if [[ -z "$(git remote)" ]]; then
  exit 0
fi

# `git update-ref`, run here or in another worktree, can move the branch without updating the index,
# which then shows the new commits reversed as staged. Treat that as clean only if that message-less
# move is the branch's newest reflog entry and the index matches the last HEAD entry with a message.
branch_moved_under_checkout() {
  local head ref sha subject f unpushed
  head="$(git rev-parse -q --verify HEAD)" || return 1
  ref="$(git symbolic-ref -q HEAD)" || ref=HEAD
  read -r sha subject < <(git log -g -n 1 --no-show-signature --format='%H %gs' "$ref" -- 2>/dev/null)
  [[ "$sha" == "$head" && -z "$subject" ]] || return 1
  for f in MERGE_HEAD REVERT_HEAD CHERRY_PICK_HEAD; do
    git rev-parse -q --verify "$f" >/dev/null && return 1
  done
  # Uses the remote-tracking refs. The branch check below refreshes origin/<branch>
  # from the remote before it counts unpushed commits.
  unpushed="$(git rev-list -n 1 HEAD --not --remotes -- 2>/dev/null)" || return 1
  [[ -z "$unpushed" ]] || return 1
  while read -r sha subject; do
    [[ -z "$subject" ]] && continue
    if git merge-base --is-ancestor "$sha" "$head" 2>/dev/null &&
       git diff --cached --quiet "$sha" 2>/dev/null; then
      return 0
    fi
    return 1
  done < <(git log -g -n 50 --no-show-signature --format='%H %gs' HEAD -- 2>/dev/null)
  return 1
}

# Check for uncommitted changes (both staged and unstaged)
if ! git diff --quiet || { ! git diff --cached --quiet && ! branch_moved_under_checkout; }; then
  echo "There are uncommitted changes in the repository. Please commit and push these changes to the remote branch." >&2
  exit 2
fi

# Check for untracked files that might be important
untracked_files=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked_files" ]]; then
  echo "There are untracked files in the repository. Please commit and push these changes to the remote branch." >&2
  exit 2
fi

current_branch=$(git branch --show-current)
if [[ -n "$current_branch" ]]; then
  # Ask the remote directly for this branch. Do not rely on local origin/<branch>
  # refs, which may be missing when the fetch configuration covers only main.
  if ! ls_out=$(git ls-remote --heads origin "refs/heads/$current_branch" 2>/dev/null); then
    echo "Could not reach origin to check branch '$current_branch'. Check the network and retry." >&2
    exit 2
  fi
  remote_sha=$(printf '%s\n' "$ls_out" | awk 'NR==1{print $1}')

  if [[ -n "$remote_sha" ]]; then
    # Refresh the tracking ref for this branch only, so its commits are present locally.
    if ! git fetch -q origin "+refs/heads/$current_branch:refs/remotes/origin/$current_branch" 2>/dev/null; then
      echo "Could not fetch origin/$current_branch to compare." >&2
      exit 2
    fi
    upstream="origin/$current_branch"
  fi

  # Check for local commits that GitHub will show as "Unverified": either no
  # signature at all, or a committer email other than noreply@anthropic.com
  # (the identity CCR's signing key is registered to). Only run when commit
  # signing is configured.
  #
  # Signature presence is tested via the raw gpgsig/gpgsig-sha256 header,
  # NOT %G?. CCR/BYOC configure SSH signing (gpg.format=ssh, /tmp/code-sign;
  # byoc.go:754-758) but never set gpg.ssh.allowedSignersFile, so %G?
  # reports 'N' for correctly SSH-signed commits — see
  # api-go/ccr/e2e/byoc/scenario_sign_commit_test.go:117 and
  # antique/cmd/aq/git.go listUnsignedCommits for the same rationale.
  #
  # Scope to commits that are on NO remote ref ($upstream..HEAD would sweep
  # in teammates' already-published commits whenever this branch was cut
  # from a feature branch and has no same-named remote yet —
  # github.com/anthropics/claude-code#69586). Only run when the remote has
  # this branch (env-manager managed flow: createLocalBranch →
  # UpdateRemoteTrackingBranch, git.go:2496). Not origin/HEAD: a
  # single-branch/shallow clone onto a non-default branch has origin/HEAD but
  # no ref covering the agent's branch's base, so 'HEAD --not --remotes' would
  # sweep in teammates' published commits. This also skips agent-created
  # branches ('git checkout -b fix-xyz') in full clones — a deliberate
  # false-negative window, traded for never re-introducing an origin/HEAD
  # fallback whose destructive rewrite advice on shallow/single-branch
  # clones is the bug this gate fixes (#69586).
  if [[ "$(git config --type=bool commit.gpgsign 2>/dev/null)" == "true" ]] &&
     git rev-parse -q --verify "origin/$current_branch" >/dev/null 2>&1; then
    local_count="$(git rev-list HEAD --not --remotes --count 2>/dev/null)"
    if [[ -n "$local_count" && "$local_count" -gt 0 ]]; then
      unverifiable=""
      while read -r sha ce; do
        if [[ "$ce" != "noreply@anthropic.com" ]] ||
           ! git cat-file commit "$sha" 2>/dev/null | sed '/^$/q' | grep -qE '^gpgsig(-sha256)? '; then
          unverifiable+="${sha:0:7} $ce"$'\n'
        fi
      done < <(git log --format='%H %ce' HEAD --not --remotes 2>/dev/null)
      if [[ -n "$unverifiable" ]]; then
        # Derive a safe rebase boundary: the parent of the oldest local-only
        # commit, falling back to --root when it has none. Only advise the
        # range rebase when local-only history is a linear chain on top of
        # the boundary — rebase replays the whole <boundary>..HEAD range,
        # not the 'on no remote' set, so a non-linear graph (e.g. after
        # 'git merge origin/main') would replay+reset-author the published
        # commits brought in by the merge.
        oldest_local="$(git rev-list HEAD --not --remotes 2>/dev/null | tail -1)"
        if git rev-parse -q --verify "$oldest_local^" >/dev/null 2>&1; then
          rebase_onto="$oldest_local^"
          range_count="$(git rev-list "$rebase_onto..HEAD" --count 2>/dev/null)"
        else
          rebase_onto="--root"
          range_count="$(git rev-list HEAD --count 2>/dev/null)"
        fi
        echo "There are commit(s) on branch '$current_branch' that GitHub will show as Unverified (missing signature, or committer email is not noreply@anthropic.com):" >&2
        printf '%s' "$unverifiable" >&2
        if [[ "$range_count" == "$local_count" ]]; then
          echo "Please run 'git config user.email noreply@anthropic.com && git config user.name Claude', then 'git commit --amend --no-edit --reset-author' for the tip commit, or 'git rebase --exec \"git commit --amend --no-edit --reset-author\" $rebase_onto' for earlier commits, then push." >&2
        else
          echo "Please run 'git config user.email noreply@anthropic.com && git config user.name Claude', then 'git commit --amend --no-edit --reset-author' for each listed commit (local history is non-linear, so a range rebase would rewrite published commits), then push." >&2
        fi
        exit 2
      fi
    fi
  fi

  if [[ -n "$remote_sha" ]]; then
    unpushed=$(git rev-list "$upstream..HEAD" --count 2>/dev/null) || unpushed=0
    if [[ "$unpushed" -gt 0 ]]; then
      echo "There are $unpushed unpushed commit(s) on branch '$current_branch'. Please push these changes to the remote repository." >&2
      exit 2
    fi
  else
    # The remote has no such branch: every local commit not on any remote is unpushed.
    unpushed=$(git rev-list HEAD --not --remotes --count 2>/dev/null) || unpushed=0
    if [[ "$unpushed" -gt 0 ]]; then
      echo "Branch '$current_branch' has $unpushed unpushed commit(s) and no remote branch. Please push these changes to the remote repository." >&2
      exit 2
    fi
  fi
fi

exit 0
