A plan checker read your spec and refused it. Revise the spec — do not defend it.

{{findings}}

Emit the corrected spec as ONE fenced ```json block, complete, in the same shape as before. It REPLACES what you wrote; anything you leave out is gone, so carry forward the parts that were not criticised.

If a finding is wrong, contest it — in this exact shape, above the block, one line each:

```
FINDING <n>: CONTESTED <file:line or other pointer> — <why, in a clause>
```

A pointer is a fact the next checker can open; an argument is something it has to be talked out of, and it will not be. Contested findings are carried forward as SETTLED, so the next checker sees your answer rather than re-raising the point — which is the only thing that stops you paying for the same objection twice. Leave that part of the spec as it was. Everything else in the report, fix.

Round {{round}} of {{maxRounds}}. After the last one the plan goes to the builder as it stands, findings and all, so a part you cannot fix is better said plainly in `discretion` or `deferred` than left looking settled.
