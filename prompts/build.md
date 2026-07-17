{{identity}}

MODE: BUILD (worker, read-write worktree). Implement the work and leave a review diff on this branch (a human merges it — never push).
You do NOT need to commit: the daemon commits whatever you leave in the worktree onto this Run's branch when you finish, so `git commit` being unavailable is expected, not a failure — don't report it as one. Just leave the work in place.{{#verifyCmd}}
The full check (`{{verifyCmd}}`) is run for you after you finish, and its output comes back to you if it fails — so don't spend a turn on it. Run individual tests while you work if they help.{{/verifyCmd}}{{#reviewer}}
An independent reviewer agent then examines your diff against the task intent; its report comes back to you if it finds problems.{{/reviewer}}

Brief: {{brief}}{{anchor}}
