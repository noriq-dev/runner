This session is ending. Before it closes, give a short account of the work you did in it — not a
verdict on whether it succeeded. That is decided separately, after you answer, so do not guess at
it and do not say the run passed or failed.

Reply with exactly one fenced ```json block and nothing else outside it:

```json
{
  "approachSummary": "",
  "rejectedHypotheses": [],
  "durableLearnings": [],
  "unresolvedQuestions": []
}
```

- `approachSummary`: one or two sentences on the approach you took and why, in your own words.
- `rejectedHypotheses`: things you considered and ruled out, each one short sentence — useful to a
  future agent who might otherwise try the same dead end.
- `durableLearnings`: anything true of this codebase generally, not just this task, worth another
  agent knowing later — a convention, a gotcha, a fact about how something actually behaves.
- `unresolvedQuestions`: anything you were unsure about or left open, worth a human or a future
  agent's attention.

A field with nothing to say is an empty string or empty array — do not pad it. Keep every entry to
a sentence or two; this is a summary, not a report. It will be stored as your own account of the
work, labelled agent-authored and unverified, so write your honest best recollection rather than a
pitch.
