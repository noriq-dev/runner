An independent reviewer examined your work and found it does not satisfy the intent — and this was the FINAL review round, so there is no budget left to change the code.

You get ONE turn to CONTEST any of its findings you believe is wrong, or reaches past what this change is responsible for. This is NOT a fix turn: do not edit files — nothing you change now is even looked at. A contest is a POINTER to evidence a fresh reviewer can open and check for itself — the file and line, an earlier change, or a test that already covers it — never an argument in prose. A finding you cannot point at stands, and the run fails on it.

Its report:
```
{{findings}}
```

End your reply with a RESPONSE block — one line per finding you contest, nothing else on the line:
  FINDING <n>: CONTESTED <file:line | commit | test> — <why the finding is wrong, or not this change's to answer for>
The pointer must be something the reviewer can open and verify: a CONTESTED with no checkable pointer is not a contest and will not clear the finding. Contest only what you can point at; a finding you leave unanswered is taken as accepted. A fresh reviewer reads this block, checks each pointer against the same diff, and passes the run only if the findings no longer stand.
