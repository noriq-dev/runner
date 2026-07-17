The check did not pass, so your work is not finished yet.

I ran `{{cmd}}` in your workspace and it {{#timedOut}}timed out after {{timeoutSeconds}}s{{/timedOut}}{{^timedOut}}exited {{exitCode}}{{/timedOut}}. This is the real gate — the same command
decides whether this run lands, so it has to be green.

Output (tail):
```
{{output}}
```

{{#last}}This is the last attempt: if it still fails after this, the run stops and a human picks it up.{{/last}}{{^last}}Fix it and stop when you are done — I will run the check again.{{/last}}
