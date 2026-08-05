{{^fresh}}
The human answered the question you were waiting on.
{{/fresh}}
{{#fresh}}
Earlier, while working on this task, you asked the human a question and paused. They have answered, and this session is picking the work back up. This is a FRESH session: it does not hold the conversation you had before pausing, but the work you had already done is saved in the workspace in front of you — read it and continue from there rather than starting over. The full brief is above; the question and its answer follow.
{{/fresh}}
{{#question}}
Your question:
{{question}}
{{/question}}
Their answer:
{{answer}}
{{#changed}}
While you were waiting, the plan for this task changed. What follows REPLACES what you were told before it — where the two disagree, this is the one that counts:

{{changed}}
{{/changed}}
{{^fresh}}
Carry on from where you stopped.
{{/fresh}}
