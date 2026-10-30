#!/usr/bin/env python3
"""Install the initial profile contract; caller holds the normal deployment lock."""
import argparse
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile


def load_module(source):
    spec = importlib.util.spec_from_file_location("consumer_profile", source / "config/profile.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def effective_environment(unit):
    pid = subprocess.check_output(
        ["systemctl", "show", unit, "--property=MainPID", "--value"], text=True).strip()
    if not pid.isdecimal() or int(pid) <= 0:
        raise ValueError(f"{unit} must be running for environment validation")
    # Credentials stay in memory; never print the environment or pass it in argv.
    return dict(part.split("=", 1) for part in Path(f"/proc/{pid}/environ").read_text().split("\0") if "=" in part)


def prepare(source, checkout, relative, environments):
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError("profile must be a repository-relative path")
    module = load_module(source)
    profile, env, _ = module.load_profile(source / relative, environ={})
    user = profile["deployment"]["agent_user"]
    for inherited in environments:
        module.load_profile(source / relative, environ=inherited)
    settings = {
        "SH_DIR": str(checkout), "AGENT_USER": user,
        "SELF_HEALING_PROFILE": str(checkout / relative),
        "DEPLOY_MONITOR_LOCK": env["MONITOR_LOCK_FILE"],
    }
    contract = "".join(key + "=" + shlex.quote(value) + "\n" for key, value in settings.items())
    return user, contract, checkout / relative


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def install(directory, target, contract):
    directory.mkdir(mode=0o755, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.geteuid() or directory.stat().st_mode & 0o022:
        raise ValueError("configuration directory must be owned and writable only by the installer")
    link, env = directory / "profile.json", directory / "deploy.env"
    # Never replace an operator's existing contract. A matching partial install
    # is safe to resume; the profile link is intentionally dangling until CD.
    if link.is_symlink():
        if os.readlink(link) != str(target):
            raise ValueError("existing profile link selects another consumer")
    elif link.exists():
        raise ValueError("existing profile is not the expected symlink")
    if env.is_symlink() or (env.exists() and env.read_text() != contract):
        raise ValueError("existing deploy.env differs; reconcile it in a reviewed migration")
    if env.exists() and (env.stat().st_uid != os.geteuid() or env.stat().st_mode & 0o022):
        raise ValueError("deploy.env must be owned and writable only by the installer")
    if not link.is_symlink():
        link.symlink_to(target)
        sync_directory(directory)
    if not env.exists():
        fd, temporary = tempfile.mkstemp(prefix=".deploy-env-", dir=directory)
        try:
            with os.fdopen(fd, "w") as output:
                output.write(contract)
                output.flush()
                os.fchmod(output.fileno(), 0o644)
                os.fsync(output.fileno())
            os.replace(temporary, env)
            sync_directory(directory)
        finally:
            Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("must run as root from the release workflow")
    source, checkout = args.source.resolve(), args.checkout.resolve()
    environments = [effective_environment(unit) for unit in
                    ("claude-code-vm-job-dispatcher.service", "self-healing-change-ingest.service")]
    user, contract, target = prepare(source, checkout, args.profile, environments)
    # Also prove the runtime user can read the staged profile and companion files.
    subprocess.run(["sudo", "-n", "-u", user, "python3", str(source / "config/run.py"),
                    "--profile", str(source / args.profile), "--check"], check=True)
    install(Path("/etc/self-healing"), target, contract)
    print("Consumer contract installed; waiting for the normal deployment timer.")


if __name__ == "__main__":
    main()
