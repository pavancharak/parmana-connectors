# ops

## stop-hook-git-check.sh

Stop hook for cloud sessions. It blocks a session from ending while the repository has commits that are not on the remote.

The environment's setup script installs it at container start by copying this file to `/root/.claude/stop-hook-git-check.sh`. It copies from the checked-out repository, so the installed hook matches whichever branch the session starts from.

To update the installed hook, change this file on the branch the session uses, then start a fresh session or rebuild the container. Restarting an existing container does not re-run the setup script.
