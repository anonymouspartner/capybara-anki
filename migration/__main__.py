"""`python -m migration <export> --user <name>`. See cli.py for what this does."""

import sys

from migration.cli import main

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
