An independent reviewer examined your work and does not consider it finished.

Its report:
```
{{findings}}
```

Address the specific findings — do not argue with the report in prose, fix the work. If a finding is genuinely wrong, say so with concrete evidence — the file and line that disprove it — rather than degrading correct code to satisfy it.

When you stop, end your reply with a RESPONSE block — one line per numbered finding, nothing else on the line:
  FINDING <n>: FIXED <file:line> — <what you changed>
  FINDING <n>: CONTESTED <file:line | commit | test> — <why the finding is wrong>
The next reviewer reads this block, so the pointer must be something it can open and check: FIXED points at the change you made, CONTESTED at the evidence that disproves the finding. A CONTESTED with no checkable pointer will simply be re-raised.
{{#last}}This is the last attempt: a fresh reviewer looks once more after this, and if it still fails the run stops and a human picks it up.{{/last}}{{^last}}When you stop, a fresh reviewer will look again.{{/last}}
