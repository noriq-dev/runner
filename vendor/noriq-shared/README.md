# @noriq-dev/shared (vendored)

This is a **vendored copy** of the runtime-neutral slice of `@noriq-dev/shared` from
the Noriq monorepo (`packages/shared/src`). It is pure zod — no Worker/CF or Node
globals — which is exactly why the daemon can import it.

Vendored (not a published dep or a cross-repo `file:` link) so this runner repo
stays standalone and CI works without a Noriq checkout, per the RUN plan
("dep on the runtime-neutral slice of @noriq-dev/shared only — published, or vendored
until the contract freezes").

**Do not edit these files here.** They are the frozen wire contract. To refresh
after a contract change upstream, run from the repo root:

```
npm run vendor:shared
```

Every refresh records `PROVENANCE.json` beside `src/` — the source commit, whether that source
checkout was dirty, and a hash per vendored file. `npm run vendor:check` re-verifies the tree
against it (also wired into `npm run check` and CI) — a hand-edit here fails that check by
construction rather than by someone noticing a diff. See [`../../VENDORED-CONTRACT.md`](../../VENDORED-CONTRACT.md)
for the full mechanism (RUN-240).

Once the contract freezes, this is replaced by a published `@noriq-dev/shared`
dependency (see the plan's open refinements).
