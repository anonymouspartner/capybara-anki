"""Makes `migration` importable under a bare `pytest` invocation.

`migration` is a real package (it has __init__.py), so `python -m pytest` already
works — the working directory lands on sys.path. This file exists only so a plain
`pytest` from the repo root behaves the same way, matching the convention in
ukrainian-anki-scanner/conftest.py.
"""
