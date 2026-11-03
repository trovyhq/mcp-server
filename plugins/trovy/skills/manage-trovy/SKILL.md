---
name: manage-trovy
description: Manage work in Trovy through its MCP tools. Use when the user asks to find, review, create, update, organize, share, or report on Trovy projects, milestones, tasks, comments, dependencies, recurrence, time entries, or notifications.
---

# Manage Trovy

Use the Trovy MCP tools as the source of truth. Keep task references such as `TF-12` in user-facing output.

## Workflow

1. For broad or ambiguous requests, inspect projects or search tasks before choosing a target.
2. Prefer `list_my_tasks` for requests about "my tasks" across projects and `get_smart_inbox` for attention or triage requests.
3. Read the target task before changing it when the reference, current state, or requested transition is ambiguous.
4. Use `list_project_milestones` to resolve a milestone reference before assigning a task. A task may have one planning milestone and contribute to multiple deliverables.
5. Execute explicit single-item writes directly. Summarize the resulting task reference and new state.
6. Preview affected task references and request confirmation before bulk deletion or a bulk update whose scope the user did not explicitly enumerate.
7. Request confirmation before creating a public share link unless the user explicitly asked to share the task publicly.

## Safety and authentication

- Never display, store, or request the full `TROVY_TOKEN` in conversation.
- If Trovy tools are unavailable because authentication is missing, tell the user to export `TROVY_TOKEN`, restart Codex, and try again.
- Do not infer a project, user, or task when multiple matches remain. Present concise candidates and ask the user to choose.
- Treat delete, public sharing, and large bulk operations as high-impact actions.
- New milestones are private by default. Set `client_visible` only when the user asks to expose a milestone to clients. Deleting a milestone ungroups its deliverables and clears task milestone assignments; explain that effect before an ambiguous deletion.
- Respect Trovy permissions and report API errors without exposing internal payloads or credentials.
