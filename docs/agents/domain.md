# Domain Docs

How engineering skills should consume this repository’s domain documentation.

## Before exploring

Read, when relevant:

- `CONTEXT.md` at the repository root.
- ADRs in `docs/adr/` that affect the area of work.

If these files do not exist, proceed silently. The `/domain-modeling` skill creates them only when domain terminology or a decision needs to be recorded.

## Layout

This is a single-context repository:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

Use the glossary vocabulary from `CONTEXT.md` in issue titles, code, tests, and proposals. If planned work conflicts with an ADR, state that conflict explicitly rather than silently overriding the decision.

