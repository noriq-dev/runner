An independent reviewer examined your work and does not consider it finished.
{{#repair}}

{{repair}}
{{/repair}}

Its report:
```
{{findings}}
```

Address the specific findings — do not argue with the report in prose, fix the work. If a finding is genuinely wrong, say so with concrete evidence — the file and line that disprove it — rather than degrading correct code to satisfy it.

When a finding names an INVARIANT rather than a single line — a promise that must hold everywhere (a round-trip, a sum, a floor, a preserved value) and cites several places it leaks — fix the invariant in ONE place, not each cited site in turn. The citations are evidence of the class, not a checklist; patch them one by one and the next reviewer finds the leak you did not, and the round after that, until the rounds run out. Find the single point the invariant can be enforced and enforce it there; if the current shape has no such point, say so in your RESPONSE — that the fix is structural — rather than spending the round patching instances.

When you stop, end your reply with a RESPONSE block — one line per numbered finding, nothing else on the line:
  FINDING <n>: FIXED <file:line> — <what you changed>
  FINDING <n>: CONTESTED <file:line | commit | test> — <why the finding is wrong>
The next reviewer reads this block, so the pointer must be something it can open and check: FIXED points at the change you made, CONTESTED at the evidence that disproves the finding. A CONTESTED with no checkable pointer will simply be re-raised.
When a finding enumerates lettered sub-claims (FINDING 1a, FINDING 1b, …), answer each letter as its own line, in the same two forms:
  FINDING <n><letter>: FIXED|CONTESTED <pointer> — <reason>
Each sub-claim is answered alone: a response to the bare number speaks for none of the letters, and a sub-claim you do not address STANDS rather than riding its siblings' answer. Letters name the lettered lines of the report above, so answer the letters in front of you — a standing sub-claim from an earlier round that this report does not repeat is carried in the record by its claim wording, still standing, and comes back to you re-listed when it still matters.
{{#last}}This is the last attempt: a fresh reviewer looks once more after this, and if it still fails the run stops and a human picks it up.{{/last}}{{^last}}When you stop, a fresh reviewer will look again.{{/last}}
