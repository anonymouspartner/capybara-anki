"""Migration CLI — reads an Anki collection export and reports/emits what is in it.

This is step 0 of docs/DESIGN.md's build order (§9): a local tool, run by hand a
handful of times, that never touches Postgres and never gets deployed (see D7 — Python
stays local, everything hosted is TypeScript). Its whole job is to answer one question
before any other code gets written: can this collection actually be read, and does it
carry what §7.3 needs (FSRS memory state + scheduler config) to make the switch feel
like nothing changed?

Two hard boundaries, both from the repo's ground rules and from §7.4 of the design doc:
  - Read-only. This package never writes to Postgres, and never will — that is the
    real migration's job, once the shape proven here is trusted.
  - No Supabase changes. Nothing here calls out to a live project.
"""
