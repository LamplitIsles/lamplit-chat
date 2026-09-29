# Explicitly bootstrap Jiji into each session

Status: accepted

Jiji is one continuing companion identity across sessions, while each session owns its conversation and workspace. The private local `.jiji` directory is the canonical identity draft. An operator explicitly synchronizes its four Markdown files to a selected session ID; a new session does not inherit an earlier cloud copy. This keeps one editable source and makes updates to a session deliberate, with the understood consequence that sessions can temporarily contain different revisions of the same identity.

The Worker loads the synchronized `AGENTS.md` into the system context for each turn. That file tells Jiji to read `IDENTITY.md`, `USER.md`, and `SOUL.md` from her session workspace. The shared companion base prompt adapts the relevant principles from `codex-for-love` but omits its Codex, mailbox, relationship-state, and media-tool assumptions. The local sync command needs an authenticated import path even while the main site remains publicly accessible; the operator accepts that session files and conversations are publicly readable until site access control is added.

Synchronization is an explicit override of the four files in one session. Between synchronizations, Jiji may edit those files in her workspace; those edits do not change the local draft or other sessions.
