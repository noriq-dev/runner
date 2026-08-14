An independent reviewer examined your work and found it does not satisfy the intent — and this was the FINAL review round, so there is no budget left to change the code.

You get ONE turn to CONTEST any of its findings you believe is wrong, or reaches past what this change is responsible for. This is NOT a fix turn: do not edit files — nothing you change now is even looked at. A contest is a POINTER to evidence a fresh reviewer can open and check for itself — the file and line, an earlier change, or a test that already covers it — never an argument in prose. A finding you cannot point at stands, and the run fails on it.

Its report:
```
{{findings}}
```

End your reply with a RESPONSE block — one line per finding you contest, nothing else on the line:
  FINDING <n>: CONTESTED <file:line | commit | test> — <why the finding is wrong, or not this change's to answer for>
The pointer must be something the reviewer can open and verify: a CONTESTED with no checkable pointer is not a contest and will not clear the finding. A finding that is real but not this change's may be contested with the task that now tracks it — `task:<key>`, the proposal filed through create_tasks or a task that already exists and covers it. The daemon verifies that task is real and hands the fact to the fresh reviewer as data; a task it cannot verify is no pointer at all, and this turn fails on it. Contest only what you can point at; a finding you leave unanswered is taken as accepted. A finding that carries lettered sub-claims is contested letter by letter, one line each:
  FINDING <n><letter>: CONTESTED <file:line | commit | test> — <why that sub-claim is wrong>
A response to the bare number speaks for none of the letters, and a sub-claim you leave unanswered is taken as accepted — the finding then stands on it, however thoroughly you rebutted its siblings.{{#record}}

THE RECORD — every sub-claim these findings carry, with the letter that answers it here and now. This lettering is authoritative for your RESPONSE block — where the report above letters a finding differently, answer by the record's letters, because the record's claims are the ones standing against you and your letters resolve against them. It includes sub-claims from earlier rounds that the report above does not repeat, and each of those still stands unless the answer shown beside it is already a contest or you contest it this turn, by the letter shown. A sub-claim marked FIXED blocks clearing too — the reviewer judged the work with that fix in it — so if you believe its claim no longer holds, CONTEST that letter with a pointer at the landed change. A contest the record marks as standing on a task pointer that did NOT verify blocks clearing the same way: answer that letter again this turn, with a pointer that checks out.
{{record}}{{/record}}
A fresh reviewer reads your RESPONSE block, checks each pointer against the same diff, and passes the run only if the findings no longer stand.
