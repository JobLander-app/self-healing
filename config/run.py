#!/usr/bin/env python3
"""Validate a consumer profile, then replace this process with a component."""
import argparse
import os
import sys
from profile import load_profile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--allow-example", action="store_true", help="validate template shape only; cannot launch")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.allow_example and not args.check:
        parser.error("--allow-example requires --check")
    value, env, _ = load_profile(args.profile, allow_example=args.allow_example)
    if args.check:
        print(f"Profile valid: {value['name']}" + (" (template only)" if args.allow_example else ""))
        return
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required (or use --check)")
    os.execvpe(command[0], command, env)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        sys.exit(2)
