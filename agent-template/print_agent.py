"""
Echel - Local Agent v6.0
NEW: System Tray (runs in the background, no CMD window)
NEW: Auto-Update (downloads + restarts by itself when a new version arrives)
"""

import requests
import time
import os
import sys
import tempfile
import subprocess
import threading
import shutil
import secrets
import re
import json
from datetime import datetime
from pathlib import Path

# SAFETY FIX: when the .exe starts automatically from Windows Startup (after a PC
# restart), the default working directory is C:\Windows\System32 — NOT the
# agent's own installation folder. If a relative path is used anywhere (or
# in future), it would resolve to the wrong place.
# So we explicitly switch to the folder of our own exe/script here.
try:
    if getattr(sys, 'frozen', False):
        _app_dir = os.path.dirname(sys.executable)
    else:
        _app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(_app_dir)
except Exception:
    pass  # even if this fails, everything else uses APPDATA-based paths, so it is safe

# ============================================================
# SHOP_ID_TEMPLATE: in .py source mode the Shop ID is written directly here
# (the server replaces it while building the download package). In .exe mode
# this always stays the unconfigured marker — the real Shop ID comes from the config file.
#
# NOTE: UNCONFIGURED_MARKER is built as a separate string on purpose so that
# server.js's text-replace operation only touches the SHOP_ID_TEMPLATE line
# and does not corrupt the comparison check.
UNCONFIGURED_MARKER = "YOUR" + "_SHOP_ID"
SHOP_ID_TEMPLATE   = "YOUR_SHOP_ID"
SERVER_URL         = "https://echel.in"

def resolve_server_url(default_url, application_dir):
    """Use a supplied deployment origin for Render and subsequent custom domains."""
    from urllib.parse import urlparse
    configured = os.environ.get("ECHEL_SERVER_URL", "").strip()
    if not configured:
        try:
            with open(os.path.join(application_dir, "echel-server.json"), encoding="utf-8") as handle:
                configured = str(json.load(handle).get("serverUrl", "")).strip()
        except (OSError, ValueError, TypeError):
            pass
    if not configured:
        return default_url
    parsed = urlparse(configured)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("Echel server URL must be an HTTPS origin.")
    return configured.rstrip("/")

SERVER_URL = resolve_server_url(SERVER_URL, _app_dir)
# ── THE THREE POLLING SPEEDS ──
# When the shop is busy, 5s; when it has been idle for a while, 10s; when it has
# been idle for a long time, 12s. As soon as a job arrives it goes straight back to 5s,
# so printing is never delayed.
CHECK_INTERVAL     = 5          # a job just arrived — fastest
IDLE_INTERVAL_1    = 10         # idle for 2 min
IDLE_INTERVAL_2    = 12         # idle for 10 min
# How long before moving to the next speed (in seconds)
IDLE_STEP_1_SEC    = 120        # 2 min  -> 10s
IDLE_STEP_2_SEC    = 600        # 10 min -> 12s
# The name is kept for compatibility with older builds
IDLE_INTERVAL_3    = 12
# After a long idle period the TCP socket is often already dead (NAT/ISP
# timeout, or Render going to sleep). The first poll on that dead socket
# fails. So while idle, the session is refreshed ON ITS OWN at this interval
# — BEFORE a job arrives.
IDLE_SOCKET_REFRESH_SEC = 300   # 5 min
# When offline, how many seconds the countdown shows before it
# reconnects by itself.
AUTO_RECONNECT_SECONDS  = 10
# During a long outage, how often a notification is shown (reconnect
# attempts keep running anyway — only the notification pauses).
AUTO_RECONNECT_NOTIFY_GAP = 600  # 10 min
# A shop is busy for only part of the day. Polling every 5 seconds would send
# hundreds of thousands of requests a day and use up the server bandwidth.
# So check slowly while idle — but go straight back to 5s as soon as a job
# arrives, so printing is not delayed.
UPDATE_CHECK_INTERVAL = 3600    # (legacy) — UPDATE_HOURS is used now

# ── The update check now runs at fixed times, not every hour ──
# Checking every hour meant an update could arrive at any moment — in the middle of
# work, while a customer was printing. Now only twice a day.
UPDATE_HOURS = (11, 18)        # 11 AM and 6 PM (the PC's local time)
UPDATE_JITTER_MAX_SEC = 25 * 60  # a random 0-25 min offset (see below)

# ── Long polling ──
# The agent asks once; the server holds the line for up to LP_SECONDS
# and sends the job on that same line as soon as it arrives. This cuts requests
# by 6x and printing starts FASTER (the line is already open).
#
# LP_TIMEOUT must be LONGER than the server's hold — otherwise the agent would
# time out first, treat every poll as a "failure" and go into backoff.
LP_SECONDS = 30                # how long the server holds the line
# The shop was not found on the server (a deleted demo) — then check once
# every this many seconds. It slows down instead of stopping, so that if
# the shop comes back the agent recovers by itself.
SHOP_GONE_INTERVAL = 30 * 60
LP_TIMEOUT = LP_SECONDS + 15   # the agent's own timeout — always longer
VERSION            = 3            # Internal update build number.
                                  # This only goes up (29 → 30 → 31...). Never turn it
                                  # into "2.0": old v27/v28/v29 agents compare it as an
                                  # integer, otherwise they would stop taking updates.
VERSION_LABEL      = "2.1"        # Display version.
REMOTE_VERSION_LABEL = None       # The server's latest label — filled in by the update check
REMOTE_VERSION_INT = 0            # The server's internal build number (for the integer compare)
SUPPORT_WA         = "917011482679"  # Offline fallback; online support follows website settings.

# Log/temp files always live in a user-writable folder (%APPDATA%) —
# because writing into Program Files after an .exe install can fail with
# permission denied. This is safe for both modes (.py script and .exe).
_APPDATA_DIR = os.path.join(os.environ.get('APPDATA', tempfile.gettempdir()), 'EchelPrint')
os.makedirs(_APPDATA_DIR, exist_ok=True)
LOG_FILE           = os.path.join(_APPDATA_DIR, "print_agent_log.txt")

# ══════════════════════════════════════════════════════════════════
# TLS CA BUNDLE PIN — the _MEIxxxxx temp folder of PyInstaller --onefile
# Windows Storage Sense / temp cleaners delete it from under an agent that has
# been running for 8-12 hours. After that every HTTPS request fails with "Could not find
# a suitable TLS CA certificate bundle" — the agent shows "Running" in the tray
# but nothing reaches the server.
# Fix: at startup copy cacert.pem into APPDATA and point the env at it —
# HTTPS stays alive even if _MEI disappears.
# ══════════════════════════════════════════════════════════════════
def _pin_ca_bundle():
    try:
        import certifi
        src = certifi.where()
        dst = os.path.join(_APPDATA_DIR, "cacert.pem")
        try:
            if (not os.path.exists(dst)
                    or os.path.getsize(dst) != os.path.getsize(src)):
                shutil.copy2(src, dst)
        except Exception:
            pass  # if the copy fails, the older pinned copy is used (if there is one)
        if os.path.exists(dst) and os.path.getsize(dst) > 10000:
            os.environ["REQUESTS_CA_BUNDLE"] = dst
            os.environ["SSL_CERT_FILE"] = dst
    except Exception:
        pass  # certifi not found at all — requests uses its default

_pin_ca_bundle()

# ══════════════════════════════════════════════════════════════════
# _MEI SURVIVAL KIT — the onefile temp folder can vanish while the agent runs
#
# This is exactly what happened on 22 Aug 2026: the agent started at 09:12, and at 09:18
# something recursively deleted its _MEI18802 folder. Only the .pyd/.dll files
# that were loaded in the process at that moment survived (Windows keeps them locked).
# base_library.zip, Crypto\, SumatraPDF.exe, agent_panel.html — all gone.
# Two errors appeared:
#   * "Large dialog failed (... base_library.zip)"          -> no new import was possible
#   * "Cannot load native module 'Crypto.Util._cpuid_c'" -> every page-range job crashed
#
# The cure comes in three layers — if one fails, the others still save the day:
#   1. _pin_base_library()    : a private copy of base_library.zip in APPDATA, and
#      it replaces the _MEI entry in sys.path.
#   2. _mirror_bundled_files(): copies of SumatraPDF.exe / the panel HTML / the icon
#      in APPDATA — get_bundled_resource_path() looks there too.
#   3. _preload_fragile()     : import Crypto + PyPDF2 + codecs right at the START.
#      Once loaded, a module stays in sys.modules and its .pyd stays mapped in
#      Windows memory — it keeps working even if the file is deleted.
#
# While _MEI is intact, all three are completely harmless (just one extra copy).
# ══════════════════════════════════════════════════════════════════
_RUNTIME_DIR = os.path.join(_APPDATA_DIR, "runtime")
_EARLY_NOTES = []          # log() does not exist yet — this is flushed at startup


def _early(msg, level="INFO"):
    """Startup notes that have to be written before log() exists."""
    _EARLY_NOTES.append((level, msg))


def _mei_dir():
    """onefile ka extraction folder. onedir / .py mode me None."""
    return getattr(sys, "_MEIPASS", None)


def _same_file(a, b):
    try:
        sa, sb = os.stat(a), os.stat(b)
        return sa.st_size == sb.st_size and int(sa.st_mtime) == int(sb.st_mtime)
    except Exception:
        return False


def _pin_base_library():
    """
    base_library.zip holds the part of Python's stdlib that has not been
    imported yet — such as encodings.cp1252, which is needed for the FIRST TIME
    when reading subprocess text output. If _MEI disappears, every new import
    fails with "FileNotFoundError: ...base_library.zip".

    So a copy of it is kept in APPDATA and the sys.path entry itself is
    changed — after that Python never touches the _MEI file again.
    """
    mei = _mei_dir()
    if not mei:
        return
    src = os.path.join(mei, "base_library.zip")
    if not os.path.exists(src):
        return
    try:
        os.makedirs(_RUNTIME_DIR, exist_ok=True)
        dst = os.path.join(_RUNTIME_DIR, "base_library.zip")
        if not _same_file(src, dst):
            shutil.copy2(src, dst)
        if not os.path.exists(dst):
            return                       # the copy was not created at all — do not touch anything
        target = os.path.normcase(os.path.abspath(src))
        swapped = False
        for i, p in enumerate(list(sys.path)):
            try:
                if os.path.normcase(os.path.abspath(p)) == target:
                    sys.path[i] = dst
                    swapped = True
            except Exception:
                continue
        if not swapped:
            sys.path.insert(0, dst)
        # drop zipimport's old cache, otherwise the same dead file would be opened
        for k in list(sys.path_importer_cache):
            try:
                if os.path.normcase(os.path.abspath(k)) == target:
                    sys.path_importer_cache.pop(k, None)
            except Exception:
                continue
        # ── Changing sys.path alone is NOT ENOUGH ──
        # `encodings`, `collections`, `re` — all three packages are imported at
        # interpreter startup, and their __path__ points DIRECTLY into the _MEI
        # zip. Any lazy submodule of theirs
        # (such as encodings.utf_8_sig) does NOT look at sys.path — it only looks at its
        # package's __path__. So those have to be redirected to the new copy
        # as well.
        moved = 0
        for _m in list(sys.modules.values()):
            try:
                pth = getattr(_m, "__path__", None)
                if not pth or isinstance(pth, str):
                    continue
                old_list = list(pth)
                new_list = [(dst + p[len(src):])
                            if os.path.normcase(p).startswith(os.path.normcase(src))
                            else p
                            for p in old_list]
                if new_list != old_list:
                    _m.__path__ = new_list
                    moved += 1
            except Exception:
                continue
        _early("base_library.zip pinned -> %s (%d package repointed)" % (dst, moved))
    except Exception as e:
        _early("base_library pin failed (%s) - the _MEI copy will be used" % e, "WARN")


# Files taken out of _MEI and kept in APPDATA. These are not Python modules,
# so they cannot be "preloaded" — copying is the only way.
_MIRROR_FILES = ("SumatraPDF.exe", "agent_panel.html", "echel.ico",
                 "SumatraPDF-settings.txt")


def _mirror_bundled_files():
    """A persistent copy of the essential bundle files in APPDATA."""
    mei = _mei_dir()
    if not mei:
        return
    try:
        os.makedirs(_RUNTIME_DIR, exist_ok=True)
    except Exception as e:
        _early("could not create the runtime folder (%s)" % e, "WARN")
        return
    for name in _MIRROR_FILES:
        src = os.path.join(mei, name)
        if not os.path.exists(src):
            continue
        dst = os.path.join(_RUNTIME_DIR, name)
        try:
            if not _same_file(src, dst):
                shutil.copy2(src, dst)
        except Exception as e:
            # If the old copy is in use (SumatraPDF is open), the copy may
            # fail — in that case the old copy does the job.
            _early("mirror %s fail (%s)" % (name, e), "WARN")


# These modules used to be imported for the FIRST TIME during a job. If _MEI had
# vanished by then, the job crashed. Now they are loaded into memory right at startup.
_CRITICAL_PRELOAD = (
    "Crypto.Util._cpu_features", "Crypto.Util.Padding", "Crypto.Util.strxor",
    "Crypto.Util.number", "Crypto.Cipher.AES", "Crypto.Cipher.ARC4",
    "Crypto.Hash.MD5", "Crypto.Hash.SHA256",
    "PyPDF2",
)
# Missing these is not fatal — if they are found, the agent becomes more robust.
_OPTIONAL_PRELOAD = (
    "ctypes", "ctypes.wintypes", "traceback", "tempfile", "winreg",
    "socket", "webbrowser", "certifi", "win32print", "PIL.Image",
)


def _preload_fragile():
    """
    Once a module has been imported it stays in sys.modules and its
    .pyd stays mapped in Windows memory. After that, even if the file is
    deleted, the code keeps running. So all the risky modules are loaded here,
    at startup — while _MEI is fully intact.
    """
    missing = []
    for mod in _CRITICAL_PRELOAD:
        try:
            __import__(mod)
        except Exception as e:
            missing.append("%s [%s: %s]" % (mod, type(e).__name__, str(e)[:90]))
    for mod in _OPTIONAL_PRELOAD:
        try:
            __import__(mod)
        except Exception:
            pass
    # ── ALL CODECS ──
    # Codecs live in base_library.zip and are loaded for the FIRST TIME only when
    # needed — such as reading subprocess text output or
    # writing a file in "utf-8-sig". If _MEI had been cleaned by then,
    # "FileNotFoundError: ...base_library.zip" appeared (the "Large dialog failed"
    # in the screenshot). Now all of them are loaded up front — they are ~100 small
    # .pyc files and take less than half a second.
    codec_names = set()
    try:
        # 1. The most reliable source: the encodings/*.pyc files in the zip
        import zipfile
        _zp = os.path.join(_RUNTIME_DIR, "base_library.zip")
        if not os.path.exists(_zp):
            _mp = _mei_dir()
            _zp = os.path.join(_mp, "base_library.zip") if _mp else ""
        if _zp and os.path.exists(_zp):
            with zipfile.ZipFile(_zp) as _zf:
                for _n in _zf.namelist():
                    if _n.startswith("encodings/") and _n.endswith(".pyc"):
                        _b = _n[len("encodings/"):-4].split(".")[0]
                        if _b and _b != "__init__":
                            codec_names.add(_b)
    except Exception:
        pass
    try:
        # 2. Fallback — from the alias table (it does NOT contain utf_8_sig, so
        #    the list below is needed too)
        import encodings.aliases
        codec_names.update(encodings.aliases.aliases.values())
    except Exception:
        pass
    # 3. The ones that have no alias but are used
    codec_names.update(("utf_8", "utf_8_sig", "utf_16", "utf_16_le", "utf_16_be",
                        "utf_32", "ascii", "latin_1", "mbcs", "oem", "cp1252",
                        "cp437", "cp850", "idna", "unicode_escape",
                        "raw_unicode_escape", "punycode", "hex_codec"))
    for _c in codec_names:
        try:
            __import__("encodings." + _c)
        except Exception:
            pass
    # Lock in the console / locale encoding as well
    try:
        import codecs, locale
        for probe in (locale.getpreferredencoding(False),
                      getattr(sys.stdout, "encoding", None),
                      getattr(sys.stderr, "encoding", None)):
            if probe:
                try:
                    codecs.lookup(probe)
                except Exception:
                    pass
    except Exception:
        pass
    if missing:
        _early("Preload FAIL -> " + " | ".join(missing), "ERROR")
    else:
        _early("Preload OK - %d essential modules + %d codecs in memory"
               % (len(_CRITICAL_PRELOAD), len(codec_names)))
    return not missing


def _mei_intact():
    """Whether the marker files of the _MEI folder still exist."""
    mei = _mei_dir()
    if not mei:
        return True                      # onedir / .py mode — not applicable
    for probe in ("base_library.zip", "SumatraPDF.exe"):
        try:
            if not os.path.exists(os.path.join(mei, probe)):
                return False
        except Exception:
            return False
    return True


_MEI_WARNED = False
_MEI_LAST_CHECK = 0.0


def _mei_watch():
    """
    A check every 5 minutes: is the _MEI folder intact?

    It does not repair anything itself — the three layers above have already
    done that. It only writes a clear note to the log ONCE, so next time
    nobody has to spend an hour hunting for this problem.
    """
    global _MEI_WARNED, _MEI_LAST_CHECK
    if _MEI_WARNED:
        return
    now = time.time()
    if now - _MEI_LAST_CHECK < 300:
        return
    _MEI_LAST_CHECK = now
    try:
        if _mei_intact():
            return
        _MEI_WARNED = True
        log("⚠️  The agent's temp folder (%s) has been cleaned by something else." % _mei_dir(),
            "WARN")
        log("   Printing continues — copies of the essential files are kept in %s."
            % _RUNTIME_DIR, "WARN")
        log("   When convenient, close the agent and start it again.", "WARN")
    except Exception:
        pass


_pin_base_library()
_mirror_bundled_files()
_preload_fragile()

LOCAL_VERSION_FILE = os.path.join(_APPDATA_DIR, "agent_version.txt")
SHOP_CONFIG_FILE   = os.path.join(_APPDATA_DIR, "shop_config.txt")
APPROVAL_CONFIG    = os.path.join(_APPDATA_DIR, "approval_mode.txt")
AGENT_TOKEN_FILE   = os.path.join(_APPDATA_DIR, "agent_token.txt")
# When the owner double-clicks the exe again, the second instance leaves a
# small file here. The RUNNING agent sees it and opens its panel.
# (Without this the second instance quietly exited and the
# owner thought "nothing happened".)
PANEL_REQUEST_FILE = os.path.join(_APPDATA_DIR, "show_panel.request")


def _machine_name():
    """The PC name — for display only ("which computer it is bound to")."""
    try:
        import socket
        return (os.environ.get("COMPUTERNAME") or socket.gethostname() or "")[:100]
    except Exception:
        return ""

def load_or_create_agent_token():
    """
    Secret that proves this really is the shop's own agent.

    Why: /api/jobs/pending/<shop_id> used to be open to anyone. A Shop ID is
    printed on the QR poster, so anybody could poll it, read customers'
    uploaded files and steal print jobs. Now every request carries this token.

    The token is created once on this PC and reused forever. The first agent
    that sends a token claims that shop on the server, so nobody else can.
    """
    try:
        if os.path.exists(AGENT_TOKEN_FILE):
            with open(AGENT_TOKEN_FILE, "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if 16 <= len(tok) <= 64:
                return tok
        tok = secrets.token_urlsafe(24)[:40]
        with open(AGENT_TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(tok)
        return tok
    except Exception:
        # Even if the file cannot be written, keep printing (server allows
        # a missing token until the admin enforces it).
        return ""


AGENT_TOKEN = load_or_create_agent_token()


def auth_headers():
    """Header sent with every agent request."""
    return {"X-Agent-Token": AGENT_TOKEN} if AGENT_TOKEN else {}

def get_machine_id():
    """Windows MachineGuid — used for demo machine-lock. Falls back to hostname."""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                             r"SOFTWARE\Microsoft\Cryptography",
                             0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY)
        val, _ = winreg.QueryValueEx(key, "MachineGuid")
        winreg.CloseKey(key)
        return str(val)[:80]
    except Exception:
        try:
            import socket
            return "host_" + socket.gethostname()[:70]
        except Exception:
            return ""

MACHINE_ID = get_machine_id()

def approval_enabled():
    """Owner-approval popup for counter jobs — ON by default."""
    try:
        if os.path.exists(APPROVAL_CONFIG):
            return open(APPROVAL_CONFIG).read().strip() != "off"
    except Exception:
        pass
    return True

def set_approval(on):
    try:
        with open(APPROVAL_CONFIG, "w") as f:
            f.write("on" if on else "off")
    except Exception:
        pass
# ============================================================

# Global state for the tray icon — so the tray menu can show the live status
agent_state = {
    "status": "Starting...",
    "printer": "Unknown",
    "tray_icon": None,
    "running": True,
    # "online" | "connecting" | "offline" — both the tray and the desktop panel
    # show their status dot from this.
    "connection": "connecting",
    # Set by the Reconnect to Server button; print_loop consumes it.
    "reconnect_requested": False,
}

# The log file was never rotated — on a PC running for months it
# just kept growing. Now at 2 MB it is moved to .old once.
# Only 1 backup is kept: the older log is so old by then that it
# is no longer useful, and a full disk is a bigger problem than this.
LOG_MAX_BYTES = 2 * 1024 * 1024


def _rotate_log_if_big():
    """If the log is larger than 2 MB, rename it to .old and start a new one."""
    try:
        if os.path.getsize(LOG_FILE) < LOG_MAX_BYTES:
            return
    except OSError:
        return          # the file does not exist — nothing to do
    old = LOG_FILE + ".old"
    try:
        if os.path.exists(old):
            os.remove(old)
        os.replace(LOG_FILE, old)
    except Exception:
        # Even if rotation fails, logging must not stop
        pass


def log(msg, level="INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{level}] {msg}"
    try:
        print(line)
    except Exception:
        pass  # windowed .exe mode has no console, so print() may fail
    try:
        _rotate_log_if_big()
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except:
        pass

# ─── A CRASH IN A BACKGROUND THREAD MUST REACH THE LOG TOO ──────────────────────
# By default Python sends a background thread's traceback to stderr.
# A windowed .exe has no stderr at all — that traceback goes nowhere.
# That is what caused the "no tray icon, no panel, and a perfectly clean log"
# situation: pystray creates its tray window in a separate thread, and if an
# exception happened there, that thread died silently and nobody ever
# found out what had happened.
def _thread_excepthook(args):
    try:
        import traceback as _tb
        tname = getattr(getattr(args, "thread", None), "name", "?")
        log(f"💥 Background thread '{tname}' crash: "
            f"{args.exc_type.__name__}: {args.exc_value}", "ERROR")
        log("".join(_tb.format_exception(
            args.exc_type, args.exc_value, args.exc_traceback)), "ERROR")
    except Exception:
        pass          # even if logging itself fails, the process must not stop


try:
    threading.excepthook = _thread_excepthook          # Python 3.8+
except Exception:
    pass


def is_running_as_exe():
    """
    Is this running as a PyInstaller-built .exe or as a normal Python script?
    In .exe mode all dependencies are already bundled.
    """
    return getattr(sys, 'frozen', False)

# ─── SAFE CHILD PROCESS ENVIRONMENT (PyInstaller onefile fix) ─────────
# The PyInstaller --onefile bootloader sets some env variables to identify
# itself (_MEIPASS2 / _PYI_APPLICATION_HOME_DIR). If we
# launch a new .exe with subprocess.Popen, the CHILD inherits these
# variables. The new .exe then thinks "I am already unpacked"
# and does NOT extract its own temp folder — it uses the same old
# _MEIxxxxxx. As soon as the old process exits, its bootloader
# DELETES that folder, and the new process dies in the middle of an import:
#     [Errno 2] No such file or directory: ...\Temp\_MEIxxxxx\base_library.zip
# So remove these variables before launching any child.
# Version label format check: "2.0", "2.10", "3.1" — up to three digits allowed.
_VERSION_LABEL_RE = re.compile(r'^\d{1,3}\.\d{1,3}$')

_PYI_BOOTLOADER_VARS = (
    '_MEIPASS2',
    '_PYI_APPLICATION_HOME_DIR',
    '_PYI_ARCHIVE_FILE',
    '_PYI_PARENT_PROCESS_LEVEL',
    '_PYI_SPLASH_IPC',
)

def _child_env():
    """A clean copy of the environment, safe to hand to a new .exe/process."""
    env = os.environ.copy()
    for var in _PYI_BOOTLOADER_VARS:
        env.pop(var, None)
    return env

def _spawn_detached(args, cwd=None):
    """
    Launch a fully independent process that survives this one exiting.
    Uses a sanitised environment so a PyInstaller onefile child always
    extracts its own temp folder.
    """
    kwargs = {'env': _child_env(), 'close_fds': True}
    if cwd:
        kwargs['cwd'] = cwd
    if os.name == 'nt':
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — the child must not die when
        # the parent dies, and Ctrl+C signals must not be shared.
        kwargs['creationflags'] = 0x00000008 | 0x00000200
    return subprocess.Popen(args, **kwargs)

def _powershell_input(prompt, title="Echel"):
    """
    Ask for one line of text WITHOUT tkinter.

    Some .exe builds ship without the Tcl/Tk runtime, so any tkinter window
    dies with "Tcl data directory ... not found". PowerShell's InputBox is
    part of Windows itself and always works.
    """
    try:
        # In a PowerShell single-quoted string ' has to be written as ''.
        # Without this, if someone ever puts an apostrophe in a prompt (such as "shop's ID"),
        # the whole command would break and the box would come up empty.
        _p = str(prompt).replace("'", "''")
        _t = str(title).replace("'", "''")
        ps = (
            "Add-Type -AssemblyName Microsoft.VisualBasic;"
            "[Microsoft.VisualBasic.Interaction]::InputBox("
            f"'{_p}','{_t}','')"
        )
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, text=True, timeout=300,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return (out.stdout or "").strip()
    except Exception as e:
        log(f"⚠️  PowerShell input failed: {e}", "WARN")
        return ""


def _ps_shop_login(head, title="Echel"):
    """
    Ask for the Shop ID and the PASSWORD in a single Windows dialog.

    InputBox cannot do this - it does not hide the password behind
    dots. So PowerShell builds a small WinForms box instead.
    WinForms comes with .NET on every Windows installation.

    Returns (shop_id, password) or None (cancel / failure).
    """
    ps1 = None
    try:
        import tempfile
        script = """
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = '__TITLE__'
$f.Size = New-Object System.Drawing.Size(440,260)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true
$lh = New-Object System.Windows.Forms.Label
$lh.Text = '__HEAD__'
$lh.Location = New-Object System.Drawing.Point(16,14)
$lh.Size = New-Object System.Drawing.Size(400,36)
$f.Controls.Add($lh)
$l1 = New-Object System.Windows.Forms.Label
$l1.Text = 'Paid Shop ID'
$l1.Location = New-Object System.Drawing.Point(16,58)
$l1.Size = New-Object System.Drawing.Size(400,18)
$f.Controls.Add($l1)
$t1 = New-Object System.Windows.Forms.TextBox
$t1.Location = New-Object System.Drawing.Point(16,78)
$t1.Size = New-Object System.Drawing.Size(400,24)
$f.Controls.Add($t1)
$l2 = New-Object System.Windows.Forms.Label
$l2.Text = 'Shop Password'
$l2.Location = New-Object System.Drawing.Point(16,112)
$l2.Size = New-Object System.Drawing.Size(400,18)
$f.Controls.Add($l2)
$t2 = New-Object System.Windows.Forms.TextBox
$t2.Location = New-Object System.Drawing.Point(16,132)
$t2.Size = New-Object System.Drawing.Size(400,24)
$t2.UseSystemPasswordChar = $true
$f.Controls.Add($t2)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Continue'
$ok.Location = New-Object System.Drawing.Point(226,178)
$ok.Size = New-Object System.Drawing.Size(90,30)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$f.Controls.Add($ok)
$cn = New-Object System.Windows.Forms.Button
$cn.Text = 'Cancel'
$cn.Location = New-Object System.Drawing.Point(326,178)
$cn.Size = New-Object System.Drawing.Size(90,30)
$cn.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$f.Controls.Add($cn)
$f.AcceptButton = $ok
$f.CancelButton = $cn
$f.Add_Shown({$f.Activate(); $t1.Focus()})
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($t1.Text)
  [Console]::Out.WriteLine($t2.Text)
}
"""
        # Inserting the text into the script must not break the quoting
        script = script.replace("__TITLE__", str(title).replace("'", "''"))
        script = script.replace("__HEAD__", str(head).replace("'", "''"))

        fd, ps1 = tempfile.mkstemp(suffix=".ps1")
        # The BOM is written by hand (b"\xef\xbb\xbf") - to avoid using the "utf-8-sig"
        # CODEC. That codec lives in base_library.zip and was loaded for the
        # FIRST TIME exactly here; if _MEI had already been cleaned, this very
        # line raised "FileNotFoundError: ...base_library.zip" - the "Large dialog
        # failed" in the screenshot came from this.
        with os.fdopen(fd, "wb") as f:
            f.write(b"\xef\xbb\xbf" + script.encode("utf-8"))

        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-File", ps1],
            capture_output=True, text=True, timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

        lines = (out.stdout or "").splitlines()
        if len(lines) < 2:
            return None                      # Cancel was pressed or the box never opened
        sid = lines[0].strip().upper()
        pwd = lines[1]                       # do NOT strip the password
        if not sid or not pwd:
            return None
        return (sid, pwd)
    except Exception as e:
        log(f"Shop login dialog fail: {e}", "WARN")
        return None
    finally:
        try:
            if ps1 and os.path.exists(ps1):
                os.remove(ps1)
        except Exception:
            pass


def convert_demo_to_paid_native():
    """
    Demo -> Paid, without the desktop panel.

    On a PC without WebView2 the panel does not open at all, and
    because of that a demo shop could never become paid before. This uses the
    same two server endpoints the panel uses, so both sides follow
    the same rules.
    """
    try:
        creds = _ps_shop_login(
            "Enter your paid Shop ID and password.\n"
            "This agent will connect to that shop.")
        if not creds:
            return
        pid, pwd = creds

        # ── Step 1: verify (nothing changes here) ──
        try:
            r = requests.post(
                f"{SERVER_URL}/api/agent/verify-paid-shop",
                headers=auth_headers(), timeout=25,
                json={"paidShopId": pid, "password": pwd, "demoShopId": SHOP_ID})
            d = r.json() if r.content else {}
        except Exception as e:
            _msgbox(f"Could not reach the server.\n\n{e}", "Echel", 0x10)
            return

        if r.status_code != 200 or not d.get("success"):
            _msgbox(d.get("error") or f"Verification failed ({r.status_code})",
                    "Echel", 0x10)
            return

        ticket = d.get("ticket")
        shop_name = d.get("shopName") or pid

        # ── Step 2: confirm ──
        warn = ("\n\nThis shop is already connected to another computer.\n"
                "Continuing will disconnect it and move printing to this computer."
                ) if d.get("alreadyLinked") else ""
        ans = _native_yesno(
            f"Shop verified:\n"
            f"\n"
            f"   Name  :   {shop_name}\n"
            f"   ID    :   {d.get('shopId') or pid}\n"
            f"   Plan  :   {d.get('planType') or '-'}"
            f"{warn}\n"
            f"\n"
            f"Yes  =  Connect this shop\n"
            f"No   =  Cancel",
            "Echel - Confirm")
        if ans is not True:
            return

        # ── Step 3: switch ──
        try:
            r2 = requests.post(
                f"{SERVER_URL}/api/agent/convert-to-paid",
                headers=auth_headers(), timeout=30, json={"ticket": ticket})
            d2 = r2.json() if r2.content else {}
        except Exception as e:
            _msgbox(f"Could not reach the server while connecting your shop.\n\n{e}",
                    "Echel", 0x10)
            return

        if r2.status_code != 200 or not d2.get("success"):
            _msgbox(d2.get("error") or f"Could not connect this shop ({r2.status_code})",
                    "Echel", 0x10)
            return

        new_id = d2.get("shopId")
        switched = switch_shop_id_live(new_id)
        if not switched:
            _msgbox("Your shop was connected on the server, but the Shop ID could not be applied "
                    f"on this computer.\n\nSelect 'Change Shop ID' in the tray menu and enter:\n\n{new_id}",
                    "Echel", 0x30)
            return

        extra = ""
        if switched == "memory-only":
            extra = ("\n\nThe Shop ID could not be saved on this computer. "
                     f"If prompted after restarting, enter:\n{new_id}")

        log(f"Demo -> paid shop {new_id} (Windows dialog se)")
        _msgbox(f"Connected!\n\nThis agent is now connected to your paid shop.\n\n"
                f"   {d2.get('shopName') or new_id}\n   {new_id}{extra}",
                "Echel")
    except Exception as e:
        log(f"Demo->paid (native) fail: {e}", "ERROR")
        try:
            _msgbox(f"Something went wrong:\n\n{e}", "Echel", 0x10)
        except Exception:
            pass


def _ps_input_big(head, sub, label, hint, title="Echel"):
    """
    A one-line input, but LARGE and clear.

    The VisualBasic InputBox (used by _powershell_input) is small
    and its font/size cannot be changed -- it was the very first thing a new
    shop owner saw, and it looked very dated.
    This WinForms box uses the same approach as _ps_shop_login,
    so there is no new dependency.

    Returns: the typed text, or "" (cancel / the box could not be created).
    """
    ps1 = None
    try:
        import tempfile

        def q(v):
            return str(v).replace("'", "''")

        script = """
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = '__TITLE__'
$f.Size = New-Object System.Drawing.Size(560,340)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true
$f.BackColor = [System.Drawing.Color]::White

$h = New-Object System.Windows.Forms.Label
$h.Text = '__HEAD__'
$h.Font = New-Object System.Drawing.Font('Segoe UI',17,[System.Drawing.FontStyle]::Bold)
$h.Location = New-Object System.Drawing.Point(28,26)
$h.Size = New-Object System.Drawing.Size(500,32)
$f.Controls.Add($h)

$s = New-Object System.Windows.Forms.Label
$s.Text = '__SUB__'
$s.Font = New-Object System.Drawing.Font('Segoe UI',10.5)
$s.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#475569')
$s.Location = New-Object System.Drawing.Point(28,62)
$s.Size = New-Object System.Drawing.Size(500,24)
$f.Controls.Add($s)

$l = New-Object System.Windows.Forms.Label
$l.Text = '__LABEL__'
$l.Font = New-Object System.Drawing.Font('Segoe UI',10,[System.Drawing.FontStyle]::Bold)
$l.Location = New-Object System.Drawing.Point(28,106)
$l.Size = New-Object System.Drawing.Size(500,20)
$f.Controls.Add($l)

$t = New-Object System.Windows.Forms.TextBox
$t.Font = New-Object System.Drawing.Font('Consolas',14)
$t.Location = New-Object System.Drawing.Point(28,130)
$t.Size = New-Object System.Drawing.Size(496,34)
$f.Controls.Add($t)

$n = New-Object System.Windows.Forms.Label
$n.Text = '__HINT__'
$n.Font = New-Object System.Drawing.Font('Segoe UI',9.5)
$n.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#64748b')
$n.Location = New-Object System.Drawing.Point(28,174)
$n.Size = New-Object System.Drawing.Size(500,40)
$f.Controls.Add($n)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Continue'
$ok.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#C81E28')
$ok.ForeColor = [System.Drawing.Color]::White
$ok.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$ok.FlatAppearance.BorderSize = 0
$ok.Font = New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
$ok.Size = New-Object System.Drawing.Size(160,44)
$ok.Location = New-Object System.Drawing.Point(194,232)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$f.Controls.Add($ok)

$cn = New-Object System.Windows.Forms.Button
$cn.Text = 'Cancel'
$cn.Font = New-Object System.Drawing.Font('Segoe UI',11)
$cn.Size = New-Object System.Drawing.Size(160,44)
$cn.Location = New-Object System.Drawing.Point(364,232)
$cn.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$f.Controls.Add($cn)

$f.AcceptButton = $ok
$f.CancelButton = $cn
$f.Add_Shown({$f.Activate(); $t.Focus()})
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.WriteLine($t.Text)
}
"""
        for k, v in (("__TITLE__", title), ("__HEAD__", head), ("__SUB__", sub),
                     ("__LABEL__", label), ("__HINT__", hint)):
            script = script.replace(k, q(v))

        fd, ps1 = tempfile.mkstemp(suffix=".ps1")
        # The BOM is written by hand (b"\xef\xbb\xbf") - to avoid using the "utf-8-sig"
        # CODEC. That codec lives in base_library.zip and was loaded for the
        # FIRST TIME exactly here; if _MEI had already been cleaned, this very
        # line raised "FileNotFoundError: ...base_library.zip" - the "Large dialog
        # failed" in the screenshot came from this.
        with os.fdopen(fd, "wb") as fh:
            fh.write(b"\xef\xbb\xbf" + script.encode("utf-8"))

        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-File", ps1],
            capture_output=True, text=True, timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

        lines = (out.stdout or "").splitlines()
        return lines[0].strip() if lines else ""
    except Exception as e:
        log(f"Large input box failed ({e}) - falling back to the old InputBox", "WARN")
        return None                      # None = "not attempted", "" = cancel
    finally:
        try:
            if ps1 and os.path.exists(ps1):
                os.remove(ps1)
        except Exception:
            pass


def _ask_shop_id_once():
    """Ask for the Shop ID — the large box first, the old InputBox if it cannot be created."""
    v = _ps_input_big(
        head="Welcome to Echel",
        sub="Enter your Shop ID to connect this computer",
        label="Shop ID",
        hint="Your Shop ID is available in your shop dashboard.\n"
             "Sign in to your Echel account to find it.",
        title="Echel - Setup")
    if v is not None:
        return v
    # PowerShell's WinForms did not work - the old small box will do
    return _powershell_input(
        "Paste your Shop ID (you got it after registering on the dashboard)")


def _shop_id_without_tkinter():
    """Fallback first-run setup when tkinter is unusable."""
    for _ in range(3):
        value = (_ask_shop_id_once() or "").strip().upper()
        if not value:
            break
        try:
            # CLAIM — one Shop ID can run on only ONE PC.
            # This used to be checked only through /api/shop/<id>, which is public and
            # knows nothing about the PC — so anyone could read a
            # Shop ID from a QR poster, put it into their own PC, and get "verified".
            r = requests.post(
                f"{SERVER_URL}/api/agent/claim/{value}",
                headers=auth_headers(), timeout=30,
                json={"machine": _machine_name()})

            if r.status_code == 404:
                # There are two kinds of 404:
                #   a) OUR JSON         -> the Shop ID really is wrong
                #   b) Express's HTML   -> the server is old and the endpoint does not exist
                # Treating both the same was wrong — on an old server even a
                # correct Shop ID showed "not found".
                is_our_404 = False
                try:
                    is_our_404 = bool(r.json().get("error"))
                except Exception:
                    is_our_404 = False

                if is_our_404:
                    _msgbox("This Shop ID was not found on the server. Please check it.",
                            "Echel", 0x10)
                    continue

                # An old server — check the old way and carry on
                log("The server has no claim endpoint (old server) — basic check", "WARN")
                try:
                    r2 = requests.get(f"{SERVER_URL}/api/shop/{value}", timeout=20)
                    if r2.status_code == 404:
                        _msgbox("This Shop ID was not found on the server. Please check it.",
                                "Echel", 0x10)
                        continue
                except Exception:
                    pass
                return value

            if r.status_code == 409:
                # It is already bound to another PC
                try:
                    msg = r.json().get("error", "")
                except Exception:
                    msg = ""
                _msgbox(
                        "This Shop ID is already in use on another computer.\n\n"
                        "Open Shop Login → Settings → \"Disconnect Computer\" to "
                        "disconnect the previous computer, then try again.",
                        "Echel", 0x10)
                continue

            if r.status_code == 400:
                # An old agent / missing token — report it, but do not stop
                log("Claim rejected (old agent build?)", "WARN")

        except Exception as e:
            # The server is asleep or there is no network — accept the ID, otherwise
            # the user would be stuck. Job polling checks the token anyway,
            # so nothing can be stolen.
            log(f"Shop ID claim check skipped: {e}", "WARN")
        return value
    try:
        return input("Enter your Shop ID: ").strip().upper()
    except Exception:
        log("❌ Could not read Shop ID — no window and no console available", "ERROR")
        return None


def show_shop_id_prompt():
    """
    On the first run, ask for the Shop ID — with Windows' own dialog.

    THIS USED TO BE A TKINTER WINDOW, and that was the most dangerous spot:
    in several .exe builds the Tcl data (init.tcl) was missing. Then the window
    was never created, resolve_shop_id() got an empty string and the
    agent called `sys.exit(1)` — so a new install never started at all,
    and the log only showed a Tcl error.

    The PowerShell InputBox is part of Windows itself — it never has to be
    bundled and it is never missing.
    """
    return _shop_id_without_tkinter()

def resolve_shop_id():
    """
    Where the Shop ID comes from, in priority order:
    1. SHOP_ID_TEMPLATE if it has already been replaced (the .py source download flow)
    2. The saved config file (%APPDATA%/EchelPrint/shop_config.txt) — already set up earlier
    3. Ask for a new Shop ID through a GUI popup (first run only, in .exe mode)
    """
    if SHOP_ID_TEMPLATE != UNCONFIGURED_MARKER:
        # .py source mode — the Shop ID is already baked into this file
        return SHOP_ID_TEMPLATE

    if os.path.exists(SHOP_CONFIG_FILE):
        try:
            with open(SHOP_CONFIG_FILE, 'r', encoding='utf-8') as f:
                saved_id = f.read().strip()
                if saved_id:
                    return saved_id
        except Exception:
            pass

    # First run and the Shop ID was not found anywhere — ask through the GUI
    shop_id = show_shop_id_prompt()
    if not shop_id:
        # The user closed the window without entering a Shop ID — the agent cannot run
        sys.exit(1)

    try:
        with open(SHOP_CONFIG_FILE, 'w', encoding='utf-8') as f:
            f.write(shop_id)
    except Exception:
        pass

    return shop_id

# ─── SINGLE INSTANCE LOCK (crash-safe, PID based) ─────────────────────
# The old Windows mutex was left orphaned on crash/sleep/force-kill —
# then a new agent thought "already exists" and quietly exited,
# and nothing appeared in the tray. Now a PID lockfile is used: exit only if
# the process written in the lock file is ALIVE; otherwise (it has crashed)
# take the lock over. This prevents double prints and also ends the silent
# exit bug.
_LOCK_FILE = os.path.join(_APPDATA_DIR, "agent.lock")

def _pid_alive(pid):
    """Is the process with this PID still running?"""
    try:
        import ctypes
        PROCESS_QUERY = 0x1000
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY, False, pid)
        if not h:
            return False
        exit_code = ctypes.c_ulong(0)
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(exit_code))
        ctypes.windll.kernel32.CloseHandle(h)
        return exit_code.value == 259  # STILL_ACTIVE
    except Exception:
        return False

_MUTEX_HANDLE = None          # it must stay alive until the process ends
_MUTEX_NAME = "Local\\EchelPrintAgent_SingleInstance"


def _single_instance_by_pidfile():
    """Fallback (non-Windows / mutex failure). Race-prone, so only a backup."""
    try:
        if os.path.exists(_LOCK_FILE):
            try:
                with open(_LOCK_FILE, "r", encoding="utf-8") as f:
                    old_pid = int(f.read().strip() or "0")
            except Exception:
                old_pid = 0
            if old_pid and old_pid != os.getpid() and _pid_alive(old_pid):
                return False
        with open(_LOCK_FILE, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
        return True
    except Exception as e:
        log(f"⚠️  Lock check failed (fail-open): {e}", "WARN")
        return True


def _ensure_single_instance():
    """
    Only ONE agent may run at a time.

    The old check read a .lock file that held the previous PID. That has a
    race: at login the agent is launched twice within the same moment (once
    from the registry Run key, once from the Startup folder). Both copies
    read the file before either had written to it, both saw "nobody running",
    and both kept going — which is why several tray icons piled up.

    A Windows named mutex is created by the kernel atomically, so exactly one
    process can ever win, no matter how close together they start. It is also
    released automatically if the agent crashes, so no stale lock is left
    behind.
    """
    global _MUTEX_HANDLE
    if os.name != "nt":
        return _single_instance_by_pidfile()
    try:
        import ctypes
        from ctypes import wintypes
        ERROR_ALREADY_EXISTS = 183
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
        handle = kernel32.CreateMutexW(None, False, _MUTEX_NAME)
        last_error = kernel32.GetLastError()
        if not handle:
            log("⚠️  Could not create the single-instance mutex — using the lock file", "WARN")
            return _single_instance_by_pidfile()
        if last_error == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False
        _MUTEX_HANDLE = handle          # keep it open for the whole process
        try:
            with open(_LOCK_FILE, "w", encoding="utf-8") as f:
                f.write(str(os.getpid()))     # only for support/debugging
        except Exception:
            pass
        return True
    except Exception as e:
        log(f"⚠️  Mutex check failed ({e}) — using the lock file", "WARN")
        return _single_instance_by_pidfile()


def _release_mutex():
    global _MUTEX_HANDLE
    try:
        if _MUTEX_HANDLE:
            import ctypes
            ctypes.windll.kernel32.ReleaseMutex(_MUTEX_HANDLE)
            ctypes.windll.kernel32.CloseHandle(_MUTEX_HANDLE)
            _MUTEX_HANDLE = None
    except Exception:
        pass
    try:
        if os.path.exists(_LOCK_FILE):
            with open(_LOCK_FILE, "r", encoding="utf-8") as f:
                if f.read().strip() == str(os.getpid()):
                    os.remove(_LOCK_FILE)
    except Exception:
        pass

# ⚠️ _ensure_single_instance() must run ONLY ONCE — it creates the
# mutex, so a second call would see its own mutex, conclude "someone else is
# running" and the agent would never start. So the result is kept
# here.
_SINGLE_OK = _ensure_single_instance()

# Windows started this itself (at login) and another copy is already
# running — so nothing needs to be shown here. This used to happen on every
# restart and the owner had to press OK every time.
# (The flag name also lives in AUTOSTART_FLAG, but that is defined further down —
#  so it is written out directly here. Keep the two identical.)
if not _SINGLE_OK and "--autostart" in sys.argv:
    sys.exit(0)

if not _SINGLE_OK:
    # ── THIS USED TO BE JUST sys.exit(0) ──
    # The owner double-clicked the exe, nothing happened, and the log only got one
    # line that they never look at. They thought "the software does not
    # work" — while the agent was already running in the background.
    #
    # Now two things happen:
    #   1. A request file is left for the running agent -- it opens its
    #      panel (which is what the owner wants from the double-click).
    #   2. The owner is told clearly what happened.
    log("⛔ Agent is already running — asking the running copy to show its panel")
    try:
        with open(PANEL_REQUEST_FILE, "w", encoding="utf-8") as _f:
            _f.write(str(int(time.time())))
    except Exception as _e:
        log(f"Could not create the panel request file: {_e}", "WARN")

    # Give the running agent a chance to see the file before showing the message —
    # otherwise the popup appears before the panel opens.
    time.sleep(2.5)
    try:
        import ctypes as _ct
        _still_pending = os.path.exists(PANEL_REQUEST_FILE)
        if _still_pending:
            _txt = ("Echel is already running.\n\n"
                    "Double-click the Echel icon in the Windows system tray to open "
                    "the panel. Use the ^ arrow beside the clock to find hidden icons.\n\n"
                    "Printing continues in the background.")
        else:
            _txt = ("Echel is already running. Its panel has been opened.\n\n"
                    "You can also open it by double-clicking the Echel icon "
                    "in the Windows system tray.")
        _ct.windll.user32.MessageBoxW(0, _txt, "Echel", 0x40 | 0x00010000 | 0x00040000)
    except Exception:
        pass
    sys.exit(0)

SHOP_ID = resolve_shop_id()

# ─── AUTO STARTUP (starts in the tray by itself after a PC restart) ─────────────
STARTUP_VBS_NAME = "EchelPrintAgent.vbs"


# The copy started at Windows login gets this flag.
# The agent autostarts from two places (the registry Run key + the Startup folder
# VBS) — both on purpose, because antivirus software often removes the Run key.
# After a restart both start, and one of them loses on the mutex.
# The losing copy used to show the owner a popup — on every restart.
# Now it sees the flag and exits quietly.
AUTOSTART_FLAG = "--autostart"


def _startup_command():
    """The exact command Windows must run at login (current paths, quoted)."""
    if is_running_as_exe():
        return f'"{sys.executable}" {AUTOSTART_FLAG}'
    py = sys.executable.replace('python.exe', 'pythonw.exe')
    if not os.path.exists(py):
        py = sys.executable
    return f'"{py}" "{os.path.abspath(__file__)}" {AUTOSTART_FLAG}'


def _startup_folder():
    """%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"""
    appdata = os.environ.get('APPDATA', '')
    if not appdata:
        return ""
    return os.path.join(appdata, "Microsoft", "Windows",
                        "Start Menu", "Programs", "Startup")


def _register_run_key(cmd):
    """Layer 1 — HKCU Run key. Written and then READ BACK to confirm."""
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE)
        winreg.SetValueEx(key, "EchelPrintAgent", 0, winreg.REG_SZ, cmd)
        saved, _ = winreg.QueryValueEx(key, "EchelPrintAgent")
        winreg.CloseKey(key)
        return saved == cmd
    except Exception as e:
        log(f"⚠️  Startup registry entry failed: {e}", "WARN")
        return False


def _register_startup_folder(cmd):
    """
    Layer 2 — a .vbs in the Startup folder.

    Why a second method: the Run key alone is not reliable. Antivirus and
    "PC cleaner" tools delete it, some office PCs block it by policy, and
    after an update the old entry can point at a path that no longer exists.
    The Startup folder keeps working in all of those cases. VBS is used
    instead of BAT so no black console window flashes at login.
    """
    folder = _startup_folder()
    if not folder:
        return False
    try:
        os.makedirs(folder, exist_ok=True)
        vbs_path = os.path.join(folder, STARTUP_VBS_NAME)
        # In VBS a quote inside a string is written as two quotes
        vbs_cmd = cmd.replace('"', '""')
        content = (
            'Set WshShell = CreateObject("WScript.Shell")\r\n'
            'WshShell.Run "' + vbs_cmd + '", 0, False\r\n'
        )
        # newline="" is important: without it Windows turns each \r\n into
        # \r\r\n and the .vbs can fail to run.
        with open(vbs_path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return os.path.exists(vbs_path) and os.path.getsize(vbs_path) > 0
    except Exception as e:
        log(f"⚠️  Startup folder entry failed: {e}", "WARN")
        return False


def add_to_startup():
    """
    Make sure the agent starts by itself after a Windows restart.

    Shop owners reported the agent not starting after a restart. Reasons found:
    the registry entry gets removed by antivirus/cleaner tools, and after an
    update it can still point to the old file path. So now:

      * both methods are used (registry + Startup folder), either one is enough
      * both are rewritten on EVERY launch with the CURRENT path, so an entry
        left over from an older version repairs itself automatically
      * the registry value is read back to confirm it was really saved
    """
    if os.name != "nt":
        return
    cmd = _startup_command()
    ok_reg = _register_run_key(cmd)
    ok_folder = _register_startup_folder(cmd)

    if ok_reg and ok_folder:
        log("✅ Auto-start is set (registry + Startup folder) — the agent will "
            "start by itself after a restart")
    elif ok_reg or ok_folder:
        which = "registry" if ok_reg else "Startup folder"
        log(f"✅ Auto-start is set via {which} — the agent will start by itself "
            f"after a restart")
    else:
        log("❌ Auto-start could NOT be set. The agent will not start on its own "
            "after a restart — please start it manually, or contact support.",
            "ERROR")

def show_banner():
    # CRITICAL FIX: there was a bare print() here — outside the try. In a --noconsole exe
    # sys.stdout is None, so print() raised AttributeError, and this is the
    # FIRST line of main() — meaning the exe hit a FATAL CRASH on every
    # launch (the log shows "'NoneType' object has no attribute
    # 'write'"). log() is already guarded, so send it through log().
    log(f"Echel - Local Agent v{VERSION_LABEL} | Tray + Auto-Update + Fit-A4")
    # Do not guess what is and is not in the bundle - write it to the log.
    try:
        bundle_selfcheck()
    except Exception as _bse:
        log(f"Bundle self-check fail: {_bse}", "WARN")

def check_printer():
    """
    NOTE: the agent always uses the Windows "Default Printer" —
    that is the printer the "🔍 Auto Detect" option in the dashboard refers to.
    Even if the shop owner selected a specific model in the dashboard (such as
    "Canon PIXMA G2010"), that is only for records/display — actual printing
    happens on this system default printer. So the correct printer on the PC must be
    set with "Set as Default Printer" (Windows Settings > Printers).
    """
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )
        if printers:
            default = win32print.GetDefaultPrinter()
            log(f"✅ System Default Printer (Auto Detected): {default}")
            return True, default
        log("❌ No printer found!", "ERROR")
        return False, None
    except ImportError:
        log("⚠️  Mock mode (win32print not available)", "WARN")
        return True, "MockPrinter"
    except Exception as e:
        log(f"❌ Printer error: {e}", "ERROR")
        return False, None

def list_all_printers():
    """List of all printers installed on this system — for the dashboard dropdown"""
    names = []
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )
        names = [p[2] for p in printers]  # index 2 = printer name
        # A printer shared from another computer is sometimes missing from that
        # enumeration while it still is the Windows default. Without this the
        # dropdown came up empty on a machine that prints perfectly well.
        try:
            default = win32print.GetDefaultPrinter()
            if default and default not in names:
                names.append(default)
        except Exception:
            pass
    except ImportError:
        return []
    except Exception as e:
        log(f"⚠️  Printer list error: {e}", "WARN")
    return names

def report_printers_to_server():
    """Send the printer list to the server so it appears in the dashboard dropdown"""
    try:
        printers = list_all_printers()
        if not printers:
            return
        requests.post(
            f"{SERVER_URL}/api/agent/printers/{SHOP_ID}",
            json={"printers": printers},
            headers=auth_headers(),
            timeout=15
        )
        log(f"📋 Printer list sent to server: {printers}")
    except Exception as e:
        log(f"⚠️  Printer list report fail: {e}", "WARN")

# ═══════════════════════════════════════════════
# IDEMPOTENCY — a job must never print twice
# ═══════════════════════════════════════════════
# The server prevents duplicates by claiming 'printing', but after an agent restart /
# stuck-job requeue the same job can come back. This local record
# stops that too. It lives on disk so it is remembered even after a restart.
_PROCESSED_PATH = os.path.join(_APPDATA_DIR, "processed_jobs.json")
_processed_jobs = {}

def _load_processed():
    global _processed_jobs
    try:
        with open(_PROCESSED_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        cutoff = time.time() - 7 * 24 * 3600          # forget anything older than 7 days
        _processed_jobs = {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > cutoff}
    except Exception:
        _processed_jobs = {}

def _save_processed():
    # Atomic write — so the file is not corrupted if the power goes out midway
    try:
        tmp = _PROCESSED_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_processed_jobs, f)
        os.replace(tmp, _PROCESSED_PATH)
    except Exception as e:
        log(f"Could not save processed-job list: {e}", "WARN")

_inflight_jobs = set()          # the job IDs being printed right now

def already_processed(job_id):
    return job_id in _processed_jobs

def mark_processed(job_id):
    _processed_jobs[job_id] = time.time()
    if len(_processed_jobs) > 500:                    # remove the oldest
        for k in sorted(_processed_jobs, key=_processed_jobs.get)[:200]:
            _processed_jobs.pop(k, None)
    _save_processed()

def get_download_url(job_id, fallback_url):
    """
    Ask the server for this job's authorized download URL.
    The server only returns the URL — the PDF does NOT pass through it; the agent
    downloads it straight from Cloudinary.
    An old server does not know this endpoint, so use the file_url from the job.
    """
    try:
        resp = requests.get(
            f"{SERVER_URL}/api/jobs/{SHOP_ID}/{job_id}/download-url",
            headers=auth_headers(), timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("downloadUrl"):
                return data["downloadUrl"], None
        elif resp.status_code in (403, 409, 410):
            # The job is no longer printable (another shop's / not paid / file deleted)
            try:
                msg = resp.json().get("error", "not available")
            except Exception:
                msg = "not available"
            return None, msg
        elif resp.status_code == 404:
            log("Server does not support authorized download yet — using job URL", "WARN")
    except Exception as e:
        log(f"Download-url lookup failed ({e}) — using job URL", "WARN")
    return fallback_url, None

def report_download(job_id, ok, bytes_count=None, err=None):
    """Only a status message — no file goes back to the server."""
    try:
        requests.post(
            f"{SERVER_URL}/api/jobs/{SHOP_ID}/{job_id}/downloaded",
            headers=auth_headers(), timeout=10,
            json={"ok": bool(ok), "bytes": bytes_count, "error": (str(err)[:180] if err else "")})
    except Exception:
        pass          # best-effort, printing must never stop

def download_file(url, ext):
    """Download the file from Cloudinary"""
    try:
        log(f"⬇️  Downloading...")
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        if len(resp.content) < 100:
            log(f"❌ Downloaded file is too small: {len(resp.content)} bytes", "ERROR")
            return None
        suffix = f".{ext}" if ext else ".pdf"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(resp.content)
        tmp.close()
        log(f"✅ Downloaded: {tmp.name} ({len(resp.content):,} bytes)")
        return tmp.name
    except Exception as e:
        log(f"❌ Download failed: {e}", "ERROR")
        return None

# ─── Problem 1: Image to PDF convert — build an A4 page and fit the image into it ─────
def convert_image_to_pdf(image_path):
    """
    Convert a JPG/PNG into an A4-size PDF page.

    Two scenarios are handled:
    1. The image is already in A4 ratio (it came from the Canvas Editor — the customer
       set the drag/resize/position on the A4 page personally) — in that case
       we wrap exactly that image into the PDF WITHOUT zoom-fitting it AGAIN,
       otherwise the customer's careful positioning would be distorted.
    2. It is a normal photo/scan (small or a different ratio) — it is zoomed to fit
       the center of the A4 page, as before.
    """
    try:
        from PIL import Image
        log(f"🔄 Converting image to A4 PDF...")

        img = Image.open(image_path)

        # Convert to RGB (a PNG may be RGBA)
        if img.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        # A4 size at 300 DPI (for print quality)
        dpi = 300
        a4_width_px = int(8.27 * dpi)   # 210mm
        a4_height_px = int(11.69 * dpi)  # 297mm
        a4_ratio = a4_width_px / a4_height_px

        img_ratio = img.width / img.height
        ratio_diff = abs(img_ratio - a4_ratio)

        # If the image ratio is very close to A4 (it came from the Canvas Editor),
        # resize and wrap it directly — no extra zoom/margin
        if ratio_diff < 0.01:
            log("ℹ️  Image is already A4 ratio (Canvas Editor output) — using it as is")
            a4_canvas = img.resize((a4_width_px, a4_height_px), Image.LANCZOS)
        else:
            # Create a full white A4 canvas
            a4_canvas = Image.new('RGB', (a4_width_px, a4_height_px), (255, 255, 255))

            # Fit the image into the A4 canvas at MAXIMUM size (zooming in)
            # so even a small image prints large instead of sitting small in a corner
            # A 95% margin is kept for a little safe area
            target_w = int(a4_width_px * 0.95)
            target_h = int(a4_height_px * 0.95)

            if img_ratio > (target_w / target_h):
                new_width = target_w
                new_height = int(target_w / img_ratio)
            else:
                new_height = target_h
                new_width = int(target_h * img_ratio)

            # High quality upscale/downscale
            resample_method = Image.LANCZOS
            img_resized = img.resize((new_width, new_height), resample_method)

            # Paste it in the center
            paste_x = (a4_width_px - new_width) // 2
            paste_y = (a4_height_px - new_height) // 2
            a4_canvas.paste(img_resized, (paste_x, paste_y))

        # Save the PDF with the correct DPI metadata
        pdf_path = image_path + '_converted.pdf'
        a4_canvas.save(pdf_path, 'PDF', resolution=dpi)
        log(f"✅ A4 PDF ready: {pdf_path}")
        return pdf_path

    except ImportError:
        log("❌ Pillow is not installed! Run: pip install Pillow", "ERROR")
        return None
    except Exception as e:
        log(f"❌ Image convert error: {e}", "ERROR")
        return None

# ─── Page Range: extract specific pages from the PDF ────────
def extract_selected_pages(pdf_path, selected_pages_str, total_pages=None):
    """
    If the customer selected specific pages (such as "5" or "1,3,5-8"),
    build a new PDF with only those pages using PyPDF2.
    If selected_pages_str is empty, return the original PDF (print all pages).

    IMPORTANT: if this function fails for any reason,
    we return None (not the original PDF) — so the whole document is never
    printed by accident when the customer selected only
    some pages. That is safer than a print that does not match
    the bill.
    """
    if not selected_pages_str or not selected_pages_str.strip():
        return pdf_path  # All pages selected — nothing to extract

    # pypdf/PyPDF2 import — pypdf (the actively maintained fork) gets priority
    # because it handles real-world "odd" PDFs (scanner apps, government
    # portals, non-UTF8 metadata) more gracefully.
    # PyPDF2 3.x still works, so it is kept as a fallback.
    # ── PDF library ──
    #
    # THIS IS WHERE THE 22 Aug 2026 CRASH HAPPENED. This used to be `except ImportError`.
    # PyPDF2 loads pycryptodome's .pyd when it opens; if that file is missing,
    # pycryptodome raises **OSError**, not ImportError
    # (Crypto/Util/_raw_api.py -> raise OSError("Cannot load native module...")).
    # The ImportError-only handler never caught it, and these imports sit OUTSIDE
    # the big try/except below — so the exception went straight up to
    # process_job() and became "Job crashed", and
    # print_file()'s SumatraPDF page-range fallback never ran.
    #
    # Now every exception is caught. If the library is missing, None is returned,
    # and print_file() prints the page range directly through SumatraPDF.
    PdfReader = None
    PdfWriter = None
    _pdf_err = None
    for _modname in ("pypdf", "PyPDF2"):
        try:
            _m = __import__(_modname, fromlist=["PdfReader", "PdfWriter"])
            PdfReader, PdfWriter = _m.PdfReader, _m.PdfWriter
            break
        except Exception as e:          # both ImportError + OSError (missing .pyd)
            _pdf_err = e

    if PdfReader is None:
        # In script mode the library can REALLY be missing — installing it there
        # is fine. Two conditions:
        #   * an .exe has no pip at all, so trying there is pointless
        #   * OSError means the library exists but its .pyd was not found —
        #     pip install does nothing for that; it only wastes 10 seconds
        if (not is_running_as_exe()) and isinstance(_pdf_err, ImportError):
            log("⚠️  pypdf/PyPDF2 not found! Installing...", "WARN")
            os.system("pip install pypdf pycryptodome --quiet")
            try:
                from pypdf import PdfReader, PdfWriter
            except Exception as e:
                log(f"❌ pypdf installation also failed: {e}", "ERROR")
                PdfReader = None
        if PdfReader is None:
            log(f"⚠️  The PDF library did not load ({_pdf_err}) — "
                f"the page range will now be printed through SumatraPDF", "WARN")
            return None

    try:
        page_numbers = [int(p.strip()) for p in selected_pages_str.split(',') if p.strip()]
        if not page_numbers:
            log("⚠️  Page list is empty — the original PDF will be printed", "WARN")
            return pdf_path

        # ── NO FAST PATH ── always extract.
        #
        # There used to be two shortcuts here and BOTH were wrong:
        #   1) "page_numbers == [1]"  -> choosing page 1 of a 2-page PDF still
        #      printed the whole document.
        #   2) "len(page_numbers) >= total_pages" -> this did not work either,
        #      because total_pages is the BILLING count (how many pages were
        #      paid for), NOT the real page count of the PDF. Choose page 1 and
        #      total_pages=1 comes in, so the check was always TRUE.
        #
        # pycryptodome is now bundled correctly in the .exe (v20+), so opening the PDF
        # is safe. Extracting even when all pages are chosen does no harm —
        # the same PDF is rebuilt; it just costs a little CPU.

        log(f"📑 Extracting specific pages: {page_numbers}")

        try:
            reader = PdfReader(pdf_path, strict=False)
        except Exception as e1:
            # Some "odd" PDFs (with wrongly encoded metadata) crash in pypdf's
            # strict mode — retry with the other library.
            log(f"⚠️  PDF read attempt 1 failed ({e1}) — retrying with another library", "WARN")
            try:
                from PyPDF2 import PdfReader as _AltReader
                reader = _AltReader(pdf_path, strict=False)
            except Exception:
                try:
                    from pypdf import PdfReader as _AltReader2
                    reader = _AltReader2(pdf_path, strict=False)
                except Exception:
                    raise e1

        # If it is not encrypted, crypto is never touched — try/except for safety
        try:
            if getattr(reader, 'is_encrypted', False):
                reader.decrypt('')
        except Exception:
            pass
        writer = PdfWriter()
        total_pdf_pages = len(reader.pages)

        added_count = 0
        for pnum in page_numbers:
            idx = pnum - 1  # 1-indexed to 0-indexed
            if 0 <= idx < total_pdf_pages:
                writer.add_page(reader.pages[idx])
                added_count += 1
            else:
                log(f"⚠️  Page {pnum} is not in the PDF (the PDF has {total_pdf_pages} pages)", "WARN")

        if added_count == 0:
            log("❌ No valid page could be extracted! Stopping the print for safety", "ERROR")
            return None

        extracted_path = pdf_path + '_extracted.pdf'
        with open(extracted_path, 'wb') as f:
            writer.write(f)

        # Verify that the extracted file was built properly
        verify_size = os.path.getsize(extracted_path)
        if verify_size < 50:
            log(f"❌ Extracted PDF is empty or corrupt ({verify_size} bytes)!", "ERROR")
            return None

        log(f"✅ Extracted {added_count} page(s): {extracted_path} ({verify_size} bytes)")
        return extracted_path

    except Exception as e:
        # A Crypto/native-module error = a packaging issue, not the PDF's fault.
        # In that case print the whole file (better than fail+requeue+a DOUBLE print).
        emsg = str(e).lower()
        if 'crypto' in emsg or 'cpuid' in emsg or 'native module' in emsg:
            # Printing the whole document is WRONG here — the customer may have paid
            # for only 1 page and 10 pages would come out.
            # Stopping the print is right: the shop will tell them, and the customer sends it again.
            log(f"❌ Crypto module missing ({e}) — cannot extract specific pages", "ERROR")
            log("⚠️  Print stopped so that extra pages are not printed.", "WARN")
            log("👉 Update the agent to v20 or newer — this is fixed there.", "WARN")
            return None
        log(f"❌ Page extract error: {e}", "ERROR")
        log(f"⚠️  SAFETY: Stopping the print so that wrong (extra) pages are not printed", "WARN")
        return None

def get_bundled_resource_path(filename):
    """
    Find the path of a bundled file (such as SumatraPDF.exe).
    Supports three kinds of build:
      1. PyInstaller --onefile : the temp extraction folder -> sys._MEIPASS
      2. Nuitka --standalone / PyInstaller --onedir : the folder next to the exe
      3. A normal .py script : the script's folder
    Only (1) existed before, so a Nuitka build could never find SumatraPDF.
    """
    candidates = []

    # 1. PyInstaller onefile
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        candidates.append(os.path.join(meipass, filename))

    # 1b. APPDATA mirror — at startup _mirror_bundled_files() placed a copy
    #     here. If the _MEI folder vanishes (the 22 Aug case), printing and the panel
    #     keep running from this copy.
    candidates.append(os.path.join(_RUNTIME_DIR, filename))

    # 2. The folder next to the compiled exe (Nuitka standalone / PyInstaller onedir)
    #    Nuitka sets __compiled__, PyInstaller sets sys.frozen
    if globals().get('__compiled__') is not None or getattr(sys, 'frozen', False):
        candidates.append(os.path.join(os.path.dirname(sys.executable), filename))

    # 3. Script mode
    try:
        candidates.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), filename))
    except NameError:
        pass

    for p in candidates:
        if p and os.path.exists(p):
            return p
    return None

# ─── Problem 5: B&W / Color Print + Fit-to-A4 ────────────────────────
def _sumatra_page_range(selected_pages):
    """
    "1,3,4,5" -> "1,3-5"  (the SumatraPDF -print-settings format).

    Used only when the pages cannot be extracted with the PDF library.
    Returns "" for invalid/empty input, so the whole document is never
    printed by mistake.
    """
    try:
        nums = sorted({int(x.strip()) for x in str(selected_pages).split(',') if x.strip()})
        nums = [x for x in nums if x >= 1]
        if not nums:
            return ""
        parts, start, prev = [], nums[0], nums[0]
        for cur in nums[1:] + [None]:
            if cur == prev + 1:
                prev = cur
                continue
            parts.append(str(start) if start == prev else f"{start}-{prev}")
            if cur is None:
                break
            start = prev = cur
        return ",".join(parts)
    except Exception:
        return ""


def print_pdf_sumatra(filepath, copies=1, color_mode="bw", printer_name=None, extra="", scale_mode="fit"):
    """
    Print through SumatraPDF — with the B&W/Color setting.
    The 'fit' flag is used so that even a small PDF/page scales properly
    to A4 paper instead of staying small in a corner.

    printer_name: if given, printing goes to that SPECIFIC printer
    (IGNORING the system default) — so B&W and Color jobs can be routed to
    different physical printers (such as an HP M1005 for B&W only and a
    Canon G2010 for Color only). If it is None/empty, the old default-
    printer behaviour applies (backward compatible).
    """
    sumatra_paths = []

    # CRITICAL FIX: in the .exe build SumatraPDF.exe was BUNDLED by PyInstaller
    # (--add-binary), but it was never checked here —
    # only system-installed paths were checked. That is why the print
    # agent never found the bundled SumatraPDF; if SumatraPDF was already
    # installed on the system (by the old .py-based INSTALL.bat)
    # printing worked, otherwise (as on fresh installs or in a clean state after a
    # restart) printing failed — "it shows in the tray
    # but nothing prints" is exactly this symptom.
    bundled = get_bundled_resource_path('SumatraPDF.exe')
    if bundled:
        sumatra_paths.append(bundled)

    sumatra_paths += [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]

    # "fit" — scales the page to the printer's paper size
    # (a small document prints enlarged on A4 paper instead of staying in a corner)
    # ⚠️ THE CORRECT COPIES SYNTAX ⚠️
    # In SumatraPDF copies are given as "Nx" (e.g. "3x" = 3 copies).
    # Sumatra has NO option called "copies=3" — it treated that as an unknown
    # token and SILENTLY ignored it. That is why a customer
    # chose 2-3 copies and paid for 2-3 copies, but only 1 print
    # came out.
    # Docs: sumatrapdfreader.org/docs/Command-line-arguments -> -print-settings "3x"
    try:
        _n_copies = int(copies)
    except (TypeError, ValueError):
        _n_copies = 1
    _n_copies = max(1, min(50, _n_copies))     # the server caps it at 50 as well
    copies_token = f"{_n_copies}x"

    if color_mode == "bw":
        print_settings = f"{copies_token},monochrome,{scale_mode}"
        log(f"🖨️  Printing B&W (Monochrome) + {scale_mode} | {_n_copies} copies")
    else:
        # EXPLICIT 'color' flag — nothing used to be sent, so the printer
        # driver's DEFAULT applied. When the driver default is Grayscale (common on Canon/HP),
        # even a color job came out B&W. Now it is forced per job, whatever the
        # driver default is.
        print_settings = f"{copies_token},color,{scale_mode}"
        log(f"🖨️  Printing Color (explicit) + {scale_mode} | {_n_copies} copies")
    if extra:
        print_settings += f",{extra}"
        log(f"🖨️  Extra print settings: {extra}")

    use_specific_printer = bool(printer_name and printer_name.strip())
    if use_specific_printer:
        log(f"🎯 Specific printer route: '{printer_name}' (configured for {color_mode.upper()})")
    else:
        log(f"ℹ️  No specific printer set for {color_mode.upper()} — the system default printer will be used")

    log(f"SumatraPDF paths to try: {sumatra_paths}")
    for sumatra in sumatra_paths:
        try:
            path_exists = os.path.exists(sumatra)
        except Exception as pathErr:
            log(f"⚠️  Path check error for {sumatra}: {pathErr}", "WARN")
            continue
        if not path_exists:
            log(f"   ❌ Not found: {sumatra}")
            continue
        log(f"   ✅ Found: {sumatra}, trying print...")
        try:
            if use_specific_printer:
                # -print-to targets a specific printer, bypassing the default
                # printer — that is the core of this feature
                cmd = [
                    sumatra,
                    "-print-to", printer_name,
                    "-silent",
                    "-print-settings", print_settings,
                    filepath
                ]
            else:
                cmd = [
                    sumatra,
                    "-print-to-default",
                    "-silent",
                    "-print-settings", print_settings,
                    filepath
                ]
            log(f"CMD: {' '.join(cmd)}")
            result = subprocess.run(cmd, timeout=120, capture_output=True)
            if result.returncode == 0:
                log(f"✅ SumatraPDF print success! ({color_mode.upper()}, fit-to-page, printer={printer_name or 'default'})")
                return True
            else:
                err = result.stderr.decode(errors='ignore') if result.stderr else ''
                log(f"⚠️  SumatraPDF error (return code {result.returncode}): {err}", "WARN")
                # If the specific printer name is wrong/disconnected, try falling back
                # to the default printer (so printing does not stop
                # completely — at least it comes out somewhere)
                if use_specific_printer:
                    log(f"⚠️  Printing on '{printer_name}' failed, trying the default printer...", "WARN")
                    try:
                        fallback_cmd = [sumatra, "-print-to-default", "-silent", "-print-settings", print_settings, filepath]
                        fb_result = subprocess.run(fallback_cmd, timeout=120, capture_output=True)
                        if fb_result.returncode == 0:
                            log(f"✅ Printed on the default printer (fallback)")
                            return True
                    except Exception:
                        pass
        except Exception as runErr:
            log(f"⚠️  SumatraPDF subprocess error: {runErr}", "WARN")

    # Fallback
    log("SumatraPDF was not found anywhere (neither in the bundle nor on this PC) - trying the Windows "
        "shell instead. With this method the B&W / fit / specific-"
        "printer settings DO NOT APPLY.", "WARN")
    try:
        os.startfile(filepath, "print")
        time.sleep(5)
        log("✅ Printed via the Windows shell (fit/B&W settings and specific printer will not apply)")
        return True
    except Exception as e:
        log(f"❌ Print failed: {e}", "ERROR")
        return False

def print_word(filepath, copies=1, color_mode="bw", printer_name=None):
    """Word document print"""
    try:
        import win32com.client
        word = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        if printer_name and printer_name.strip():
            try:
                word.ActivePrinter = printer_name
                log(f"🎯 Word ActivePrinter set: {printer_name}")
            except Exception as ape:
                log(f"⚠️  Could not set ActivePrinter, the default will be used: {ape}", "WARN")
        doc = word.Documents.Open(os.path.abspath(filepath))
        doc.PrintOut(Copies=copies)
        time.sleep(5)
        doc.Close(False)
        word.Quit()
        log("✅ Word document printed!")
        return True
    except:
        try:
            os.startfile(filepath, "print")
            time.sleep(3)
            return True
        except Exception as e:
            log(f"❌ Word print failed: {e}", "ERROR")
            return False

def print_file(filepath, copies=1, color_mode="bw", selected_pages="", printer_name=None, duplex_on=False, duplex_mode="", duplex_pages=1, paper_size="a4", total_pages=None):
    """Main print function — handles all file types"""
    ext = Path(filepath).suffix.lower()
    log(f"🖨️  Printing: {os.path.basename(filepath)}")
    log(f"   Copies: {copies} | Mode: {color_mode.upper()} | Type: {ext}")
    if selected_pages:
        log(f"   Selected Pages: {selected_pages}")

    converted_pdf = None
    extracted_pdf = None

    try:
        sumatra_page_extra = ""   # filled only in the extraction-failure fallback

        # Problem 1: convert image files into an A4-fit PDF first
        if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.gif']:
            log(f"🔄 Image file detected — converting to A4 PDF...")
            converted_pdf = convert_image_to_pdf(filepath)
            if not converted_pdf:
                log("❌ Image to PDF conversion failed!", "ERROR")
                return False
            print_path = converted_pdf
        elif ext == '.pdf':
            print_path = filepath
            # Page Range: if specific pages are selected, extract them
            if selected_pages:
                extracted_pdf = extract_selected_pages(filepath, selected_pages, total_pages)
                if extracted_pdf is None:
                    # Extraction failed (in an .exe usually because PyCryptodome's native
                    # module is missing: "Cannot load native module
                    # Crypto.Util._cpuid_c"). The print used to be STOPPED here —
                    # which stopped the shop's work.
                    # Now the page range is handed straight to SumatraPDF. Sumatra
                    # prints a PDF page range by itself, no Python PDF
                    # library needed — and it prints no extra pages either.
                    page_range = _sumatra_page_range(selected_pages)
                    if page_range:
                        log(f"⚠️  Page extraction failed — printing pages {page_range} "
                            f"directly through SumatraPDF instead", "WARN")
                        sumatra_page_extra = page_range
                        print_path = filepath
                    else:
                        log("❌ Page extraction failed and the page list is unusable — "
                            "stopping the print for safety", "ERROR")
                        return False
                else:
                    print_path = extracted_pdf
        elif ext in ['.doc', '.docx']:
            return print_word(filepath, copies, color_mode, printer_name)
        else:
            print_path = filepath

        # ── DUPLEX ──
        # ── PAPER TOKEN ── the paper= flag for the sizes Sumatra understands;
        # for the rest (4x6, A1) the flag is skipped — the PDF itself has the right size,
        # and the driver default + fit handle it. Sumatra silently ignores a wrong/unknown
        # token, but we only send known ones.
        _PAPER_TOKENS = {"a4": "A4", "a3": "A3", "a5": "A5", "a2": "A2",
                         "letter": "letter", "legal": "legal"}
        _ptok = _PAPER_TOKENS.get((paper_size or "a4").lower(), "")
        # 'fit' for all sizes. The PDF itself is now built at the right paper size
        # (on the customer side), so 'fit' fills that paper completely
        # without stretching (the aspect matches). 4x6 used to use 'noscale', which kept
        # a small image small (the size/quality complaint).
        _scale = "fit"
        _paper_extra = f"paper={_ptok}" if _ptok else ""
        def _mix(dup_extra=""):
            # sumatra_page_extra is filled only when the pages could not be extracted
            # from the PDF — then Sumatra has to be given the page range itself.
            return ",".join([t for t in (_paper_extra, dup_extra, sumatra_page_extra) if t])

        # duplex_on / duplex_mode / duplex_pages are parameters now —
        # v9 called job.get() here, but this function has no 'job'
        # (EVERY print failed with a NameError)
        total_pgs = duplex_pages

        if duplex_on and duplex_mode == "auto":
            # The printer does duplex itself — the duplexlong flag for the driver
            log("📄 AUTO duplex — the printer prints both sides by itself")
            return print_pdf_sumatra(print_path, copies, color_mode, printer_name, extra=_mix("duplexlong"), scale_mode=_scale)

        if duplex_on and duplex_mode == "manual" and total_pgs > 1:
            # Two-pass manual duplex: first the ODD pages (1,3,5...), then the owner
            # turns the pages over and reloads them, then the EVEN pages (2,4,6...).
            # The server forces copies=1 for manual duplex.
            # NOTE: with 3+ sheets the order of the even pass depends on the printer's output
            # stacking (face-down laser = correct as is;
            # face-up means the owner flips the stack). Always correct for 1-2 page documents.
            log("📄 MANUAL duplex — pass 1: front (odd pages)")
            ok1 = print_pdf_sumatra(print_path, 1, color_mode, printer_name, extra=_mix("odd"), scale_mode=_scale)
            if not ok1:
                return False
            update_tray_status("📄 Waiting for the back side — flip the pages!")
            if ask_backside():
                log("📄 MANUAL duplex — pass 2: back (even pages)")
                return print_pdf_sumatra(print_path, 1, color_mode, printer_name, extra=_mix("even"), scale_mode=_scale)
            else:
                log("📄 Owner skipped the back side — only the front was printed")
                return True  # the front was printed, the job is done

        if duplex_on and total_pgs <= 1:
            log("📄 Duplex was selected but there is only 1 page — printing normally")

        # Print the PDF with fit-to-page (an image is now an A4-fitted PDF as well)
        success = print_pdf_sumatra(print_path, copies, color_mode, printer_name, extra=_mix(), scale_mode=_scale)
        return success

    except Exception as e:
        # This used to be just try/finally — any unusual exception went straight up
        # to process_job() and became "Job crashed". Now it is stopped here and
        # False is returned: the job is cleanly marked "failed", the agent
        # keeps running, and the log shows the real cause.
        log(f"❌ Print error: {type(e).__name__}: {e}", "ERROR")
        try:
            import traceback
            log("   " + traceback.format_exc().strip().replace("\n", " | ")[-400:], "ERROR")
        except Exception:
            pass
        return False

    finally:
        if converted_pdf and os.path.exists(converted_pdf):
            try:
                time.sleep(2)
                os.unlink(converted_pdf)
                log(f"🗑️  Converted PDF deleted")
            except:
                pass
        if extracted_pdf and extracted_pdf != filepath and os.path.exists(extracted_pdf):
            try:
                time.sleep(2)
                os.unlink(extracted_pdf)
                log(f"🗑️  Extracted PDF deleted")
            except:
                pass

_http = None

def http():
    """
    A single Session that retries automatically on small network problems.
    The connection is reused, so the chance that the first request after an
    idle period fails becomes very small.
    """
    global _http
    if _http is not None:
        return _http
    sess = requests.Session()
    try:
        from requests.adapters import HTTPAdapter
        try:
            from urllib3.util.retry import Retry
        except Exception:
            from requests.packages.urllib3.util.retry import Retry
        retry = Retry(
            total=2, connect=2, read=2, backoff_factor=0.6,
            status_forcelist=(502, 503, 504),
            allowed_methods=frozenset(["GET", "POST"])
        )
        ad = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
        sess.mount("https://", ad)
        sess.mount("http://", ad)
    except Exception as e:
        log(f"HTTP retry setup skipped: {e}", "WARN")
    _http = sess
    return _http

def reset_http():
    """On reconnect throw the old session away completely — new sockets get created."""
    global _http
    try:
        if _http is not None:
            _http.close()
    except Exception:
        pass
    _http = None

class PollError(Exception):
    """The poll could not reach the server at all (socket/network/server)."""
    pass


_poll_last_logged = 0.0


def _log_poll_problem(msg):
    """
    Logging every failed poll means one line every 10 seconds — the file
    fills up and the real message gets buried. So: the first failure is logged
    immediately, after that once every 60s.
    """
    global _poll_last_logged
    now = time.time()
    if now - _poll_last_logged >= 60:
        _poll_last_logged = now
        log(msg, "WARN")


def _reset_poll_log():
    """Reset the counter when the connection comes back — so the next problem is logged immediately."""
    global _poll_last_logged
    _poll_last_logged = 0.0


def get_pending_jobs():
    """
    Returns:
        list  -- the server answered (an empty list = there really is no job)
        None  -- the poll FAILED

    This difference is the most important thing. Both cases used to return [],
    so print_loop() took a network failure for "no job"
    and all recovery stopped.
    """
    global _demo_expired_shown, _shop_missing_count, _shop_gone
    try:
        # lp = long poll. A new server holds the line this long and sends the job
        # as soon as it arrives. An OLD server does not know this param — it
        # silently ignores it and answers empty immediately, and the
        # agent simply keeps running the old sleep-based way.
        url = f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}"
        if MACHINE_ID:
            url += f"?m={MACHINE_ID}&v={VERSION}&vl={VERSION_LABEL}&lp={LP_SECONDS}"
        else:
            url += f"?v={VERSION}&vl={VERSION_LABEL}&lp={LP_SECONDS}"
        # the timeout is longer than the server's hold — otherwise every long poll would look like a failure
        resp = http().get(url, headers=auth_headers(), timeout=LP_TIMEOUT)
        if resp.status_code == 403:
            # The old message said "use 'Re-link agent'" — the dashboard has no
            # button with that name, so the shop owner kept
            # searching for it. The real place is:
            #   Dashboard -> Settings -> "Connected Computer" ->
            #   "Disconnect Computer"
            # After that the agent links itself again.
            log("❌ The server rejected the agent token of this PC. "
                "Open the shop dashboard -> Settings -> 'Connected Computer' -> "
                "press 'Disconnect Computer', then close this agent and start it "
                "again. It will link itself automatically.", "ERROR")
            update_tray_status("Connection denied — select 'Disconnect Computer' in your dashboard")
            return []
        if resp.status_code == 404:
            # There are two kinds of 404 (the claim code makes the same distinction):
            #   a) OUR JSON         -> the shop really does not exist on the server
            #   b) Express's HTML   -> an old server, the endpoint does not exist
            # Stopping on (b) would be wrong — that is a case for retrying.
            _our_404 = False
            try:
                _our_404 = bool(resp.json().get("error"))
            except Exception:
                _our_404 = False

            if not _our_404:
                _log_poll_problem("The server returned 404 (old server?) — will retry")
                return None

            # One 404 is not enough — a network blip or one bad answer must not put the
            # agent to sleep for 30 minutes. It takes 3 in a row.
            _note_shop_missing()
            if _shop_gone:
                return []           # [] = "no job", not None —
                                    # otherwise a PollError would switch the tray
                                    # to "Offline" and start the backoff
                                    # churn.
            _log_poll_problem("The server returned 404 — will retry")
            return None

        if resp.status_code != 200:
            # The server did answer, but with a bad status (502/503 =
            # Render is still waking up). Treating that as "no job"
            # would be wrong — retry/backoff must run.
            _log_poll_problem(f"The server returned {resp.status_code} — will retry")
            return None
        d = resp.json()
        _clear_shop_missing()      # an answer arrived = the shop exists. Clear the marker.
        if d.get("demo_expired"):
            update_tray_status("⏰ Demo has ended — please register!")
            if not _demo_expired_shown:
                _demo_expired_shown = True
                log("⏰ Demo period has ended — register to get a new Shop ID")
                threading.Thread(target=_show_demo_expired_popup, daemon=True).start()
            return []
        return d.get("jobs", [])
    except Exception as e:
        # THIS IS WHERE THE BUG LIVED: this used to be
        # `return []`, without any log. Dead socket, timeout,
        # DNS failure — all of them silently became "no job".
        _log_poll_problem(f"Could not talk to the server: {type(e).__name__} — {e}")
        return None

_demo_expired_shown = False

# The shop was not found on the server — how many times in a row, and whether we have paused
_shop_missing_count = 0
_shop_gone = False
_shop_gone_shown = False


def _note_shop_missing():
    """Counts consecutive 404s. On the third one the agent slows down."""
    global _shop_missing_count, _shop_gone, _shop_gone_shown
    _shop_missing_count += 1
    if _shop_missing_count < 3 or _shop_gone:
        return
    _shop_gone = True
    log("🛑 This Shop ID no longer exists on the server. The demo may have ended "
        "or the shop was deleted. The agent has almost stopped asking — "
        "it will now check once every 30 minutes. When you get a new Shop ID, close the agent "
        "and start it again.", "ERROR")
    update_tray_status("Shop ID unavailable — enter a new Shop ID")
    if not _shop_gone_shown:
        _shop_gone_shown = True
        threading.Thread(target=_show_shop_gone_popup, daemon=True).start()


def _clear_shop_missing():
    """The poll succeeded — so the shop exists. Everything back to normal."""
    global _shop_missing_count, _shop_gone
    if _shop_missing_count or _shop_gone:
        if _shop_gone:
            log("✅ The Shop ID is back — returning to normal speed")
        _shop_missing_count = 0
        _shop_gone = False


def _show_shop_gone_popup():
    _msgbox("This Shop ID is no longer available on the server.\n\n"
            "Your demo may have ended. Register for a new Shop ID at "
            f"{SERVER_URL}/register, then restart the agent.",
            "Echel", 0x30)

def _show_demo_expired_popup():
    try:
        import ctypes
        r = ctypes.windll.user32.MessageBoxW(None,
            # The duration is DELIBERATELY not written. The superadmin can change it
            # anywhere between 15 minutes and 24 hours at any time, and the server
            # only sends "demo_expired" -- not how long it was.
            # This used to hardcode "2-hour", which looked wrong.
            "Your demo has ended.\n\n"
            "Register to get your permanent Shop ID:\n"
            f"{SERVER_URL}/register\n\n"
            "Select OK to open the registration page.",
            "Echel — Demo Ended", 0x40 | 0x1)  # OK/Cancel + info icon
        if r == 1:  # OK
            os.startfile(f"{SERVER_URL}/register")
    except Exception:
        pass

# ══════════════════════════════════════════════════════════════════
# DEMO UPGRADE REMINDER
# When the agent runs on a demo shop ID, it reminds the owner 4 times between
# 9 AM and 8 PM — take the Monthly or Lifetime plan. The popup has
# buttons for both plans + Dismiss. Pressing a plan button opens the
# new shop registration in the browser.
# Each slot is shown only once (recorded in the state file), so
# it does not spam again even after an agent restart.
# ══════════════════════════════════════════════════════════════════
DEMO_REMINDER_FILE = os.path.join(_APPDATA_DIR, "demo_reminder.txt")
DEMO_SLOTS = [(9, 0), (12, 40), (16, 20), (20, 0)]   # 4 times, 9AM–8PM
DEMO_CHECK_INTERVAL = 300                             # har 5 min slot check


def _demo_status():
    """Ask the server whether this shop is a demo. Uses the new lightweight endpoint;
    falls back to /api/shop/<id> on an old server."""
    try:
        r = requests.get(f"{SERVER_URL}/api/shop/{SHOP_ID}/demo-status", timeout=12)
        if r.status_code == 200:
            d = r.json()
            return bool(d.get("demo")), bool(d.get("expired"))
    except Exception:
        pass
    try:
        r = requests.get(f"{SERVER_URL}/api/shop/{SHOP_ID}", timeout=12)
        if r.status_code == 200:
            return bool(r.json().get("demo")), False
    except Exception:
        pass
    return False, False


def _demo_slot_index(now=None):
    """Which slot is active right now (0-3), or None if outside the window."""
    n = now or datetime.now()
    cur = None
    for i, (h, m) in enumerate(DEMO_SLOTS):
        if (n.hour, n.minute) >= (h, m):
            cur = i
    # The slot after 8 PM stays valid until the next day, but not after 11 PM
    if cur is not None and n.hour >= 22:
        return None
    return cur


def _demo_reminder_done(tag):
    try:
        if os.path.exists(DEMO_REMINDER_FILE):
            with open(DEMO_REMINDER_FILE, "r", encoding="utf-8") as f:
                return f.read().strip() == tag
    except Exception:
        pass
    return False


def _demo_reminder_mark(tag):
    try:
        with open(DEMO_REMINDER_FILE, "w", encoding="utf-8") as f:
            f.write(tag)
    except Exception:
        pass


def _open_register(plan):
    url = f"{SERVER_URL}/register?plan={plan}&from=agent"
    try:
        os.startfile(url)
    except Exception:
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass


def _show_demo_upgrade_popup():
    """
    Demo reminder — Windows' own dialog.

    This used to be a two-button tkinter window (Monthly / Lifetime).
    A MessageBox cannot have that many buttons, so it is now a single Yes/No:
    pressing Yes opens the registration page in the browser, where
    all the plans are shown as before. One extra click, but it never
    fails.
    """
    try:
        ans = _native_yesno(
            "DEMO SHOP ID\n"
            "\n"
            "Your shop is currently using a demo Shop ID.\n"
            "Printing will stop when the demo ends.\n"
            "\n"
            "Yes  =  View plans in your browser\n"
            "No   =  Not now",
            "Echel - Demo")
        if ans is True:
            _open_register("onetime")
    except Exception as e:
        log(f"Could not open the demo popup: {e}", "WARN")


def demo_reminder_loop():
    """Background thread — checks every 5 minutes whether a slot is due."""
    last_status_check = 0
    is_demo, expired = False, False
    while agent_state["running"]:
        try:
            now = time.time()
            # Refresh the demo status once every 30 min (light on the server)
            if now - last_status_check > 1800:
                is_demo, expired = _demo_status()
                last_status_check = now
            if is_demo and not expired:
                slot = _demo_slot_index()
                if slot is not None:
                    tag = f"{datetime.now().strftime('%Y-%m-%d')}#{slot}"
                    if not _demo_reminder_done(tag):
                        _demo_reminder_mark(tag)
                        log(f"\u23f0 Demo upgrade reminder ({slot + 1}/4 today)")
                        threading.Thread(target=_show_demo_upgrade_popup, daemon=True).start()
        except Exception:
            pass
        time.sleep(DEMO_CHECK_INTERVAL)


def _report_with_retry(url, payload, job_id, what):
    """The result report MUST reach the SERVER — if one attempt fails,
    the job stays stuck in 'printing' on the server and after 10 min it is requeued
    and printed AGAIN (duplicate paper!). So 6 attempts,
    10s apart — it gets through within ~1 min even on a weak network."""
    for attempt in range(1, 7):
        try:
            r = requests.post(url, json=payload, timeout=15)
            if r.status_code == 200:
                if attempt > 1:
                    log(f"✅ {what} report delivered on attempt {attempt} ({job_id})")
                # The server's answer is returned too — it tells whether the
                # customer's file was deleted just now or earlier.
                try:
                    return True, (r.json() or {})
                except Exception:
                    return True, {}
            log(f"⚠️ {what} report HTTP {r.status_code} (attempt {attempt}/6)", "WARN")
        except Exception as e:
            log(f"⚠️ {what} report failed (attempt {attempt}/6): {e}", "WARN")
        if attempt < 6:
            time.sleep(10)
    log(f"❌ {what} report failed after 6 attempts — job {job_id} "
        f"will stay stuck on the server (the server clears it in 10 minutes)", "ERROR")
    return False, {}

def _log_server_file(ok, data):
    """
    Whether the customer's file was removed from the server — this never used to
    appear in the log. Only "Local file deleted" showed, and that is THIS PC's temp file.
    The customer's real file lives on the server.

    On /api/jobs/complete (and /failed) the server deletes that file itself
    and writes file_deleted=true in the DB. So a 200 means
    that work is done. `already:true` means it had already happened.
    """
    try:
        if not ok:
            log("⚠️  The report did not reach the server — the customer's file may still "
                "be on the server (the server cleans it up by itself within 10 min)", "WARN")
            return False
        if isinstance(data, dict) and data.get("already"):
            log("☁️  Server: the customer's file had already been deleted")
        else:
            log("☁️  The customer's file was deleted from the server")
        return True
    except Exception:
        return bool(ok)


def mark_complete(job_id):
    # First the local record, then the server report. Even if the agent crashes
    # in the middle of the report, this job will not be printed again.
    try:
        mark_processed(job_id)
    except Exception as e:
        log(f"Could not record processed job: {e}", "WARN")
    log(f"✅ Job {job_id} complete! Reporting to the server...")
    ok, data = _report_with_retry(
        f"{SERVER_URL}/api/jobs/complete/{job_id}", {}, job_id, "Complete")
    return _log_server_file(ok, data)


def mark_failed(job_id, reason=""):
    ok, data = _report_with_retry(
        f"{SERVER_URL}/api/jobs/failed/{job_id}", {"reason": reason}, job_id, "Failed")
    # On deny/fail too the server cleans up its file — log that
    return _log_server_file(ok, data)


# ══════════════════════════════════════════════════════════════
#  LIVE JOB WINDOW  —  one job, one window, all the work in view
#
#  The old approval popup was ONE-SHOT: run PowerShell, get the answer, close.
#  After that nothing more could be shown — Python waited on
#  `subprocess.run` and there was no way to send anything to an open window.
#
#  Now it is the other way round:
#    * the window runs through Popen (Python does NOT wait)
#    * Python writes a small JSON state file
#    * every 320ms the window reads that file and refreshes itself
#    * pressing a button makes the window write a result file, which Python reads
#
#  The look uses WPF (XAML), not WinForms. With WinForms the rounded
#  cards / shadows / chips would all have to be drawn by hand in GDI+ and the edges
#  would look jagged. WPF is part of Windows itself (no download) and all of this
#  is built in.
#
#  THE OLD RULE STILL APPLIES: if this window fails for any reason, printing
#  MUST NOT STOP. Every call is inside try/except, and the old MessageBox
#  path for approval is still fully alive.
# ══════════════════════════════════════════════════════════════

_JOBWIN_DIR = os.path.join(_APPDATA_DIR, "jobwin")
_JOBWIN_PS1 = os.path.join(_RUNTIME_DIR, "job_window.ps1")
_JOBWIN_OK = None          # None = not tried yet, False = this PC could not run it

# Step state
_ST_WAIT = "wait"          # its turn has not come yet
_ST_RUN = "run"            # running (spinning circle)
_ST_DONE = "done"          # done (green tick)
_ST_FAIL = "fail"          # did not happen (red cross)
_ST_SKIP = "skip"          # does not apply to this job (dash)

# Segoe MDL2 Assets icons (built into Windows 10/11).
_IC_FILE = "E7C3"      # page (folded corner)
_IC_CARD = "E8C7"      # payment card
_IC_USER = "E77B"      # contact
_IC_CLOCK = "E823"     # clock
_IC_PRINT = "E749"     # printer
_IC_CLOUD = "E753"     # cloud
_IC_TRASH = "E74D"     # delete
_IC_TICK = "E73E"      # check
_IC_CROSS = "E711"     # cancel
_IC_DASH = "E738"      # remove (for skip)


_JOBWIN_XAML = r'''<Window
  xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  Title="Echel" Height="472" Width="400"
  WindowStartupLocation="Manual" ResizeMode="NoResize" ShowActivated="False"
  ShowInTaskbar="True" Topmost="True" Background="#FFFFFF"
  FontFamily="Segoe UI" UseLayoutRounding="True" SnapsToDevicePixels="True">
  <Window.Resources>
    <Style x:Key="Chip" TargetType="Border">
      <Setter Property="Width" Value="30"/>
      <Setter Property="Height" Value="30"/>
      <Setter Property="CornerRadius" Value="9"/>
    </Style>
    <Style x:Key="Glyph" TargetType="TextBlock">
      <Setter Property="FontFamily" Value="Segoe MDL2 Assets, Segoe UI Symbol"/>
      <Setter Property="FontSize" Value="13"/>
      <Setter Property="HorizontalAlignment" Value="Center"/>
      <Setter Property="VerticalAlignment" Value="Center"/>
    </Style>
    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Height" Value="34"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="bd" CornerRadius="8" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="1">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="bd" Property="Opacity" Value="0.86"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter TargetName="bd" Property="Opacity" Value="0.45"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <Grid>
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <!-- HEADER -->
    <Border x:Name="HeadCard" Grid.Row="0" Padding="12,9,12,9" Background="#FFFBEB"
            BorderBrush="#F3E8D0" BorderThickness="0,0,0,1">
      <Grid>
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
        </Grid.ColumnDefinitions>

        <Border x:Name="HeadChip" Grid.Column="0" Width="34" Height="34" CornerRadius="10"
                Background="#FDE68A" VerticalAlignment="Top">
          <TextBlock x:Name="HeadIcon" Style="{StaticResource Glyph}" FontSize="16"
                     Foreground="#B45309" Text="&#xE8C7;"/>
        </Border>

        <StackPanel Grid.Column="1" Margin="9,0,6,0">
          <TextBlock x:Name="HeadTitle" Text="Cash Mode" FontSize="13" FontWeight="Bold"
                     Foreground="#B45309" TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="HeadJob" Text="-" FontSize="10" Foreground="#78716C"
                     Margin="0,2,0,0" TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="HeadFile" Text="-" FontSize="10" Foreground="#1C1917"
                     Margin="0,2,0,0" TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="HeadAmt" Text="-" FontSize="10" Foreground="#1C1917"
                     FontWeight="SemiBold" Margin="0,2,0,0" TextTrimming="CharacterEllipsis"/>
        </StackPanel>

        <Border x:Name="BadgeBox" Grid.Column="2" CornerRadius="7" Padding="8,5,8,5"
                Background="#FFFFFF" BorderBrush="#F59E0B" BorderThickness="1"
                VerticalAlignment="Top" MinWidth="76">
          <StackPanel>
            <TextBlock x:Name="BadgeTop" Text="ACCEPTED" FontSize="10" FontWeight="Bold"
                       Foreground="#B45309" HorizontalAlignment="Center"/>
            <TextBlock x:Name="BadgeSub" Text="Now Printing" FontSize="9"
                       Foreground="#78716C" HorizontalAlignment="Center" Margin="0,1,0,0"
                       TextTrimming="CharacterEllipsis"/>
          </StackPanel>
        </Border>
      </Grid>
    </Border>

    <!-- STEPS -->
    <StackPanel x:Name="Steps" Grid.Row="1" Margin="12,8,12,0">
      <!--ROWS-->
    </StackPanel>

    <!-- BUTTONS -->
    <Grid Grid.Row="2" Margin="12,4,12,9">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="8"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>
      <Button x:Name="BtnA" Grid.Column="0" Style="{StaticResource Btn}"
              Background="#16A34A" BorderBrush="#15803D" Visibility="Collapsed">
        <TextBlock x:Name="BtnAText" Text="Approve" Foreground="White" FontWeight="Bold"
                   FontSize="12"/>
      </Button>
      <Button x:Name="BtnB" Grid.Column="2" Style="{StaticResource Btn}"
              Background="#FFFFFF" BorderBrush="#D6D3D1">
        <TextBlock x:Name="BtnBText" Text="Close" Foreground="#1C1917" FontWeight="SemiBold"
                   FontSize="12"/>
      </Button>
    </Grid>

    <!-- STATUS -->
    <Border Grid.Row="3" Background="#FAFAF9" BorderBrush="#E7E5E4" BorderThickness="0,1,0,0"
            Padding="12,6,12,6">
      <Grid>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Left">
          <TextBlock Text="Agent :" FontSize="10" Foreground="#57534E"/>
          <TextBlock x:Name="AgentTxt" Text="Online" FontSize="10" FontWeight="SemiBold"
                     Foreground="#16A34A" Margin="4,0,4,0"/>
          <Ellipse x:Name="AgentDot" Width="7" Height="7" Fill="#16A34A" VerticalAlignment="Center"/>
        </StackPanel>
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
          <TextBlock Text="Server :" FontSize="10" Foreground="#57534E"/>
          <TextBlock x:Name="SrvTxt" Text="Connected" FontSize="10" FontWeight="SemiBold"
                     Foreground="#16A34A" Margin="4,0,4,0"/>
          <Ellipse x:Name="SrvDot" Width="7" Height="7" Fill="#16A34A" VerticalAlignment="Center"/>
        </StackPanel>
      </Grid>
    </Border>
  </Grid>
</Window>'''


# One step row. Repeated 6 times (index 0..5).
_JOBWIN_ROW = r'''
      <Grid Name="RowG__I__" Margin="0,0,0,0">
        <Grid.ColumnDefinitions>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="*"/>
          <ColumnDefinition Width="Auto"/>
          <ColumnDefinition Width="24"/>
        </Grid.ColumnDefinitions>
        <Grid Grid.Column="0" Width="30" Height="44">
          <Rectangle Name="RowLine__I__" Width="2" Fill="#E7E5E4" Height="14"
                     VerticalAlignment="Bottom" HorizontalAlignment="Center"/>
          <Border Name="RowChip__I__" Style="{StaticResource Chip}" Background="#F5F5F4"
                  VerticalAlignment="Top">
            <TextBlock Name="RowIcon__I__" Style="{StaticResource Glyph}"
                       Foreground="#A8A29E" Text="&#xE7C3;"/>
          </Border>
        </Grid>
        <TextBlock Name="RowLbl__I__" Grid.Column="1" Text="-" FontSize="11.5"
                   Foreground="#292524" VerticalAlignment="Top" Margin="9,8,4,0"
                   TextTrimming="CharacterEllipsis"/>
        <TextBlock Name="RowTime__I__" Grid.Column="2" Text="" FontSize="9.5"
                   Foreground="#78716C" VerticalAlignment="Top" Margin="0,9,6,0"/>
        <Grid Grid.Column="3" VerticalAlignment="Top" Margin="0,7,0,0">
          <TextBlock Name="RowMark__I__" Style="{StaticResource Glyph}" FontSize="13"
                     Foreground="#16A34A" Text="&#xE73E;" Visibility="Collapsed"/>
          <Canvas Name="RowSpin__I__" Width="16" Height="16" Visibility="Collapsed">
            <Ellipse Width="14" Height="14" Canvas.Left="1" Canvas.Top="1"
                     Stroke="#DBEAFE" StrokeThickness="2.5"/>
            <Path Stroke="#2563EB" StrokeThickness="2.5" StrokeStartLineCap="Round"
                  Data="M 8,1 A 7,7 0 0 1 15,8">
              <Path.RenderTransform>
                <RotateTransform x:Name="Rot__I__" CenterX="8" CenterY="8" Angle="0"/>
              </Path.RenderTransform>
            </Path>
          </Canvas>
        </Grid>
      </Grid>'''


# The PowerShell driver. It is only a "renderer" — no business logic.
# Python makes every decision and writes it into the state file.
_JOBWIN_PS = r'''param([string]$State, [string]$Result, [string]$XamlFile)
$ErrorActionPreference = 'Stop'

# WITHOUT a BOM. [Text.Encoding]::UTF8 puts EF BB BF at the start of the file, and
# Python's .strip() cannot remove it — so "reject" never matched
# and every reject turned into "the window was closed".
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Fail($m) {
  try { [IO.File]::WriteAllText($Result, "ERROR:$m", $Utf8NoBom) } catch {}
  exit 1
}

if (-not (Get-Command ConvertFrom-Json -ErrorAction SilentlyContinue)) { Fail 'no-json' }

try {
  Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml
} catch { Fail 'no-wpf' }

try {
  [xml]$xdoc = [IO.File]::ReadAllText($XamlFile, [Text.Encoding]::UTF8)
  $rdr = New-Object System.Xml.XmlNodeReader $xdoc
  $win = [Windows.Markup.XamlReader]::Load($rdr)
} catch { Fail ('xaml:' + $_.Exception.Message) }

$bc = New-Object System.Windows.Media.BrushConverter
function B([string]$hex) { try { return $bc.ConvertFromString($hex) } catch { return $null } }
function G([string]$hex) { try { return [string][char][Convert]::ToInt32($hex,16) } catch { return '' } }

$C = @{}
foreach ($n in @('HeadCard','HeadChip','HeadIcon','HeadTitle','HeadJob','HeadFile','HeadAmt',
                 'BadgeBox','BadgeTop','BadgeSub','BtnA','BtnAText','BtnB','BtnBText',
                 'AgentTxt','AgentDot','SrvTxt','SrvDot')) { $C[$n] = $win.FindName($n) }
for ($i = 0; $i -lt 6; $i++) {
  foreach ($p in @('RowG','RowLine','RowChip','RowIcon','RowLbl','RowTime','RowMark','RowSpin','Rot')) {
    $C["$p$i"] = $win.FindName("$p$i")
  }
}

$script:decided = $false
$script:idA = ''
$script:idB = 'close'
$script:closeAt = $null
$script:lastRaw = ''

function Send([string]$v) {
  if ($script:decided) { return }
  $script:decided = $true
  try { [IO.File]::WriteAllText($Result, $v, $Utf8NoBom) } catch {}
}

$C['BtnA'].Add_Click({ Send $script:idA; $C['BtnA'].IsEnabled = $false })
$C['BtnB'].Add_Click({
  if ($script:idB -eq 'close') { $win.Close() }
  else { Send $script:idB; $C['BtnB'].IsEnabled = $false }
})
$win.Add_Closing({ Send 'CLOSED' })

function Apply($s) {
  if ($s.title)  { $C['HeadTitle'].Text = [string]$s.title }
  if ($s.job_id) { $C['HeadJob'].Text  = [string]$s.job_id }
  if ($s.file)   { $C['HeadFile'].Text = [string]$s.file }
  if ($s.amount) { $C['HeadAmt'].Text  = [string]$s.amount }
  if ($s.accent) {
    $a = B $s.accent
    if ($a) { $C['HeadTitle'].Foreground = $a; $C['HeadIcon'].Foreground = $a
              $C['BadgeTop'].Foreground = $a; $C['BadgeBox'].BorderBrush = $a }
  }
  if ($s.bg)      { $x = B $s.bg;      if ($x) { $C['HeadCard'].Background = $x } }
  if ($s.chip_bg) { $x = B $s.chip_bg; if ($x) { $C['HeadChip'].Background = $x } }
  if ($s.icon)    { $C['HeadIcon'].Text = G $s.icon }
  if ($s.badge_top -ne $null) { $C['BadgeTop'].Text = [string]$s.badge_top }
  if ($s.badge_sub -ne $null) { $C['BadgeSub'].Text = [string]$s.badge_sub }

  $n = 0
  if ($s.steps) { $n = @($s.steps).Count }
  for ($i = 0; $i -lt 6; $i++) {
    if ($i -ge $n) { $C["RowG$i"].Visibility = 'Collapsed'; continue }
    $C["RowG$i"].Visibility = 'Visible'
    $st = @($s.steps)[$i]
    $C["RowLbl$i"].Text  = [string]($i + 1) + '. ' + [string]$st.label
    $C["RowTime$i"].Text = [string]$st.time
    $C["RowIcon$i"].Text = G $st.icon
    if ($i -lt ($n - 1)) { $C["RowLine$i"].Visibility = 'Visible' }
    else { $C["RowLine$i"].Visibility = 'Collapsed' }

    $mark = $C["RowMark$i"]
    $spin = $C["RowSpin$i"]
    switch ([string]$st.state) {
      'done' {
        $mark.Text = G 'E73E'
        $mark.Foreground = B '#16A34A'
        $mark.Visibility = 'Visible'
        $spin.Visibility = 'Collapsed'
        $x = B $st.chip; if ($x) { $C["RowChip$i"].Background = $x }
        $x = B $st.fg;   if ($x) { $C["RowIcon$i"].Foreground = $x }
        $C["RowLbl$i"].Foreground = B '#292524'
      }
      'fail' {
        $mark.Text = G 'E711'
        $mark.Foreground = B '#DC2626'
        $mark.Visibility = 'Visible'
        $spin.Visibility = 'Collapsed'
        $C["RowChip$i"].Background = B '#FEE2E2'
        $C["RowIcon$i"].Foreground = B '#DC2626'
        $C["RowLbl$i"].Foreground = B '#292524'
      }
      'run' {
        $mark.Visibility = 'Collapsed'
        $spin.Visibility = 'Visible'
        $x = B $st.chip; if ($x) { $C["RowChip$i"].Background = $x }
        $x = B $st.fg;   if ($x) { $C["RowIcon$i"].Foreground = $x }
        $C["RowLbl$i"].Foreground = B '#292524'
      }
      'skip' {
        $mark.Text = G 'E738'
        $mark.Foreground = B '#A8A29E'
        $mark.Visibility = 'Visible'
        $spin.Visibility = 'Collapsed'
        $C["RowChip$i"].Background = B '#F5F5F4'
        $C["RowIcon$i"].Foreground = B '#D6D3D1'
        $C["RowLbl$i"].Foreground = B '#A8A29E'
      }
      default {
        $mark.Visibility = 'Collapsed'
        $spin.Visibility = 'Collapsed'
        $C["RowChip$i"].Background = B '#F5F5F4'
        $C["RowIcon$i"].Foreground = B '#A8A29E'
        $C["RowLbl$i"].Foreground = B '#A8A29E'
      }
    }
  }

  if ($s.btn_a -and $s.btn_a.id) {
    $script:idA = [string]$s.btn_a.id
    $C['BtnAText'].Text = [string]$s.btn_a.text
    $x = B $s.btn_a.bg; if ($x) { $C['BtnA'].Background = $x }
    $x = B $s.btn_a.bd; if ($x) { $C['BtnA'].BorderBrush = $x }
    $x = B $s.btn_a.fg; if ($x) { $C['BtnAText'].Foreground = $x }
    $C['BtnA'].Visibility = 'Visible'
    if ($script:decided) { $C['BtnA'].IsEnabled = $false }
  } else { $C['BtnA'].Visibility = 'Collapsed' }

  if ($s.btn_b -and $s.btn_b.id) {
    $script:idB = [string]$s.btn_b.id
    $C['BtnBText'].Text = [string]$s.btn_b.text
    $x = B $s.btn_b.bg; if ($x) { $C['BtnB'].Background = $x }
    $x = B $s.btn_b.bd; if ($x) { $C['BtnB'].BorderBrush = $x }
    $x = B $s.btn_b.fg; if ($x) { $C['BtnBText'].Foreground = $x }
  }

  if ($s.agent) {
    $C['AgentTxt'].Text = [string]$s.agent
    $x = B $s.agent_c; if ($x) { $C['AgentTxt'].Foreground = $x; $C['AgentDot'].Fill = $x }
  }
  if ($s.server) {
    $C['SrvTxt'].Text = [string]$s.server
    $x = B $s.server_c; if ($x) { $C['SrvTxt'].Foreground = $x; $C['SrvDot'].Fill = $x }
  }

  if ($s.close_in -ne $null -and $script:closeAt -eq $null) {
    $script:closeAt = (Get-Date).AddSeconds([double]$s.close_in)
  }
}

$script:tick = 0
$script:angle = 0.0
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(80)
$timer.Add_Tick({
  $script:angle = ($script:angle + 32) % 360
  for ($i = 0; $i -lt 6; $i++) {
    $r = $C["Rot$i"]
    if ($r -ne $null) { $r.Angle = $script:angle }
  }
  $script:tick++
  if (($script:tick % 4) -eq 0) {
    try {
      $raw = [IO.File]::ReadAllText($State, [Text.Encoding]::UTF8)
      if ($raw -and $raw -ne $script:lastRaw) {
        $script:lastRaw = $raw
        Apply ($raw | ConvertFrom-Json)
      }
    } catch { }
  }
  if ($script:closeAt -ne $null) {
    $left = [int][Math]::Ceiling(($script:closeAt - (Get-Date)).TotalSeconds)
    if ($left -le 0) { $timer.Stop(); $win.Close() }
    else { $C['BtnBText'].Text = "Close ($left)" }
  }
})

try {
  $raw0 = [IO.File]::ReadAllText($State, [Text.Encoding]::UTF8)
  $script:lastRaw = $raw0
  Apply ($raw0 | ConvertFrom-Json)
} catch { }

# Bottom-right corner, away from the taskbar. WorkArea excludes the taskbar,
# so the window never sits on top of it.
try {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.Width - 14
  $win.Top  = $wa.Bottom - $win.Height - 14
} catch {
  $win.WindowStartupLocation = 'CenterScreen'
}
# Activate() was removed on purpose — this window will not steal focus from
# the app you are typing in. It is Topmost, so it is still visible.
$win.Add_Closed({ try { $timer.Stop() } catch {} })
$timer.Start()
$win.ShowDialog() | Out-Null
Send 'CLOSED'
exit 0
'''


def _jobwin_write_assets():
    """
    Write the .ps1 and .xaml into APPDATA (only once, or when they change).

    APPDATA instead of _MEI because that is the place that does not get cleaned
    (the [[_MEI survival kit]] point).
    """
    os.makedirs(_RUNTIME_DIR, exist_ok=True)
    os.makedirs(_JOBWIN_DIR, exist_ok=True)
    rows = "".join(_JOBWIN_ROW.replace("__I__", str(i)) for i in range(6))
    xaml = _JOBWIN_XAML.replace("      <!--ROWS-->", rows)
    for path, body in ((_JOBWIN_PS1, _JOBWIN_PS),
                       (_JOBWIN_PS1[:-4] + ".xaml", xaml)):
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as fh:
                    if fh.read() == body:
                        continue
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
        except Exception as e:
            log(f"Could not write the job window assets ({e})", "WARN")
            return False
    return True


class JobWindow:
    """
    The live window of a single job.

    Usage:
        w = JobWindow(job); w.open()
        w.step(1, _ST_DONE); w.push()
        ans = w.decide(timeout=600)     # "approve" / "reject" / None
        ...
        w.done_and_close()

    Every method fails silently. If the window does not run, printing is
    not affected at all — only this window is not shown.
    """

    def __init__(self, job):
        self.job = job or {}
        self.proc = None
        self.alive = False
        jid = str(self.job.get("id", "job"))
        safe = "".join(c for c in jid if c.isalnum() or c in "-_")[:60] or "job"
        self.state_file = os.path.join(_JOBWIN_DIR, safe + ".json")
        self.result_file = os.path.join(_JOBWIN_DIR, safe + ".result")
        self._decided = None
        self.s = self._initial_state()

    # ── build the state ──
    def _initial_state(self):
        j = self.job
        counter = j.get("payment_method") == "counter"
        color = "Color" if j.get("color_mode") == "color" else "B&W"
        copies = j.get("copies", 1) or 1
        pages = j.get("total_pages", 1) or 1
        sel = j.get("selected_pages", "")
        bits = ["%d Page%s" % (pages, "" if pages == 1 else "s"), color,
                "Copies: %d" % copies]
        if sel:
            bits.append("Pages: %s" % sel)
        steps = [
            {"label": "File Received", "icon": _IC_FILE,
             "chip": "#DBEAFE", "fg": "#2563EB", "state": _ST_WAIT, "time": ""},
            {"label": "Waiting for Admin" if counter else "Payment Verified",
             "icon": _IC_CLOCK if counter else _IC_CARD,
             "chip": "#FEF3C7" if counter else "#DCFCE7",
             "fg": "#B45309" if counter else "#16A34A",
             "state": _ST_WAIT, "time": ""},
            {"label": "Now Printing", "icon": _IC_PRINT,
             "chip": "#EDE9FE", "fg": "#7C3AED", "state": _ST_WAIT, "time": ""},
            # NOTE: the order is deliberate — in the code the local temp file is deleted
            # FIRST, then complete is sent to the server.
            # The mockup had it the other way round; this shows what REALLY happens.
            {"label": "Local Temp File Deleting", "icon": _IC_TRASH,
             "chip": "#CFFAFE", "fg": "#0891B2", "state": _ST_WAIT, "time": ""},
            {"label": "File Deleting from Server", "icon": _IC_CLOUD,
             "chip": "#E0E7FF", "fg": "#4F46E5", "state": _ST_WAIT, "time": ""},
            {"label": "Job Completed", "icon": _IC_TICK,
             "chip": "#DCFCE7", "fg": "#16A34A", "state": _ST_WAIT, "time": ""},
        ]
        if counter:
            head = {"title": "Cash Mode", "accent": "#B45309", "bg": "#FFFBEB",
                    "chip_bg": "#FDE68A", "icon": _IC_CARD,
                    "badge_top": "WAITING", "badge_sub": "Needs the owner's approval"}
        else:
            head = {"title": "Online Mode - Paid", "accent": "#16A34A", "bg": "#F0FDF4",
                    "chip_bg": "#BBF7D0", "icon": _IC_CARD,
                    "badge_top": "PAID", "badge_sub": "Auto Print"}
        st = {"job_id": str(j.get("id", "-"))[:30],
              "file": str(j.get("file_name", "file"))[:38],
              "amount": "Rs %s  |  %s" % (j.get("amount", 0), " | ".join(bits)),
              "steps": steps, "btn_a": None,
              "btn_b": {"id": "close", "text": "Close", "bg": "#FFFFFF",
                        "bd": "#D6D3D1", "fg": "#1C1917"},
              "agent": "Online", "agent_c": "#16A34A",
              "server": "Connected", "server_c": "#16A34A",
              "close_in": None}
        st.update(head)
        return st

    # ── small helpers ──
    def _now(self):
        return datetime.now().strftime("%I:%M:%S %p").lstrip("0")

    def step(self, n, state, label=None, stamp=True, icon=None):
        """Change the state of step n (1..6). push() still has to be called."""
        try:
            s = self.s["steps"][n - 1]
            s["state"] = state
            if label:
                s["label"] = label
            if icon:
                s["icon"] = icon
            if stamp and state in (_ST_DONE, _ST_FAIL, _ST_RUN) and not s["time"]:
                s["time"] = self._now()
            elif stamp and state in (_ST_DONE, _ST_FAIL):
                s["time"] = self._now()
        except Exception:
            pass
        return self

    def head(self, **kw):
        try:
            self.s.update(kw)
        except Exception:
            pass
        return self

    def buttons(self, a=None, b=None):
        try:
            self.s["btn_a"] = a
            if b:
                self.s["btn_b"] = b
        except Exception:
            pass
        return self

    def push(self):
        """Write the state file atomically (the whole state, every time)."""
        if not self.alive:
            return
        try:
            tmp = self.state_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.s, fh)
            for _ in range(4):
                try:
                    os.replace(tmp, self.state_file)
                    return
                except OSError:
                    time.sleep(0.03)
            # It still failed after 4 attempts — give up. The next push sends the whole
            # state again, so nothing is lost.
            try:
                os.unlink(tmp)
            except Exception:
                pass
        except Exception:
            pass

    # ── start / stop the window ──
    def open(self):
        global _JOBWIN_OK
        if _JOBWIN_OK is False:
            return False
        try:
            if not _jobwin_write_assets():
                _JOBWIN_OK = False
                return False
            for p in (self.state_file, self.result_file):
                try:
                    if os.path.exists(p):
                        os.unlink(p)
                except Exception:
                    pass
            self.alive = True
            self.push()
            self.proc = subprocess.Popen(
                ["powershell", "-NoProfile", "-NonInteractive", "-STA",
                 "-ExecutionPolicy", "Bypass", "-File", _JOBWIN_PS1,
                 self.state_file, self.result_file,
                 _JOBWIN_PS1[:-4] + ".xaml"],
                env=_child_env(), close_fds=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return True
        except Exception as e:
            self.alive = False
            _JOBWIN_OK = False
            log(f"Could not open the live job window ({e}) - the old popup will be used", "WARN")
            return False

    def _read_result(self):
        """
        Read the button's answer.

        NOTE: "utf-8-sig" is used here and \ufeff is stripped on top of that.
        Reason — PowerShell's [Text.Encoding]::UTF8 put a BOM at the start of
        the file, and Python's .strip() does not treat a BOM as whitespace.
        So "reject" was never equal to "reject", and every
        Reject turned into "the window was closed" and the job went back to the queue.
        The .ps1 no longer writes a BOM at all, but an old window may still be running,
        so it is handled on both sides.
        """
        try:
            if os.path.exists(self.result_file):
                with open(self.result_file, "r", encoding="utf-8-sig") as fh:
                    v = fh.read()
                v = v.replace("\ufeff", "").strip()
                if v:
                    return v
        except Exception:
            pass
        return None

    def decide(self, timeout=600):
        """
        Wait for the owner's button.
        "approve" / "reject" / None (the window was closed or never ran).
        """
        global _JOBWIN_OK
        if not self.alive:
            return None
        end = time.time() + timeout
        while time.time() < end:
            v = self._read_result()
            if v:
                if v.startswith("ERROR"):
                    _JOBWIN_OK = False
                    self.alive = False
                    log(f"The live job window does not run on this PC ({v[:60]}) - "
                        f"the old popup will be used", "WARN")
                    return None
                if v == "CLOSED":
                    self._decided = None
                    return None
                self._decided = v
                return v
            if self.proc is not None and self.proc.poll() is not None:
                # PowerShell died without answering
                v = self._read_result()
                if not v or v.startswith("ERROR"):
                    _JOBWIN_OK = False
                    self.alive = False
                    return None
                return v
            time.sleep(0.15)
        log("No answer came from the live job window within 10 min", "WARN")
        return None

    def done_and_close(self, seconds=8):
        """Send the final state and let the window close itself."""
        try:
            self.s["close_in"] = seconds
            self.push()
        except Exception:
            pass
        self.alive = False

    def kill(self):
        try:
            if self.proc is not None and self.proc.poll() is None:
                self.proc.terminate()
        except Exception:
            pass
        self.alive = False
        for p in (self.state_file, self.result_file):
            try:
                if os.path.exists(p):
                    os.unlink(p)
            except Exception:
                pass

    def fail_rest(self, msg="Job Failed"):
        """
        Close whatever steps are still open and say goodbye to the window.

        This runs from process_job()'s `finally`, so whichever way the job
        leaves — download failure, server refusal, or an exception —
        the window is never left hanging half-finished.
        """
        try:
            for s in self.s["steps"]:
                if s["state"] == _ST_RUN:
                    s["state"] = _ST_FAIL
                    s["time"] = self._now()
                elif s["state"] == _ST_WAIT:
                    s["state"] = _ST_SKIP
            last = self.s["steps"][-1]
            last["state"] = _ST_FAIL
            last["label"] = msg
            last["time"] = self._now()
            self.head(badge_top="FAILED", badge_sub=str(msg)[:26],
                      accent="#DC2626", bg="#FEF2F2", chip_bg="#FECACA")
            self.buttons(a=None, b=_BTN_CLOSE)
            self.done_and_close(12)
        except Exception:
            pass


# When there is no decision to make — only "Close".
_BTN_CLOSE = {"id": "close", "text": "Close", "bg": "#FFFFFF",
              "bd": "#D6D3D1", "fg": "#1C1917"}

# The window of the job that is running right now. It is cleared in
# process_job()'s finally, so the window closes whichever way the job
# leaves. Jobs run one at a time (sequentially in print_loop),
# so one is enough.
_CURRENT_JOBWIN = None

# ══════════════════════════════════════════════════════════════════
# COUNTER-PAYMENT APPROVAL POPUP
# For counter (cash) jobs the customer has NOT paid yet —
# the system used to print immediately. Now there is a popup on the owner's PC:
# look at the details, collect the cash, press Approve — then it prints. Deny = the job is cancelled + the file deleted.
# FAIL-OPEN: if the popup cannot be created for some reason, the job prints —
# a technical problem with the popup must not stop the business.
# ══════════════════════════════════════════════════════════════════
def ask_backside():
    """
    Manual duplex: the front side has printed — now ask the owner whether the
    pages have been turned over and put back in the tray.

    Windows' own dialog. This used to be a tkinter window that did not open
    when Tcl was missing; then the even pages printed straight away and came out
    on separate sheets, wasting paper.
    """
    return _ask_backside_native()

def ask_approval(job):
    """
    Approval for a counter order — Windows' own dialog.

    This gate is about MONEY: the customer will pay cash at the counter, so it
    must not print without the owner's OK. This used to be a tkinter window,
    and when Tcl failed the log only said "Approval popup failed".
    Now it is the dialog that works on every Windows installation.
    """
    return _ask_approval_native(job)

def process_job(job):
    """
    A wrapper with the in-flight guard. _process_job_inner does the real work.
    Cleanup in finally — whether the print succeeds, fails or raises —
    a job ID never stays stuck in the "running right now" list.
    """
    global _CURRENT_JOBWIN
    job_id = job.get("id", "unknown")
    try:
        return _process_job_inner(job)
    except Exception as e:
        log(f"❌ Job {job_id} crashed: {e}", "ERROR")
        try:
            mark_failed(job_id, str(e)[:180])
        except Exception:
            pass
    finally:
        _inflight_jobs.discard(job_id)
        # Whichever way the job left — download failure, server refusal,
        # or an exception — the live window must not be left hanging half-finished.
        _w = _CURRENT_JOBWIN
        _CURRENT_JOBWIN = None
        if _w is not None:
            try:
                if _w.alive:
                    _w.fail_rest()
            except Exception:
                pass


def _process_job_inner(job):
    job_id  = job.get("id", "unknown")
    # DUPLICATE PRINT GUARD — the server has claimed the job, but after an agent
    # restart or a stuck-job requeue the same job can arrive again.
    # The customer paid for one print, not two.
    if already_processed(job_id):
        log(f"⏭️  Job {job_id} already printed earlier — skipping (duplicate)")
        try:
            mark_complete(job_id)
        except Exception:
            pass
        return
    # The server sent this job again while it is still printing
    # (a large PDF taking more than 45s). Skip it — it must not come out twice.
    if job_id in _inflight_jobs:
        log(f"⏭️  Job {job_id} is still printing — not taking it again")
        return
    _inflight_jobs.add(job_id)
    url     = job.get("file_url")
    copies  = job.get("copies", 1)
    color   = job.get("color_mode", "bw")
    ext     = job.get("file_type", "pdf")
    fname   = job.get("file_name", f"print.{ext}")
    pages   = job.get("total_pages", 1)
    paper   = job.get("paper_size", "a4")
    amount  = job.get("amount", 0)
    selected_pages = job.get("selected_pages", "")

    # If the shop has set a specific B&W/Color printer (from Super Admin/
    # the Dashboard), the right printer is chosen from the job's color_mode
    # — IGNORING the system default printer. If it is not
    # set (an empty string), None is passed and the old default-printer
    # behaviour applies (backward compatible, nothing breaks).
    printer_name_bw = job.get("printer_name_bw", "") or None
    printer_name_color = job.get("printer_name_color", "") or None
    printer_name_4x6 = job.get("printer_name_4x6", "") or None
    printer_name_a3 = job.get("printer_name_a3", "") or None
    printer_name_duplex = job.get("printer_name_duplex", "") or None
    # ── ROUTING PRECEDENCE ──
    # 1. The paper-special printer (4x6 photo / A3-A2-A1 large) if the shop has set one
    # 2. The duplex printer — a two-sided job, when the shop has set a separate printer
    # 3. Otherwise color/bw routing (as before)
    #
    # The paper size is a HARD LIMIT of the printer, duplex is only a convenience —
    # so the A3/4x6 printer WINS over duplex. An A3 sheet will not even fit into
    # a smaller printer, even if that one has duplex.
    _paper = (job.get("paper_size", "a4") or "a4").lower()
    if _paper == "4x6" and printer_name_4x6:
        target_printer = printer_name_4x6
        log(f"   📷 4x6 photo job — special printer: {printer_name_4x6}")
    elif _paper in ("a3", "a2", "a1") and printer_name_a3:
        target_printer = printer_name_a3
        log(f"   📐 {_paper.upper()} large job — special printer: {printer_name_a3}")
    elif bool(job.get("duplex")) and printer_name_duplex:
        target_printer = printer_name_duplex
        log(f"   📄 Duplex job — duplex printer: {printer_name_duplex}")
    else:
        target_printer = printer_name_bw if color == "bw" else printer_name_color

    # ── COUNTER APPROVAL GATE ── online-paid jobs print directly (the money has
    # already arrived); only counter jobs ask the owner
    log(f"📄 Job {job_id}: {color.upper()} | copies={job.get('copies',1)} | "
        f"BW-printer='{printer_name_bw or 'default'}' | Color-printer='{printer_name_color or 'default'}' | "
        f"target='{target_printer or 'DEFAULT PRINTER'}'")

    # ── LIVE JOB WINDOW ──
    # One job, one window. If it does not open, everything runs exactly as before
    # (the old MessageBox approval + log) — printing never stops.
    global _CURRENT_JOBWIN
    win = JobWindow(job)
    if not win.open():
        win = None
    _CURRENT_JOBWIN = win
    if win:
        win.step(1, _ST_DONE).push()

    if job.get("payment_method") == "counter" and approval_enabled():
        update_tray_status("Counter order — waiting for approval")

        ans = None
        if win:
            win.step(2, _ST_RUN)
            win.head(badge_top="WAITING", badge_sub="Waiting for your approval")
            win.buttons(
                a={"id": "approve", "text": "Approve and Print",
                   "bg": "#16A34A", "bd": "#15803D", "fg": "#FFFFFF"},
                b={"id": "reject", "text": "Reject Job",
                   "bg": "#FFFFFF", "bd": "#FCA5A5", "fg": "#DC2626"})
            win.push()
            got = win.decide(timeout=600)
            if got == "approve":
                ans = True
            elif got == "reject":
                ans = False
            elif not win.alive:
                # The window could not run on this PC — the old path
                win = None
                _CURRENT_JOBWIN = None
                ans = ask_approval(job)
        else:
            ans = ask_approval(job)

        if ans is None:
            log(f"⏸️ Approval window closed without a response — job {job_id} will come back later")
            if win:
                win.kill()
                _CURRENT_JOBWIN = None
            return
        if ans is False:
            log(f"❌ The owner DENIED — job {job_id} cancelled")
            if win:
                win.head(title="Cash Mode - Denied", accent="#DC2626", bg="#FEF2F2",
                         chip_bg="#FECACA", badge_top="DENIED", badge_sub="Job Rejected")
                win.step(2, _ST_FAIL, label="Admin Denied", icon=_IC_CROSS)
                win.step(3, _ST_SKIP, stamp=False)
                win.step(4, _ST_SKIP, stamp=False)
                win.step(5, _ST_RUN)
                win.buttons(a=None, b=_BTN_CLOSE)
                win.push()
            _srv_ok = mark_failed(job_id, "Shop owner declined the counter order")
            if win:
                win.step(5, _ST_DONE if _srv_ok else _ST_FAIL)
                win.step(6, _ST_FAIL, label="Job Rejected")
                win.done_and_close()
                _CURRENT_JOBWIN = None
            return
        log(f"✅ Owner approved — job {job_id} is printing")
        if win:
            win.head(title="Cash Mode - Accepted", badge_top="ACCEPTED",
                     badge_sub="Now Printing")
            win.step(2, _ST_DONE, label="Admin Accepted", icon=_IC_USER)
            win.buttons(a=None, b=_BTN_CLOSE)
            win.push()
    elif win:
        # An online-paid job (or approval is off) — the money has already arrived
        win.step(2, _ST_DONE).push()

    log(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log(f"📄 Job: {job_id}")
    log(f"   File: {fname}")
    log(f"   Pages: {pages} | Copies: {copies} | {color.upper()} | ₹{amount}")
    if selected_pages:
        log(f"   Specific Pages Requested: {selected_pages}")
    if target_printer:
        log(f"   🎯 Target Printer ({color.upper()}): {target_printer}")

    # Get the authorized download URL from the server. The server only returns the URL —
    # the PDF comes STRAIGHT from Cloudinary to this PC, not through Render.
    signed_url, blocked = get_download_url(job_id, url)
    if blocked:
        log(f"❌ Server refused this job: {blocked}", "ERROR")
        mark_failed(job_id, blocked)
        return
    url = signed_url or url

    if not url:
        log("❌ No file URL!", "ERROR")
        mark_failed(job_id, "No URL")
        return

    filepath = download_file(url, ext)
    if not filepath:
        report_download(job_id, False, err="download failed")
        mark_failed(job_id, "Download failed")
        return
    report_download(job_id, True, os.path.getsize(filepath))

    file_size = os.path.getsize(filepath)
    if file_size < 100:
        log(f"❌ File empty: {file_size} bytes", "ERROR")
        os.unlink(filepath)
        mark_failed(job_id, "Empty file")
        return

    _dup_on   = bool(job.get("duplex"))
    _dup_mode = job.get("duplex_mode", "") or ""
    if selected_pages:
        _dup_pages = len([p for p in str(selected_pages).replace(' ', '').split(',') if p])
    else:
        _dup_pages = int(job.get("total_pages", 1) or 1)
    if win:
        win.step(3, _ST_RUN).push()

    success = print_file(filepath, copies, color, selected_pages, target_printer,
                         duplex_on=_dup_on, duplex_mode=_dup_mode, duplex_pages=_dup_pages,
                         paper_size=job.get("paper_size", "a4") or "a4",
                         total_pages=job.get("total_pages", 0))

    if win:
        win.step(3, _ST_DONE if success else _ST_FAIL)
        win.step(4, _ST_RUN).push()

    try:
        time.sleep(3)
        if os.path.exists(filepath):
            os.unlink(filepath)
            log("🗑️  Local file deleted")
    except:
        pass

    if win:
        win.step(4, _ST_DONE)
        win.step(5, _ST_RUN).push()

    if success:
        _srv_ok = mark_complete(job_id)
        log(f"🎉 Job {job_id} DONE!")
        if win:
            win.step(5, _ST_DONE if _srv_ok else _ST_FAIL)
            win.step(6, _ST_DONE, label="Job Completed")
            win.head(badge_sub="Completed")
            win.done_and_close()
            _CURRENT_JOBWIN = None
    else:
        mark_failed(job_id, "Print failed")
        log(f"❌ Job {job_id} failed!", "ERROR")
        if win:
            win.step(5, _ST_DONE)
            win.fail_rest("Print Failed")
            _CURRENT_JOBWIN = None

def check_dependencies():
    if is_running_as_exe():
        # This used to print just one hardcoded line: "everything ready (bundled)".
        # That was a LIE — nothing was checked at all. On 22 Aug the Crypto .pyd
        # was missing and the log still said "ready", so finding the real cause
        # took a long time. Now the imports are actually checked.
        log("🔍 Checking dependencies... (.exe mode)")
        ok, bad = [], []
        for label, mod in (("Pillow", "PIL.Image"),
                           ("win32print", "win32print"),
                           ("PyPDF2", "PyPDF2"),
                           ("PyCryptodome", "Crypto.Cipher.AES"),
                           ("pystray", "pystray")):
            try:
                __import__(mod)
                ok.append(label)
            except Exception as e:
                bad.append("%s (%s)" % (label, type(e).__name__))
        if ok:
            log("✅ " + ", ".join(ok) + " — ready (bundled)")
        if bad:
            log("❌ Problem in the bundle: " + ", ".join(bad), "ERROR")
            log("   Close the agent and start it again — the bundle will be unpacked again.",
                "ERROR")
        return

    log("🔍 Dependencies check...")
    try:
        from PIL import Image
        log("✅ Pillow (image→PDF) ready")
    except ImportError:
        log("⚠️  Pillow not found! Installing...", "WARN")
        os.system("pip install Pillow --quiet")
        try:
            from PIL import Image
            log("✅ Pillow installed!")
        except:
            log("❌ Pillow could not be installed — JPG/PNG printing will not work!", "ERROR")
    try:
        import win32print
        log("✅ win32print ready")
    except ImportError:
        log("⚠️  win32print not found! Run: pip install pywin32", "WARN")
    try:
        from PyPDF2 import PdfReader
        log("✅ PyPDF2 (page range) ready")
    except ImportError:
        log("⚠️  PyPDF2 not found! Installing...", "WARN")
        os.system("pip install PyPDF2 --quiet")
    try:
        import Crypto  # noqa
        log("✅ PyCryptodome (encrypted PDF) ready")
    except ImportError:
        log("⚠️  PyCryptodome not found! Installing...", "WARN")
        os.system("pip install pycryptodome --quiet")
        try:
            import Crypto  # noqa
            log("✅ PyCryptodome installed!")
        except:
            log("❌ PyCryptodome could not be installed — page extraction may fail for some PDFs!", "ERROR")
    try:
        import pystray
        log("✅ pystray (System Tray) ready")
    except ImportError:
        log("⚠️  pystray not found! Installing...", "WARN")
        os.system("pip install pystray --quiet")
        try:
            import pystray
            log("✅ pystray installed!")
        except:
            log("⚠️  pystray could not be installed — tray mode will not work, using console mode", "WARN")

# ─── DESKTOP CONTROL PANEL (optional UI layer) ──────────────────────
# Even if the panel does not open, the agent works completely — printing, tray,
# auto-update, everything as before. So an import failure is swallowed here.
PANEL = None
try:
    import agent_panel as PANEL
    PANEL.bind(sys.modules[__name__])
except Exception as _panel_err:
    PANEL = None

def switch_shop_id_live(new_shop_id):
    """
    Change the Shop ID WHILE RUNNING — without restarting the process.

    Why no restart: the old restart flow is exactly what produced the _MEI crash
    (Phase 0). Showing that crash to a customer during the conversion would be the
    worst possible experience. SHOP_ID is a module-level variable, so
    it is updated through globals() and the config file is written atomically.
    """
    global SHOP_ID
    old = SHOP_ID

    # IMPORTANT: the conversion has already happened on the server — the agent token has
    # already moved to the paid shop. If we stopped here now, the PC would stay stuck
    # on the old demo ID and printing would stop.
    # So: switch in MEMORY first (printing continues immediately), write the
    # file afterwards — if the file fails, the only problem is "it will not be
    # remembered after a restart"; printing does not stop.
    SHOP_ID = new_shop_id

    saved = False
    try:
        # Atomic write — so the config is not corrupted if the power goes out midway
        tmp = SHOP_CONFIG_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(new_shop_id)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, SHOP_CONFIG_FILE)
        saved = True
    except Exception as e:
        log(f"Shop ID switched in memory but could not be saved to disk: {e}", "ERROR")
        log(f"   After a restart this PC may ask for the Shop ID again — enter: {new_shop_id}", "WARN")
    # The processed-job records of the old demo are useless now
    try:
        _processed_jobs.clear()
        _save_processed()
    except Exception:
        pass

    agent_state["connection"] = "connecting"
    agent_state["reconnect_requested"] = True      # poll immediately with the new shop
    log(f"✅ Shop switched: {old} → {new_shop_id}" + ("" if saved else " (not saved to disk)"))
    try:
        report_printers_to_server()
    except Exception:
        pass
    update_tray_status("Running — waiting for jobs")
    return True if saved else "memory-only"


def is_demo_shop():
    """
    Demo or paid — the SERVER says so; it is not guessed from the Shop ID text
    (spec: backend is the source of truth). If the server cannot be reached, False —
    showing nothing is better than showing a demo prompt to a paid shop by mistake.
    """
    try:
        if PANEL is not None:
            return PANEL.shop_type() == "demo"
    except Exception:
        pass
    return False


def open_upgrade_panel(icon=None, item=None):
    """
    The tray's '⚡ Change Demo ID to Paid Shop'.

    If the panel window can be created, that (nicer) flow is used. If not — as on
    PCs without WebView2 — the same job is done with Windows' own dialogs.
    This used to show only "Please open Settings...",
    while Settings did not even open; the demo shop was stuck right there.
    """
    panel_up = False
    try:
        panel_up = (PANEL is not None
                    and getattr(PANEL, "_window", None) is not None)
    except Exception:
        panel_up = False

    if panel_up:
        try:
            PANEL.open_panel(page="upgrade")
            return
        except Exception as e:
            log(f"The upgrade page did not open ({e}) — falling back to the Windows dialog",
                "WARN")

    # In a separate thread — the tray menu callback must not block
    threading.Thread(target=convert_demo_to_paid_native, daemon=True).start()


def open_panel(icon=None, item=None):
    """The tray's '⚙ Settings' — open the desktop panel."""
    if PANEL is None:
        _msgbox("The desktop panel is not available in this build.\n\n"
                "Your Print Agent is running normally and printing is unaffected.",
                "Echel")
        return
    try:
        PANEL.open_panel()
    except Exception as e:
        log(f"Panel open failed: {e} — agent continues normally", "ERROR")

# ─── AUTO-UPDATE: check with the server whether there is a new version ──────
def get_remote_version():
    """Fetch the latest agent version number from the server"""
    try:
        resp = requests.get(f"{SERVER_URL}/api/agent/version", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        v = data.get("version")
        # A new server also sends a display label ("2.1"). An old server does not —
        # then leave it None and keep showing our own label.
        global REMOTE_VERSION_LABEL, REMOTE_VERSION_INT
        try:
            REMOTE_VERSION_INT = int(v) if v is not None else 0
        except Exception:
            REMOTE_VERSION_INT = 0
        lbl = data.get("versionLabel") or data.get("displayVersion")
        REMOTE_VERSION_LABEL = lbl if (isinstance(lbl, str) and _VERSION_LABEL_RE.match(lbl.strip())) else None
        # If the server sends a string ("7"), comparing it with int(6) raises TypeError —
        # and the update silently never triggers. Coerce to int.
        return int(v) if v is not None else None
    except Exception as e:
        log(f"⚠️  Version check failed: {e}", "WARN")
        return None

def remote_label_or(fallback_int):
    """Show the server's label; if there is none, show the internal number."""
    return REMOTE_VERSION_LABEL or f"{fallback_int}"

def download_latest_agent():
    """Download the new print_agent.py code from the server"""
    try:
        resp = requests.get(f"{SERVER_URL}/api/agent/download-latest", timeout=30)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        log(f"❌ Could not download the new agent: {e}", "ERROR")
        return None

def apply_update_and_restart(new_code=None):
    """
    In source (.py) mode: fill the new code with the current SHOP_ID/SERVER_URL,
    replace print_agent.py, then restart.

    In .exe mode: replacing the .py source would not work (the exe is already
    compiled), so instead the new installer .exe is downloaded and
    run — it replaces the old one itself and restarts.
    """
    if is_running_as_exe():
        apply_exe_update_and_restart()
        return

    try:
        # Fill the placeholder in the new code with the current Shop ID/Server URL
        new_code = new_code.replace('YOUR_SHOP_ID', SHOP_ID)
        new_code = new_code.replace(
            'SERVER_URL         = "https://echel.in"',
            f'SERVER_URL         = "{SERVER_URL}"'
        )

        current_file = os.path.abspath(__file__)
        backup_file = current_file + ".backup"

        # Keep a backup of the old file (so it can be used again if something goes wrong)
        shutil.copy2(current_file, backup_file)

        with open(current_file, 'w', encoding='utf-8') as f:
            f.write(new_code)

        log("✅ New code installed! Restarting the agent...")

        # Restart ourselves — run the same script in a new Python process.
        # pythonw.exe is forced so that no console window opens after the restart
        # either (whether this process was started with pythonw or python)
        python_exe = sys.executable
        pythonw_exe = python_exe.replace('python.exe', 'pythonw.exe')
        if not os.path.exists(pythonw_exe):
            pythonw_exe = python_exe  # fallback if pythonw was not found

        _spawn_detached([pythonw_exe, current_file], cwd=os.path.dirname(current_file))
        time.sleep(2.0)   # give the new process time to start

        # Close the tray icon and exit this old process
        if agent_state["tray_icon"]:
            agent_state["tray_icon"].stop()
        os._exit(0)
    except Exception as e:
        log(f"❌ Error while applying the update: {e}", "ERROR")

def download_installer(progress_cb=None):
    """
    Download the new installer. progress_cb(percent_or_None, mb_done)
    is called for every chunk. Returns: the installer path or (None, error_msg).
    """
    resp = requests.get(f"{SERVER_URL}/api/agent/download-latest-exe", timeout=120, stream=True)
    if resp.status_code == 404:
        return None, "No new installer has been uploaded to the server (inform the Super Admin)"
    resp.raise_for_status()

    total = int(resp.headers.get('content-length') or 0)
    # FIX [Errno 13]: with a fixed filename, an old installer that was locked/held by antivirus
    # made every following download fail (both auto + manual). Now every download gets a
    # unique name + old installers are cleaned up best-effort.
    try:
        for old_f in os.listdir(tempfile.gettempdir()):
            if old_f.startswith("EchelPrint-Update-") and old_f.endswith(".exe"):
                try: os.remove(os.path.join(tempfile.gettempdir(), old_f))
                except Exception: pass
    except Exception:
        pass
    installer_path = os.path.join(tempfile.gettempdir(), f"EchelPrint-Update-{int(time.time())}.exe")
    done = 0
    with open(installer_path, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                f.write(chunk)
                done += len(chunk)
                if progress_cb:
                    pct = int(done * 100 / total) if total else None
                    progress_cb(pct, done / 1048576)
    if done < 100_000:  # <100KB = not an installer, some error page
        return None, "The downloaded file does not look like an installer (too small) — check the installer URL"
    return installer_path, None

def _is_windows_exe(path):
    """Is the downloaded file really a Windows program? (MZ header)"""
    try:
        with open(path, "rb") as f:
            return f.read(2) == b"MZ"
    except Exception:
        return False


def run_installer_and_exit(new_exe_path):
    """
    Put the new build in place of the OLD exe and start it from there.

    ⚠️ This used to pass Inno Setup switches (/VERYSILENT ...).
    But the file the server sends is not an installer at all — it is the agent's
    own PyInstaller exe. It silently ignored those switches,
    ran from TEMP, and even wrote the autostart pointing at the TEMP
    path. As soon as temp was cleaned, that path broke — which is why the update
    "downloaded but never installed".

    Now a small .bat does the work:
      * it keeps trying to copy — while the old exe is running
        the file stays locked and the copy fails. As soon as it exits,
        the copy goes through. So there is no need to
        "wait for the process" separately.
      * after the replacement it starts the new exe FROM THE SAME PLACE.
      * it always writes its own log, so a failure can be traced.
    """
    if not is_running_as_exe():
        log("Self-update only works in the .exe build — skipped in script mode", "WARN")
        return
    if not _is_windows_exe(new_exe_path):
        log("❌ The downloaded file does not look like a Windows program — update stopped", "ERROR")
        return

    target = os.path.abspath(sys.executable)      # where we are running from right now
    bat = os.path.join(tempfile.gettempdir(), f"qsp-update-{int(time.time())}.bat")
    upd_log = os.path.join(_APPDATA_DIR, "update_log.txt")

    # ⚠️ DO NOT WRITE PATHS INSIDE the .bat — cmd.exe reads the file in the ANSI
    # codepage. On a shop PC whose username is in Hindi/Bengali/Tamil script,
    # %TEMP% and %APPDATA% are in that script too, and the path turns into
    # garbage as soon as it is written into the file. So all three paths are
    # passed as arguments (%~1 %~2 %~3) — Windows passes arguments in Unicode,
    # and the .bat's own text stays clean ASCII.
    #
    # We wait with `ping`, not `timeout` — in a process without a console,
    # timeout fails with "input redirection is not supported" and exits immediately.
    script = "\r\n".join([
        "@echo off",
        "set N=0",
        ":try",
        'copy /Y "%~1" "%~2" >nul 2>&1',
        "if not errorlevel 1 goto ok",
        "ping -n 3 127.0.0.1 >nul",
        "set /a N+=1",
        "if %N% LSS 40 goto try",
        'echo [%date% %time%] UPDATE FAIL - "%~2" was not replaced>>"%~3"',
        "goto clean",
        ":ok",
        'echo [%date% %time%] UPDATE OK - "%~2">>"%~3"',
        'start "" "%~2"',
        ":clean",
        'del /f /q "%~1" >nul 2>&1',
        'del /f /q "%~f0" >nul 2>&1',
    ]) + "\r\n"
    try:
        with open(bat, "w", encoding="ascii", newline="") as f:
            f.write(script)
    except Exception as e:
        log(f"❌ Could not create the update helper: {e}", "ERROR")
        return

    log(f"🔄 Applying the update — {target}")
    try:
        _spawn_detached(["cmd", "/c", bat, new_exe_path, target, upd_log])
    except Exception as e:
        log(f"❌ The update helper did not run: {e}", "ERROR")
        return

    time.sleep(1)
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def apply_exe_update_and_restart():
    """Auto-update path (hourly loop) — silent, no UI."""
    try:
        log("⬇️  Downloading the new installer...")
        installer_path, err = download_installer()
        if err:
            log(f"❌ {err}", "ERROR")
            return
        log(f"✅ Installer downloaded: {installer_path}")
        run_installer_and_exit(installer_path)
    except Exception as e:
        log(f"❌ Error while applying the .exe update: {e}", "ERROR")

# ─── MANUAL UPDATE CHECK (from the tray menu) ──────────────────────────────
# The auto loop swallows errors silently — this window SHOWS everything:
# the server version, the download %, and the exact error. Update problems
# can be diagnosed at any shop without opening the logs.
def manual_update_check(icon=None, item=None):
    threading.Thread(target=_manual_update_ui, daemon=True).start()

def _msgbox(text, title="Echel", flags=0x40):
    """Windows message box via ctypes — needs no Tkinter/Tcl."""
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, title, flags)
    except Exception:
        pass


# ══════════════════════════════════════════════════════════════
#  WINDOWS' OWN DIALOGS
#
#  EVERY popup of the agent is now built here - user32's MessageBoxW and
#  a PowerShell WinForms box. No tkinter.
#
#  Why: popups used to be built with tkinter. The tkinter MODULE made it into
#  the exe, but its Tcl DATA (init.tcl etc.) did not. Then
#  `import tkinter` SUCCEEDED and the error only appeared at tk.Tk():
#      "Can't find a usable init.tcl"
#  That is exactly what a shop's log showed, and worst of all, the very first
#  Shop ID popup did not open either - so a new install never started at all.
#
#  MessageBoxW is part of Windows itself. It never has to be bundled
#  and it is never missing.
# ══════════════════════════════════════════════════════════════




# ══════════════════════════════════════════════════════════════
#  LARGE DIALOG  (PowerShell + WinForms)
#
#  MessageBoxW is small and its font cannot be changed. In a shop the
#  approval popup appears dozens of times a day and has to be read from the
#  counter — so it gets its own, larger dialog.
#
#  This is ONLY a visual upgrade. If PowerShell does not run, _native_yesno()
#  silently falls back to the old MessageBoxW, so reliability stays exactly
#  what it was.
# ══════════════════════════════════════════════════════════════
_PS_DIALOG_OK = None          # None = not tried yet, False = does not work
_PS_DIALOG_FAILS = 0          # how many times in a row it failed (disabled for good at 3)


def _ps_dialog(title, big, sub, rows, yes_label=None, no_label=None,
               accent="#16a34a", timeout=600):
    """
    Show the large dialog.

    title      : the window name
    big        : large text at the very top (such as "Rs 150") — may be empty
    sub        : one line below the large text
    rows       : [(label, value), ...] — monospaced, columns aligned
    yes_label  : text of the Yes button. None = a single OK button only
    no_label   : text of the No button

    Returns True (yes/ok) / False (no) / None (the dialog was not created)
    """
    global _PS_DIALOG_OK, _PS_DIALOG_FAILS
    if _PS_DIALOG_OK is False:
        return None                       # it has failed before — do not waste time

    ps1 = None
    try:
        import tempfile

        def q(v):                          # a PowerShell single-quoted string
            return str(v).replace("'", "''")

        # Pad the rows for monospace — tabs are not built in PowerShell;
        # they are aligned in Python directly.
        pad = max([len(str(a)) for a, _ in rows] or [0])
        body = "\n".join("%s  %s" % (str(a).ljust(pad), b) for a, b in rows)

        height = 210 + (len(rows) * 22) + (46 if big else 0) + (22 if sub else 0)
        two = yes_label is not None and no_label is not None

        script = """
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$f = New-Object System.Windows.Forms.Form
$f.Text = '__TITLE__'
$f.Size = New-Object System.Drawing.Size(540,__H__)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true
$f.BackColor = [System.Drawing.Color]::White
$y = 18
__BIG__
__SUB__
__BODY__
$btnY = __H__ - 108
if (__TWO__) {
  $b1 = New-Object System.Windows.Forms.Button
  $b1.Text = '__YES__'
  $b1.Font = New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
  $b1.Size = New-Object System.Drawing.Size(170,46)
  $b1.Location = New-Object System.Drawing.Point(150,$btnY)
  $b1.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $f.Controls.Add($b1)
  $b2 = New-Object System.Windows.Forms.Button
  $b2.Text = '__NO__'
  $b2.Font = New-Object System.Drawing.Font('Segoe UI',11)
  $b2.Size = New-Object System.Drawing.Size(170,46)
  $b2.Location = New-Object System.Drawing.Point(330,$btnY)
  $b2.DialogResult = [System.Windows.Forms.DialogResult]::No
  $f.Controls.Add($b2)
  $f.AcceptButton = $b1
  $f.CancelButton = $b2
} else {
  $b1 = New-Object System.Windows.Forms.Button
  $b1.Text = '__YES__'
  $b1.Font = New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
  $b1.Size = New-Object System.Drawing.Size(170,46)
  $b1.Location = New-Object System.Drawing.Point(330,$btnY)
  $b1.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $f.Controls.Add($b1)
  $f.AcceptButton = $b1
}
$f.Add_Shown({$f.Activate()})
$r = $f.ShowDialog()
if ($r -eq [System.Windows.Forms.DialogResult]::No) { [Console]::Out.WriteLine('NO') }
else { [Console]::Out.WriteLine('YES') }
"""
        big_ps = ""
        if big:
            big_ps = ("$lb = New-Object System.Windows.Forms.Label\n"
                      "$lb.Text = '%s'\n"
                      "$lb.Font = New-Object System.Drawing.Font('Segoe UI',26,"
                      "[System.Drawing.FontStyle]::Bold)\n"
                      "$lb.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('%s')\n"
                      "$lb.Location = New-Object System.Drawing.Point(24,$y)\n"
                      "$lb.Size = New-Object System.Drawing.Size(480,44)\n"
                      "$f.Controls.Add($lb)\n"
                      "$y = $y + 46\n" % (q(big), q(accent)))
        sub_ps = ""
        if sub:
            sub_ps = ("$ls = New-Object System.Windows.Forms.Label\n"
                      "$ls.Text = '%s'\n"
                      "$ls.Font = New-Object System.Drawing.Font('Segoe UI',10.5)\n"
                      "$ls.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#475569')\n"
                      "$ls.Location = New-Object System.Drawing.Point(24,$y)\n"
                      "$ls.Size = New-Object System.Drawing.Size(480,22)\n"
                      "$f.Controls.Add($ls)\n"
                      "$y = $y + 24\n" % q(sub))
        # In a PowerShell DOUBLE-quoted string ` $ and " all have their own
        # meaning. A file name can be anything (such as
        # "bill $500.pdf") — without escaping, PowerShell treats $500 as a variable,
        # blanks it, and the dialog shows up incomplete.
        def psq(v):
            return (str(v).replace("`", "``").replace("$", "`$")
                    .replace('"', '`"').replace("\n", "`r`n"))

        body_ps = ("$lt = New-Object System.Windows.Forms.Label\n"
                   "$lt.Text = \"%s\"\n"
                   "$lt.Font = New-Object System.Drawing.Font('Consolas',11)\n"
                   "$lt.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#0f172a')\n"
                   "$lt.Location = New-Object System.Drawing.Point(24,$y)\n"
                   "$lt.Size = New-Object System.Drawing.Size(480,%d)\n"
                   "$f.Controls.Add($lt)\n"
                   % (psq(body), len(rows) * 22 + 8))

        script = (script
                  .replace("__TITLE__", q(title))
                  .replace("__H__", str(height))
                  .replace("__BIG__", big_ps)
                  .replace("__SUB__", sub_ps)
                  .replace("__BODY__", body_ps)
                  .replace("__TWO__", "$true" if two else "$false")
                  .replace("__YES__", q(yes_label or "OK"))
                  .replace("__NO__", q(no_label or "")))

        fd, ps1 = tempfile.mkstemp(suffix=".ps1")
        # The BOM is written by hand (b"\xef\xbb\xbf") - to avoid using the "utf-8-sig"
        # CODEC. That codec lives in base_library.zip and was loaded for the
        # FIRST TIME exactly here; if _MEI had already been cleaned, this very
        # line raised "FileNotFoundError: ...base_library.zip" - the "Large dialog
        # failed" in the screenshot came from this.
        with os.fdopen(fd, "wb") as fh:
            fh.write(b"\xef\xbb\xbf" + script.encode("utf-8"))

        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-File", ps1],
            capture_output=True, text=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

        ans = (out.stdout or "").strip().upper()
        if ans.endswith("YES"):
            _PS_DIALOG_OK = True
            return True
        if ans.endswith("NO"):
            _PS_DIALOG_OK = True
            return False
        # Nothing came back — meaning the dialog was never created
        if _PS_DIALOG_OK is None:
            _PS_DIALOG_OK = False
            log("The large dialog could not be created - MessageBox will be used now "
                f"({(out.stderr or '')[:120]})", "WARN")
        return None
    except Exception as e:
        # A SINGLE failure used to disable the large dialog FOREVER.
        # On 22 Aug a FileNotFoundError came from the _MEI cleanup, and the whole day
        # only the small MessageBox was shown. Now it is disabled only after three failures
        # — so one glitch does not spoil the whole day.
        if _PS_DIALOG_OK is None:
            _PS_DIALOG_FAILS += 1
            log(f"Large dialog failed ({e}) - MessageBox will be used this time "
                f"[{_PS_DIALOG_FAILS}/3]", "WARN")
            if _PS_DIALOG_FAILS >= 3:
                _PS_DIALOG_OK = False
                log("The large dialog failed three times - MessageBox will always be used from now on",
                    "WARN")
        return None
    finally:
        try:
            if ps1 and os.path.exists(ps1):
                os.remove(ps1)
        except Exception:
            pass


# MessageBoxW flags (winuser.h)
_MB_YESNO         = 0x00000004
_MB_ICONQUESTION  = 0x00000020
_MB_SETFOREGROUND = 0x00010000
_MB_TOPMOST       = 0x00040000
_IDYES, _IDNO = 6, 7


def _native_yesno(text, title="Echel"):
    """
    Ask Yes/No without any Tcl - straight through user32.dll's MessageBoxW.
    It is part of Windows itself: nothing to bundle, nothing to install.

    Returns True (Yes) / False (No) / None (the dialog was not created).
    """
    try:
        import ctypes
        r = ctypes.windll.user32.MessageBoxW(
            0, text, title,
            _MB_YESNO | _MB_ICONQUESTION | _MB_SETFOREGROUND | _MB_TOPMOST)
        if r == _IDYES:
            return True
        if r == _IDNO:
            return False
        return None
    except Exception as e:
        log(f"The native MessageBox failed as well: {e}", "ERROR")
        return None


def _ask_approval_native(job):
    """
    The approval box for a counter order.

    Care was taken with the formatting because this popup appears dozens of
    times a day in the shop. MessageBox uses a proportional font,
    so building columns with spaces is pointless — everything goes on its own
    line, with a colon after the label. The AMOUNT is at the very top, because
    that one number is what matters at the counter.
    """
    color  = job.get("color_mode", "bw")
    copies = job.get("copies", 1)
    pages  = job.get("total_pages", 1)
    sel    = job.get("selected_pages", "")
    amount = job.get("amount", 0)
    fname  = job.get("file_name", "file")

    # The server's created_at (ISO/UTC) -> the PC's local time.
    # This used to appear only in the tkinter popup; it was missed in the native
    # one. It helps identify "which order" at the counter.
    tstr = ""
    try:
        from datetime import datetime
        raw = job.get("created_at", "")
        if raw:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            tstr = dt.astimezone().strftime("%I:%M %p")
    except Exception:
        tstr = ""

    mode_txt = "COLOR" if color == "color" else "B&W"
    cop_txt  = f"{copies} copy" if copies == 1 else f"{copies} copies"
    pg_txt   = f"{pages} page" if pages == 1 else f"{pages} pages"

    lines = [
        "COUNTER PAYMENT ORDER",
        "The customer will pay cash at the counter.",
        "",
        f"Amount   :   Rs {amount}",
        f"Print    :   {mode_txt}  -  {pg_txt}  x  {cop_txt}",
    ]
    if sel:
        lines.append(f"Pages    :   {sel}")
    lines.append(f"File     :   {str(fname)[:44]}")
    if tstr:
        lines.append(f"Time     :   {tstr}")
    lines += [
        "",
        "Yes  =  Approve and print",
        "No   =  Decline - cancel the order and delete the file",
    ]

    # The LARGE dialog first. If it cannot be created, the same old MessageBox — just as
    # reliable, only it looks better.
    rows = [("Print", f"{mode_txt}  -  {pg_txt}  x  {cop_txt}")]
    if sel:
        rows.append(("Pages", str(sel)))
    rows.append(("File", str(fname)[:44]))
    if tstr:
        rows.append(("Time", tstr))

    ans = _ps_dialog(
        "Echel - Counter Order",
        big=f"Rs {amount}",
        sub="The customer will pay cash at the counter",
        rows=rows,
        yes_label="Approve and Print",
        no_label="Deny (cancel)")

    if ans is None:
        ans = _native_yesno("\n".join(lines), "Echel - Counter Order")

    if ans is None:
        # The dialog could not be opened in any way. STOPPING the print would also be wrong
        # (the shop would be shut down), so continue - but LOUDLY, not silently.
        log("The approval dialog could not be opened in any way - the job is being printed "
            "WITHOUT approval. Try restarting the agent once.",
            "ERROR")
        try:
            update_tray_status("Approval dialog unavailable - printing without approval")
        except Exception:
            pass
        return True
    return ans


def _ask_backside_native():
    """Back-side prompt — the large dialog first, MessageBox as the fallback."""
    ans = _ps_dialog(
        "Echel - Back Side",
        big="Front side printed",
        sub="Finish printing the other side",
        rows=[("Reload", "Place the printed pages back in the tray"),
              ("Position", "Face the blank side towards the print head"),
              ("Continue", "Select the button below")],
        yes_label="Print back side",
        no_label="Skip back side")
    if ans is not None:
        return ans

    ans = _native_yesno(
        "FRONT SIDE PRINTED\n"
        "\n"
        "Place the printed pages back in the printer tray\n"
        "with the blank side facing the print head.\n"
        "\n"
        "Yes  =  Print the back side now\n"
        "No   =  Keep only the front side",
        "Echel - Back Side")
    if ans is None:
        log("The back-side dialog could not be opened - printing the even pages directly", "WARN")
        return True
    return ans


def bundle_selfcheck():
    """
    Once at startup: write clearly in the log what was really bundled.

    This used to be guesswork. The exe got built, printing even worked
    (because SumatraPDF was installed separately on that PC) and nobody
    noticed that the bundle was empty - until everything failed on some new
    PC.

    The Tcl/Tk check was removed from here — no popup uses Tk
    any more; they all use Windows' own dialogs.
    """
    # The startup notes that were written BEFORE log() existed
    # (base_library pin, mirror, preload) — put them into the log now.
    try:
        while _EARLY_NOTES:
            lvl, msg = _EARLY_NOTES.pop(0)
            log("BOOT    " + msg, lvl)
    except Exception:
        pass

    frozen = bool(getattr(sys, 'frozen', False) or globals().get('__compiled__'))
    if not frozen:
        log("Bundle check skipped - it only applies to the .exe build (script mode right now)")
        return

    # -- SumatraPDF --
    bundled = get_bundled_resource_path('SumatraPDF.exe')
    if bundled:
        log(f"BUNDLE  SumatraPDF : BUNDLED OK  ({bundled})")
    else:
        found_system = None
        for p in (r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
                  r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
                  os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe")):
            try:
                if os.path.exists(p):
                    found_system = p
                    break
            except Exception:
                pass
        if found_system:
            log(f"BUNDLE  SumatraPDF : NOT IN THE BUNDLE - found installed separately on this PC "
                f"({found_system}). PRINTING WILL FAIL ON A NEW PC. Put SumatraPDF.exe in the build "
                f"folder and build again.", "WARN")
        else:
            log("BUNDLE  SumatraPDF : MISSING - neither in the bundle nor on this PC. "
                "Printing will not work!", "ERROR")

    # -- Popup --
    log("BUNDLE  Popup     : Windows' own dialogs (no Tcl/Tk needed)")

    # -- Desktop panel --
    if get_bundled_resource_path('agent_panel.html'):
        log("BUNDLE  Panel HTML : BUNDLED OK")
    else:
        log("BUNDLE  Panel HTML : NOT IN THE BUNDLE - the desktop panel will not open "
            "(printing works normally)", "WARN")

    # -- Survival kit --
    try:
        have = [n for n in _MIRROR_FILES
                if os.path.exists(os.path.join(_RUNTIME_DIR, n))]
        log("BUNDLE  Safe copy : %d/%d files -> %s"
            % (len(have), len(_MIRROR_FILES), _RUNTIME_DIR))
        if not _mei_intact():
            log("BUNDLE  Temp folder : ALREADY CLEANED - running on the safe copy",
                "WARN")
    except Exception:
        pass


def _manual_update_headless():
    """
    Update check without any Tkinter window.

    Needed because some builds of the .exe do not ship the Tcl/Tk runtime.
    In that case opening a Tkinter window fails with "Can't find a usable
    init.tcl", and earlier that error was simply shown to the shop owner and
    nothing else happened. Now the update still runs — only the progress
    window is missing.
    """
    try:
        remote = get_remote_version()
        if remote is None:
            _msgbox("Could not get the version from the server.\n"
                    "Check your internet or the server, then try again.",
                    "Echel — Update", 0x30)
            return
        if remote <= VERSION:
            _msgbox(f"You have the latest version.\n\nInstalled: v{VERSION_LABEL}",
                    "Echel — Update")
            return

        _rl = remote_label_or(remote)
        log(f"🔄 New version available: v{VERSION_LABEL} → v{_rl} (headless update)")
        _msgbox(f"New version found: v{VERSION_LABEL} -> v{_rl}\n\n"
                f"Downloading now. The agent will restart by itself.\n"
                f"This can take a few minutes on a slow connection.",
                "Echel — Update")
        try:
            installer_path, err = download_installer(None)
        except Exception as e:
            installer_path, err = None, str(e)
        if not installer_path:
            log(f"❌ Manual update (headless): {err}", "ERROR")
            _msgbox(f"Update download failed.\n\n{err}",
                    "Echel — Update", 0x10)
            return
        log(f"✅ Installing v{remote} (headless)...")
        run_installer_and_exit(installer_path)
    except Exception as e:
        log(f"❌ Headless update error: {e}", "ERROR")
        _msgbox(f"Update check error: {e}", "Echel", 0x10)


def _manual_update_ui():
    """
    The tray's "Check for Update".

    This used to be a tkinter progress window, and when Tcl failed the
    shop owner saw a line like "Can't find a usable init.tcl".
    Now the window-less update runs directly — every step shows
    Windows' own message box.
    """
    _manual_update_headless()

def _seconds_until_next_update_check():
    """Seconds until the next update check — at 11:00 and 18:00, with jitter.

    WHY JITTER: if every agent checked at exactly 11:00:00, 72
    requests would hit the server at once. Each agent takes its own offset
    derived from its SHOP_ID — so it differs per PC,
    but does not change on restart (otherwise the offset would change every time
    and the schedule would be useless).
    """
    import datetime, hashlib
    seed = hashlib.md5((SHOP_ID or "agent").encode()).digest()
    offset = (seed[0] * 256 + seed[1]) % UPDATE_JITTER_MAX_SEC

    now = datetime.datetime.now()
    best = None
    for day in (0, 1):                      # today, then tomorrow
        for hh in UPDATE_HOURS:
            t = (now + datetime.timedelta(days=day)).replace(
                hour=hh, minute=0, second=0, microsecond=0)
            t += datetime.timedelta(seconds=offset)
            if t > now and (best is None or t < best):
                best = t
    return max(60, (best - now).total_seconds())


def update_checker_loop():
    """Background thread — checks for updates twice a day (UPDATE_HOURS)."""
    # The first check comes with a short delay — so the agent starts up properly first.
    # This startup check is essential: otherwise a freshly installed agent would
    # not look for an update until the next 11 o'clock.
    time.sleep(30)
    while agent_state["running"]:
        try:
            remote_version = get_remote_version()
            if remote_version is not None and remote_version > VERSION:
                _rl = remote_label_or(remote_version)
                log(f"🔄 New version available: v{_rl} (currently running v{VERSION_LABEL})")
                update_tray_status(f"Updating to v{_rl}...")

                if is_running_as_exe():
                    # .exe mode — download/run the new installer directly
                    apply_update_and_restart()
                else:
                    # Source (.py) mode — the old flow: download the new .py code and replace it
                    new_code = download_latest_agent()
                    if new_code:
                        apply_update_and_restart(new_code)
                    else:
                        log("⚠️  Update download failed, will try again at the next check", "WARN")
        except Exception as e:
            log(f"⚠️  Update checker error: {e}", "WARN")

        # Sleep until the next fixed time. The long sleep is split into chunks
        # so the thread stops immediately when the agent is closed — otherwise it would
        # hang around for hours even after "Exit" was pressed.
        _left = _seconds_until_next_update_check()
        while _left > 0 and agent_state["running"]:
            _nap = min(60, _left)
            time.sleep(_nap)
            _left -= _nap

# ─── SYSTEM TRAY ───────────────────────────────────────────────────
def update_tray_status(status_text):
    """Update the tray icon tooltip/status"""
    agent_state["status"] = status_text
    if agent_state["tray_icon"]:
        try:
            agent_state["tray_icon"].title = f"Echel — {status_text}"
        except Exception:
            pass

# To wake the print loop immediately. The flag used to be checked every 1 second,
# so even after pressing Reconnect it could wait up to 1 second.
# With an Event this becomes 0 milliseconds.
_wake_event = threading.Event()

def wake_print_loop():
    """Wake the print loop now — cut the sleep short."""
    _wake_event.set()

def _interruptible_sleep(seconds):
    """
    Sleep, but wake up IMMEDIATELY on Reconnect or Exit.
    Event.wait() returns the very moment someone calls wake_print_loop()
    — no polling, no delay.
    """
    if seconds <= 0:
        return
    if _wake_event.wait(timeout=seconds):
        _wake_event.clear()

def reconnect_to_server(icon=None, item=None, announce=True):
    """
    'Reconnect to Server' — from the tray or the desktop panel.
    No need to close and reopen the software: this re-detects the
    printer, checks the server immediately and resets the
    status.
    """
    log("🔌 Reconnect to Server pressed")
    # After a manual click, a running countdown is pointless — stop it.
    # (The automatic one comes here by itself; it does not need to be stopped.)
    if announce:
        cancel_auto_reconnect()
    reset_http()          # throw away the old dead sockets
    agent_state["connection"] = "connecting"
    update_tray_status("Reconnecting...")
    agent_state["reconnect_requested"] = True
    wake_print_loop()     # wake the print loop now — do not wait for the sleep to end

    # Re-detect the printer — after a printer has been offline, the
    # default printer often changes or the handle goes stale.
    try:
        ok, printer_name = check_printer()
        if ok and printer_name:
            agent_state["printer"] = printer_name
            log(f"🖨️  Printer re-detected: {printer_name}")
        else:
            log("⚠️  No printer found during reconnect", "WARN")
    except Exception as e:
        log(f"Printer re-detect skipped: {e}", "WARN")

    # Send the current printer list to the server again (best-effort)
    try:
        report_printers_to_server()
    except Exception as e:
        log(f"Printer report skipped: {e}", "WARN")

    # Check IMMEDIATELY — the user should not have to wait for the poll. It is a light
    # read-only endpoint; no job gets claimed.
    connected = ping_server()
    if connected:
        agent_state["connection"] = "online"
        update_tray_status("Running — waiting for jobs")
        log("✅ Reconnected — connected to the server")
        # Always report success — manual or automatic. That is what
        # everyone was waiting for.
        tray_notify("Connected", "Connected to the server. Pending print jobs will resume.")
        reset_auto_reconnect_notice()
    else:
        agent_state["connection"] = "offline"
        update_tray_status("Offline — click Reconnect to Server")
        log("❌ Reconnect failed — could not reach the server", "WARN")
        # Report it only on a manual click. If every automatic attempt sent a
        # notification, a long outage would turn into spam.
        if announce:
            tray_notify("Not connected", "Check your internet connection, then select Reconnect.")
    return connected

def ping_server(timeout=8):
    """
    Is the server reachable — that is all. A read-only endpoint, so
    no print job gets claimed (do NOT use get_pending_jobs here,
    otherwise a job would be claimed but never printed).
    """
    try:
        r = http().get(f"{SERVER_URL}/api/agent/version", timeout=timeout)
        return r.status_code == 200
    except Exception as e:
        log(f"Server ping failed: {e}", "WARN")
        return False

def tray_notify(title, msg):
    """A small Windows notification — best effort."""
    try:
        icon = agent_state.get("tray_icon")
        if icon and hasattr(icon, "notify"):
            icon.notify(msg, f"Echel — {title}")
    except Exception:
        pass

# ══════════════════════════════════════════════════════════════
#  OFFLINE -> NOTIFICATION + 10-SECOND COUNTDOWN + AUTO RECONNECT
#
#  Going offline used to change only the tray text. The shop owner looks
#  at the tray only when a print does not come out — meanwhile the customer
#  is left standing. Now a Windows notification appears immediately and after
#  10 seconds the agent reconnects BY ITSELF.
#
#  TO BE CLEAR: a Windows tray notification (the Shell_NotifyIcon balloon
#  that pystray uses) cannot have a BUTTON — it only shows
#  text. So the countdown runs in the TRAY TOOLTIP, where it
#  updates every second:
#      "Offline — auto reconnect in 7s"
#  The user can also right-click the tray -> Reconnect to Server to do it
#  immediately; the countdown then stops by itself.
# ══════════════════════════════════════════════════════════════
_auto_rc_lock = threading.Lock()
_auto_rc_running = False
_auto_rc_cancel = threading.Event()
_auto_rc_last_notify = 0.0


def auto_reconnect_active():
    """Is a countdown running? (so print_loop does not overwrite the tray text)"""
    return _auto_rc_running


def cancel_auto_reconnect():
    """The user pressed Reconnect personally — the countdown is pointless now."""
    _auto_rc_cancel.set()


def reset_auto_reconnect_notice():
    """When the connection comes back — so the next notification appears immediately."""
    global _auto_rc_last_notify
    _auto_rc_last_notify = 0.0


def start_auto_reconnect_countdown():
    """
    As soon as the agent goes offline, send one notification, run a countdown
    from 10 to 1 in the tray, then reconnect by itself.

    Runs in a separate thread so the print loop does not stop.
    """
    global _auto_rc_running
    with _auto_rc_lock:
        if _auto_rc_running:
            return                      # only one countdown at a time
        _auto_rc_running = True
    _auto_rc_cancel.clear()

    def _run():
        global _auto_rc_running, _auto_rc_last_notify
        try:
            # If the internet is down all night, a notification every time would be
            # torture. So the notification appears once per AUTO_RECONNECT_NOTIFY_GAP
            # — but reconnect attempts still keep happening.
            now = time.time()
            if now - _auto_rc_last_notify >= AUTO_RECONNECT_NOTIFY_GAP:
                _auto_rc_last_notify = now
                tray_notify(
                    "Connection lost",
                    f"The server is unavailable. Reconnecting automatically in {AUTO_RECONNECT_SECONDS} seconds.\n"
                    f"To reconnect now, right-click the tray icon and select "
                    f"'Reconnect to Server'.")

            for left in range(AUTO_RECONNECT_SECONDS, 0, -1):
                if not agent_state.get("running"):
                    return
                if agent_state.get("connection") == "online":
                    log("✅ The connection came back during the countdown")
                    return
                update_tray_status(f"Offline — reconnecting in {left}s")
                # wait() returns the very moment the user presses Reconnect
                # — no need to wait a full second.
                if _auto_rc_cancel.wait(timeout=1.0):
                    log("🔌 The user pressed Reconnect — countdown stopped")
                    return

            if not agent_state.get("running"):
                return
            log(f"⏱️  {AUTO_RECONNECT_SECONDS}s elapsed — running the auto reconnect")
            update_tray_status("Reconnecting automatically...")
            # announce=False: do not send a notification on failure, otherwise
            # every attempt during a long outage would produce a notification.
            reconnect_to_server(announce=False)
        except Exception as e:
            log(f"Auto reconnect counter error: {e}", "WARN")
        finally:
            with _auto_rc_lock:
                _auto_rc_running = False

    threading.Thread(target=_run, daemon=True,
                     name="auto-reconnect").start()


def create_tray_icon_image():
    """Draw a small printer-like icon (using Pillow)"""
    from PIL import Image, ImageDraw
    img = Image.new('RGB', (64, 64), color=(10, 10, 15))
    draw = ImageDraw.Draw(img)
    # Simple printer shape: body + paper
    draw.rectangle([12, 24, 52, 44], fill=(255, 77, 29))   # printer body
    draw.rectangle([20, 10, 44, 29], fill=(255, 255, 255)) # paper
    draw.rectangle([16, 44, 48, 54], fill=(40, 40, 45))    # tray
    return img

def toggle_approval(icon=None, item=None):
    now = not approval_enabled()
    set_approval(now)
    log(f"🔔 Counter approval: {'ON' if now else 'OFF'}")
    try:
        icon.update_menu()
    except Exception:
        pass

def open_logs(icon=None, item=None):
    """Open the log file in Notepad"""
    try:
        log_path = os.path.abspath(LOG_FILE)
        if os.path.exists(log_path):
            os.startfile(log_path)
        else:
            log("The log file has not been created yet")
    except Exception as e:
        log(f"Error while opening the logs: {e}", "ERROR")

def contact_admin(icon=None, item=None):
    """
    'Contact Admin' from the tray — WhatsApp opens in the browser with the Shop ID
    already filled into the message. Exactly like the Support button of the
    shop login. The owner only has to type their problem and send it.
    """
    try:
        import webbrowser, urllib.parse
        # the same format as admin.html's sendWhatsApp()
        text = (
            "Hello, Echel Support \U0001F64F\n\n"
            f"Shop ID: {SHOP_ID}\n\n"
            "Problem: "
        )
        number = SUPPORT_WA
        try:
            response = requests.get(f"{SERVER_URL}/api/homepage-config", timeout=4)
            response.raise_for_status()
            settings = response.json()
            number = ''.join(c for c in str(settings.get('whatsapp') or settings.get('supportPhone') or '') if c.isdigit())
            if len(number) == 10:
                number = '91' + number
            if not number:
                webbrowser.open(f"{SERVER_URL}/contact")
                return
        except Exception:
            pass  # Keep support available if the public settings endpoint is offline.
        url = f"https://wa.me/{number}?text=" + urllib.parse.quote(text)
        webbrowser.open(url)
        log("\U0001F4AC Contact Admin — WhatsApp opened")
    except Exception as e:
        log(f"Contact Admin error: {e}", "ERROR")

def change_shop_id(icon=None, item=None):
    """
    When 'Change Shop ID' is clicked in the tray, delete the config file
    and restart the agent — the new Shop ID popup opens right after the restart.
    """
    log("🔄 Shop ID change requested — restarting the agent...")
    try:
        if os.path.exists(SHOP_CONFIG_FILE):
            os.remove(SHOP_CONFIG_FILE)
    except Exception as e:
        log(f"Config delete error: {e}", "ERROR")

    try:
        # Release the mutex, otherwise the new instance would think "already running",
        # exit, and the Shop ID popup would never open
        _release_mutex()
        if is_running_as_exe():
            _spawn_detached([sys.executable])
        else:
            python_exe = sys.executable
            pythonw_exe = python_exe.replace('python.exe', 'pythonw.exe')
            if not os.path.exists(pythonw_exe):
                pythonw_exe = python_exe
            _spawn_detached([pythonw_exe, os.path.abspath(__file__)],
                            cwd=os.path.dirname(os.path.abspath(__file__)))
        # Give the new process time to extract its own temp folder. Without
        # this the old bootloader could delete its _MEIxxxxxx folder
        # while the new process is still importing.
        time.sleep(2.0)
    except Exception as e:
        log(f"Restart error: {e}", "ERROR")

    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def _uninstall_clear_autostart():
    """Remove the name from both places — the registry Run key and the Startup folder."""
    gone = []
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE)
        try:
            winreg.DeleteValue(key, "EchelPrintAgent")
            gone.append("registry Run key")
        except FileNotFoundError:
            pass                          # it was not there — fine
        finally:
            winreg.CloseKey(key)
    except Exception as e:
        log(f"Uninstall: could not remove the registry entry: {e}", "WARN")

    folder = _startup_folder()
    if folder:
        # EchelPrintAgent.vbs is the current one. EchelPrint.bat may have been left behind by
        # a very old INSTALL.bat — remove that too, otherwise the old Python
        # copy would try to start after a PC restart.
        for name in (STARTUP_VBS_NAME, "EchelPrint.bat"):
            path = os.path.join(folder, name)
            try:
                if os.path.exists(path):
                    os.remove(path)
                    gone.append(name)
            except Exception as e:
                log(f"Uninstall: could not remove {name}: {e}", "WARN")
    return gone


def _uninstall_cleanup_bat():
    """
    A small .bat that deletes the exe and the data folder after the agent closes.

    Blocks — `if ... (` — are deliberately not used: cmd reads the whole block
    at once, so the old value of %N% keeps applying
    and the count never advances. Hence only goto/labels.

    Returns: (bat path, exe path). If bat is "", nothing
    happened; if exe is "", only the data folder has to be deleted.
    """
    target = ""
    if is_running_as_exe():
        cand = os.path.abspath(sys.executable)
        # An essential guard: in script mode sys.executable is python.exe.
        # is_running_as_exe() already prevents this, but checking again here
        # is cheap — Python must never be
        # deleted.
        if os.path.basename(cand).lower() not in ("python.exe", "pythonw.exe"):
            target = cand

    bat = os.path.join(tempfile.gettempdir(), f"qsp-uninstall-{int(time.time())}.bat")
    # Do not write paths inside the .bat — they are passed as arguments %~1 (exe) and
    # %~2 (data folder). The reason is the same as for the update .bat:
    # cmd reads the file in the ANSI codepage, and the path of a user with a
    # Hindi/Bengali name turns into garbage right there.
    script = "\r\n".join([
        "@echo off",
        "set N=0",
        ":wait",
        "ping -n 3 127.0.0.1 >nul",
        'if "%~1"=="" goto data',
        'del /f /q "%~1" >nul 2>&1',
        'if not exist "%~1" goto data',
        "set /a N+=1",
        "if %N% LSS 40 goto wait",
        ":data",
        'rmdir /s /q "%~2" >nul 2>&1',
        'del /f /q "%~f0" >nul 2>&1',
    ]) + "\r\n"
    try:
        with open(bat, "w", encoding="ascii", newline="") as f:
            f.write(script)
        return bat, target
    except Exception as e:
        log(f"Could not create the uninstall helper: {e}", "ERROR")
        return "", target


def _uninstall_flow():
    """Uninstall from the tray — confirm, Shop ID, then cleanup. In a separate thread."""
    ok = _native_yesno(
        "Uninstall Echel from this computer?\n\n"
        "The agent will stop, auto-start will be removed, and the program "
        "and its settings will be deleted from this PC.\n\n"
        "QR printing will stop working on this computer.",
        "Echel - Uninstall")
    if ok is not True:
        log("Uninstall cancelled — no Yes at the confirmation")
        return

    want = (SHOP_ID or "").strip().upper()
    for attempt in (1, 2):
        typed = _ps_input_big(
            head="Uninstall Echel",
            sub="Type this computer's Shop ID to confirm",
            label="Shop ID",
            hint="Find this Shop ID in the tray menu or the agent panel.\n"
                 "Nothing will be removed if the ID does not match.",
            title="Echel - Uninstall")
        if typed is None:                 # the large box was never created
            typed = _powershell_input("Type your Shop ID to confirm uninstall")
        typed = (typed or "").strip().upper()
        if not typed:
            log("Uninstall cancelled — the Shop ID was left empty")
            return
        if typed == want:
            break
        if attempt == 1:
            _msgbox("That Shop ID does not match. Please try once more.",
                    "Echel - Uninstall", 0x30)
        else:
            _msgbox("Shop ID did not match - nothing was removed.",
                    "Echel - Uninstall", 0x10)
            log("Uninstall stopped — the Shop ID did not match", "WARN")
            return

    log("🗑 Uninstall started — Shop ID confirmed")
    agent_state["running"] = False        # so no new print job gets picked up
    try:
        wake_print_loop()
    except Exception:
        pass

    gone = _uninstall_clear_autostart()
    log("Uninstall: auto-start removed — " + (", ".join(gone) if gone else "nothing was found"))
    bat, exe_path = _uninstall_cleanup_bat()

    _msgbox(
        "Echel has been removed from this computer.\n\n"
        "Auto-start is switched off and the program with its settings "
        "will be deleted in a few seconds.\n\n"
        "To use this Shop ID on another computer, open your shop login on "
        "the website and use Settings > Disconnect Computer first.",
        "Echel - Uninstall", 0x40)

    try:
        if PANEL is not None:
            PANEL.shutdown()
    except Exception:
        pass
    try:
        _release_mutex()                  # otherwise the .bat cannot delete the exe
    except Exception:
        pass
    if bat:
        try:
            # Keep cwd in TEMP — if cmd's cwd is inside the folder that is being
            # deleted, `rmdir /s` fails with "process cannot access".
            _spawn_detached(["cmd", "/c", bat, exe_path, _APPDATA_DIR],
                            cwd=tempfile.gettempdir())
        except Exception as e:
            log(f"The uninstall helper did not run: {e}", "ERROR")
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    time.sleep(0.5)
    os._exit(0)


def uninstall_agent(icon=None, item=None):
    """
    The tray's '🗑 Uninstall'. The work runs in a separate thread — pystray's handler runs
    in the tray's own loop, and opening a modal dialog there freezes the tray
    menu.
    """
    threading.Thread(target=_uninstall_flow, daemon=True).start()


def quit_agent(icon=None, item=None):
    """Shut the agent down gracefully when 'Exit' is clicked in the tray"""
    log("👋 Exit pressed from the tray — shutting the agent down...")
    agent_state["running"] = False
    wake_print_loop()     # a loop stuck in sleep ends immediately
    # Close the panel window — otherwise the main thread's webview loop keeps
    # running and the process never exits completely.
    try:
        if PANEL is not None:
            PANEL.shutdown()
    except Exception:
        pass
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def _tray_action(fn):
    """
    Never pass a function to the tray menu DIRECTLY — always wrap it with this.

    WHY (this was a real bug, not theory):
    pystray only accepts a callable with 0, 1 or 2 parameters. As soon as it sees
    3 or more it throws while building the MenuItem:

        File "pystray/_base.py", in _assert_action
        ValueError: <function reconnect_to_server at 0x...>

    And that exception stops the whole `pystray.Menu(...)` from being built — meaning
    THE TRAY ICON IS NEVER CREATED. That is exactly what happened in v2.3: the
    auto-reconnect feature added a third parameter (announce=True) to
    reconnect_to_server(), and from that day on neither the tray icon appeared nor
    the panel opened. Printing kept running because it lives in its own thread
    — which made the cause even harder to find.

    This wrapper always exposes EXACTLY 2 parameters, however many the real function
    has. Even if someone adds a new parameter later, the tray stays safe.
    """
    def _runner(icon=None, item=None):
        return fn(icon, item)
    # Show the real name in logs/debugging, not '_runner'
    try:
        _runner.__name__ = fn.__name__
    except Exception:
        pass
    return _runner


# Give the tray icon this many seconds to get ready. On a slow PC pystray
# takes a moment to create its window; 12s is comfortably enough.
TRAY_WAIT_SEC = 12


def _tray_is_up(icon, timeout=TRAY_WAIT_SEC):
    """
    Was the tray icon REALLY created?

    icon.run_detached() returns immediately — its return is NOT
    proof that the icon was created. On Windows pystray creates its own (hidden)
    window in a separate thread and keeps that window's handle in _hwnd.
    If something fails in that thread, _hwnd is never set.
    So we wait for the handle, not for the function to return.
    """
    end = time.time() + timeout
    while time.time() < end:
        try:
            if getattr(icon, "_hwnd", None) or getattr(icon, "visible", False):
                return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def panel_request_watcher():
    """
    Did the owner double-click the exe again? That second instance leaves a
    request file and exits — we see it and open our
    panel.
    """
    while agent_state.get("running", True):
        try:
            if os.path.exists(PANEL_REQUEST_FILE):
                try:
                    os.remove(PANEL_REQUEST_FILE)
                except Exception:
                    pass
                log("🪟 Panel request received (the exe was started again) — opening the panel")
                if PANEL is not None:
                    try:
                        PANEL.open_panel()
                    except Exception as e:
                        log(f"Could not open the panel: {e}", "WARN")
        except Exception:
            pass
        time.sleep(1)


def run_tray_icon():
    """
    Start the System Tray icon. This function blocks inside the tray's event loop
    — so the print-checking loop runs in a separate thread.
    """
    try:
        import pystray
        from pystray import MenuItem as Item

        _CONN_DOT = {"online": "🟢", "connecting": "🟡", "offline": "🔴"}

        def status_label(item):
            dot = _CONN_DOT.get(agent_state.get("connection", "connecting"), "🟡")
            return f"{dot} Status: {agent_state['status']}"

        def shop_label(item):
            return f"Shop: {SHOP_ID}"

        def printer_label(item):
            return f"Printer: {agent_state['printer']}"

        def version_label(item):
            return f"Version: v{VERSION_LABEL}"

        menu = pystray.Menu(
            Item(status_label, None, enabled=False),
            Item(shop_label, None, enabled=False),
            Item(printer_label, None, enabled=False),
            Item(version_label, None, enabled=False),
            pystray.Menu.SEPARATOR,
            # DEMO-ONLY: this disappears by itself right after the conversion
            # — pystray calls visible() again every time it renders the menu.
            # No reinstall needed.
            # ── EVERY ACTION GOES THROUGH _tray_action() ──
            # If even one action is passed directly and it has more than 2 parameters,
            # pystray refuses to build the whole menu and the TRAY
            # ICON DISAPPEARS (that is what happened in v2.3 with reconnect_to_server).
            # When adding a new menu item, do not forget the wrapper.
            Item("⚡ Change Demo ID to Paid Shop", _tray_action(open_upgrade_panel),
                 visible=lambda item: is_demo_shop()),
            Item("⚙ Settings", _tray_action(open_panel), default=True),
            # It has two locks inside (confirm + Shop ID), so even sitting next to
            # Settings nothing gets deleted by mistake.
            Item("🗑 Uninstall Echel", _tray_action(uninstall_agent)),
            Item("🔌 Reconnect to Server", _tray_action(reconnect_to_server)),
            Item(lambda item: f"🔔 Counter Approval: {'ON' if approval_enabled() else 'OFF'}",
                 _tray_action(toggle_approval)),
            Item("📋 View Logs", _tray_action(open_logs)),
            Item("💬 Contact Admin", _tray_action(contact_admin)),
            Item("⬆️ Check for Update", _tray_action(manual_update_check)),
            Item("🔄 Change Shop ID", _tray_action(change_shop_id)),
            Item("❌ Exit", _tray_action(quit_agent)),
        )

        icon_image = create_tray_icon_image()
        icon = pystray.Icon("echel_agent", icon_image, "Echel — Starting...", menu)
        agent_state["tray_icon"] = icon

        # ══════════════════════════════════════════════════════
        # THREAD SPLIT
        #
        # On Windows pywebview can create a window ONLY on the main thread.
        # From a background thread it fails with:
        #     "pywebview must be run on a main thread"
        # Meanwhile pystray's icon.run() also wants the main thread.
        #
        # So:
        #   MAIN thread       -> panel (pywebview)
        #   Background thread -> tray  (icon.run_detached())
        #
        # If the panel is not available, everything is as before: the tray on the main
        # thread, and printing keeps running exactly the same.
        # ══════════════════════════════════════════════════════
        use_panel = False
        if PANEL is not None:
            try:
                use_panel = PANEL.panel_available()
            except Exception as e:
                log(f"Panel check failed: {e}", "WARN")
                use_panel = False

        if not use_panel:
            log("The panel is not available on this PC — running the tray on the main thread")
            icon.run()               # the old behaviour — tray only
            return

        try:
            icon.run_detached()      # tray background thread me
        except Exception as e:
            # Some systems do not support run_detached — then drop
            # the panel; printing is what matters.
            log(f"Tray detached mode unavailable ({e}) — tray-only mode", "WARN")
            icon.run()
            return

        # ── NOW CONFIRM THAT THE TRAY REALLY APPEARED ──
        # This check exists because run_detached() returns immediately, but the
        # icon is created in another thread. If something failed there,
        # this is what USED to happen — no tray icon, no error, and right
        # afterwards the panel took over the main thread. The owner saw nothing
        # and the log stayed perfectly clean, so finding the cause
        # was impossible. Now if the tray did not appear, it is run on the main
        # thread — the tray is GUARANTEED (in that state the panel will
        # not open, but printing is not affected).
        if not _tray_is_up(icon):
            log(f"The tray icon did not appear within {TRAY_WAIT_SEC}s — now running it on the main "
                f"thread. The panel will not open this time; printing "
                f"and auto-update keep working normally.", "WARN")
            try:
                icon.run()
            except Exception as e:
                import traceback as _tb
                log(f"The tray did not start even on the main thread: {e}", "ERROR")
                log(_tb.format_exc(), "ERROR")
            return

        log("✅ Tray icon ready — the panel is now opening on the main thread")

        # Hand the main thread to the panel now. The Shop ID has already been verified,
        # so the panel opens directly (spec).
        ok = PANEL.start_ui_loop(show_now=True)
        if not ok:
            log("Panel could not start — continuing in tray-only mode", "WARN")

        # We only get here when the panel loop has ended, or never
        # started. In both cases the tray and the print thread are still
        # running — returning from here would kill the process
        # and STOP PRINTING. So stay alive.
        # Only Exit (quit_agent) ends the process — it sets running=False
        # and calls os._exit(0).
        while agent_state.get("running", True):
            time.sleep(1)
    except ImportError as e:
        # This used to log only one generic line. The real module name
        # never reached the log, so for a "tray disappeared" complaint there
        # was no way to tell which piece was missing.
        import traceback as _tb
        log(f"⚠️  A module required for the tray was not found: {e}", "WARN")
        log(_tb.format_exc(), "WARN")
        log("    Running in console mode — printing works normally.", "WARN")
    except Exception as e:
        import traceback as _tb
        log(f"❌ Tray icon could not start: {e}", "ERROR")
        log(_tb.format_exc(), "ERROR")

# ─── MAIN PRINT LOOP (runs in a background thread while the tray is active) ──
def print_loop():
    log("=" * 50)
    log(f"Job check: {CHECK_INTERVAL}s busy | {IDLE_INTERVAL_1}s ({IDLE_STEP_1_SEC//60} min idle) "
        f"| {IDLE_INTERVAL_2}s ({IDLE_STEP_2_SEC//60} min idle) — back to {CHECK_INTERVAL}s as soon as a job arrives")
    log("=" * 50)
    update_tray_status("Running — waiting for jobs")

    errors = 0
    check_count = 0
    idle_since = time.time()      # when the last job arrived
    cur_interval = CHECK_INTERVAL
    elapsed_min = 0.0
    last_socket_refresh = time.time()
    last_err_log = 0.0
    _poll_took = 0.0        # how long the server took on the last poll
    _lp_active = False      # whether the server supports long polling

    while agent_state["running"]:
        try:
            # Manual "Reconnect to Server" — go back to fast mode immediately
            if agent_state.get("reconnect_requested"):
                agent_state["reconnect_requested"] = False
                errors = 0
                idle_since = time.time()
                cur_interval = CHECK_INTERVAL
                # A manual Reconnect means something is stuck —
                # so throw away the old session and create a new socket.
                reset_http()
                last_socket_refresh = time.time()
                _reset_poll_log()
                log("🔌 Reconnect requested — creating a new connection and checking...")

            # After a long idle period the socket is already dead. Do not wait for a
            # job to arrive — refresh the session while idle,
            # so that when a real job arrives the very first poll works.
            if (time.time() - idle_since) > IDLE_STEP_1_SEC and \
               (time.time() - last_socket_refresh) >= IDLE_SOCKET_REFRESH_SEC:
                reset_http()
                last_socket_refresh = time.time()
                log("🔁 Idle socket refresh — a new connection is ready")

            _mei_watch()          # throttles itself (every 5 min)

            _t_poll = time.time()
            jobs = get_pending_jobs()
            _poll_took = time.time() - _t_poll
            check_count += 1

            # None = the poll FAILED. Keeping it separate from [] (no job) is
            # essential. It is raised into the except so the
            # recovery that lives there — reset_http(), backoff, tray "Offline" — runs.
            if jobs is None:
                raise PollError("no response from the server")

            # The server answered = the connection is fine. Whether jobs
            # arrived or not, clear the error state right here.
            # (The old bug: the status was reset only inside 'if jobs',
            #  so after one network blip the tray stayed stuck forever at
            #  "Error — retrying".)
            if errors:
                log("✅ Connection restored — back to normal")
                _reset_poll_log()
                last_err_log = 0.0
                reset_auto_reconnect_notice()
            errors = 0
            agent_state["connection"] = "online"

            if jobs:
                log(f"📬 {len(jobs)} new job(s)!")
                update_tray_status(f"Printing {len(jobs)} job(s)...")
                for job in jobs:
                    process_job(job)
                update_tray_status("Running — waiting for jobs")
                # A job arrived = the shop is busy. Back to fast checking immediately.
                idle_since = time.time()
                if cur_interval != CHECK_INTERVAL:
                    cur_interval = CHECK_INTERVAL
                    log(f"⚡ Fast mode — har {CHECK_INTERVAL}s check")
            else:
                # v2.0: only two speeds — 5s (a job just arrived) and 10s (idle).
                # It used to go up to 45s, which could delay a print by
                # up to 45 seconds after a job arrived.
                idle_sec = time.time() - idle_since
                if idle_sec <= IDLE_STEP_1_SEC:
                    new_interval = CHECK_INTERVAL      # 5s
                elif idle_sec <= IDLE_STEP_2_SEC:
                    new_interval = IDLE_INTERVAL_1     # 10s
                else:
                    new_interval = IDLE_INTERVAL_2     # 12s
                if new_interval != cur_interval:
                    cur_interval = new_interval
                    log(f"💤 Idle — ab har {cur_interval}s check")

                # ── LONG POLL: do not sleep ──
                # The server held the line for 30 sec, which means it has already
                # waited that long ITSELF. Sleeping on top of that would only
                # add delay. Open a new line immediately.
                #
                # How do we know the long poll worked? If the server answered quickly
                # (well under LP), it is an old server that does not know lp
                # — then the old sleep is right.
                if _poll_took >= (LP_SECONDS * 0.7):
                    _lp_active = True
                    continue          # straight to the next poll — no sleep
                else:
                    _lp_active = False
                elapsed_min += cur_interval / 60.0
                if check_count % 60 == 0:
                    log(f"👀 Waiting... ({int(elapsed_min)} min)")
                # The poll succeeded = all good. Remove whatever old text is left on
                # the tray (Error / Offline / Reconnecting).
                # THE BUG WAS: it used to reset only on "Error"/"Offline",
                # so "Reconnecting..." stayed stuck forever.
                if not _shop_gone and \
                   agent_state.get("status", "") != "Running — waiting for jobs":
                    update_tray_status("Running — waiting for jobs")

            # Sleep in short chunks — so that when Reconnect is clicked the
            # agent does not sleep for 60s.
            # The shop does not exist on the server — 30 minutes instead of 12 seconds.
            # This is the change that stops the useless requests.
            if _shop_gone:
                cur_interval = SHOP_GONE_INTERVAL
            _interruptible_sleep(cur_interval)
        except KeyboardInterrupt:
            log("\n👋 Shutting down...")
            break
        except Exception as e:
            errors += 1
            # Writing a line on every failure fills the log file:
            # with 12s polling that is ~300 lines/hour, and the real message gets
            # buried. Write the first 3 immediately, after that one every 60s.
            if errors <= 3 or (time.time() - last_err_log) >= 60:
                last_err_log = time.time()
                log(f"❌ Error: {e}", "ERROR")
            if errors == 2:
                # Two failures = the socket really is dead. Create a new session
                # so the user does not have to press Reconnect personally.
                # (It used to be 3 — with 12s polling that meant a ~36s
                #  wait. At 2 the recovery is much faster.)
                log("🔄 Resetting the connection (auto)")
                reset_http()
                last_socket_refresh = time.time()
            if errors >= 3:
                was_offline = agent_state.get("connection") == "offline"
                agent_state["connection"] = "offline"
                # While the countdown is running, do not touch the tray text —
                # otherwise the countdown would be overwritten every second.
                if not auto_reconnect_active():
                    update_tray_status("Offline — click Reconnect to Server")
                # Start the countdown only when we have JUST gone offline,
                # or when the notification gap of a long outage has passed.
                # Starting it on every error would create a 10s loop and
                # the backoff would become meaningless.
                if (not was_offline) or \
                   (time.time() - _auto_rc_last_notify) >= AUTO_RECONNECT_NOTIFY_GAP:
                    start_auto_reconnect_countdown()
            else:
                agent_state["connection"] = "connecting"
                update_tray_status("Reconnecting...")
            # Capped exponential backoff: 5s, 10s, 20s, 40s ... max 60s.
            # It used to jump straight to 60s after 10 errors and the counter
            # was reset, which reset the offline detection as well.
            backoff = min(CHECK_INTERVAL * (2 ** min(errors - 1, 5)), 60)
            _interruptible_sleep(backoff)

def main():
    show_banner()
    check_dependencies()

    _load_processed()
    log(f"🚀 Agent start | Shop: {SHOP_ID} | Version: v{VERSION_LABEL} (build {VERSION})")
    log(f"🌐 Server: {SERVER_URL}")

    # On a PC restart the agent starts in the tray by itself — HKCU Run registry
    add_to_startup()

    # CRITICAL FIX: this used to call input("Press Enter...") when no printer was
    # found — in the .exe's WINDOWED mode (which has no console/STDIN
    # at all, because this is a background tray app) that crashed or hung silently.
    # This exact situation happens right after a PC restart:
    # the agent launches immediately from Windows Startup, but the printer driver/
    # USB/network printer is not initialized yet — check_printer()
    # failed, and the whole process crashed without any visible
    # error. That is where the "it sometimes disappears from the tray"
    # symptom came from.
    #
    # FIX: we now RETRY (the printer may be ready a moment later),
    # and even if it keeps failing, the PROCESS DOES NOT CRASH —
    # the tray icon keeps running, and printer detection keeps retrying
    # in the background (through print_loop).
    printer_ok, printer_name = check_printer()
    retry_count = 0
    while not printer_ok and retry_count < 6:
        retry_count += 1
        log(f"⏳ Printer is not ready yet, waiting 10s before retry {retry_count}/6...", "WARN")
        time.sleep(10)
        printer_ok, printer_name = check_printer()

    if not printer_ok:
        log("⚠️  Printer still not found — keeping the tray icon running anyway, "
            "print_loop will keep retrying the printer in the background", "WARN")
        printer_name = "Not Detected"
    else:
        log(f"✅ Printer: {printer_name}")

    agent_state["printer"] = printer_name

    # Report the printer list to the server (at startup) — required for choosing
    # the B&W/Color printer from the dashboard dropdown
    try:
        report_printers_to_server()
    except Exception:
        pass

    def printer_report_loop():
        while agent_state["running"]:
            time.sleep(1800)  # 30 minute
            try:
                report_printers_to_server()
            except Exception:
                pass
    printer_report_thread = threading.Thread(target=printer_report_loop, daemon=True)
    printer_report_thread.start()

    # Upgrade reminder on a demo shop (9 AM to 8 PM, 4 times)
    demo_thread = threading.Thread(target=demo_reminder_loop, daemon=True)
    demo_thread.start()

    # Run the auto-update checker in a background thread
    update_thread = threading.Thread(target=update_checker_loop, daemon=True)
    update_thread.start()
    log(f"🔄 Auto-update checker active — twice a day (around {UPDATE_HOURS[0]}:00 and {UPDATE_HOURS[1]}:00)")

    # Run the print loop in a background thread too — so the tray icon
    # can run in the foreground (an OS requirement for tray icons)
    print_thread = threading.Thread(target=print_loop, daemon=True)
    print_thread.start()

    # If the owner double-clicks the exe again, the panel opens
    threading.Thread(target=panel_request_watcher, daemon=True).start()

    # Clear any old request file (from last time) first, otherwise
    # the panel would open for no reason right at startup.
    try:
        if os.path.exists(PANEL_REQUEST_FILE):
            os.remove(PANEL_REQUEST_FILE)
    except Exception:
        pass

    # Start the tray icon (this blocks until Exit is pressed)
    try:
        run_tray_icon()
    except Exception as trayErr:
        log(f"⚠️  Tray icon error: {trayErr}", "WARN")

    # If the tray fails (pystray missing), keep running in normal console mode
    if agent_state["tray_icon"] is None:
        log("ℹ️  Running in console mode (press Ctrl+C to stop)")
        log("=" * 50)
        try:
            while agent_state["running"]:
                time.sleep(1)
        except KeyboardInterrupt:
            log("\n👋 Shutting down...")
            agent_state["running"] = False

if __name__ == "__main__":
    # CRITICAL FIX: the whole main() is now wrapped in try/except. Previously, if
    # any unexpected exception occurred anywhere (in any function), the whole
    # process CRASHED SILENTLY — vanishing from the tray without any
    # trace. Now every crash is written to LOG_FILE, so the tray menu's
    # "📋 View Logs" shows the customer/owner the real cause.
    try:
        main()
    except Exception as fatalErr:
        try:
            log(f"💥 FATAL CRASH: {fatalErr}", "ERROR")
            import traceback
            log(traceback.format_exc(), "ERROR")
        except Exception:
            pass  # even if logging fails, at least exit the process cleanly
