"""Database Explorer: generic, policy-driven access to allowlisted tables.

A technical adapter, separate from the business services. Read path: `policy.py` decides what may
be shown and changed, `metadata.py` describes it, `query.py` validates client queries against that
metadata, `statements.py` turns validated queries into Core statements with bound parameters only,
and `reads.py` is the entry point used by the HTTP routes. Staged write path (Task 12):
`changes.py` validates a change set against the same metadata, `writes.py` applies it through the
ORM (audited) — delegating to the domain service where one owns the rule (company change, contact
tracking) — and `deletion.py` reports what a deletion would block or cascade. The read-only SQL
console (Task 13) is a separate path.
"""
