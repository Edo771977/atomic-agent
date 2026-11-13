# Git tools and remote credentials

Status: current
Owner: src/tools/os/git/

Git read and remote-mutation operations have different resource/approval classes. Preserve subprocess argument handling, host/path validation, credential headers and scope of destructive operations. Credentials must not persist in remote URLs or tool summaries.

Read [tool instructions](../../AGENTS.md), [Git API helpers](../../../github/README.md), [git registry](index.ts), and adjacent git tests. Remote fetch/pull/push/clone behavior must be checked separately from read-only status/diff/log.

The read tools (`status`, `branch`, `show`, `log`, `blame`, `diff`) are read-scope tools: `repo` and every pathspec, resolved against `repo`, are read targets. A `revision`/`revisionRange` reaches git before `--`, so one starting with `-` is refused (`revisionArg` in `git-runner.ts`) rather than becoming an option such as `--no-index`, `--contents=` or `--output=`.
