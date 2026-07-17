Your change is being rebased onto {{landBranch}} so it can land, and git could not merge it automatically.

You implemented: {{#task}}{{task}}{{/task}}{{^task}}the task you just implemented{{/task}}
Conflicted files:
{{files}}

The rebase is IN PROGRESS in this worktree. Resolve ONLY if the resolution is mechanical and preserves BOTH sides' intent — e.g. two additions to the same list/import block, or a formatting collision. Edit the files to remove every conflict marker (<<<<<<<, =======, >>>>>>>). Do NOT commit, do not run git rebase --continue — the daemon does that.{{#verifyCmd}}
When the files are resolved, run: {{verifyCmd}}
If it does not pass, do NOT force it — say so and stop.{{/verifyCmd}}

STOP and explain instead if resolving would mean DECIDING anything:
  - the two sides implement competing versions of the same behavior,
  - the other side refactored/renamed/moved what you changed,
  - a signature, schema, or contract changed under you,
  - you cannot tell what the other side intended.

Bailing out is the CORRECT answer in those cases, not a failure — a human will merge it. Picking a winner silently discards someone's work, which is far worse than waiting.

End your response with EXACTLY one line, on its own:
  RESOLVED: YES   — every conflict marker is gone and both intents are preserved
  RESOLVED: NO    — this needs a human (then explain what the collision actually is)
