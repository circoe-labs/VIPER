"""One command from a fresh pull to a running app. Usage: `python scripts/dev.py` (stdlib only).

Idempotent: every step is a no-op when already up to date, so run it after EVERY `git pull`.
  1. Docker daemon (started if down) and the PostgreSQL container.
  2. Databases viper_test / viper_e2e (created if the volume predates the init script).
  3. backend/.venv and its dependencies (reinstalled only when requirements*.txt changed).
  4. `alembic upgrade head` and the read-only SQL role (run after every pull).
  5. frontend/node_modules (`npm ci` only when package-lock.json changed).
  6. Login account (asks once if the users table is empty).
  7. Backend (8042) and Vite (5173); Ctrl+C stops both.

Options: `--no-start` prepares everything but launches nothing.
"""

import hashlib
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
WIN = os.name == "nt"
VENV_PY = BACKEND / ".venv" / ("Scripts/python.exe" if WIN else "bin/python")
NPM = "npm.cmd" if WIN else "npm"
API_PORT, WEB_PORT = 8042, 5173


def say(message: str) -> None:
    print(f"==> {message}", flush=True)


def die(message: str) -> None:
    print(f"\nERREUR : {message}", file=sys.stderr)
    sys.exit(1)


def run(
    cmd: list[str], cwd: Path = ROOT, check: bool = True, **kw: Any
) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(cmd, cwd=cwd, **kw)
    if check and result.returncode != 0:
        die(f"commande en echec ({result.returncode}) : {' '.join(cmd)}")
    return result


def quiet(cmd: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)


def digest(*files: Path) -> str:
    h = hashlib.sha256()
    for f in files:
        h.update(f.read_bytes())
    return h.hexdigest()


def port_busy(port: int) -> bool:
    # Both stacks: Node resolves "localhost" to ::1, so another project's Vite can hold the port on IPv6 only.
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(family) as s:
                s.settimeout(0.5)
                if s.connect_ex((host, port)) == 0:
                    return True
        except OSError:
            pass  # stack unavailable on this machine
    return False


def free_port(preferred: int) -> int:
    for port in range(preferred, preferred + 20):
        if not port_busy(port):
            return port
    die(f"aucun port libre entre {preferred} et {preferred + 19}.")
    raise AssertionError  # unreachable: die() exits


def ensure_docker() -> None:
    say("Docker")
    if quiet(["docker", "info"]).returncode == 0:
        return
    if not shutil.which("docker"):
        die("Docker n'est pas installe (Docker Desktop requis).")
    exe = (
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
        / "Docker/Docker/Docker Desktop.exe"
    )
    if WIN and exe.exists():
        print("    Docker Desktop est arrete, demarrage...", flush=True)
        subprocess.Popen([str(exe)], creationflags=0x00000008)  # DETACHED_PROCESS
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-a", "Docker"])
    else:
        die("Le demon Docker ne repond pas. Demarrez-le puis relancez.")
    for _ in range(90):
        time.sleep(2)
        if quiet(["docker", "info"]).returncode == 0:
            return
    die("Docker ne repond pas apres 3 minutes. Ouvrez Docker Desktop, relancez.")


def ensure_database() -> None:
    say("PostgreSQL (docker compose up --wait)")
    run(["docker", "compose", "up", "-d", "--wait"])
    have = quiet(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "db",
            "psql",
            "-U",
            "viper",
            "-d",
            "viper",
            "-tAc",
            "select datname from pg_database",
        ]
    ).stdout.split()
    for name in ("viper_test", "viper_e2e"):
        if name not in have:
            run(
                [
                    "docker",
                    "compose",
                    "exec",
                    "-T",
                    "db",
                    "psql",
                    "-U",
                    "viper",
                    "-d",
                    "viper",
                    "-c",
                    f"CREATE DATABASE {name} OWNER viper",
                ]
            )


def ensure_backend() -> None:
    say("Backend : venv, dependances, migrations")
    if not VENV_PY.exists():
        run([sys.executable, "-m", "venv", str(BACKEND / ".venv")])
    stamp = BACKEND / ".venv" / ".deps-stamp"
    wanted = digest(BACKEND / "requirements.txt", BACKEND / "requirements-dev.txt")
    if stamp.exists() and stamp.read_text() == wanted:
        pass
    elif (
        "Would install"
        not in quiet(
            [str(VENV_PY), "-m", "pip", "install", "--dry-run", "-r", "requirements-dev.txt"],
            BACKEND,
        ).stdout
    ):
        stamp.write_text(wanted)  # first run: the existing venv already satisfies the requirements
    else:
        if port_busy(API_PORT):
            die("requirements*.txt ont change : arretez le backend (port 8042) puis relancez.")
        run([str(VENV_PY), "-m", "pip", "install", "-q", "-r", "requirements-dev.txt"], cwd=BACKEND)
        stamp.write_text(wanted)
    run([str(VENV_PY), "-m", "alembic", "upgrade", "head"], cwd=BACKEND)
    if (
        run(
            [str(VENV_PY), "-m", "app.cli", "provision-sql-reader"], cwd=BACKEND, check=False
        ).returncode
        != 0
    ):
        print("    (avertissement : role SQL lecture seule non provisionne)", flush=True)


def ensure_frontend() -> None:
    say("Frontend : node_modules")
    stamp = FRONTEND / "node_modules" / ".deps-stamp"
    wanted = digest(FRONTEND / "package-lock.json")
    if stamp.exists() and stamp.read_text() == wanted:
        return
    if (FRONTEND / "node_modules").exists() and quiet(
        [NPM, "ls", "--depth=0"], FRONTEND
    ).returncode == 0:
        stamp.write_text(wanted)  # first run: the existing install already matches the lockfile
        return
    if port_busy(WEB_PORT):
        die("package-lock.json a change : arretez Vite (port 5173) puis relancez.")
    run([NPM, "ci"], cwd=FRONTEND)
    stamp.write_text(wanted)


def ensure_user() -> None:
    say("Compte de connexion")
    count = quiet(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "db",
            "psql",
            "-U",
            "viper",
            "-d",
            "viper",
            "-tAc",
            "select count(*) from users",
        ]
    ).stdout.strip()
    if count == "0":
        email = input("    Aucun compte. Email : ").strip()
        name = input("    Nom affiche : ").strip()
        run(
            [
                str(VENV_PY),
                "-m",
                "app.cli",
                "create-user",
                "--email",
                email,
                "--display-name",
                name,
            ],
            cwd=BACKEND,
        )


def wait_health(api: subprocess.Popen[bytes], port: int) -> None:
    for _ in range(60):
        if api.poll() is not None:
            die(f"le backend s'est arrete au demarrage (code {api.returncode}).")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
                if r.status == 200:
                    return
        except OSError:
            time.sleep(1)
    die("le backend ne repond pas sur /api/health.")


def wait_web(web: subprocess.Popen[bytes], port: int) -> None:
    for _ in range(60):
        if web.poll() is not None:
            die(f"Vite s'est arrete au demarrage (code {web.returncode}), voir le message ci-dessus.")
        if port_busy(port):
            return
        time.sleep(0.5)
    die(f"Vite n'ecoute pas sur le port {port} apres 30 s.")


def start() -> None:
    # A busy default port (another project's dev server, a forgotten VIPER) shifts to the next free one
    # instead of failing at launch; both servers are told the actual ports.
    api_port, web_port = free_port(API_PORT), free_port(WEB_PORT)
    for wanted, got in ((API_PORT, api_port), (WEB_PORT, web_port)):
        if got != wanted:
            print(f"    (port {wanted} deja utilise par un autre processus : {got} a la place)", flush=True)
    if web_port != WEB_PORT:
        print(
            "    (la connexion OAuth Toolbox attend le port 5173 : liberez-le si vous en avez besoin)",
            flush=True,
        )
    say(f"Demarrage : API {api_port}, Vite {web_port}")
    api = subprocess.Popen(
        [
            str(VENV_PY),
            "-m",
            "uvicorn",
            "app.main:create_app",
            "--factory",
            "--reload",
            "--port",
            str(api_port),
        ],
        cwd=BACKEND,
    )
    try:
        wait_health(api, api_port)
        env = {
            **os.environ,
            "VIPER_WEB_PORT": str(web_port),
            "VIPER_API_TARGET": f"http://127.0.0.1:{api_port}",
        }
        web = subprocess.Popen([NPM, "run", "dev"], cwd=FRONTEND, env=env)
        wait_web(web, web_port)
        print(
            f"\n    Pret : http://localhost:{web_port}   (Ctrl+C pour tout arreter)\n", flush=True
        )
        web.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for p in (locals().get("web"), api):
            if p and p.poll() is None:
                if (
                    WIN
                ):  # whole tree: uvicorn --reload and npm spawn children that outlive terminate()
                    subprocess.run(
                        ["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True
                    )
                else:
                    p.terminate()


def main() -> None:
    ensure_docker()
    ensure_database()
    ensure_backend()
    ensure_frontend()
    ensure_user()
    if "--no-start" not in sys.argv[1:]:
        start()
    else:
        say("Environnement pret.")


if __name__ == "__main__":
    main()
