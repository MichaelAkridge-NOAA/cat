# Roles and Access

CAT combines a deployment-wide account role with a separate role on each project. Both affect what a user can do.

## Account roles

| Account role | Normal capabilities |
| --- | --- |
| **Annotator** | Use projects shared with the account, create projects, annotate when granted edit access, and use review/export pages. |
| **Team lead** | All annotator capabilities, plus deployment-wide species, field-option, and default configuration. |
| **Administrator** | All team-lead capabilities, plus user activation, role assignment, and password reset. |

An elevated account role does not replace project access. For example, a team lead still needs access to a project before it appears in that person's project list.

## Project roles

| Project role | Access |
| --- | --- |
| **Owner** | Full control of the project, including sharing and deletion. |
| **Editor** | Can modify project content, assets, layers, and annotations. |
| **Viewer** | Read-only access. Can inspect or duplicate the project but cannot mutate the original. |

!!! warning "Use least privilege"
    Give **Viewer** access when a person only needs to inspect results. Give **Editor** access only when that person should change shared project data.

## Common access checks

- A **View only** badge means editing controls should be unavailable or rejected.
- **Species & Fields** configuration requires a team-lead or administrator account role.
- **User Administration** requires an administrator account role.
- Sharing controls are intended for the project owner.
- A viewer can use **Duplicate** to create an independently editable copy owned by that viewer.

When a control is missing, first confirm both the account role and the project role before reporting a problem.