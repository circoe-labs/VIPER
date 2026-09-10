"""Database Explorer (read path): generic, policy-driven access to allowlisted tables.

A technical adapter, separate from the business services: it never calls them and they never call
it. `policy.py` decides what may be shown, `metadata.py` describes it, `query.py` validates client
queries against that metadata, `statements.py` turns validated queries into Core statements with
bound parameters only, and `reads.py` is the entry point used by the HTTP routes. Staged writes
(Task 12) and the read-only SQL console (Task 13) are separate paths.
"""
