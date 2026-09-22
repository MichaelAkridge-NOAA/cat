# Troubleshooting

Start with the visible message and the affected project. Do not include passwords, session cookies, database credentials, or private storage URLs in support requests.

## Cannot sign in

1. Confirm that you are using the correct CAT deployment and username.
2. Re-enter the password without browser autofill.
3. If the account may be inactive or locked out, contact a CAT administrator.
4. Ask for a password reset only after your identity is verified.

## Project is missing

1. Refresh **Project Manager**.
2. Confirm that you are signed in with the expected account.
3. Ask the project owner to check the collaborator list for your exact username.
4. Confirm that the account is assigned **Viewer** or **Editor**.

## Project is read-only

A **View only** badge means the project role is Viewer. Ask the owner for Editor access, or select **Duplicate** to create an independent editable copy.

## Configuration or administration page is unavailable

- Species and field configuration requires Team Lead or Administrator.
- User Administration requires Administrator.
- Sign out and back in after an administrator changes your account role.

## Imagery or overlay does not load

1. Confirm that other project content loads.
2. Refresh once and retry the layer toggle.
3. Check whether the problem affects one layer, one project, or all projects.
4. Record the project ID, layer name, time, and visible error.
5. Do not send private imagery URLs or storage credentials in an ordinary support message.

## Annotation does not save

1. Stop adding annotations until the current save state is clear.
2. Record the annotation identifier and exact status message.
3. If CAT reports **Saved locally, DB sync failed**, do not refresh or close the tab until you have preserved the unsynchronized field values.
4. Confirm that your project role is Owner or Editor.
5. Retry only after connectivity and access are restored; check for duplicates afterward.

## QC or export is empty

1. Clear the Region and Year filters.
2. Confirm that at least one accessible project is selected.
3. Verify that the project contains saved annotations.
4. Confirm that your account still has project access.

## Information to provide support

- CAT page and action being performed
- Project name and project ID
- Your account role and project role
- Date and time with time zone
- Exact visible error text
- Whether the issue affects one project or several
- A sanitized screenshot with personal and restricted data removed

Never include a password, session token, database connection string, or unredacted private bucket URL.