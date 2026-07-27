A plan checker read your spec and refused it. Revise the spec — do not defend it.

{{findings}}

Emit the corrected spec as ONE fenced ```json block, complete, in the same shape as before. It REPLACES what you wrote; anything you leave out is gone, so carry forward the parts that were not criticised.

If a finding is wrong, say why in one line above the block — with a pointer to the file or line that shows it — and leave that part of the spec as it was. A pointer is a fact the next checker can open; an argument is something it has to be talked out of, and it will not be. Everything else in the report, fix.

Round {{round}} of {{maxRounds}}. After the last one the plan goes to the builder as it stands, findings and all, so a part you cannot fix is better said plainly in `discretion` or `deferred` than left looking settled.
