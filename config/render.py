#!/usr/bin/env python3
"""Render host templates without modifying a consumer's profile."""
from pathlib import Path
import sys
from profile import load_profile


def render(profile, source, destination):
    _, _, values = load_profile(profile, environ={}, allow_example=True)
    text = Path(source).read_text()
    for key, value in values.items():
        text = text.replace(key, value)
    Path(destination).write_text(text)


if __name__ == "__main__":
    render(*sys.argv[1:])
