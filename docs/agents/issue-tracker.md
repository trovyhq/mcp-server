# Issue tracker: GitHub

Issues and specs for this repo live as GitHub Issues. Use the `gh` CLI for all operations.

## Conventions

- Create: `gh issue create --title "..." --body "..."`.
- Read: `gh issue view <number> --comments`, including labels.
- List: `gh issue list --state open`, with the appropriate label filters.
- Comment: `gh issue comment <number> --body "..."`.
- Label: `gh issue edit <number> --add-label "..." --remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Infer the repository from its Git remote; `gh` does so automatically inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to `yes` only if this repository treats external pull requests as feature requests.

## Skill conventions

When a skill says “publish to the issue tracker”, create a GitHub issue. When it says “fetch the relevant ticket”, run `gh issue view <number> --comments`.

