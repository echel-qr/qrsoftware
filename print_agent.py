"""
Echel - Local Agent v6.0
NEW: System Tray (background mein chalta hai, koi CMD window nahi)
NEW: Auto-Update (naya version aane par khud download + restart)
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

# SAFETY FIX: Jab Windows Startup se .exe automatically chalता hai (PC
# restart ke baad), default working directory C:\Windows\System32 hoti
# hai — agent ka apna installation folder NAHI. Agar kahin bhi relative
# path use ho (ya future mein use ho), yeh galat jagah resolve hoga.
# Yahan explicitly apne exe/script ke folder mein switch karte hain.
try:
    if getattr(sys, 'frozen', False):
        _app_dir = os.path.dirname(sys.executable)
    else:
        _app_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(_app_dir)
except Exception:
    pass  # agar yeh fail ho bhi jaaye, baaki sab APPDATA-based paths use karte hain to safe hai

# ============================================================
# SHOP_ID_TEMPLATE: .py source mode mein yahan seedha Shop ID daala jaata hai
# (server download-package banate waqt isko replace karta hai). .exe mode mein
# yeh hamesha unconfigured marker hi rahega — asli Shop ID config file se aata hai.
#
# NOTE: UNCONFIGURED_MARKER ko is naam se isliye rakha hai (alag string) taaki
# server.js ka text-replace operation sirf SHOP_ID_TEMPLATE ki line ko hi
# touch kare, comparison check ko corrupt na kare.
UNCONFIGURED_MARKER = "AAPKA" + "_SHOP_ID"
SHOP_ID_TEMPLATE   = "AAPKA_SHOP_ID"
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
# ── POLLING KI TEEN SPEED ──
# Dukaan busy ho to 5s, thodi der khaali ho to 10s, kaafi der se
# khaali ho to 12s. Job aate hi turant 5s par wapas aa jata hai,
# isliye print me deri kabhi nahi hoti.
CHECK_INTERVAL     = 5          # Abhi job aaya tha — sabse tez
IDLE_INTERVAL_1    = 10         # 2 min se khaali
IDLE_INTERVAL_2    = 12         # 10 min se khaali
# Kitni der baad agli speed par jayen (second me)
IDLE_STEP_1_SEC    = 120        # 2 min  -> 10s
IDLE_STEP_2_SEC    = 600        # 10 min -> 12s
# Purane build se compatibility ke liye naam rakha hai
IDLE_INTERVAL_3    = 12
# Lambi idle ke baad TCP socket aksar mar chuka hota hai (NAT/ISP
# timeout, ya Render ka sleep). Us mari hui socket par pehla poll
# fail hota hai. Isliye khaali baithe rehne par har itni der me
# session KHUD refresh kar dete hain — job aane se PEHLE.
IDLE_SOCKET_REFRESH_SEC = 300   # 5 min
# Offline hone par kitne second ka ulta counter dikhe, phir khud
# reconnect ho jaye.
AUTO_RECONNECT_SECONDS  = 10
# Lambi outage me notification kitni der me ek baar (reconnect ki
# koshish phir bhi chalti rehti hai — sirf notification rukti hai).
AUTO_RECONNECT_NOTIFY_GAP = 600  # 10 min
# Dukaan din bhar me sirf kuch der busy rehti hai. Har 5 second poll karne se
# roz lakhon request jaati hain aur server ka bandwidth khatam ho jaata hai.
# Isliye khaali waqt me dheere check karo — par job aate hi turant 5s par
# wapas aa jao, taaki print me deri na ho.
UPDATE_CHECK_INTERVAL = 3600    # (purana) — ab UPDATE_HOURS use hota hai

# ── Update check ab fix time par, har ghante nahi ──
# Har ghante check karne se update kisi bhi waqt aa sakta tha — beech kaam
# ke, jab customer print karwa raha ho. Ab din me sirf do baar.
UPDATE_HOURS = (11, 18)        # subah 11 baje, shaam 6 baje (PC ka local time)
UPDATE_JITTER_MAX_SEC = 25 * 60  # 0-25 min ka random offset (neeche dekho)

# ── Long polling ──
# Agent ek baar poochta hai, server LP_SECONDS tak line pakde rakhta hai
# aur job aate hi usi line par bhej deta hai. Isse request 6x kam ho jaati
# hain aur print pehle se TEZ nikalta hai (line pehle se khuli hoti hai).
#
# LP_TIMEOUT server ke hold se ZYADA hona chahiye — warna agent pehle
# timeout maan lega aur har baar "fail" samajh kar backoff me chala jayega.
LP_SECONDS = 30                # server itni der line pakde
# Shop server par mila hi nahi (mit chuka demo) — tab itni der me
# ek baar dekhte hain. Band karne ki jagah dheema karte hain taaki
# shop wapas aa jaye to agent khud sambhal le.
SHOP_GONE_INTERVAL = 30 * 60
LP_TIMEOUT = LP_SECONDS + 15   # agent ka apna timeout — hamesha zyada
VERSION            = 2            # Internal update build number.
                                  # Ye sirf badhta hai (29 → 30 → 31...). Isko kabhi
                                  # "2.0" mat banao: purane v27/v28/v29 agents integer
                                  # compare karte hain, warna woh update lena band kar denge.
VERSION_LABEL      = "2.0"        # Display version.
REMOTE_VERSION_LABEL = None       # Server ka latest label — update check par bhar jaata hai
REMOTE_VERSION_INT = 0            # Server ka internal build number (integer compare ke liye)
SUPPORT_WA         = "917011482679"  # Offline fallback; online support follows website settings.

# Log/temp files hamesha user-writable folder (%APPDATA%) mein rakhte hain —
# kyunki .exe install hone par Program Files mein likhna permission-denied
# de sakta hai. Yeh dono mode (.py script aur .exe) ke liye safe hai.
_APPDATA_DIR = os.path.join(os.environ.get('APPDATA', tempfile.gettempdir()), 'EchelPrint')
os.makedirs(_APPDATA_DIR, exist_ok=True)
LOG_FILE           = os.path.join(_APPDATA_DIR, "print_agent_log.txt")

# ══════════════════════════════════════════════════════════════════
# TLS CA BUNDLE PIN — PyInstaller --onefile ka _MEIxxxxx temp folder
# Windows Storage Sense / temp cleaners 8-12 ghante chalte agent ke
# neeche se uda dete hain. Uske baad har HTTPS request "Could not find
# a suitable TLS CA certificate bundle" se fail hoti hai — agent tray
# mein "Running" dikhta hai par server tak kuch nahi pahunchta.
# Fix: startup par cacert.pem ko APPDATA mein copy karke env se wahi
# point karo — _MEI ude to bhi HTTPS zinda rahega.
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
            pass  # copy fail ho to purani pinned copy chalegi (agar hai)
        if os.path.exists(dst) and os.path.getsize(dst) > 10000:
            os.environ["REQUESTS_CA_BUNDLE"] = dst
            os.environ["SSL_CERT_FILE"] = dst
    except Exception:
        pass  # certifi hi nahi mila — requests apne default par chalega

_pin_ca_bundle()

# ══════════════════════════════════════════════════════════════════
# _MEI SURVIVAL KIT — onefile ka temp folder chalte-chalte ud sakta hai
#
# 22 Aug 2026 ko yahi hua: agent 09:12 par chala, 09:18 par kisi cheez ne
# uske _MEI18802 folder ko recursive delete kar diya. Sirf wahi .pyd/.dll
# bache jo us waqt process me load the (Windows unhe lock rakhta hai).
# base_library.zip, Crypto\, SumatraPDF.exe, agent_panel.html — sab ud gaye.
# Do error nikle:
#   * "Bada dialog fail (... base_library.zip)"          -> naya import hi na ho saka
#   * "Cannot load native module 'Crypto.Util._cpuid_c'" -> har page-range job crash
#
# Ilaaj teen parat me — koi ek fail ho to baaki bacha lete hain:
#   1. _pin_base_library()    : base_library.zip ki apni copy APPDATA me, aur
#      sys.path me _MEI wali entry ki JAGAH wahi lagao.
#   2. _mirror_bundled_files(): SumatraPDF.exe / panel HTML / icon ki copy
#      APPDATA me — get_bundled_resource_path() wahan bhi dhoondhta hai.
#   3. _preload_fragile()     : Crypto + PyPDF2 + codecs SHURU me hi import kar
#      lo. Ek baar load hone par module sys.modules me aur .pyd Windows ki
#      memory me map ho jaati hai — file delete ho jaye to bhi chalti rehti hai.
#
# _MEI salaamat rehne par ye teeno bilkul harmless hain (bas ek copy zyada).
# ══════════════════════════════════════════════════════════════════
_RUNTIME_DIR = os.path.join(_APPDATA_DIR, "runtime")
_EARLY_NOTES = []          # log() abhi bana nahi hai — startup par flush hota hai


def _early(msg, level="INFO"):
    """Startup ke wo notes jo log() ban-ne se pehle likhne padte hain."""
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
    base_library.zip me Python ki stdlib ka wo hissa hai jo abhi tak import
    nahi hua — jaise encodings.cp1252, jo subprocess ka text output padhte
    waqt PEHLI BAAR lagta hai. _MEI ud jaye to har naya import
    "FileNotFoundError: ...base_library.zip" deta hai.

    Isliye uski ek copy APPDATA me rakh kar sys.path ki entry hi badal dete
    hain — uske baad Python _MEI wali file ko haath hi nahi lagata.
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
            return                       # copy hi nahi bani — kuch mat chhedo
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
        # zipimport ka purana cache hata do, warna wahi mari hui file khulegi
        for k in list(sys.path_importer_cache):
            try:
                if os.path.normcase(os.path.abspath(k)) == target:
                    sys.path_importer_cache.pop(k, None)
            except Exception:
                continue
        # ── Sirf sys.path badalna KAAFI NAHI HAI ──
        # `encodings`, `collections`, `re` — teeno package interpreter ke
        # startup par hi import ho jaate hain, aur inka __path__ SEEDHA _MEI
        # wali zip ke andar point karta hai. Inka koi bhi lazy submodule
        # (jaise encodings.utf_8_sig) sys.path dekhta hi NAHI — sirf apne
        # package ka __path__ dekhta hai. Isliye unhe bhi nayi copy par
        # mod dena padta hai.
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
        _early("base_library pin fail (%s) - _MEI wali copy hi chalegi" % e, "WARN")


# _MEI se nikaal kar APPDATA me rakhne wali files. Ye Python module nahi hain,
# isliye inhe "preload" nahi kiya ja sakta — copy hi ek raasta hai.
_MIRROR_FILES = ("SumatraPDF.exe", "agent_panel.html", "qrseprint.ico",
                 "SumatraPDF-settings.txt")


def _mirror_bundled_files():
    """Zaroori bundle files ki pakki copy APPDATA me."""
    mei = _mei_dir()
    if not mei:
        return
    try:
        os.makedirs(_RUNTIME_DIR, exist_ok=True)
    except Exception as e:
        _early("runtime folder nahi bana (%s)" % e, "WARN")
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
            # Purani copy chal rahi ho (SumatraPDF khula ho) to copy fail
            # ho sakti hai — us haalat me wahi purani copy kaam de degi.
            _early("mirror %s fail (%s)" % (name, e), "WARN")


# Ye module job ke waqt PEHLI BAAR import hote the. Tab tak _MEI ud chuka ho
# to job crash ho jaata tha. Ab shuruaat me hi memory me le aate hain.
_CRITICAL_PRELOAD = (
    "Crypto.Util._cpu_features", "Crypto.Util.Padding", "Crypto.Util.strxor",
    "Crypto.Util.number", "Crypto.Cipher.AES", "Crypto.Cipher.ARC4",
    "Crypto.Hash.MD5", "Crypto.Hash.SHA256",
    "PyPDF2",
)
# Inka na milna ghaatak nahi — mil jayen to aur mazboot ho jaata hai.
_OPTIONAL_PRELOAD = (
    "ctypes", "ctypes.wintypes", "traceback", "tempfile", "winreg",
    "socket", "webbrowser", "certifi", "win32print", "PIL.Image",
)


def _preload_fragile():
    """
    Ek baar module import ho jaye to wo sys.modules me reh jaata hai aur uski
    .pyd Windows ki memory me map ho jaati hai. Uske baad file delete ho bhi
    jaye to code chalta rehta hai. Isliye risk wale saare module yahin,
    shuruaat me, load kar lete hain — jab _MEI poora salaamat hai.
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
    # ── SAARE CODEC ──
    # Codec base_library.zip me rehte hain aur PEHLI BAAR tab load hote hain
    # jab zaroorat padti hai — jaise subprocess ka text output padhna ya
    # "utf-8-sig" me file likhna. Tab tak _MEI saaf ho chuka ho to
    # "FileNotFoundError: ...base_library.zip" aata tha (screenshot wala
    # "Bada dialog fail"). Ab sabhi abhi load kar lete hain — ye ~100 chhoti
    # .pyc hain, aadhe second se bhi kam lagta hai.
    codec_names = set()
    try:
        # 1. Sabse pakka source: zip me jo encodings/*.pyc hain wahi
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
        # 2. Fallback — alias table se (isme utf_8_sig NAHI hota, isliye
        #    neeche wali list bhi zaroori hai)
        import encodings.aliases
        codec_names.update(encodings.aliases.aliases.values())
    except Exception:
        pass
    # 3. Jinka koi alias nahi hai par kaam me aate hain
    codec_names.update(("utf_8", "utf_8_sig", "utf_16", "utf_16_le", "utf_16_be",
                        "utf_32", "ascii", "latin_1", "mbcs", "oem", "cp1252",
                        "cp437", "cp850", "idna", "unicode_escape",
                        "raw_unicode_escape", "punycode", "hex_codec"))
    for _c in codec_names:
        try:
            __import__("encodings." + _c)
        except Exception:
            pass
    # Console / locale ka apna encoding bhi pakka kar lo
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
        _early("Preload OK - %d zaroori module + %d codec memory me"
               % (len(_CRITICAL_PRELOAD), len(codec_names)))
    return not missing


def _mei_intact():
    """_MEI folder ki nishani files abhi bhi hain ya nahi."""
    mei = _mei_dir()
    if not mei:
        return True                      # onedir / .py mode — sawaal hi nahi
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
    Har 5 minute me ek nazar: _MEI folder salaamat hai ya nahi.

    Khud koi ilaaj nahi karta — ilaaj upar wali teen parat pehle hi kar chuki
    hain. Ye sirf EK BAAR log me saaf-saaf likh deta hai, taaki agli baar ye
    dikkat ghanta bhar dhoondhni na pade.
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
        log("⚠️  Agent ka temp folder (%s) kisi ne saaf kar diya hai." % _mei_dir(),
            "WARN")
        log("   Printing chalti rahegi — zaroori files ki copy %s me rakhi hai."
            % _RUNTIME_DIR, "WARN")
        log("   Fursat me agent band karke dobara chalu kar lena.", "WARN")
    except Exception:
        pass


_pin_base_library()
_mirror_bundled_files()
_preload_fragile()

LOCAL_VERSION_FILE = os.path.join(_APPDATA_DIR, "agent_version.txt")
SHOP_CONFIG_FILE   = os.path.join(_APPDATA_DIR, "shop_config.txt")
APPROVAL_CONFIG    = os.path.join(_APPDATA_DIR, "approval_mode.txt")
AGENT_TOKEN_FILE   = os.path.join(_APPDATA_DIR, "agent_token.txt")
# Jab owner exe par dobara double-click kare, doosra instance yahan ek
# chhoti file chhod jaata hai. CHALU agent use dekh kar apna panel khol
# deta hai. (Iske bina doosra instance chup-chaap band ho jaata tha aur
# owner ko lagta tha "kuch hua hi nahi".)
PANEL_REQUEST_FILE = os.path.join(_APPDATA_DIR, "show_panel.request")


def _machine_name():
    """PC ka naam — sirf dikhane ke liye ("kis computer par juda hai")."""
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

# Tray icon ke liye global state — taaki tray menu se live status dikhaya ja sake
agent_state = {
    "status": "Starting...",
    "printer": "Unknown",
    "tray_icon": None,
    "running": True,
    # "online" | "connecting" | "offline" — tray aur desktop panel dono
    # isi se apna status dot dikhate hain.
    "connection": "connecting",
    # Reconnect to Server button set karta hai; print_loop ise consume karta hai.
    "reconnect_requested": False,
}

# Log file kabhi rotate nahi hoti thi — mahino chalne wale PC par ye
# badhti hi rehti thi. Ab 2 MB par ek baar .old me chali jaati hai.
# Sirf 1 backup rakhte hain: purani log itni purani ho jaati hai ki
# uska koi kaam nahi bachta, aur disk bharna is se bada problem hai.
LOG_MAX_BYTES = 2 * 1024 * 1024


def _rotate_log_if_big():
    """2 MB se badi ho to log ko .old bana kar nayi shuru karo."""
    try:
        if os.path.getsize(LOG_FILE) < LOG_MAX_BYTES:
            return
    except OSError:
        return          # file hai hi nahi — kuch karne ki zaroorat nahi
    old = LOG_FILE + ".old"
    try:
        if os.path.exists(old):
            os.remove(old)
        os.replace(LOG_FILE, old)
    except Exception:
        # Rotation fail ho jaye to bhi logging ruknI nahi chahiye
        pass


def log(msg, level="INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{level}] {msg}"
    try:
        print(line)
    except Exception:
        pass  # .exe windowed mode mein console hi nahi hota, print() fail ho sakta hai
    try:
        _rotate_log_if_big()
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except:
        pass

# ─── BACKGROUND THREAD KA CRASH BHI LOG ME AAYE ──────────────────────
# Python by default background thread ka traceback stderr par bhejta hai.
# Windowed .exe me stderr hai hi nahi — wo traceback kahin nahi jaata.
# Isi wajah se "na tray icon, na panel, aur log bilkul saaf" wali halat
# banti thi: pystray apna tray window ek alag thread me banata hai, wahan
# koi exception aata to wo thread chup-chaap mar jaata aur kisi ko pata
# hi nahi chalta ki hua kya.
def _thread_excepthook(args):
    try:
        import traceback as _tb
        tname = getattr(getattr(args, "thread", None), "name", "?")
        log(f"💥 Background thread '{tname}' crash: "
            f"{args.exc_type.__name__}: {args.exc_value}", "ERROR")
        log("".join(_tb.format_exception(
            args.exc_type, args.exc_value, args.exc_traceback)), "ERROR")
    except Exception:
        pass          # logging khud fail ho jaye to bhi process na ruke


try:
    threading.excepthook = _thread_excepthook          # Python 3.8+
except Exception:
    pass


def is_running_as_exe():
    """
    PyInstaller se bana .exe chal raha hai ya normal Python script?
    .exe mode mein sab dependencies already bundled hoti hain.
    """
    return getattr(sys, 'frozen', False)

# ─── SAFE CHILD PROCESS ENVIRONMENT (PyInstaller onefile fix) ─────────
# PyInstaller ka --onefile bootloader apne aap ko batane ke liye kuch env
# variables set karta hai (_MEIPASS2 / _PYI_APPLICATION_HOME_DIR). Agar hum
# subprocess.Popen se naya .exe launch karein to ye variables CHILD ko
# inherit ho jaate hain. Tab naya .exe sochta hai "main already unpacked
# hoon" aur apna alag temp folder extract NAHI karta — wahi purana
# _MEIxxxxxx use karta hai. Purana process exit hote hi uska bootloader
# us folder ko DELETE kar deta hai, aur naya process beech import mein hi
# mar jaata hai:
#     [Errno 2] No such file or directory: ...\Temp\_MEIxxxxx\base_library.zip
# Isliye har child launch se pehle ye variables hata do.
# Version label format check: "2.0", "2.10", "3.1" — teen digit tak allowed.
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
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP — parent ke marne par
        # child bhi na mare, aur Ctrl+C signals share na hon.
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
        # PowerShell ki single-quoted string me ' ko '' likhna padta hai.
        # Bina iske kal koi prompt me apostrophe daal de (jaise "shop's ID")
        # to poori command toot jaati aur box khaali aata.
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
    Ek hi Windows dialog me Shop ID aur PASSWORD poochho.

    InputBox se ye kaam nahi ho sakta - usme password dots me nahi
    chhupta. Isliye PowerShell se ek chhota WinForms box banate hain.
    WinForms har Windows par .NET ke saath pehle se hota hai.

    Returns (shop_id, password) ya None (cancel / fail).
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
        # Text ko script me daalte waqt quote todna nahi chahiye
        script = script.replace("__TITLE__", str(title).replace("'", "''"))
        script = script.replace("__HEAD__", str(head).replace("'", "''"))

        fd, ps1 = tempfile.mkstemp(suffix=".ps1")
        # BOM khud likh rahe hain (b"\xef\xbb\xbf") - "utf-8-sig" CODEC use
        # karne se bachne ke liye. Wo codec base_library.zip me rehta hai aur
        # PEHLI BAAR theek yahin load hota tha; _MEI saaf ho chuka ho to yahi
        # line "FileNotFoundError: ...base_library.zip" deti thi - screenshot
        # wala "Bada dialog fail" isi se aaya tha.
        with os.fdopen(fd, "wb") as f:
            f.write(b"\xef\xbb\xbf" + script.encode("utf-8"))

        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-File", ps1],
            capture_output=True, text=True, timeout=600,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

        lines = (out.stdout or "").splitlines()
        if len(lines) < 2:
            return None                      # Cancel dabaya ya box hi nahi khula
        sid = lines[0].strip().upper()
        pwd = lines[1]                       # password ko strip MAT karo
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
    Demo -> Paid, bina desktop panel ke.

    Jis PC par WebView2 nahi hai wahan panel khulta hi nahi, aur pehle
    is wajah se demo shop kabhi paid ban hi nahi sakti thi. Ye wahi do
    server endpoint use karta hai jo panel karta hai, isliye dono taraf
    ek hi niyam chalte hain.
    """
    try:
        creds = _ps_shop_login(
            "Enter your paid Shop ID and password.\n"
            "This agent will connect to that shop.")
        if not creds:
            return
        pid, pwd = creds

        # ── Step 1: verify (yahan kuch badalta NAHI) ──
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
    Ek line ka input, par BADA aur saaf.

    VisualBasic ka InputBox (jo _powershell_input use karta hai) chhota
    hota hai aur uska font/size badla hi nahi ja sakta -- naye shop owner
    ko sabse pehle wahi dikhta tha, aur bahut purana lagta tha.
    Ye WinForms wala box wahi tareeka hai jo _ps_shop_login me chal raha
    hai, isliye koi nayi nirbharta nahi.

    Returns: type kiya hua text, ya "" (cancel / box hi na bane).
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
        # BOM khud likh rahe hain (b"\xef\xbb\xbf") - "utf-8-sig" CODEC use
        # karne se bachne ke liye. Wo codec base_library.zip me rehta hai aur
        # PEHLI BAAR theek yahin load hota tha; _MEI saaf ho chuka ho to yahi
        # line "FileNotFoundError: ...base_library.zip" deti thi - screenshot
        # wala "Bada dialog fail" isi se aaya tha.
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
        log(f"Bada input box fail ({e}) - purane InputBox par ja rahe hain", "WARN")
        return None                      # None = "try nahi hua", "" = cancel
    finally:
        try:
            if ps1 and os.path.exists(ps1):
                os.remove(ps1)
        except Exception:
            pass


def _ask_shop_id_once():
    """Shop ID poochho — pehle bada box, na bane to purana InputBox."""
    v = _ps_input_big(
        head="Welcome to Echel",
        sub="Enter your Shop ID to connect this computer",
        label="Shop ID",
        hint="Your Shop ID is available in your shop dashboard.\n"
             "Sign in to your Echel account to find it.",
        title="Echel - Setup")
    if v is not None:
        return v
    # PowerShell ka WinForms nahi chala - purana chhota box hi sahi
    return _powershell_input(
        "Paste your Shop ID (you got it after registering on the dashboard)")


def _shop_id_without_tkinter():
    """Fallback first-run setup when tkinter is unusable."""
    for _ in range(3):
        value = (_ask_shop_id_once() or "").strip().upper()
        if not value:
            break
        try:
            # CLAIM — ek Shop ID sirf EK PC par chal sakti hai.
            # Pehle sirf /api/shop/<id> se check hota tha, jo public hai aur
            # PC ka koi hisaab nahi rakhta — isliye koi bhi QR poster se
            # Shop ID padh kar apne PC me daal deta aur "verified" ho jaata.
            r = requests.post(
                f"{SERVER_URL}/api/agent/claim/{value}",
                headers=auth_headers(), timeout=30,
                json={"machine": _machine_name()})

            if r.status_code == 404:
                # Do tarah ke 404 hote hain:
                #   a) HAMARA JSON  -> Shop ID sach me galat hai
                #   b) Express ka HTML -> server purana hai, endpoint hai hi nahi
                # Dono ko ek jaisa maan lena galat tha — purane server par
                # sahi Shop ID par bhi "not found" dikh jaata tha.
                is_our_404 = False
                try:
                    is_our_404 = bool(r.json().get("error"))
                except Exception:
                    is_our_404 = False

                if is_our_404:
                    _msgbox("This Shop ID was not found on the server. Please check it.",
                            "Echel", 0x10)
                    continue

                # Purana server — purane tarike se check karke aage badho
                log("Server par claim endpoint nahi hai (purana server) — basic check", "WARN")
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
                # Kisi doosre PC par pehle se juda hua hai
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
                # Purana agent / token missing — batao par rukо mat
                log("Claim rejected (old agent build?)", "WARN")

        except Exception as e:
            # Server so raha hai ya net nahi hai — ID accept kar lo, warna
            # user phansa reh jayega. Job polling waise bhi token check
            # karti hai, isliye chori phir bhi nahi ho sakti.
            log(f"Shop ID claim check skipped: {e}", "WARN")
        return value
    try:
        return input("Enter your Shop ID: ").strip().upper()
    except Exception:
        log("❌ Could not read Shop ID — no window and no console available", "ERROR")
        return None


def show_shop_id_prompt():
    """
    Pehli baar chalne par Shop ID poochho — Windows ke apne dialog se.

    PEHLE YAHAN TKINTER KA WINDOW THA, aur wahi sabse khatarnak jagah thi:
    kai .exe build me Tcl ka data (init.tcl) nahi jaata. Tab ye window
    banti hi nahi thi, resolve_shop_id() ko khaali string milti thi aur
    agent `sys.exit(1)` kar deta tha — yaani naya install kabhi chalu hi
    nahi hota, aur log me sirf Tcl ki galti dikhti thi.

    PowerShell ka InputBox Windows ka apna hissa hai — na bundle karna
    padta hai, na kabhi missing hota hai.
    """
    return _shop_id_without_tkinter()

def resolve_shop_id():
    """
    Shop ID kahan se aaye, priority order:
    1. SHOP_ID_TEMPLATE agar already replace hui hai (.py source download wala flow)
    2. Saved config file (%APPDATA%/EchelPrint/shop_config.txt) — pehle se setup ho chuka hai
    3. GUI popup se naya Shop ID poocho (sirf pehli baar, .exe mode mein)
    """
    if SHOP_ID_TEMPLATE != UNCONFIGURED_MARKER:
        # .py source mode — Shop ID already baked hai is file mein
        return SHOP_ID_TEMPLATE

    if os.path.exists(SHOP_CONFIG_FILE):
        try:
            with open(SHOP_CONFIG_FILE, 'r', encoding='utf-8') as f:
                saved_id = f.read().strip()
                if saved_id:
                    return saved_id
        except Exception:
            pass

    # Pehli baar chal raha hai aur Shop ID kahin nahi mila — GUI se poocho
    shop_id = show_shop_id_prompt()
    if not shop_id:
        # User ne window band kar di bina Shop ID daale — agent chal nahi sakta
        sys.exit(1)

    try:
        with open(SHOP_CONFIG_FILE, 'w', encoding='utf-8') as f:
            f.write(shop_id)
    except Exception:
        pass

    return shop_id

# ─── SINGLE INSTANCE LOCK (crash-safe, PID based) ─────────────────────
# Purana Windows Mutex crash/sleep/force-kill pe orphan reh jaata tha —
# phir naya agent "already exists" samajh ke chupchaap exit ho jaata,
# tray me kuch nahi aata. Ab PID lockfile use karte hain: agar lock file
# me likha process ZINDA hai tabhi exit karo; warna (crash ho chuka hai)
# lock ko apne naam kar lo. Isse double-print bhi rukta hai aur silent
# exit wala bug bhi khatam.
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

_MUTEX_HANDLE = None          # process khatam hone tak zinda rakhna zaroori hai
_MUTEX_NAME = "Local\\EchelPrintAgent_SingleInstance"


def _single_instance_by_pidfile():
    """Fallback (non-Windows / mutex fail). Race-prone, isliye sirf backup."""
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

# ⚠️ _ensure_single_instance() SIRF EK BAAR chalni chahiye — wo mutex
# banati hai, to doosri call apne hi mutex ko dekh kar "koi aur chal raha
# hai" samajh leti aur agent chalu hi na hota. Isliye nateeja yahan rakh
# lete hain.
_SINGLE_OK = _ensure_single_instance()

# Windows ne khud chalaya hai (login par) aur koi copy pehle se chal rahi
# hai — to yahan kuch dikhana nahi hai. Ye har restart par hota tha aur
# owner ko har baar OK dabana padta tha.
# (Flag ka naam AUTOSTART_FLAG me bhi hai, par wo neeche define hota hai —
#  isliye yahan seedha likha hai. Dono ek jaise rakhna.)
if not _SINGLE_OK and "--autostart" in sys.argv:
    sys.exit(0)

if not _SINGLE_OK:
    # ── PEHLE YAHAN SIRF sys.exit(0) THA ──
    # Owner exe par double-click karta, kuch nahi hota, aur log me bas ek
    # line aati thi jo wo dekhta hi nahi. Usse lagta tha "software chalta
    # hi nahi hai" — jabki agent pehle se background me chal raha hota tha.
    #
    # Ab do kaam karte hain:
    #   1. Chalu agent ke liye ek request file chhod dete hain -- wo apna
    #      panel khol lega (yahi owner double-click se chahta hai).
    #   2. Owner ko saaf batate hain ki hua kya.
    log("⛔ Agent is already running — asking the running copy to show its panel")
    try:
        with open(PANEL_REQUEST_FILE, "w", encoding="utf-8") as _f:
            _f.write(str(int(time.time())))
    except Exception as _e:
        log(f"Panel request file nahi bani: {_e}", "WARN")

    # Chalu agent ko file dekhne ka mauka do, phir hi message dikhao —
    # warna panel khulne se pehle hi popup aa jaata hai.
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

# ─── AUTO STARTUP (PC restart pe tray mein khud start ho) ─────────────
STARTUP_VBS_NAME = "EchelPrintAgent.vbs"


# Windows login par jo copy chalti hai uske saath ye flag jaata hai.
# Agent do jagah se autostart hota hai (registry Run key + Startup folder
# ka VBS) — dono jaan-boojh kar hain, kyunki antivirus aksar Run key uda
# deta hai. Restart par dono chalti hain aur ek mutex par haar jaati hai.
# Pehle haarne wali copy owner ko popup dikha deti thi — har restart par.
# Ab flag dekh kar wo chupchaap band ho jaati hai.
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
    # CRITICAL FIX: yahan bare print() tha — try ke bahar. --noconsole exe
    # mein sys.stdout None hota hai, print() AttributeError deta, aur yeh
    # main() ki PEHLI line hai — matlab exe har launch pe turant FATAL
    # CRASH ho jaata tha (log mein "'NoneType' object has no attribute
    # 'write'" dikhta hai). log() already guarded hai, isliye usi se bhejo.
    log(f"Echel - Local Agent v{VERSION_LABEL} | Tray + Auto-Update + Fit-A4")
    # Bundle me kya hai kya nahi - guess mat karo, log me likho.
    try:
        bundle_selfcheck()
    except Exception as _bse:
        log(f"Bundle self-check fail: {_bse}", "WARN")

def check_printer():
    """
    NOTE: Agent hamesha Windows ke "Default Printer" ko use karta hai —
    yeh wahi printer hai jo dashboard mein "🔍 Auto Detect" option ka matlab hai.
    Agar shop owner ne dashboard mein specific model bhi select kiya ho (jaise
    "Canon PIXMA G2010"), woh sirf record/display ke liye hai — actual printing
    isi system default printer se hoti hai. Isliye PC mein sahi printer ko
    "Set as Default Printer" karna zaroori hai (Windows Settings > Printers).
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
    try:
        import win32print
        printers = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        )
        return [p[2] for p in printers]  # index 2 = printer name
    except ImportError:
        return []
    except Exception as e:
        log(f"⚠️  Printer list error: {e}", "WARN")
        return []

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
# IDEMPOTENCY — ek job kabhi do baar print na ho
# ═══════════════════════════════════════════════
# Server 'printing' claim karke duplicate rokta hai, par agent ke restart /
# stuck-job requeue ke baad wahi job dobara aa sakta hai. Ye local record
# usko bhi rok deta hai. Disk par isliye taaki restart ke baad bhi yaad rahe.
_PROCESSED_PATH = os.path.join(_APPDATA_DIR, "processed_jobs.json")
_processed_jobs = {}

def _load_processed():
    global _processed_jobs
    try:
        with open(_PROCESSED_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        cutoff = time.time() - 7 * 24 * 3600          # 7 din se purane bhool jao
        _processed_jobs = {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > cutoff}
    except Exception:
        _processed_jobs = {}

def _save_processed():
    # Atomic write — beech me power chali jaye to file corrupt na ho
    try:
        tmp = _PROCESSED_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_processed_jobs, f)
        os.replace(tmp, _PROCESSED_PATH)
    except Exception as e:
        log(f"Could not save processed-job list: {e}", "WARN")

_inflight_jobs = set()          # abhi is waqt print ho rahe job IDs

def already_processed(job_id):
    return job_id in _processed_jobs

def mark_processed(job_id):
    _processed_jobs[job_id] = time.time()
    if len(_processed_jobs) > 500:                    # sabse purane hata do
        for k in sorted(_processed_jobs, key=_processed_jobs.get)[:200]:
            _processed_jobs.pop(k, None)
    _save_processed()

def get_download_url(job_id, fallback_url):
    """
    Server se is job ka authorized download URL maango.
    Server sirf URL deta hai — PDF uske through NAHI jaati; agent Cloudinary
    se seedha download karta hai.
    Purana server ye endpoint nahi jaanta, to job me aaya file_url use karo.
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
            # Job ab printable nahi (dusri shop ka / paid nahi / file delete)
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
    """Sirf status message — koi file wapas server ko nahi jaati."""
    try:
        requests.post(
            f"{SERVER_URL}/api/jobs/{SHOP_ID}/{job_id}/downloaded",
            headers=auth_headers(), timeout=10,
            json={"ok": bool(ok), "bytes": bytes_count, "error": (str(err)[:180] if err else "")})
    except Exception:
        pass          # best-effort, print kabhi na ruke

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

# ─── Problem 1: Image to PDF convert — A4 page banake usme image fit karo ─────
def convert_image_to_pdf(image_path):
    """
    JPG/PNG ko A4-size PDF page mein convert karo.

    Do scenarios handle karte hain:
    1. Image already A4 ratio mein hai (Canvas Editor se aaya — customer ne
       khud A4 page pe drag/resize/position set kiya tha) — is case mein
       hum SEEDHA wahi image PDF mein wrap karte hain, DOBARA zoom-fit nahi
       karte, warna customer ki careful positioning distort ho jayegi.
    2. Normal photo/scan hai (chhota ya alag ratio) — A4 page ke center
       mein zoom karke fit karte hain jaisa pehle se ho raha tha.
    """
    try:
        from PIL import Image
        log(f"🔄 Converting image to A4 PDF...")

        img = Image.open(image_path)

        # RGB mein convert karo (PNG mein RGBA ho sakta hai)
        if img.mode in ('RGBA', 'LA', 'P'):
            background = Image.new('RGB', img.size, (255, 255, 255))
            if img.mode == 'P':
                img = img.convert('RGBA')
            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = background
        elif img.mode != 'RGB':
            img = img.convert('RGB')

        # A4 ka size 300 DPI pe (print quality ke liye)
        dpi = 300
        a4_width_px = int(8.27 * dpi)   # 210mm
        a4_height_px = int(11.69 * dpi)  # 297mm
        a4_ratio = a4_width_px / a4_height_px

        img_ratio = img.width / img.height
        ratio_diff = abs(img_ratio - a4_ratio)

        # Agar image ka ratio A4 se bahut close hai (Canvas Editor se aaya hai),
        # to seedha resize karke wrap karo — koi extra zoom/margin nahi
        if ratio_diff < 0.01:
            log("ℹ️  Image is already A4 ratio (Canvas Editor output) — using it as is")
            a4_canvas = img.resize((a4_width_px, a4_height_px), Image.LANCZOS)
        else:
            # Create a full white A4 canvas
            a4_canvas = Image.new('RGB', (a4_width_px, a4_height_px), (255, 255, 255))

            # Image ko A4 canvas ke andar MAXIMUM size mein fit karo (zoom karke)
            # taaki chhota image bhi bada print ho, chhota corner mein na rahe
            # 95% margin rakhte hain thoda safe area ke liye
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

            # Center mein paste karo
            paste_x = (a4_width_px - new_width) // 2
            paste_y = (a4_height_px - new_height) // 2
            a4_canvas.paste(img_resized, (paste_x, paste_y))

        # PDF save karo with correct DPI metadata
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

# ─── Page Range: Specific pages extract karo PDF se ────────
def extract_selected_pages(pdf_path, selected_pages_str, total_pages=None):
    """
    Agar customer ne specific pages select kiye hain (jaise "5" ya "1,3,5-8")
    to PyPDF2 se sirf wahi pages ka naya PDF banao.
    Agar selected_pages_str empty hai to original PDF wapas bhejo (sab pages print karo).

    IMPORTANT: Agar yeh function kisi bhi reason se fail ho jaye,
    hum None return karte hain (original PDF nahi) — taaki kabhi
    accidentally poora document print na ho jab customer ne sirf
    kuch pages select kiye the. Yeh galat-billing print se zyada
    safe hai.
    """
    if not selected_pages_str or not selected_pages_str.strip():
        return pdf_path  # All pages selected — kuch extract nahi karna

    # pypdf/PyPDF2 import — pypdf (actively maintained fork) ko priority
    # dete hain kyunki ye real-world "ajeeb" PDFs (scanner apps, govt
    # portals, non-UTF8 metadata) ko zyada gracefully handle karta hai.
    # PyPDF2 3.x abhi bhi kaam karta hai isliye fallback rakha hai.
    # ── PDF library ──
    #
    # YAHAN 22 Aug 2026 WALA CRASH THA. Pehle yahan `except ImportError` tha.
    # PyPDF2 khulte waqt pycryptodome ki .pyd load karta hai; wo file na mile
    # to pycryptodome **OSError** uthata hai, ImportError nahi
    # (Crypto/Util/_raw_api.py -> raise OSError("Cannot load native module...")).
    # ImportError-only handler use pakadta hi nahi tha, aur ye imports neeche
    # wale bade try/except ke BAHAR hain — isliye exception seedha
    # process_job() tak pahunch kar "Job crashed" ban jaata tha, aur
    # print_file() ka SumatraPDF page-range fallback kabhi chala hi nahi.
    #
    # Ab har exception pakadte hain. Library na mile to None lautate hain,
    # jispar print_file() SumatraPDF se seedha page range chhaap deta hai.
    PdfReader = None
    PdfWriter = None
    _pdf_err = None
    for _modname in ("pypdf", "PyPDF2"):
        try:
            _m = __import__(_modname, fromlist=["PdfReader", "PdfWriter"])
            PdfReader, PdfWriter = _m.PdfReader, _m.PdfWriter
            break
        except Exception as e:          # ImportError + OSError (gayab .pyd) dono
            _pdf_err = e

    if PdfReader is None:
        # Script mode me library SACH ME missing ho sakti hai — wahan install
        # karna theek hai. Do shart:
        #   * .exe me pip hota hi nahi, isliye wahan koshish bekaar
        #   * OSError ka matlab hai library hai par uski .pyd nahi mili —
        #     usme pip install se kuch nahi hota, sirf 10 second jaate hain
        if (not is_running_as_exe()) and isinstance(_pdf_err, ImportError):
            log("⚠️  pypdf/PyPDF2 not found! Installing...", "WARN")
            os.system("pip install pypdf pycryptodome --quiet")
            try:
                from pypdf import PdfReader, PdfWriter
            except Exception as e:
                log(f"❌ pypdf installation also failed: {e}", "ERROR")
                PdfReader = None
        if PdfReader is None:
            log(f"⚠️  PDF library load nahi hui ({_pdf_err}) — "
                f"page range ab SumatraPDF se nikalega", "WARN")
            return None

    try:
        page_numbers = [int(p.strip()) for p in selected_pages_str.split(',') if p.strip()]
        if not page_numbers:
            log("⚠️  Page list is empty — the original PDF will be printed", "WARN")
            return pdf_path

        # ── KOI FAST-PATH NAHI ── hamesha extract karo.
        #
        # Pehle yahan do shortcut the aur DONO galat the:
        #   1) "page_numbers == [1]"  -> 2-page PDF me page 1 chunne par bhi
        #      poora document print ho jata tha.
        #   2) "len(page_numbers) >= total_pages" -> ye bhi kaam nahi karta,
        #      kyunki total_pages BILLING ka count hai (kitne page ka paisa
        #      liya), PDF ka asli page count NAHI. Page 1 chuno to
        #      total_pages=1 aata hai, isliye check hamesha TRUE ho jata tha.
        #
        # Ab pycryptodome .exe me sahi bundle hai (v20+), isliye PDF kholna
        # safe hai. Saare page chune ho tab bhi extract karna nuksan nahi —
        # wahi PDF wapas banta hai, bas thoda CPU lagta hai.

        log(f"📑 Extracting specific pages: {page_numbers}")

        try:
            reader = PdfReader(pdf_path, strict=False)
        except Exception as e1:
            # Kuch "ajeeb" PDFs (galat-encoded metadata waale) pypdf ke
            # strict-mode se crash ho jaate hain — dusri library se retry.
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

        # Encrypted na ho to crypto touch hi na ho — try/except safety
        try:
            if getattr(reader, 'is_encrypted', False):
                reader.decrypt('')
        except Exception:
            pass
        writer = PdfWriter()
        total_pdf_pages = len(reader.pages)

        added_count = 0
        for pnum in page_numbers:
            idx = pnum - 1  # 1-indexed se 0-indexed
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

        # Verify extracted file properly bani hai
        verify_size = os.path.getsize(extracted_path)
        if verify_size < 50:
            log(f"❌ Extracted PDF is empty or corrupt ({verify_size} bytes)!", "ERROR")
            return None

        log(f"✅ Extracted {added_count} page(s): {extracted_path} ({verify_size} bytes)")
        return extracted_path

    except Exception as e:
        # Crypto/native-module error = packaging issue, PDF ka dosh nahi.
        # Aise me poori file print karo (fail+requeue+DOUBLE print se behtar).
        emsg = str(e).lower()
        if 'crypto' in emsg or 'cpuid' in emsg or 'native module' in emsg:
            # Poora document print karna yahan GALAT hai — customer ne shayad
            # sirf 1 page ka paisa diya ho aur 10 page nikal jayein.
            # Print rokna hi sahi hai: shop bata dega, customer dobara bhej dega.
            log(f"❌ Crypto module missing ({e}) — cannot extract specific pages", "ERROR")
            log("⚠️  Print stopped so that extra pages are not printed.", "WARN")
            log("👉 Update the agent to v20 or newer — this is fixed there.", "WARN")
            return None
        log(f"❌ Page extract error: {e}", "ERROR")
        log(f"⚠️  SAFETY: Stopping the print so that wrong (extra) pages are not printed", "WARN")
        return None

def get_bundled_resource_path(filename):
    """
    Bundle kiye gaye file (jaise SumatraPDF.exe) ka path dhoondho.
    Teen tarah ke build support karta hai:
      1. PyInstaller --onefile : temp extraction folder -> sys._MEIPASS
      2. Nuitka --standalone / PyInstaller --onedir : exe ke saath wale folder me
      3. Normal .py script : script ke folder me
    Pehle sirf (1) tha, isliye Nuitka ka build SumatraPDF dhoondh hi nahi paata tha.
    """
    candidates = []

    # 1. PyInstaller onefile
    meipass = getattr(sys, '_MEIPASS', None)
    if meipass:
        candidates.append(os.path.join(meipass, filename))

    # 1b. APPDATA mirror — startup par _mirror_bundled_files() ne yahan copy
    #     rakhi thi. _MEI folder ud jaye (22 Aug wala case) to print aur panel
    #     isi copy se chalte rehte hain.
    candidates.append(os.path.join(_RUNTIME_DIR, filename))

    # 2. Compiled exe ke saath wala folder (Nuitka standalone / PyInstaller onedir)
    #    Nuitka __compiled__ set karta hai, PyInstaller sys.frozen
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
    "1,3,4,5" -> "1,3-5"  (SumatraPDF -print-settings ka format).

    Sirf tabhi use hota hai jab PDF library se page extract na ho paye.
    Galat/khali input par "" lautata hai, taaki galti se poora document
    print na ho jaye.
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
    SumatraPDF se print — B&W/Color setting ke saath
    'fit' flag use karte hain taaki chhota PDF/page bhi A4 paper
    ke hisaab se properly scale ho jaye, corner mein chhota na rahe.

    printer_name: agar diya gaya hai, usi SPECIFIC printer pe print hoga
    (system default ko IGNORE karke) — taaki B&W aur Color jobs alag-alag
    physical printers pe route ho sakein (jaise HP M1005 sirf B&W ke liye,
    Canon G2010 sirf Color ke liye). Agar None/empty hai, purana default-
    printer wala behavior chalega (backward compatible).
    """
    sumatra_paths = []

    # CRITICAL FIX: .exe build mein SumatraPDF.exe PyInstaller se BUNDLE
    # kiya gaya tha (--add-binary), lekin yahan kabhi check hi nahi ho raha
    # tha — sirf system-installed paths check ho rahe the. Isi wajah se
    # print agent ko bundled SumatraPDF kabhi mil hi nahi raha tha; agar
    # system pe pehle se SumatraPDF install tha (purane .py-based INSTALL.bat
    # se) to print chal jaata, warna (jaisa fresh installs ya restart ke
    # baad clean state mein) print fail ho jaata — "tray mein dikhता hai
    # lekin print nahi nikalta" exactly yehi symptom hai.
    bundled = get_bundled_resource_path('SumatraPDF.exe')
    if bundled:
        sumatra_paths.append(bundled)

    sumatra_paths += [
        r"C:\Program Files\SumatraPDF\SumatraPDF.exe",
        r"C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe",
        os.path.expanduser(r"~\AppData\Local\SumatraPDF\SumatraPDF.exe"),
    ]

    # "fit" — page ko printer paper size ke hisaab se scale karta hai
    # (chhota document A4 paper mein bada hoke print hoga, corner mein nahi rahega)
    # ⚠️ COPIES KA SAHI SYNTAX ⚠️
    # SumatraPDF me copies "Nx" se aate hain (jaise "3x" = 3 copies).
    # "copies=3" naam ka koi option Sumatra me HAI HI NAHI — wo use unknown
    # token samajh ke CHUPCHAP ignore kar deta tha. Isi wajah se customer
    # 2-3 copies chunta tha, paisa bhi 2-3 copy ka katta tha, par print
    # sirf 1 hi nikalta tha.
    # Docs: sumatrapdfreader.org/docs/Command-line-arguments -> -print-settings "3x"
    try:
        _n_copies = int(copies)
    except (TypeError, ValueError):
        _n_copies = 1
    _n_copies = max(1, min(50, _n_copies))     # server par bhi 50 ka cap hai
    copies_token = f"{_n_copies}x"

    if color_mode == "bw":
        print_settings = f"{copies_token},monochrome,{scale_mode}"
        log(f"🖨️  B&W (Monochrome) + {scale_mode} print karenge | {_n_copies} copy")
    else:
        # EXPLICIT 'color' flag — pehle kuch nahi bhejte the, to printer
        # driver ka DEFAULT chalta tha. Driver default Grayscale ho (Canon/HP
        # par common) to color job bhi B&W nikalta tha. Ab job ke hisaab se
        # force hota hai, driver default jo bhi ho.
        print_settings = f"{copies_token},color,{scale_mode}"
        log(f"🖨️  Color (explicit) + {scale_mode} print karenge | {_n_copies} copy")
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
                # -print-to specific printer ko target karta hai, default
                # printer ko bypass karke — yahi is feature ki core hai
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
                # Agar specific printer name galat/disconnected ho, default
                # printer pe fallback try karte hain (taaki print bilkul
                # ruk na jaaye — kam se kam kahin to nikal jaaye)
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
    log("SumatraPDF kahin nahi mila (na bundle me, na is PC par) - Windows "
        "shell se try kar rahe hain. Is tarike me B&W / fit / specific-"
        "printer setting LAGU NAHI hoti.", "WARN")
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
        sumatra_page_extra = ""   # sirf extraction-fail wale fallback me bharta hai

        # Problem 1: Image files ko pehle A4-fit PDF mein convert karo
        if ext in ['.jpg', '.jpeg', '.png', '.bmp', '.gif']:
            log(f"🔄 Image file detected — converting to A4 PDF...")
            converted_pdf = convert_image_to_pdf(filepath)
            if not converted_pdf:
                log("❌ Image to PDF conversion failed!", "ERROR")
                return False
            print_path = converted_pdf
        elif ext == '.pdf':
            print_path = filepath
            # Page Range: agar specific pages selected hain to extract karo
            if selected_pages:
                extracted_pdf = extract_selected_pages(filepath, selected_pages, total_pages)
                if extracted_pdf is None:
                    # Extraction fail hua (aksar .exe me PyCryptodome ka native
                    # module missing hone se: "Cannot load native module
                    # Crypto.Util._cpuid_c"). Pehle yahan print ROK diya jaata
                    # tha — shop ka kaam ruk jaata tha.
                    # Ab SumatraPDF ko seedha page range de dete hain. Sumatra
                    # khud PDF ka page range print karta hai, koi Python PDF
                    # library nahi chahiye — aur extra page bhi nahi nikalta.
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
        # ── PAPER TOKEN ── Sumatra jo sizes samajhta hai unke liye paper=
        # flag; baaki (4x6, A1) par flag skip — PDF khud sahi size ki hai,
        # driver default+fit sambhal lega. Galat/unknown token Sumatra
        # chupchaap ignore karta hai, par hum sirf known hi bhejte hain.
        _PAPER_TOKENS = {"a4": "A4", "a3": "A3", "a5": "A5", "a2": "A2",
                         "letter": "letter", "legal": "legal"}
        _ptok = _PAPER_TOKENS.get((paper_size or "a4").lower(), "")
        # Sab sizes par 'fit'. PDF ab KHUD sahi paper-size ki banti hai
        # (customer side), to 'fit' usko us kagaz par poora bhar deta hai
        # bina stretch (aspect match). Pehle 4x6 par 'noscale' tha jisse
        # chhoti image chhoti hi rehti thi (size/quality complaint).
        _scale = "fit"
        _paper_extra = f"paper={_ptok}" if _ptok else ""
        def _mix(dup_extra=""):
            # sumatra_page_extra sirf tab bharta hai jab PDF se page extract
            # nahi ho paya — tab Sumatra ko khud page range dena padta hai.
            return ",".join([t for t in (_paper_extra, dup_extra, sumatra_page_extra) if t])

        # duplex_on / duplex_mode / duplex_pages ab parameters hain —
        # v9 me yahan job.get() tha par is function me 'job' hota hi nahi
        # (NameError se HAR print fail ho raha tha)
        total_pgs = duplex_pages

        if duplex_on and duplex_mode == "auto":
            # Printer khud duplex karta hai — driver ko duplexlong flag
            log("📄 AUTO duplex — printer dono side khud chhapega")
            return print_pdf_sumatra(print_path, copies, color_mode, printer_name, extra=_mix("duplexlong"), scale_mode=_scale)

        if duplex_on and duplex_mode == "manual" and total_pgs > 1:
            # Do-pass manual duplex: pehle ODD pages (1,3,5...), phir owner
            # pages palat ke lagaye, phir EVEN pages (2,4,6...).
            # Server manual-duplex par copies=1 force karta hai.
            # NOTE: 3+ sheets par even-pass ka order printer ke output
            # stacking par depend karta hai (face-down laser = seedha sahi;
            # face-up par owner stack palat le). 1-2 page docs par hamesha sahi.
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
                return True  # front print hua tha, job done

        if duplex_on and total_pgs <= 1:
            log("📄 Duplex was selected but there is only 1 page — printing normally")

        # PDF print karo with fit-to-page (image bhi ab already A4-fitted PDF hai)
        success = print_pdf_sumatra(print_path, copies, color_mode, printer_name, extra=_mix(), scale_mode=_scale)
        return success

    except Exception as e:
        # Pehle yahan sirf try/finally tha — koi bhi anokha exception seedha
        # process_job() tak jaakar "Job crashed" banta tha. Ab yahin rok kar
        # False lautate hain: job saaf-saaf "failed" mark hota hai, agent
        # chalta rehta hai, aur log me asli wajah dikhti hai.
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
    Ek hi Session, jisme chhoti network dikkat par apne aap retry hota hai.
    Connection reuse hota hai, isliye idle ke baad wala pehla request
    fail hone ka chance bahut kam ho jaata hai.
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
    """Reconnect par purana session poori tarah phenk do — naye socket banenge."""
    global _http
    try:
        if _http is not None:
            _http.close()
    except Exception:
        pass
    _http = None

class PollError(Exception):
    """Server tak poll pahunch hi nahi paya (socket/network/server)."""
    pass


_poll_last_logged = 0.0


def _log_poll_problem(msg):
    """
    Poll fail har baar log karein to 10 second me ek line — file
    bhar jaati hai aur asli baat dab jaati hai. Isliye: pehli fail
    turant, uske baad har 60s me ek baar.
    """
    global _poll_last_logged
    now = time.time()
    if now - _poll_last_logged >= 60:
        _poll_last_logged = now
        log(msg, "WARN")


def _reset_poll_log():
    """Connection wapas aane par counter reset — agli dikkat turant log ho."""
    global _poll_last_logged
    _poll_last_logged = 0.0


def get_pending_jobs():
    """
    Returns:
        list  -- server ne jawab diya (khaali list = sach me koi job nahi)
        None  -- poll FAIL hua

    Ye farak sabse zaroori hai. Pehle dono case me [] lautta tha,
    isliye print_loop() network failure ko "koi job nahi" samajh
    leta tha aur saari recovery band ho jaati thi.
    """
    global _demo_expired_shown, _shop_missing_count, _shop_gone
    try:
        # lp = long poll. Naya server itni der line pakdega aur job aate
        # hi turant bhej dega. PURANA server is param ko nahi jaanta — wo
        # ise chup-chaap ignore karke turant khaali jawab de dega, aur
        # agent apne aap purane sleep-wale tarike par chalta rahega.
        url = f"{SERVER_URL}/api/jobs/pending/{SHOP_ID}"
        if MACHINE_ID:
            url += f"?m={MACHINE_ID}&v={VERSION}&vl={VERSION_LABEL}&lp={LP_SECONDS}"
        else:
            url += f"?v={VERSION}&vl={VERSION_LABEL}&lp={LP_SECONDS}"
        # timeout server ke hold se zyada — warna har long poll "fail" lagega
        resp = http().get(url, headers=auth_headers(), timeout=LP_TIMEOUT)
        if resp.status_code == 403:
            # Purana message "use 'Re-link agent'" kehta tha — dashboard me
            # us naam ka koi button hai hi nahi, isliye shop owner dhoondta
            # reh jaata tha. Asli jagah ye hai:
            #   Dashboard -> Settings -> "Connected Computer" ->
            #   "Disconnect Computer"
            # Uske baad agent khud dobara link ho jaata hai.
            log("❌ Server ne is PC ka agent token reject kar diya. "
                "Shop dashboard kholo -> Settings -> 'Connected Computer' -> "
                "'Disconnect Computer' dabao, phir ye agent band karke dobara "
                "chalao. Wo apne aap link ho jayega.", "ERROR")
            update_tray_status("Connection denied — select 'Disconnect Computer' in your dashboard")
            return []
        if resp.status_code == 404:
            # Do tarah ke 404 hote hain (yahi farak claim wale code me bhi hai):
            #   a) HAMARA JSON  -> shop sach me server par nahi hai
            #   b) Express ka HTML -> purana server, endpoint hai hi nahi
            # (b) par rukna galat hoga — wo retry ka maamla hai.
            _our_404 = False
            try:
                _our_404 = bool(resp.json().get("error"))
            except Exception:
                _our_404 = False

            if not _our_404:
                _log_poll_problem("Server ne 404 bheja (purana server?) — dobara koshish karenge")
                return None

            # Ek 404 kaafi nahi — network blip ya ek kharab jawab agent ko
            # 30 minute ke liye sula na de. Lagatar 3 chahiye.
            _note_shop_missing()
            if _shop_gone:
                return []           # [] = "koi job nahi", None nahi —
                                    # warna PollError uth kar tray ko
                                    # "Offline" kar deta aur backoff churn
                                    # shuru ho jaata.
            _log_poll_problem("Server ne 404 bheja — dobara koshish karenge")
            return None

        if resp.status_code != 200:
            # Server ne jawab to diya par galat status (502/503 =
            # Render abhi jag raha hai). Ise "koi job nahi" maan
            # lena galat hai — retry/backoff chalna chahiye.
            _log_poll_problem(f"Server ne {resp.status_code} bheja — dobara koshish karenge")
            return None
        d = resp.json()
        _clear_shop_missing()      # jawab aa gaya = shop hai. Nishan hatao.
        if d.get("demo_expired"):
            update_tray_status("⏰ Demo has ended — please register!")
            if not _demo_expired_shown:
                _demo_expired_shown = True
                log("⏰ Demo period has ended — register to get a new Shop ID")
                threading.Thread(target=_show_demo_expired_popup, daemon=True).start()
            return []
        return d.get("jobs", [])
    except Exception as e:
        # YAHI WO JAGAH THI jahan bug baitha tha: pehle yahan
        # `return []` tha, bina kisi log ke. Dead socket, timeout,
        # DNS fail — sab chup-chaap "koi job nahi" ban jaate the.
        _log_poll_problem(f"Server se baat nahi ho paayi: {type(e).__name__} — {e}")
        return None

_demo_expired_shown = False

# Shop server par mila hi nahi — kitni baar lagatar, aur kya hum ruk chuke hain
_shop_missing_count = 0
_shop_gone = False
_shop_gone_shown = False


def _note_shop_missing():
    """Lagatar 404 ginta hai. Teesre par agent dheema pad jaata hai."""
    global _shop_missing_count, _shop_gone, _shop_gone_shown
    _shop_missing_count += 1
    if _shop_missing_count < 3 or _shop_gone:
        return
    _shop_gone = True
    log("🛑 Ye Shop ID ab server par nahi hai. Shayad demo khatam ho gaya "
        "ya shop delete ho gayi. Agent ne poochna lagbhag band kar diya — "
        "ab har 30 minute me ek baar dekhega. Naya Shop ID mile to agent "
        "band karke dobara chalao.", "ERROR")
    update_tray_status("Shop ID unavailable — enter a new Shop ID")
    if not _shop_gone_shown:
        _shop_gone_shown = True
        threading.Thread(target=_show_shop_gone_popup, daemon=True).start()


def _clear_shop_missing():
    """Poll safal — matlab shop hai. Sab wapas normal."""
    global _shop_missing_count, _shop_gone
    if _shop_missing_count or _shop_gone:
        if _shop_gone:
            log("✅ Shop ID wapas mil gayi — normal speed par laut rahe hain")
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
            # Avdhi JAAN-BOOJH KAR nahi likhte. Superadmin ise 15 minute
            # se 24 ghante ke beech kabhi bhi badal sakta hai, aur server
            # sirf "demo_expired" bhejta hai -- kitni der thi, ye nahi.
            # Pehle yahan "2-hour" hardcoded tha, jo galat dikhta tha.
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
# Demo shop ID par agent chal raha ho to subah 9 baje se raat 8 baje
# tak 4 baar yaad dilata hai — Monthly ya Lifetime plan lo. Popup me
# dono plan ke button + Dismiss. Plan button dabate hi browser me
# nayi shop registration khul jati hai.
# Har slot ek hi baar dikhta hai (state file me likha jata hai), isliye
# agent restart hone par bhi dobara spam nahi hota.
# ══════════════════════════════════════════════════════════════════
DEMO_REMINDER_FILE = os.path.join(_APPDATA_DIR, "demo_reminder.txt")
DEMO_SLOTS = [(9, 0), (12, 40), (16, 20), (20, 0)]   # 4 baar, 9AM–8PM
DEMO_CHECK_INTERVAL = 300                             # har 5 min slot check


def _demo_status():
    """Server se poochho: ye shop demo hai ya nahi. Naya halka endpoint
    use karte hain; purana server ho to /api/shop/<id> par fallback."""
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
    # 8 baje ke baad wala slot agle din tak valid, par raat 11 ke baad nahi
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
    Demo reminder — Windows ka apna dialog.

    Pehle ye tkinter ka do-button wala window tha (Monthly / Lifetime).
    MessageBox me utne button nahi ho sakte, isliye ab ek Yes/No hai:
    Yes dabate hi registration page browser me khul jaata hai, jahan
    saare plan waise hi dikhte hain. Ek extra click, par ye kabhi
    fail nahi hota.
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
        log(f"Demo popup nahi khul paya: {e}", "WARN")


def demo_reminder_loop():
    """Background thread — checks every 5 minutes whether a slot is due."""
    last_status_check = 0
    is_demo, expired = False, False
    while agent_state["running"]:
        try:
            now = time.time()
            # Demo status har 30 min me ek baar refresh (server par halka)
            if now - last_status_check > 1800:
                is_demo, expired = _demo_status()
                last_status_check = now
            if is_demo and not expired:
                slot = _demo_slot_index()
                if slot is not None:
                    tag = f"{datetime.now().strftime('%Y-%m-%d')}#{slot}"
                    if not _demo_reminder_done(tag):
                        _demo_reminder_mark(tag)
                        log(f"\u23f0 Demo upgrade reminder ({slot + 1}/4 aaj)")
                        threading.Thread(target=_show_demo_upgrade_popup, daemon=True).start()
        except Exception:
            pass
        time.sleep(DEMO_CHECK_INTERVAL)


def _report_with_retry(url, payload, job_id, what):
    """Result report SERVER tak pahunchna hi chahiye — ek attempt fail hone
    par job server par 'printing' me atka rehta hai aur 10 min baad requeue
    hokar DUBARA print ho jata hai (duplicate paper!). Isliye 6 koshish,
    10s gap — kamzor network par bhi ~1 min me pahunch jata hai."""
    for attempt in range(1, 7):
        try:
            r = requests.post(url, json=payload, timeout=15)
            if r.status_code == 200:
                if attempt > 1:
                    log(f"✅ {what} report delivered on attempt {attempt} ({job_id})")
                # Server ka jawab bhi lauta rahe hain — usi se pata chalta hai
                # ki customer ki file abhi delete hui ya pehle ho chuki thi.
                try:
                    return True, (r.json() or {})
                except Exception:
                    return True, {}
            log(f"⚠️ {what} report HTTP {r.status_code} (koshish {attempt}/6)", "WARN")
        except Exception as e:
            log(f"⚠️ {what} report fail (koshish {attempt}/6): {e}", "WARN")
        if attempt < 6:
            time.sleep(10)
    log(f"❌ {what} report failed after 6 attempts — job {job_id} "
        f"will stay stuck on the server (the server clears it in 10 minutes)", "ERROR")
    return False, {}

def _log_server_file(ok, data):
    """
    Customer ki file server par se hati ya nahi — ye log me pehle aata hi
    nahi tha. Sirf "Local file deleted" dikhta tha, aur wo IS PC ka temp hai.
    Customer ki asli file server par hoti hai.

    Server /api/jobs/complete (aur /failed) par wo file apni taraf se delete
    karta hai aur DB me file_deleted=true likhta hai. Isliye 200 mila =
    wo kaam ho chuka. `already:true` matlab pehle hi ho chuka tha.
    """
    try:
        if not ok:
            log("⚠️  Server tak report nahi pahunchi — customer ki file abhi "
                "server par ho sakti hai (server 10 min me khud saaf karta hai)", "WARN")
            return False
        if isinstance(data, dict) and data.get("already"):
            log("☁️  Server: customer ki file pehle hi delete ho chuki thi")
        else:
            log("☁️  Server se customer ki file delete ho gayi")
        return True
    except Exception:
        return bool(ok)


def mark_complete(job_id):
    # Pehle local record, phir server report. Agar report ke beech me
    # agent crash ho jaye to bhi ye job dobara print nahi hoga.
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
    # Deny/fail par bhi server apni file saaf karta hai — wahi likho
    return _log_server_file(ok, data)


# ══════════════════════════════════════════════════════════════
#  LIVE JOB WINDOW  —  ek job, ek window, saara kaam saamne
#
#  Purana approval popup ONE-SHOT tha: PowerShell chalao, jawab lo, band.
#  Uske baad kuch dikhaya hi nahi ja sakta tha — Python `subprocess.run`
#  par ruka rehta tha aur khuli hui window me kuch bhejne ka raasta nahi tha.
#
#  Ab ulta hai:
#    * window Popen se chalti hai (Python rukta NAHI)
#    * Python ek chhoti JSON state file likhta hai
#    * window har 320ms wahi file padh kar khud ko refresh karti hai
#    * button dabane par window ek result file likhti hai, Python padh leta hai
#
#  Dikhne ke liye WPF (XAML) use kiya hai, WinForms nahi. WinForms me rounded
#  card / shadow / chip sab haath se GDI+ me banane padte aur kinare fate hue
#  dikhte. WPF Windows ka apna hissa hai (koi download nahi) aur ye sab usme
#  built-in hai.
#
#  NIYAM WAHI PURANA: ye window kisi bhi wajah se na chale to printing
#  RUKNI NAHI CHAHIYE. Har call try/except me hai, aur approval ke liye
#  purana MessageBox raasta jyon ka tyon zinda hai.
# ══════════════════════════════════════════════════════════════

_JOBWIN_DIR = os.path.join(_APPDATA_DIR, "jobwin")
_JOBWIN_PS1 = os.path.join(_RUNTIME_DIR, "job_window.ps1")
_JOBWIN_OK = None          # None = abhi try nahi kiya, False = ye PC nahi chala paya

# Step ka haal
_ST_WAIT = "wait"          # abhi baari nahi aayi
_ST_RUN = "run"            # chal raha hai (ghoomta hua gola)
_ST_DONE = "done"          # ho gaya (hara tick)
_ST_FAIL = "fail"          # nahi hua (laal cross)
_ST_SKIP = "skip"          # is job me lagta hi nahi (dash)

# Segoe MDL2 Assets ke icon (Windows 10/11 me pehle se hote hain).
_IC_FILE = "E7C3"      # page (folded corner)
_IC_CARD = "E8C7"      # payment card
_IC_USER = "E77B"      # contact
_IC_CLOCK = "E823"     # clock
_IC_PRINT = "E749"     # printer
_IC_CLOUD = "E753"     # cloud
_IC_TRASH = "E74D"     # delete
_IC_TICK = "E73E"      # check
_IC_CROSS = "E711"     # cancel
_IC_DASH = "E738"      # remove (skip ke liye)


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


# Ek step ki row. 6 baar dohrayi jaati hai (index 0..5).
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


# PowerShell ka driver. Ye sirf "renderer" hai — koi business logic nahi.
# Saara faisla Python leta hai aur state file me likh deta hai.
_JOBWIN_PS = r'''param([string]$State, [string]$Result, [string]$XamlFile)
$ErrorActionPreference = 'Stop'

# BOM ke BINA. [Text.Encoding]::UTF8 file ke aage EF BB BF lagata hai, aur
# Python ka .strip() use hata nahi paata — isse "reject" kabhi match hi nahi
# hota tha aur har reject "window band ho gayi" ban jaata tha.
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

# Taskbar ko chhod kar, neeche-daayein kone me. WorkArea taskbar hata kar
# hi milta hai, isliye window uske upar kabhi nahi chadhti.
try {
  $wa = [System.Windows.SystemParameters]::WorkArea
  $win.Left = $wa.Right - $win.Width - 14
  $win.Top  = $wa.Bottom - $win.Height - 14
} catch {
  $win.WindowStartupLocation = 'CenterScreen'
}
# Activate() jaan-boojh kar hata diya — jis app me aap type kar rahe ho
# uska focus ye window nahi chheenegi. Topmost hai, isliye dikhti phir bhi hai.
$win.Add_Closed({ try { $timer.Stop() } catch {} })
$timer.Start()
$win.ShowDialog() | Out-Null
Send 'CLOSED'
exit 0
'''


def _jobwin_write_assets():
    """
    .ps1 aur .xaml ko APPDATA me likh do (ek hi baar, ya badalne par).

    _MEI ke bajaye APPDATA isliye — wahi jagah hai jo saaf nahi hoti
    ([[_MEI survival kit]] wali baat).
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
            log(f"Job window asset likh nahi paye ({e})", "WARN")
            return False
    return True


class JobWindow:
    """
    Ek job ki live window.

    Istemaal:
        w = JobWindow(job); w.open()
        w.step(1, _ST_DONE); w.push()
        ans = w.decide(timeout=600)     # "approve" / "reject" / None
        ...
        w.done_and_close()

    Har method chup-chaap fail hoti hai. Window na chale to printing par
    koi asar nahi padta — sirf ye window nahi dikhti.
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

    # ── state banao ──
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
            # NOTE: order jaan-boojh kar aisa hai — code me local temp PEHLE
            # delete hoti hai, phir server ko complete bheja jaata hai.
            # Mockup me ulta tha; yahan wahi likha hai jo SACH me hota hai.
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
                    "badge_top": "WAITING", "badge_sub": "Owner ki haan chahiye"}
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

    # ── chhoti madad ──
    def _now(self):
        return datetime.now().strftime("%I:%M:%S %p").lstrip("0")

    def step(self, n, state, label=None, stamp=True, icon=None):
        """Step n (1..6) ka haal badlo. push() abhi bhi karna padta hai."""
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
        """State file ko atomically likho (poori state, har baar)."""
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
            # 4 koshish ke baad bhi nahi hua — chhod do. Agli push me poori
            # state dobara jayegi, isliye kuch khota nahi.
            try:
                os.unlink(tmp)
            except Exception:
                pass
        except Exception:
            pass

    # ── window chalu / band ──
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
            log(f"Live job window nahi khul paya ({e}) - purana popup use hoga", "WARN")
            return False

    def _read_result(self):
        """
        Button ka jawab padho.

        DHYAAN: yahan "utf-8-sig" use kiya hai aur upar se \ufeff bhi hata rahe
        hain. Wajah — PowerShell ka [Text.Encoding]::UTF8 file ke aage BOM
        laga deta tha, aur Python ka .strip() BOM ko whitespace nahi maanta.
        Isliye "reject" kabhi bhi "reject" ke barabar nahi hota tha aur har
        Reject "window band ho gayi" ban kar job wapas queue me chala jaata tha.
        Ab .ps1 BOM likhta hi nahi, par purani window chal rahi ho to bhi
        sambhal jaye — isliye dono taraf se band.
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
        Owner ke button ka intezaar.
        "approve" / "reject" / None (window band ho gayi ya chali hi nahi).
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
                    log(f"Live job window is PC par nahi chala ({v[:60]}) - "
                        f"purana popup use hoga", "WARN")
                    return None
                if v == "CLOSED":
                    self._decided = None
                    return None
                self._decided = v
                return v
            if self.proc is not None and self.proc.poll() is not None:
                # PowerShell bina jawab diye mar gaya
                v = self._read_result()
                if not v or v.startswith("ERROR"):
                    _JOBWIN_OK = False
                    self.alive = False
                    return None
                return v
            time.sleep(0.15)
        log("Live job window par 10 min tak koi jawab nahi aaya", "WARN")
        return None

    def done_and_close(self, seconds=8):
        """Aakhri state bhejo aur window ko khud band hone do."""
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
        Jo step baaki reh gaye unhe band karo aur window ko vida do.

        Ye process_job() ke `finally` se chalta hai, isliye job kisi bhi
        raaste se nikle — download fail, server refuse, ya exception —
        window kabhi adhoori nahi latki rahegi.
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


# Jab koi faisla nahi lena — sirf "Close".
_BTN_CLOSE = {"id": "close", "text": "Close", "bg": "#FFFFFF",
              "bd": "#D6D3D1", "fg": "#1C1917"}

# Abhi jo job chal rahi hai uski window. process_job() ke finally me
# saaf hoti hai, isliye kisi bhi raaste se nikalne par window band ho
# jaati hai. Jobs ek-ek karke chalte hain (print_loop me sequential),
# isliye ek hi kaafi hai.
_CURRENT_JOBWIN = None

# ══════════════════════════════════════════════════════════════════
# COUNTER-PAYMENT APPROVAL POPUP
# Counter (cash) wale jobs mein customer ne abhi paisa NAHI diya hota —
# system turant print nikal deta tha. Ab owner ke PC par popup: details
# dekho, cash lo, Approve karo — tab print. Deny = job cancel + file delete.
# FAIL-OPEN: popup kisi wajah se na ban paye to print ho jata hai —
# popup ki technical dikkat business nahi rokni chahiye.
# ══════════════════════════════════════════════════════════════════
def ask_backside():
    """
    Manual duplex: front side chhap gaya — ab owner se poochho ki page
    palat kar tray me rakh diya ya nahi.

    Windows ka apna dialog. Pehle yahan tkinter ka window tha jo Tcl na
    hone par nahi khulta tha; tab evens seedhe chhap jaate the aur alag
    sheet par nikal kar kagaz barbaad hota tha.
    """
    return _ask_backside_native()

def ask_approval(job):
    """
    Counter order ka approval — Windows ka apna dialog.

    Ye gate PAISE ka hai: customer counter par cash dega, isliye owner ki
    haan ke bina print nahi jaana chahiye. Pehle yahan tkinter ka window
    tha aur Tcl fail hone par log me sirf "Approval popup fail" aata tha.
    Ab seedha wahi dialog jo har Windows par chalta hai.
    """
    return _ask_approval_native(job)

def process_job(job):
    """
    In-flight guard ke saath wrapper. Asli kaam _process_job_inner karta hai.
    finally me cleanup — chahe print safal ho, fail ho, ya exception aaye —
    job ID kabhi "abhi chal raha hai" list me atki nahi rahegi.
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
        # Job kisi bhi raaste se nikli ho — download fail, server refuse,
        # ya exception — live window adhoori latki nahi rehni chahiye.
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
    # DUPLICATE PRINT GUARD — server ne claim to kar liya hai, par agent
    # restart ya stuck-job requeue ke baad wahi job dobara aa sakta hai.
    # Customer ka paisa ek print ka hai, do nahi.
    if already_processed(job_id):
        log(f"⏭️  Job {job_id} already printed earlier — skipping (duplicate)")
        try:
            mark_complete(job_id)
        except Exception:
            pass
        return
    # Server ne isi job ko dobara bhej diya jabki ye abhi print ho raha hai
    # (bada PDF 45s se zyada le raha ho). Chhod do — do baar nahi nikalna.
    if job_id in _inflight_jobs:
        log(f"⏭️  Job {job_id} abhi print ho raha hai — dobara nahi lenge")
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

    # Shop ne agar specific B&W/Color printer set kiya hai (Super Admin/
    # Dashboard se), to job ke color_mode ke hisaab se sahi printer select
    # karte hain — system default printer ko IGNORE karke. Agar set nahi
    # hai (khali string), to None pass hoga aur purana default-printer
    # wala behavior chalega (backward compatible, kuch nahi tootega).
    printer_name_bw = job.get("printer_name_bw", "") or None
    printer_name_color = job.get("printer_name_color", "") or None
    printer_name_4x6 = job.get("printer_name_4x6", "") or None
    printer_name_a3 = job.get("printer_name_a3", "") or None
    printer_name_duplex = job.get("printer_name_duplex", "") or None
    # ── ROUTING PRECEDENCE ──
    # 1. Paper-special printer (4x6 photo / A3-A2-A1 large) agar shop ne set kiya
    # 2. Duplex printer — dono side wala job, aur shop ne alag printer diya ho
    # 3. Warna color/bw routing (jaisa pehle)
    #
    # Kagaz ka size printer ki MAJBOORI hai, duplex sirf ek suvidha —
    # isliye A3/4x6 wala printer duplex se JEETTA hai. A3 ki sheet chhote
    # printer me jaayegi hi nahi, chahe usme duplex ho.
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

    # ── COUNTER APPROVAL GATE ── online-paid jobs seedha print (paisa aa
    # chuka); sirf counter jobs par owner se pucho
    log(f"📄 Job {job_id}: {color.upper()} | copies={job.get('copies',1)} | "
        f"BW-printer='{printer_name_bw or 'default'}' | Color-printer='{printer_name_color or 'default'}' | "
        f"target='{target_printer or 'DEFAULT PRINTER'}'")

    # ── LIVE JOB WINDOW ──
    # Ek job, ek window. Na khule to sab kuch bilkul pehle jaisa chalta hai
    # (purana MessageBox approval + log) — printing kabhi nahi rukti.
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
                # Window is PC par chal hi nahi payi — purana raasta
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
            log(f"❌ Owner ne DENY kiya — job {job_id} cancel")
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
        # Online-paid job (ya approval band hai) — paisa pehle hi aa chuka
        win.step(2, _ST_DONE).push()

    log(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    log(f"📄 Job: {job_id}")
    log(f"   File: {fname}")
    log(f"   Pages: {pages} | Copies: {copies} | {color.upper()} | ₹{amount}")
    if selected_pages:
        log(f"   Specific Pages Requested: {selected_pages}")
    if target_printer:
        log(f"   🎯 Target Printer ({color.upper()}): {target_printer}")

    # Server se authorized download URL lo. Server sirf URL deta hai —
    # PDF Cloudinary se SEEDHA is PC par aati hai, Render se hoke nahi.
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
        # Pehle yahan sirf ek hardcoded line chhapti thi: "sab ready (bundled)".
        # Wo JHOOTH tha — kuch check hota hi nahi tha. 22 Aug ko Crypto ki .pyd
        # gayab thi aur log phir bhi "ready" likh raha tha, isliye asli wajah
        # pakadne me bahut waqt laga. Ab sach me import karke dekhte hain.
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
            log("❌ Bundle me dikkat: " + ", ".join(bad), "ERROR")
            log("   Agent band karke dobara chalu karo — bundle wapas khul jayega.",
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
# Panel na khule to bhi agent poori tarah kaam karta hai — printing, tray,
# auto-update sab pehle jaisa. Isliye import failure yahan swallow karte hain.
PANEL = None
try:
    import agent_panel as PANEL
    PANEL.bind(sys.modules[__name__])
except Exception as _panel_err:
    PANEL = None

def switch_shop_id_live(new_shop_id):
    """
    Shop ID ko CHALTE-CHALTE badlo — process restart ke bina.

    Restart kyun nahi: purana restart flow hi wo _MEI crash deta tha
    (Phase 0). Conversion ke waqt customer ko wo crash dikhana sabse
    kharab experience hoga. SHOP_ID module-level variable hai, isliye
    globals() se update karte hain aur config file atomically likhte hain.
    """
    global SHOP_ID
    old = SHOP_ID

    # IMPORTANT: server par conversion ho chuki hai — agent token already
    # paid shop par move ho gaya hai. Ab agar hum yahan ruk gaye to PC purane
    # demo ID par atka rahega aur printing band ho jaayegi.
    # Isliye: MEMORY me switch pehle karo (printing turant chal jaaye),
    # file write baad me — file fail ho to sirf "restart ke baad yaad nahi
    # rahega" wali problem hoti hai, printing nahi rukti.
    SHOP_ID = new_shop_id

    saved = False
    try:
        # Atomic write — beech me power gayi to config corrupt na ho
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
    # Purane demo ke processed-job records ab bekaar hain
    try:
        _processed_jobs.clear()
        _save_processed()
    except Exception:
        pass

    agent_state["connection"] = "connecting"
    agent_state["reconnect_requested"] = True      # turant naye shop se poll karo
    log(f"✅ Shop switched: {old} → {new_shop_id}" + ("" if saved else " (not saved to disk)"))
    try:
        report_printers_to_server()
    except Exception:
        pass
    update_tray_status("Running — waiting for jobs")
    return True if saved else "memory-only"


def is_demo_shop():
    """
    Demo hai ya paid — SERVER batata hai, Shop ID ke text se guess nahi karte
    (spec: backend is the source of truth). Server na mile to False —
    galti se paid shop ko demo dikhane se behtar hai kuch na dikhana.
    """
    try:
        if PANEL is not None:
            return PANEL.shop_type() == "demo"
    except Exception:
        pass
    return False


def open_upgrade_panel(icon=None, item=None):
    """
    Tray ka '⚡ Change Demo ID to Paid Shop'.

    Panel ki window bani ho to wahi (sundar) flow. Na bani ho — jaise un
    PC par jahan WebView2 nahi hai — to Windows ke apne dialog se wahi
    kaam. Pehle yahan sirf "Please open Settings..." likha aata tha,
    jabki Settings bhi khulti hi nahi thi; demo shop wahin atak jaati thi.
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
            log(f"Upgrade page nahi khula ({e}) — Windows dialog par ja rahe hain",
                "WARN")

    # Alag thread me — tray ka menu callback block nahi hona chahiye
    threading.Thread(target=convert_demo_to_paid_native, daemon=True).start()


def open_panel(icon=None, item=None):
    """Tray ka '⚙ Settings' — desktop panel kholo."""
    if PANEL is None:
        _msgbox("The desktop panel is not available in this build.\n\n"
                "Your Print Agent is running normally and printing is unaffected.",
                "Echel")
        return
    try:
        PANEL.open_panel()
    except Exception as e:
        log(f"Panel open failed: {e} — agent continues normally", "ERROR")

# ─── AUTO-UPDATE: Server se check karo naya version hai ya nahi ──────
def get_remote_version():
    """Fetch the latest agent version number from the server"""
    try:
        resp = requests.get(f"{SERVER_URL}/api/agent/version", timeout=15)
        resp.raise_for_status()
        data = resp.json()
        v = data.get("version")
        # Naya server display label bhi bhejta hai ("2.1"). Purana server nahi
        # bhejta — tab None rehne do aur apna hi label dikhate raho.
        global REMOTE_VERSION_LABEL, REMOTE_VERSION_INT
        try:
            REMOTE_VERSION_INT = int(v) if v is not None else 0
        except Exception:
            REMOTE_VERSION_INT = 0
        lbl = data.get("versionLabel") or data.get("displayVersion")
        REMOTE_VERSION_LABEL = lbl if (isinstance(lbl, str) and _VERSION_LABEL_RE.match(lbl.strip())) else None
        # Server string bhej de ("7") to int(6) se compare TypeError deta —
        # update silently kabhi trigger nahi hota. Int coerce karo.
        return int(v) if v is not None else None
    except Exception as e:
        log(f"⚠️  Version check failed: {e}", "WARN")
        return None

def remote_label_or(fallback_int):
    """Server ka label dikhao; na mile to internal number hi dikha do."""
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
    Source (.py) mode mein: naya code current SHOP_ID/SERVER_URL ke saath
    fill karke print_agent.py replace karte hain, phir restart.

    .exe mode mein: .py source replace karna kaam nahi karega (exe already
    compiled hai), isliye iske jagah naya installer .exe download karke
    chalate hain — woh khud purane ko replace karke restart karega.
    """
    if is_running_as_exe():
        apply_exe_update_and_restart()
        return

    try:
        # Naya code mein placeholder ko current Shop ID/Server URL se fill karo
        new_code = new_code.replace('AAPKA_SHOP_ID', SHOP_ID)
        new_code = new_code.replace(
            'SERVER_URL         = "https://echel.in"',
            f'SERVER_URL         = "{SERVER_URL}"'
        )

        current_file = os.path.abspath(__file__)
        backup_file = current_file + ".backup"

        # Purani file ka backup rakho (kuch gadbad ho jaye to wapas use kar sake)
        shutil.copy2(current_file, backup_file)

        with open(current_file, 'w', encoding='utf-8') as f:
            f.write(new_code)

        log("✅ New code installed! Restarting the agent...")

        # Khud ko restart karo — naye Python process mein same script chalao.
        # pythonw.exe force karte hain taaki restart ke baad bhi koi console
        # window na khule (chahe yeh process pythonw ya python se shuru hua ho)
        python_exe = sys.executable
        pythonw_exe = python_exe.replace('python.exe', 'pythonw.exe')
        if not os.path.exists(pythonw_exe):
            pythonw_exe = python_exe  # fallback agar pythonw nahi mila

        _spawn_detached([pythonw_exe, current_file], cwd=os.path.dirname(current_file))
        time.sleep(2.0)   # naye process ko start hone ka time do

        # Tray icon band karke is purane process ko exit karo
        if agent_state["tray_icon"]:
            agent_state["tray_icon"].stop()
        os._exit(0)
    except Exception as e:
        log(f"❌ Update apply karne mein error: {e}", "ERROR")

def download_installer(progress_cb=None):
    """
    Naya installer download karo. progress_cb(percent_or_None, mb_done)
    har chunk par call hota hai. Return: installer path ya (None, error_msg).
    """
    resp = requests.get(f"{SERVER_URL}/api/agent/download-latest-exe", timeout=120, stream=True)
    if resp.status_code == 404:
        return None, "No new installer has been uploaded to the server (inform the Super Admin)"
    resp.raise_for_status()

    total = int(resp.headers.get('content-length') or 0)
    # FIX [Errno 13]: fixed filename par purana locked/antivirus-held installer
    # har agla download fail karwata tha (auto + manual dono). Ab unique naam
    # per download + purane installers best-effort saaf.
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
    if done < 100_000:  # <100KB = installer nahi, koi error page hai
        return None, "The downloaded file does not look like an installer (too small) — check the installer URL"
    return installer_path, None

def _is_windows_exe(path):
    """Downloaded file sach me Windows ka program hai? (MZ header)"""
    try:
        with open(path, "rb") as f:
            return f.read(2) == b"MZ"
    except Exception:
        return False


def run_installer_and_exit(new_exe_path):
    """
    Naye build ko PURANE exe ki jagah par bitha kar wahin se chalu karo.

    ⚠️ Yahan pehle Inno Setup ke switch (/VERYSILENT ...) bheje jaate the.
    Par server jo file bhejta hai wo installer hai hi nahi — wo khud agent
    ka PyInstaller exe hai. Wo in switches ko chupchaap ignore kar deta
    tha, TEMP se chal padta tha, aur autostart bhi TEMP ke raste par likh
    deta tha. Temp saaf hote hi wo raasta toot jaata tha — isiliye update
    "download to hota tha, install nahi hota tha".

    Ab kaam ek chhoti .bat karti hai:
      * copy ki koshish karti rehti hai — jab tak purana exe chal raha
        hai, file locked rehti hai aur copy fail hoti hai. Wo band hote hi
        copy chal jaati hai. Isliye alag se "process ka intezaar" karne ki
        zaroorat hi nahi.
      * replace hone ke baad naye exe ko USI JAGAH se chalu karti hai.
      * har haal me apna log likhti hai, taaki fail ho to pata chale.
    """
    if not is_running_as_exe():
        log("Self-update sirf .exe build me hota hai — script mode me chhod diya", "WARN")
        return
    if not _is_windows_exe(new_exe_path):
        log("❌ Download kiya hua file Windows program jaisa nahi hai — update roka", "ERROR")
        return

    target = os.path.abspath(sys.executable)      # abhi jahan se chal rahe hain
    bat = os.path.join(tempfile.gettempdir(), f"qsp-update-{int(time.time())}.bat")
    upd_log = os.path.join(_APPDATA_DIR, "update_log.txt")

    # ⚠️ RAASTE .bat ke ANDAR MAT LIKHO — cmd.exe file ko ANSI codepage me
    # padhta hai. Jis shop ke PC par username Hindi/Bangla/Tamil me hai,
    # uska %TEMP% aur %APPDATA% bhi usi lipi me hota hai, aur wo raasta
    # file me likhte hi kachra ban jaata hai. Isliye teeno raaste argument
    # ban kar jaate hain (%~1 %~2 %~3) — argument Windows ko Unicode me
    # milta hai, aur .bat ka apna matn saaf ASCII rehta hai.
    #
    # `ping` se rukte hain, `timeout` se nahi — bina console wale process me
    # timeout "input redirection is not supported" de kar turant nikal jaata hai.
    script = "\r\n".join([
        "@echo off",
        "set N=0",
        ":try",
        'copy /Y "%~1" "%~2" >nul 2>&1',
        "if not errorlevel 1 goto ok",
        "ping -n 3 127.0.0.1 >nul",
        "set /a N+=1",
        "if %N% LSS 40 goto try",
        'echo [%date% %time%] UPDATE FAIL - "%~2" replace nahi hua>>"%~3"',
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
        log(f"❌ Update helper nahi ban paayi: {e}", "ERROR")
        return

    log(f"🔄 Update lagaya ja raha hai — {target}")
    try:
        _spawn_detached(["cmd", "/c", bat, new_exe_path, target, upd_log])
    except Exception as e:
        log(f"❌ Update helper chali nahi: {e}", "ERROR")
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
        log(f"❌ .exe update apply karne mein error: {e}", "ERROR")

# ─── MANUAL UPDATE CHECK (tray menu se) ──────────────────────────────
# Auto-loop errors chupchaap kha jata hai — yeh window sab kuch DIKHATI
# hai: server ka version, download %, aur exact error. Har shop par bina
# logs khole update-problem diagnose ho jati hai.
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
#  WINDOWS KE APNE DIALOG
#
#  Agent ka HAR popup ab yahin se banta hai - user32 ka MessageBoxW aur
#  PowerShell ka WinForms box. Koi tkinter nahi.
#
#  Kyun: pehle popup tkinter se bante the. Exe me tkinter ka MODULE to
#  chala jaata tha par uska Tcl DATA (init.tcl waghairah) nahi. Tab
#  `import tkinter` SAFAL hota tha aur galti sirf tk.Tk() par dikhti thi:
#      "Can't find a usable init.tcl"
#  Shop ke log me yahi aaya tha, aur sabse bura ye tha ki Shop ID wala
#  pehla popup bhi nahi khulta - matlab naya install chalu hi nahi hota.
#
#  MessageBoxW Windows ka apna hissa hai. Na bundle karna padta hai,
#  na kabhi missing hota hai.
# ══════════════════════════════════════════════════════════════




# ══════════════════════════════════════════════════════════════
#  BADA DIALOG  (PowerShell + WinForms)
#
#  MessageBoxW chhota hai aur uska font badla nahi ja sakta. Dukaan par
#  approval popup din me dozens baar dikhta hai aur counter se padhna
#  padta hai — isliye uske liye apna, bada dialog banate hain.
#
#  Ye SIRF dikhne ka upgrade hai. PowerShell na chale to _native_yesno()
#  chup-chaap purane MessageBoxW par gir jaata hai, isliye bharosa utna
#  hi rehta hai jitna pehle tha.
# ══════════════════════════════════════════════════════════════
_PS_DIALOG_OK = None          # None = abhi try nahi kiya, False = kaam nahi karta
_PS_DIALOG_FAILS = 0          # lagatar kitni baar fail hua (3 par hamesha ke liye band)


def _ps_dialog(title, big, sub, rows, yes_label=None, no_label=None,
               accent="#16a34a", timeout=600):
    """
    Bada dialog dikhao.

    title      : window ka naam
    big        : sabse upar bada text (jaise "Rs 150") — khaali bhi ho sakta hai
    sub        : bade text ke neeche ek line
    rows       : [(label, value), ...] — monospace me, column seedhe
    yes_label  : Yes button ka text. None = sirf ek OK button
    no_label   : No button ka text

    Returns True (yes/ok) / False (no) / None (dialog bana hi nahi)
    """
    global _PS_DIALOG_OK, _PS_DIALOG_FAILS
    if _PS_DIALOG_OK is False:
        return None                       # pehle fail ho chuka — time mat kharab karo

    ps1 = None
    try:
        import tempfile

        def q(v):                          # PowerShell ki single-quote string
            return str(v).replace("'", "''")

        # Rows ko monospace ke liye pad karo — tab PowerShell me nahi banate,
        # Python me hi seedhe kar dete hain.
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
        # PowerShell ki DOUBLE-quoted string me ` $ aur " teeno ka apna
        # matlab hota hai. File ka naam kuch bhi ho sakta hai (jaise
        # "bill $500.pdf") — bina escape kiye PowerShell $500 ko variable
        # samajh kar khaali kar deta aur dialog adhoora dikhta.
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
        # BOM khud likh rahe hain (b"\xef\xbb\xbf") - "utf-8-sig" CODEC use
        # karne se bachne ke liye. Wo codec base_library.zip me rehta hai aur
        # PEHLI BAAR theek yahin load hota tha; _MEI saaf ho chuka ho to yahi
        # line "FileNotFoundError: ...base_library.zip" deti thi - screenshot
        # wala "Bada dialog fail" isi se aaya tha.
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
        # Kuch bhi nahi aaya — matlab dialog bana hi nahi
        if _PS_DIALOG_OK is None:
            _PS_DIALOG_OK = False
            log("Bada dialog nahi ban paya - ab MessageBox use hoga "
                f"({(out.stderr or '')[:120]})", "WARN")
        return None
    except Exception as e:
        # Pehle EK fail par hi bada dialog HAMESHA ke liye band ho jaata tha.
        # 22 Aug ko _MEI saaf hone se ek FileNotFoundError aaya aur poore din
        # chhota MessageBox hi dikhta raha. Ab teen baar fail hone par hi band
        # karte hain — taaki ek gadbad saara din kharab na kare.
        if _PS_DIALOG_OK is None:
            _PS_DIALOG_FAILS += 1
            log(f"Bada dialog fail ({e}) - is baar MessageBox use hoga "
                f"[{_PS_DIALOG_FAILS}/3]", "WARN")
            if _PS_DIALOG_FAILS >= 3:
                _PS_DIALOG_OK = False
                log("Bada dialog teen baar fail - ab hamesha MessageBox hi chalega",
                    "WARN")
        return None
    finally:
        try:
            if ps1 and os.path.exists(ps1):
                os.remove(ps1)
        except Exception:
            pass


# MessageBoxW ke flags (winuser.h)
_MB_YESNO         = 0x00000004
_MB_ICONQUESTION  = 0x00000020
_MB_SETFOREGROUND = 0x00010000
_MB_TOPMOST       = 0x00040000
_IDYES, _IDNO = 6, 7


def _native_yesno(text, title="Echel"):
    """
    Yes/No poochho bina kisi Tcl ke - seedha user32.dll ka MessageBoxW.
    Ye Windows ka apna hissa hai: na bundle karna padta hai, na install.

    Returns True (Yes) / False (No) / None (dialog hi nahi bana).
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
        log(f"Native MessageBox bhi fail hua: {e}", "ERROR")
        return None


def _ask_approval_native(job):
    """
    Counter order ka approval box.

    Formatting par dhyan diya gaya hai kyunki ye popup dukaan par din me
    dozens baar dikhta hai. MessageBox proportional font use karta hai,
    isliye space se column banane ki koshish bekar hai — har cheez apni
    line par, label ke baad colon. Sabse upar AMOUNT, kyunki counter par
    wahi ek number chahiye hota hai.
    """
    color  = job.get("color_mode", "bw")
    copies = job.get("copies", 1)
    pages  = job.get("total_pages", 1)
    sel    = job.get("selected_pages", "")
    amount = job.get("amount", 0)
    fname  = job.get("file_name", "file")

    # Server ka created_at (ISO/UTC) -> PC ka local time.
    # Ye pehle sirf tkinter wale popup me dikhta tha; native me chhoot
    # gaya tha. Counter par "kaunsa order" pehchanne me kaam aata hai.
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

    # Pehle BADA dialog. Na bane to wahi purana MessageBox — bharosa
    # utna hi, bas dikhne me behtar.
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
        # Dialog kisi bhi tarah nahi khula. Print ROKNA bhi galat hai
        # (dukaan hi band ho jayegi), isliye jaari - par LOUD, chupchaap nahi.
        log("Approval dialog kisi bhi tarike se nahi khul paya - job print "
            "ja raha hai BINA approval ke. Agent ek baar restart karke dekho.",
            "ERROR")
        try:
            update_tray_status("Approval dialog unavailable - printing without approval")
        except Exception:
            pass
        return True
    return ans


def _ask_backside_native():
    """Back-side prompt — pehle bada dialog, fallback MessageBox."""
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
        log("Back-side dialog nahi khul paya - evens seedha print", "WARN")
        return True
    return ans


def bundle_selfcheck():
    """
    Startup par ek baar: kya-kya sach me bundle hua hai, log me saaf likho.

    Pehle ye guess-work tha. Exe ban jaati thi, print bhi chal jaata tha
    (kyunki us PC par SumatraPDF alag se install tha) aur kisi ko pata hi
    nahi chalta ki bundle khaali hai - jab tak kisi naye PC par sab fail
    na ho jaye.

    Tcl/Tk ka check yahan se hata diya gaya hai — ab koi popup Tk use
    karta hi nahi, sab Windows ke apne dialog par hain.
    """
    # Startup ke wo notes jo log() ban-ne se PEHLE likhe gaye the
    # (base_library pin, mirror, preload) — ab log me daal do.
    try:
        while _EARLY_NOTES:
            lvl, msg = _EARLY_NOTES.pop(0)
            log("BOOT    " + msg, lvl)
    except Exception:
        pass

    frozen = bool(getattr(sys, 'frozen', False) or globals().get('__compiled__'))
    if not frozen:
        log("Bundle check skip - ye sirf .exe build ke liye hai (abhi script mode)")
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
            log(f"BUNDLE  SumatraPDF : BUNDLE ME NAHI - is PC par alag se install "
                f"mila ({found_system}). NAYE PC PAR PRINT FAIL HOGA. Build folder "
                f"me SumatraPDF.exe rakh kar dobara build karo.", "WARN")
        else:
            log("BUNDLE  SumatraPDF : MISSING - na bundle me, na is PC par. "
                "Print kaam nahi karega!", "ERROR")

    # -- Popup --
    log("BUNDLE  Popup     : Windows ke apne dialog (Tcl/Tk ki zaroorat nahi)")

    # -- Desktop panel --
    if get_bundled_resource_path('agent_panel.html'):
        log("BUNDLE  Panel HTML : BUNDLED OK")
    else:
        log("BUNDLE  Panel HTML : BUNDLE ME NAHI - desktop panel nahi khulega "
            "(printing normal chalegi)", "WARN")

    # -- Survival kit --
    try:
        have = [n for n in _MIRROR_FILES
                if os.path.exists(os.path.join(_RUNTIME_DIR, n))]
        log("BUNDLE  Safe copy : %d/%d files -> %s"
            % (len(have), len(_MIRROR_FILES), _RUNTIME_DIR))
        if not _mei_intact():
            log("BUNDLE  Temp folder : SAAF HO CHUKA HAI - safe copy par chal rahe hain",
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
    Tray ka "Check for Update".

    Pehle yahan tkinter ka progress window tha aur Tcl fail hone par
    shop owner ko "Can't find a usable init.tcl" jaisi line dikh jaati
    thi. Ab seedha bina-window wala update chalta hai — har step par
    Windows ka apna message box aata hai.
    """
    _manual_update_headless()

def _seconds_until_next_update_check():
    """Agle update check tak kitne second — 11:00 aur 18:00 par, jitter ke saath.

    JITTER KYUN: agar sab agents theek 11:00:00 par check karein to 72
    request ek saath server par gir jayengi. Har agent apna alag offset
    leta hai jo uske SHOP_ID se banta hai — isliye har PC par alag hota
    hai, par restart karne par badalta nahi (warna offset har baar badal
    kar schedule hi bekaar ho jaata).
    """
    import datetime, hashlib
    seed = hashlib.md5((SHOP_ID or "agent").encode()).digest()
    offset = (seed[0] * 256 + seed[1]) % UPDATE_JITTER_MAX_SEC

    now = datetime.datetime.now()
    best = None
    for day in (0, 1):                      # aaj, phir kal
        for hh in UPDATE_HOURS:
            t = (now + datetime.timedelta(days=day)).replace(
                hour=hh, minute=0, second=0, microsecond=0)
            t += datetime.timedelta(seconds=offset)
            if t > now and (best is None or t < best):
                best = t
    return max(60, (best - now).total_seconds())


def update_checker_loop():
    """Background thread — din me 2 baar (UPDATE_HOURS) update check karta hai."""
    # Pehla check thoda delay se — taaki agent properly start ho jaye pehle.
    # Ye startup wala check zaroori hai: warna naya install kiya hua agent
    # agle 11 baje tak update hi nahi dhoondhega.
    time.sleep(30)
    while agent_state["running"]:
        try:
            remote_version = get_remote_version()
            if remote_version is not None and remote_version > VERSION:
                _rl = remote_label_or(remote_version)
                log(f"🔄 New version available: v{_rl} (currently running v{VERSION_LABEL})")
                update_tray_status(f"Updating to v{_rl}...")

                if is_running_as_exe():
                    # .exe mode — seedha naya installer download/run karo
                    apply_update_and_restart()
                else:
                    # Source (.py) mode — purana flow: naya .py code download karke replace karo
                    new_code = download_latest_agent()
                    if new_code:
                        apply_update_and_restart(new_code)
                    else:
                        log("⚠️  Update download failed, will try again at the next check", "WARN")
        except Exception as e:
            log(f"⚠️  Update checker error: {e}", "WARN")

        # Agle fix time tak so jao. Lambi neend ko tukdon me todte hain
        # taaki agent band karne par thread turant ruk jaye — warna
        # "Exit" dabane ke baad bhi ghanton latka rehta.
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

# Print loop ko turant jagane ke liye. Pehle har 1 second par flag check
# hota tha, matlab Reconnect dabane ke baad bhi 1 second tak ruk sakta tha.
# Event se ye 0 millisecond ho jaata hai.
_wake_event = threading.Event()

def wake_print_loop():
    """Print loop ko abhi jaga do — sleep beech me hi tod do."""
    _wake_event.set()

def _interruptible_sleep(seconds):
    """
    Sona, par Reconnect ya Exit par TURANT uthna.
    Event.wait() us hi pal wapas aa jaata hai jab koi wake_print_loop()
    kare — koi polling, koi deri nahi.
    """
    if seconds <= 0:
        return
    if _wake_event.wait(timeout=seconds):
        _wake_event.clear()

def reconnect_to_server(icon=None, item=None, announce=True):
    """
    'Reconnect to Server' — tray se ya desktop panel se.
    Software band karke dobara kholne ki zaroorat nahi: yeh printer dobara
    detect karta hai, server se turant check karta hai aur status reset
    kar deta hai.
    """
    log("🔌 Reconnect to Server pressed")
    # Manual click hua to chalta hua counter bekaar hai — rok do.
    # (Auto wala khud yahan aata hai, use rokne ki zaroorat nahi.)
    if announce:
        cancel_auto_reconnect()
    reset_http()          # purane mare hue socket phenk do
    agent_state["connection"] = "connecting"
    update_tray_status("Reconnecting...")
    agent_state["reconnect_requested"] = True
    wake_print_loop()     # print loop abhi jaage — sleep khatam hone ka intezaar nahi

    # Printer dobara detect karo — kai baar printer offline hone ke baad
    # default printer badal jaata hai ya handle stale ho jaata hai.
    try:
        ok, printer_name = check_printer()
        if ok and printer_name:
            agent_state["printer"] = printer_name
            log(f"🖨️  Printer re-detected: {printer_name}")
        else:
            log("⚠️  No printer found during reconnect", "WARN")
    except Exception as e:
        log(f"Printer re-detect skipped: {e}", "WARN")

    # Server ko current printer list dobara bhejo (best-effort)
    try:
        report_printers_to_server()
    except Exception as e:
        log(f"Printer report skipped: {e}", "WARN")

    # TURANT check — user ko poll ka intezaar na karna pade. Halka
    # read-only endpoint hai, koi job claim nahi hoti.
    connected = ping_server()
    if connected:
        agent_state["connection"] = "online"
        update_tray_status("Running — waiting for jobs")
        log("✅ Reconnected — server se jud gaya")
        # Success hamesha batao — chahe manual ho ya auto. Isi ka
        # to intezaar tha.
        tray_notify("Connected", "Connected to the server. Pending print jobs will resume.")
        reset_auto_reconnect_notice()
    else:
        agent_state["connection"] = "offline"
        update_tray_status("Offline — click Reconnect to Server")
        log("❌ Reconnect fail — server tak nahi pahunche", "WARN")
        # Sirf manual click par batao. Auto koshish har baar
        # notification bheje to lambi outage me spam ban jaayega.
        if announce:
            tray_notify("Not connected", "Check your internet connection, then select Reconnect.")
    return connected

def ping_server(timeout=8):
    """
    Server pahunch me hai ya nahi — bas itna. Read-only endpoint, isliye
    koi print job claim nahi hoti (get_pending_jobs yahan use MAT karo,
    warna job claim ho jayegi par print nahi hogi).
    """
    try:
        r = http().get(f"{SERVER_URL}/api/agent/version", timeout=timeout)
        return r.status_code == 200
    except Exception as e:
        log(f"Server ping failed: {e}", "WARN")
        return False

def tray_notify(title, msg):
    """Windows ka chhota notification — best effort."""
    try:
        icon = agent_state.get("tray_icon")
        if icon and hasattr(icon, "notify"):
            icon.notify(msg, f"Echel — {title}")
    except Exception:
        pass

# ══════════════════════════════════════════════════════════════
#  OFFLINE -> NOTIFICATION + 10 SECOND ULTA COUNTER + AUTO RECONNECT
#
#  Pehle offline hone par sirf tray ka text badalta tha. Shop wale ka
#  dhyan tray par tabhi jaata hai jab print na nikle — tab tak customer
#  khada rehta hai. Ab Windows ka notification turant dikhta hai aur
#  10 second baad agent KHUD reconnect kar leta hai.
#
#  EK BAAT SAAF: Windows ke tray notification (Shell_NotifyIcon balloon,
#  jo pystray use karta hai) me BUTTON nahi ho sakta — wo sirf text
#  dikhata hai. Isliye ulta counter TRAY TOOLTIP me chalta hai, jahan
#  har second update hota hai:
#      "Offline — 7s me auto reconnect"
#  User chahe to tray par right-click -> Reconnect to Server dabakar
#  turant kara sakta hai; tab counter apne aap ruk jaata hai.
# ══════════════════════════════════════════════════════════════
_auto_rc_lock = threading.Lock()
_auto_rc_running = False
_auto_rc_cancel = threading.Event()
_auto_rc_last_notify = 0.0


def auto_reconnect_active():
    """Countdown chal raha hai? (print_loop tray text overwrite na kare)"""
    return _auto_rc_running


def cancel_auto_reconnect():
    """User ne khud Reconnect daba diya — counter ab bekaar hai."""
    _auto_rc_cancel.set()


def reset_auto_reconnect_notice():
    """Connection wapas aane par — agli baar notification turant aaye."""
    global _auto_rc_last_notify
    _auto_rc_last_notify = 0.0


def start_auto_reconnect_countdown():
    """
    Offline hote hi ek notification bhejo, tray me 10 se 1 tak ulta
    counter chalao, phir khud reconnect kar do.

    Alag thread me chalta hai taaki print loop ruke nahi.
    """
    global _auto_rc_running
    with _auto_rc_lock:
        if _auto_rc_running:
            return                      # ek waqt me ek hi counter
        _auto_rc_running = True
    _auto_rc_cancel.clear()

    def _run():
        global _auto_rc_running, _auto_rc_last_notify
        try:
            # Raat bhar internet band ho to har baar notification bhejna
            # torture hai. Isliye notification AUTO_RECONNECT_NOTIFY_GAP me
            # ek baar — par reconnect ki koshish tab bhi hoti rehti hai.
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
                    log("✅ Counter ke beech hi connection wapas aa gaya")
                    return
                update_tray_status(f"Offline — reconnecting in {left}s")
                # wait() us hi pal wapas aa jaata hai jab user Reconnect
                # dabaye — poore 1 second ka intezaar nahi karna padta.
                if _auto_rc_cancel.wait(timeout=1.0):
                    log("🔌 User ne khud Reconnect dabaya — counter band")
                    return

            if not agent_state.get("running"):
                return
            log(f"⏱️  {AUTO_RECONNECT_SECONDS}s pura — auto reconnect chala rahe hain")
            update_tray_status("Reconnecting automatically...")
            # announce=False: fail hone par notification mat bhejo, warna
            # lambi outage me har koshish par ek notification aayegi.
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
    """Log file ko Notepad mein kholo"""
    try:
        log_path = os.path.abspath(LOG_FILE)
        if os.path.exists(log_path):
            os.startfile(log_path)
        else:
            log("The log file has not been created yet")
    except Exception as e:
        log(f"Logs open karne mein error: {e}", "ERROR")

def contact_admin(icon=None, item=None):
    """
    Tray se 'Contact Admin' — WhatsApp browser me khulta hai, Shop ID
    pehle se message me bhara hua. Bilkul shop-login ke Support button
    jaisa. Owner ko sirf apni problem type karke send karni hai.
    """
    try:
        import webbrowser, urllib.parse
        # admin.html ke sendWhatsApp() jaisa hi format
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
    Tray se 'Change Shop ID' click karne par config file delete karo
    aur agent ko restart karo — restart hote hi naya Shop ID popup khulega.
    """
    log("🔄 Shop ID change requested — restarting the agent...")
    try:
        if os.path.exists(SHOP_CONFIG_FILE):
            os.remove(SHOP_CONFIG_FILE)
    except Exception as e:
        log(f"Config delete error: {e}", "ERROR")

    try:
        # Mutex release karo warna naya instance "already running" samajh
        # ke exit ho jayega aur Shop ID popup kabhi nahi khulega
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
        # Naye process ko apna temp folder extract karne ka time do. Iske
        # bina purana bootloader apna _MEIxxxxxx folder delete kar sakta hai
        # jabki naya process abhi imports hi kar raha hota hai.
        time.sleep(2.0)
    except Exception as e:
        log(f"Restart error: {e}", "ERROR")

    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    os._exit(0)

def _uninstall_clear_autostart():
    """Registry Run key aur Startup folder — dono jagah se naam hata do."""
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
            pass                          # pehle se nahi thi — theek hai
        finally:
            winreg.CloseKey(key)
    except Exception as e:
        log(f"Uninstall: registry entry nahi hat payi: {e}", "WARN")

    folder = _startup_folder()
    if folder:
        # EchelPrintAgent.vbs abhi ka hai. EchelPrint.bat bahut purane
        # INSTALL.bat ka chhoda hua ho sakta hai — wo bhi hata do, warna
        # PC restart par Python wali purani copy chalne ki koshish karegi.
        for name in (STARTUP_VBS_NAME, "EchelPrint.bat"):
            path = os.path.join(folder, name)
            try:
                if os.path.exists(path):
                    os.remove(path)
                    gone.append(name)
            except Exception as e:
                log(f"Uninstall: {name} nahi hat payi: {e}", "WARN")
    return gone


def _uninstall_cleanup_bat():
    """
    Agent band hone ke baad exe aur data folder mitane wali chhoti .bat.

    Blocks — `if ... (` — jaan-boojh kar nahi likhe: cmd poore block ko
    ek saath padhta hai, isliye %N% ki purani value hi lagti rehti hai
    aur ginti kabhi aage nahi badhti. Isliye sirf goto/label.

    Lautati hai: (bat ka raasta, exe ka raasta). bat "" ho to kuch nahi
    hua; exe "" ho to sirf data folder mitana hai.
    """
    target = ""
    if is_running_as_exe():
        cand = os.path.abspath(sys.executable)
        # Zaroori pehra: script mode me sys.executable python.exe hota
        # hai. is_running_as_exe() waise hi rok deta hai, par yahan
        # dobara jaanch lena sasta hai — Python kabhi delete nahi hona
        # chahiye.
        if os.path.basename(cand).lower() not in ("python.exe", "pythonw.exe"):
            target = cand

    bat = os.path.join(tempfile.gettempdir(), f"qsp-uninstall-{int(time.time())}.bat")
    # Raaste .bat ke andar mat likho — %~1 (exe) aur %~2 (data folder) ban
    # kar argument me jaate hain. Wajah wahi jo update wali .bat par likhi
    # hai: cmd file ko ANSI codepage me padhta hai, aur Hindi/Bangla naam
    # wale user ka raasta wahin kachra ban jaata hai.
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
        log(f"Uninstall helper nahi ban paayi: {e}", "ERROR")
        return "", target


def _uninstall_flow():
    """Tray se Uninstall — confirm, Shop ID, phir safai. Alag thread me."""
    ok = _native_yesno(
        "Uninstall Echel from this computer?\n\n"
        "The agent will stop, auto-start will be removed, and the program "
        "and its settings will be deleted from this PC.\n\n"
        "QR printing will stop working on this computer.",
        "Echel - Uninstall")
    if ok is not True:
        log("Uninstall cancel — confirm par Yes nahi mila")
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
        if typed is None:                 # bada box bana hi nahi
            typed = _powershell_input("Type your Shop ID to confirm uninstall")
        typed = (typed or "").strip().upper()
        if not typed:
            log("Uninstall cancel — Shop ID khali chhodi gayi")
            return
        if typed == want:
            break
        if attempt == 1:
            _msgbox("That Shop ID does not match. Please try once more.",
                    "Echel - Uninstall", 0x30)
        else:
            _msgbox("Shop ID did not match - nothing was removed.",
                    "Echel - Uninstall", 0x10)
            log("Uninstall roka gaya — Shop ID match nahi hui", "WARN")
            return

    log("🗑 Uninstall shuru — Shop ID confirm ho gayi")
    agent_state["running"] = False        # naya print job na uthe
    try:
        wake_print_loop()
    except Exception:
        pass

    gone = _uninstall_clear_autostart()
    log("Uninstall: auto-start hataya — " + (", ".join(gone) if gone else "kuch mila hi nahi"))
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
        _release_mutex()                  # warna .bat exe delete nahi kar payegi
    except Exception:
        pass
    if bat:
        try:
            # cwd TEMP me rakho — agar cmd ka cwd usi folder ke andar hua
            # jise mitana hai, to `rmdir /s` "process cannot access" de kar
            # fail ho jaata hai.
            _spawn_detached(["cmd", "/c", bat, exe_path, _APPDATA_DIR],
                            cwd=tempfile.gettempdir())
        except Exception as e:
            log(f"Uninstall helper chali nahi: {e}", "ERROR")
    if agent_state["tray_icon"]:
        agent_state["tray_icon"].stop()
    time.sleep(0.5)
    os._exit(0)


def uninstall_agent(icon=None, item=None):
    """
    Tray ka '🗑 Uninstall'. Kaam alag thread me — pystray ka handler tray
    ke apne loop me chalta hai, aur wahan modal dialog kholne par tray
    menu jam jaata hai.
    """
    threading.Thread(target=_uninstall_flow, daemon=True).start()


def quit_agent(icon=None, item=None):
    """Shut the agent down gracefully when 'Exit' is clicked in the tray"""
    log("👋 Exit pressed from the tray — shutting the agent down...")
    agent_state["running"] = False
    wake_print_loop()     # sleep me atka loop turant khatam ho
    # Panel window band karo — warna main thread ka webview loop chalta
    # reh jaata hai aur process poori tarah band nahi hota.
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
    Tray menu me function SEEDHA mat do — hamesha isse lapet kar do.

    KYUN (ye ek asli bug tha, theory nahi):
    pystray sirf 0, 1 ya 2 parameter wala callable accept karta hai. 3 ya
    usse zyada dekhte hi wo MenuItem banate waqt phenk deta hai:

        File "pystray/_base.py", in _assert_action
        ValueError: <function reconnect_to_server at 0x...>

    Aur ye exception poora `pystray.Menu(...)` banna rok deta hai — yaani
    TRAY ICON BANTA HI NAHI. v2.3 me bilkul yahi hua: auto-reconnect
    feature ne reconnect_to_server() me teesra parameter (announce=True)
    jod diya, aur us din se na tray icon aaya na panel khula. Printing
    chalti rehti thi kyunki wo apne alag thread me hai — isliye wajah
    pakadna aur mushkil ho gaya tha.

    Ye wrapper hamesha THEEK 2 parameter dikhata hai, chahe asli function
    me kitne bhi ho. Aage koi naya parameter add kare to bhi tray safe.
    """
    def _runner(icon=None, item=None):
        return fn(icon, item)
    # Log/debug me asli naam dikhe, '_runner' nahi
    try:
        _runner.__name__ = fn.__name__
    except Exception:
        pass
    return _runner


# Tray icon ko taiyaar hone ke liye itne second do. Slow PC par pystray
# ko window banane me thoda time lagta hai; 12s me aaram se ho jaata hai.
TRAY_WAIT_SEC = 12


def _tray_is_up(icon, timeout=TRAY_WAIT_SEC):
    """
    Tray icon SACH ME ban gaya?

    icon.run_detached() turant laut aata hai — uska laut jaana iska sabut
    NAHI hai ki icon ban gaya. pystray Windows par apna (chhupa hua)
    window ek alag thread me banata hai aur usi ka handle _hwnd me rakhta
    hai. Us thread me kuch fail ho to _hwnd kabhi set hi nahi hota.
    Isliye handle ka intezaar karte hain, function ke return ka nahi.
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
    Owner ne exe par dobara double-click kiya? Wo doosra instance ek
    request file chhod kar band ho jaata hai — hum wahi dekh kar apna
    panel khol dete hain.
    """
    while agent_state.get("running", True):
        try:
            if os.path.exists(PANEL_REQUEST_FILE):
                try:
                    os.remove(PANEL_REQUEST_FILE)
                except Exception:
                    pass
                log("🪟 Panel request mili (exe dobara chalaya gaya) — panel khol rahe hain")
                if PANEL is not None:
                    try:
                        PANEL.open_panel()
                    except Exception as e:
                        log(f"Panel nahi khul paya: {e}", "WARN")
        except Exception:
            pass
        time.sleep(1)


def run_tray_icon():
    """
    System Tray icon start karo. Yeh function tray ke event-loop mein
    block ho jaata hai — isliye print-checking loop ko alag thread mein chalate hain.
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
            # DEMO-ONLY: conversion ke turant baad ye apne aap gayab ho
            # jaata hai — pystray har baar menu render karte waqt visible()
            # dobara call karta hai. Reinstall ki zaroorat nahi.
            # ── HAR ACTION _tray_action() SE HO KAR JAATA HAI ──
            # Ek bhi action seedha diya aur usme 2 se zyada parameter hue,
            # to pystray poora menu banane se mana kar deta hai aur TRAY
            # ICON GAYAB ho jaata hai (v2.3 me reconnect_to_server ke saath
            # yahi hua tha). Naya menu item add karo to wrapper mat bhoolna.
            Item("⚡ Change Demo ID to Paid Shop", _tray_action(open_upgrade_panel),
                 visible=lambda item: is_demo_shop()),
            Item("⚙ Settings", _tray_action(open_panel), default=True),
            # Do taale iske andar hain (confirm + Shop ID), isliye Settings
            # ke bagal me hone par bhi galti se kuch nahi udta.
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
        icon = pystray.Icon("qr_se_print", icon_image, "Echel — Starting...", menu)
        agent_state["tray_icon"] = icon

        # ══════════════════════════════════════════════════════
        # THREAD BAANT
        #
        # Windows par pywebview KEVAL main thread par window bana sakta
        # hai. Background thread se ye error aata hai:
        #     "pywebview must be run on a main thread"
        # Udhar pystray ka icon.run() bhi main thread chahta hai.
        #
        # Isliye:
        #   MAIN thread       -> panel (pywebview)
        #   Background thread -> tray  (icon.run_detached())
        #
        # Panel available na ho to sab kuch pehle jaisa: tray main
        # thread par, printing bilkul waise hi chalti rahegi.
        # ══════════════════════════════════════════════════════
        use_panel = False
        if PANEL is not None:
            try:
                use_panel = PANEL.panel_available()
            except Exception as e:
                log(f"Panel check failed: {e}", "WARN")
                use_panel = False

        if not use_panel:
            log("Panel is PC par available nahi — tray main thread par chala rahe hain")
            icon.run()               # purana behaviour — tray only
            return

        try:
            icon.run_detached()      # tray background thread me
        except Exception as e:
            # Kuch systems par run_detached support nahi hota — tab panel
            # chhod do, printing zaroori hai.
            log(f"Tray detached mode unavailable ({e}) — tray-only mode", "WARN")
            icon.run()
            return

        # ── AB CONFIRM KARO KI TRAY SACH ME AAYA ──
        # Ye check isliye hai: run_detached() turant laut aata hai, par
        # icon banta hai ek doosre thread me. Wahan kuch fail ho jaye to
        # PEHLE ye hota tha — na tray icon, na koi error, aur uske turant
        # baad panel main thread le leta tha. Owner ko dikhta kuch nahi
        # tha aur log bilkul saaf rehta tha, isliye wajah pakadna
        # namumkin ho jaata tha. Ab agar tray nahi aaya to use main
        # thread par chalate hain — tray PAKKA milega (panel us halat me
        # nahi khulega, par printing par koi asar nahi).
        if not _tray_is_up(icon):
            log(f"Tray icon {TRAY_WAIT_SEC}s me nahi aaya — ab ise main thread "
                f"par chala rahe hain. Panel is baar nahi khulega; printing "
                f"aur auto-update normal chalte rahenge.", "WARN")
            try:
                icon.run()
            except Exception as e:
                import traceback as _tb
                log(f"Tray main thread par bhi start nahi hua: {e}", "ERROR")
                log(_tb.format_exc(), "ERROR")
            return

        log("✅ Tray icon ready — ab panel main thread par khul raha hai")

        # Main thread ab panel ko de do. Shop ID verify ho chuka hai,
        # isliye panel seedha khulega (spec).
        ok = PANEL.start_ui_loop(show_now=True)
        if not ok:
            log("Panel could not start — continuing in tray-only mode", "WARN")

        # Yahan tabhi pahunchte hain jab panel ka loop khatam ho gaya ho,
        # ya shuru hi na hua ho. Dono me tray aur print thread abhi chal
        # rahe hain — agar yahan se return kar diya to process mar jayega
        # aur PRINTING BAND ho jayegi. Isliye zinda raho.
        # Sirf Exit (quit_agent) hi process band karta hai — wo running=False
        # karke os._exit(0) call karta hai.
        while agent_state.get("running", True):
            time.sleep(1)
    except ImportError as e:
        # Pehle yahan sirf ek generic line jaati thi. Asli module ka naam
        # kabhi log me nahi aata tha, isliye "tray gayab" wali shikayat par
        # kuch pata hi nahi chalta tha ki kaun si cheez missing hai.
        import traceback as _tb
        log(f"⚠️  Tray ke liye zaroori module nahi mila: {e}", "WARN")
        log(_tb.format_exc(), "WARN")
        log("    Console mode me chal rahe hain — printing normal chalegi.", "WARN")
    except Exception as e:
        import traceback as _tb
        log(f"❌ Tray icon could not start: {e}", "ERROR")
        log(_tb.format_exc(), "ERROR")

# ─── MAIN PRINT LOOP (background thread mein chalta hai jab tray active ho) ──
def print_loop():
    log("=" * 50)
    log(f"Job check: {CHECK_INTERVAL}s busy | {IDLE_INTERVAL_1}s ({IDLE_STEP_1_SEC//60} min khaali) "
        f"| {IDLE_INTERVAL_2}s ({IDLE_STEP_2_SEC//60} min khaali) — job aate hi wapas {CHECK_INTERVAL}s par")
    log("=" * 50)
    update_tray_status("Running — waiting for jobs")

    errors = 0
    check_count = 0
    idle_since = time.time()      # aakhri job kab aaya tha
    cur_interval = CHECK_INTERVAL
    elapsed_min = 0.0
    last_socket_refresh = time.time()
    last_err_log = 0.0
    _poll_took = 0.0        # aakhri poll me server ne kitni der li
    _lp_active = False      # kya server long poll support karta hai

    while agent_state["running"]:
        try:
            # Manual "Reconnect to Server" — turant fast mode par wapas aao
            if agent_state.get("reconnect_requested"):
                agent_state["reconnect_requested"] = False
                errors = 0
                idle_since = time.time()
                cur_interval = CHECK_INTERVAL
                # Manual Reconnect ka matlab hi yahi hai ki kuch atka hai —
                # isliye purana session phenk kar naya socket banao.
                reset_http()
                last_socket_refresh = time.time()
                _reset_poll_log()
                log("🔌 Reconnect requested — naya connection banakar check kar rahe hain...")

            # Lambi idle ke baad socket mar chuka hota hai. Job aane ka
            # intezaar mat karo — khaali baithe hi session refresh kar do,
            # taaki asli job aaye to pehla hi poll kaam kar jaye.
            if (time.time() - idle_since) > IDLE_STEP_1_SEC and \
               (time.time() - last_socket_refresh) >= IDLE_SOCKET_REFRESH_SEC:
                reset_http()
                last_socket_refresh = time.time()
                log("🔁 Idle socket refresh — naya connection taiyaar")

            _mei_watch()          # khud ko throttle karta hai (har 5 min)

            _t_poll = time.time()
            jobs = get_pending_jobs()
            _poll_took = time.time() - _t_poll
            check_count += 1

            # None = poll FAIL. Ise [] (koi job nahi) se alag rakhna
            # zaroori hai. except me bhejte hain taaki wahan baithi
            # recovery — reset_http(), backoff, tray "Offline" — chale.
            if jobs is None:
                raise PollError("server se jawab nahi mila")

            # Server ne jawab de diya = connection theek hai. Chahe jobs
            # mile ya nahi, error state yahin clear kar do.
            # (Purana bug: status sirf 'if jobs' ke andar reset hota tha,
            #  isliye ek network blip ke baad tray hamesha ke liye
            #  "Error — retrying" par atak jaata tha.)
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
                # Job aaya = dukaan busy hai. Turant tez check par wapas.
                idle_since = time.time()
                if cur_interval != CHECK_INTERVAL:
                    cur_interval = CHECK_INTERVAL
                    log(f"⚡ Fast mode — har {CHECK_INTERVAL}s check")
            else:
                # v2.0: sirf do speed — 5s (abhi job aaya tha) aur 10s (khaali).
                # Pehle 45s tak chala jaata tha, jisse job aane ke baad
                # print me 45 second tak ki deri ho sakti thi.
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

                # ── LONG POLL: sona nahi hai ──
                # Server ne line 30 sec pakdi rakhi thi, matlab utni der wo
                # KHUD intezaar kar chuka hai. Ab upar se aur sleep karna
                # matlab bekaar me deri. Turant nayi line jod do.
                #
                # Kaise pata ki long poll chala? Agar server ne jaldi jawab
                # diya (LP se kaafi kam), to wo purana server hai jo lp nahi
                # jaanta — tab purana sleep hi sahi hai.
                if _poll_took >= (LP_SECONDS * 0.7):
                    _lp_active = True
                    continue          # seedha agla poll — koi sleep nahi
                else:
                    _lp_active = False
                elapsed_min += cur_interval / 60.0
                if check_count % 60 == 0:
                    log(f"👀 Waiting... ({int(elapsed_min)} min)")
                # Poll safal = sab theek. Tray par jo bhi purana text bacha
                # ho (Error / Offline / Reconnecting), use hata do.
                # BUG THA: pehle sirf "Error"/"Offline" par reset hota tha,
                # isliye "Reconnecting..." hamesha ke liye atak jaata tha.
                if not _shop_gone and \
                   agent_state.get("status", "") != "Running — waiting for jobs":
                    update_tray_status("Running — waiting for jobs")

            # Sleep chhote tukdon mein — taaki Reconnect click karte hi
            # agent 60s tak so na jaaye.
            # Shop server par hai hi nahi — 12 second ki jagah 30 minute.
            # Yahi wo badlaav hai jo bekaar wali request rokta hai.
            if _shop_gone:
                cur_interval = SHOP_GONE_INTERVAL
            _interruptible_sleep(cur_interval)
        except KeyboardInterrupt:
            log("\n👋 Shutting down...")
            break
        except Exception as e:
            errors += 1
            # Har fail par line likhne se log file bhar jaati hai:
            # 12s polling me ~300 line/ghanta, aur asli baat dab jaati
            # hai. Pehli 3 turant likho, uske baad har 60s me ek.
            if errors <= 3 or (time.time() - last_err_log) >= 60:
                last_err_log = time.time()
                log(f"❌ Error: {e}", "ERROR")
            if errors == 2:
                # Do baar fail = socket sach me mar chuka hai. Naya session
                # banao taaki user ko khud Reconnect na dabana pade.
                # (Pehle 3 par tha — 12s polling me wo ~36s ka intezaar
                #  ban jaata tha. 2 par recovery kaafi tez ho jaati hai.)
                log("🔄 Connection reset kar rahe hain (auto)")
                reset_http()
                last_socket_refresh = time.time()
            if errors >= 3:
                was_offline = agent_state.get("connection") == "offline"
                agent_state["connection"] = "offline"
                # Counter chal raha ho to tray ka text mat chheedo —
                # warna ulta counter har second overwrite ho jayega.
                if not auto_reconnect_active():
                    update_tray_status("Offline — click Reconnect to Server")
                # Counter sirf tab shuru karo jab ABHI offline hue hain,
                # ya lambi outage me notification ka gap poora ho gaya ho.
                # Har error par shuru karte to 10s ka loop ban jaata aur
                # backoff ka koi matlab nahi rehta.
                if (not was_offline) or \
                   (time.time() - _auto_rc_last_notify) >= AUTO_RECONNECT_NOTIFY_GAP:
                    start_auto_reconnect_countdown()
            else:
                agent_state["connection"] = "connecting"
                update_tray_status("Reconnecting...")
            # Capped exponential backoff: 5s, 10s, 20s, 40s ... max 60s.
            # Pehle 10 errors ke baad seedha 60s ho jaata tha aur counter
            # reset ho jaata tha, jisse offline detection bhi reset ho jaati.
            backoff = min(CHECK_INTERVAL * (2 ** min(errors - 1, 5)), 60)
            _interruptible_sleep(backoff)

def main():
    show_banner()
    check_dependencies()

    _load_processed()
    log(f"🚀 Agent start | Shop: {SHOP_ID} | Version: v{VERSION_LABEL} (build {VERSION})")
    log(f"🌐 Server: {SERVER_URL}")

    # PC restart pe agent khud tray mein start ho — HKCU Run registry
    add_to_startup()

    # CRITICAL FIX: Pehle yahan printer na milne par input("Enter dabao...")
    # call hota tha — yeh .exe ke WINDOWED mode mein (jahan koi console/STDIN
    # hi nahi hota, kyunki yeh background tray app hai) crash ya silent hang
    # kar deta tha. Yeh exact situation PC restart ke turant baad hoti hai:
    # Windows Startup se agent turant launch hota hai, lekin printer driver/
    # USB/network printer abhi initialize nahi hua hota — check_printer()
    # fail ho jaata, aur poora process crash ho jaata bina kisi visible
    # error ke. Isi wajah se "it sometimes disappears from the tray" wala
    # symptom aata tha.
    #
    # FIX: ab hum RETRY karte hain (printer thodi der mein ready ho sakta
    # hai), aur agar baar-baar fail bhi ho, to PROCESS CRASH NAHI karte —
    # tray icon phir bhi chalta rehta hai, aur background mein printer
    # detection retry hota rehta hai (print_loop ke through).
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

    # Printer list server ko report karo (startup pe) — Dashboard mein
    # dropdown se B&W/Color printer select karne ke liye zaroori hai
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

    # Demo shop par upgrade reminder (subah 9 se raat 8, 4 baar)
    demo_thread = threading.Thread(target=demo_reminder_loop, daemon=True)
    demo_thread.start()

    # Auto-update checker background thread mein chalao
    update_thread = threading.Thread(target=update_checker_loop, daemon=True)
    update_thread.start()
    log(f"🔄 Auto-update checker active — din me 2 baar ({UPDATE_HOURS[0]}:00 aur {UPDATE_HOURS[1]}:00 ke aas-paas)")

    # Print loop bhi background thread mein chalao — taaki tray icon
    # foreground mein chal sake (yeh OS requirement hai tray icons ke liye)
    print_thread = threading.Thread(target=print_loop, daemon=True)
    print_thread.start()

    # Owner exe par dobara double-click kare to panel khul jaye
    threading.Thread(target=panel_request_watcher, daemon=True).start()

    # Purani request file (pichhli baar ki) pehle hi saaf kar do, warna
    # start hote hi bina wajah panel khul jayega.
    try:
        if os.path.exists(PANEL_REQUEST_FILE):
            os.remove(PANEL_REQUEST_FILE)
    except Exception:
        pass

    # Tray icon start karo (yeh block karega jab tak Exit na dabaya jaye)
    try:
        run_tray_icon()
    except Exception as trayErr:
        log(f"⚠️  Tray icon error: {trayErr}", "WARN")

    # Agar tray fail ho jaye (pystray missing), normal console mode mein chalte raho
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
    # CRITICAL FIX: poora main() ab try/except mein wrapped hai. Pehle agar
    # kahin bhi koi unexpected exception aati (kisi bhi function se), poora
    # process SILENTLY CRASH ho jaata — tray se gayab ho jaata bina kisi
    # trace ke. Ab har crash LOG_FILE mein likha jaata hai, taaki Tray menu
    # ke "📋 View Logs" se customer/owner asal wajah dekh sake.
    try:
        main()
    except Exception as fatalErr:
        try:
            log(f"💥 FATAL CRASH: {fatalErr}", "ERROR")
            import traceback
            log(traceback.format_exc(), "ERROR")
        except Exception:
            pass  # agar logging bhi fail ho jaaye, kam se kam process clean exit kare
