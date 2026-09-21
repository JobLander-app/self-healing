#!/usr/bin/env python3
"""Serialize Codex and operator login per auth home. Never unlink the lock.

Codex inherits the kernel lock: a dead supervisor cannot allow a second
refresher while its child lives. FD 3 is the Node adapter's private handshake.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile


def fingerprint(home):
    try:
        return hashlib.sha256((home / "auth.json").read_bytes()).hexdigest()
    except FileNotFoundError:
        return "missing"


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}), flush=True)


def save(home, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=home, delete=False) as output:
            temporary = output.name
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, home / "shl-auth-state.json")
        directory = os.open(home, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def main():
    home = Path(os.environ["CODEX_HOME"]).resolve()
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = os.open(home / "shl-auth.lock", os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    binary, *args = sys.argv[1:]
    if args == ["login", "--device-auth"]:
        # Login uses the same lock, and does not claim readiness.
        return subprocess.call([binary, "-c", 'cli_auth_credentials_store="file"', *args], pass_fds=(lock,))

    generation = fingerprint(home)
    emit("shl.auth_locked", credentialFingerprint=generation)
    with os.fdopen(3, "r+b", buffering=0) as control:
        if control.read(1) != b"G":
            return 1  # candidate rejected, parent aborted or died
        marker = home / "shl-auth-state.json"
        saved = json.loads(marker.read_text()) if marker.exists() else {}
        if marker.exists() and (not isinstance(saved, dict) or saved.get("status") not in {"unknown", "available", "blocked"}
                                or not saved.get("credentialFingerprint") or not saved.get("checkedAt")):
            raise ValueError("invalid auth state")
        retry = None
        try:
            retry = datetime.datetime.fromisoformat(saved.get("retryAt", "").replace("Z", "+00:00"))
        except ValueError:
            pass
        cooling = retry is not None and retry.tzinfo is not None and retry > datetime.datetime.now(datetime.timezone.utc)
        if (saved.get("credentialFingerprint") == generation and saved.get("status") == "blocked"
                and (saved.get("requiresLogin") is True or cooling)):
            emit("shl.auth_blocked", state=saved, credentialFingerprint=generation)
            return 1  # no CLI, no state write, no extension of the deadline
        else:
            child = subprocess.Popen([binary, *args], stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, pass_fds=(lock,))
            stderr = b""
            ends_line = True
            with selectors.DefaultSelector() as selector:
                selector.register(child.stdout, selectors.EVENT_READ, 1)
                selector.register(child.stderr, selectors.EVENT_READ, 2)
                while selector.get_map():
                    events = selector.select(timeout=0.1)
                    if not events and child.poll() is not None:
                        break  # descendants may retain pipes; Node kills the group
                    for key, _ in events:
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        elif key.data == 1:
                            sys.stdout.buffer.write(chunk)
                            sys.stdout.buffer.flush()
                            ends_line = chunk.endswith(b"\n")
                        else:
                            stderr = (stderr + chunk)[-4000:]
            code = child.wait()
            if not ends_line:
                sys.stdout.buffer.write(b"\n")
                sys.stdout.buffer.flush()
        finished = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        generation = fingerprint(home)  # includes built-in refresh
        emit("shl.auth_finished", code=code, checkedAt=finished,
             credentialFingerprint=generation, stderr=stderr.decode("utf-8", "replace"))
        # Classify once in Node before another process can acquire the lock.
        # EOF means no unverified success is saved.
        reply = bytearray()
        while len(reply) <= 4096:
            byte = control.read(1)
            if not byte:
                return 1
            if byte == b"\n":
                break
            reply.extend(byte)
        state = json.loads(reply)
        if state is None:
            return code if code >= 0 else 1  # retain evidence after a task failure
        if state.get("status") not in ("available", "blocked", "unknown"):
            raise ValueError("invalid provider state")
        save(home, {**state, "checkedAt": finished, "credentialFingerprint": generation})
        return code if code >= 0 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # A broken lock/state store must never launch unlocked. Exception
        # content can include private paths/content, so keep this generic.
        print("Codex auth coordination unavailable", file=sys.stderr)
        sys.exit(1)
