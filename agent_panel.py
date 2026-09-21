"""
Echel — Desktop Control Panel
====================================
This module is ONLY the UI layer. Printing, tray, Shop ID verification, updates —
everything in print_agent.py keeps running exactly as before. The panel calls those
same functions and keeps no logic of its own.

Design rules (deliberate):

1. If the panel FAILS, printing never stops.
   No WebView2, pywebview not installed, a window crash — the agent
   keeps running in the background. The panel is optional, not required.

2. No duplicated business logic.
   Settings go through the same server APIs the website dashboard
   uses. The agent exchanges its agent_token for a short-lived admin token
   (/api/jobs/<shop>/panel-session).

3. The token never reaches JavaScript.
   The panel's JS only calls pywebview.api.*; Python makes the real HTTP
   requests. The panel's HTML contains no secrets.

4. Close (X) = hide into the tray. Only Exit stops the agent.
"""

import os
import sys
import json
import time
import threading
import webbrowser

# ── These are injected from print_agent.py (to avoid a circular import) ──
_AGENT = None          # print_agent module reference


def bind(agent_module):
    """print_agent.py calls this at startup."""
    global _AGENT
    _AGENT = agent_module


def _log(msg, level="INFO"):
    try:
        _AGENT.log(f"[panel] {msg}", level)
    except Exception:
        print(f"[panel] {msg}")


def _runtime_dir():
    """
    %APPDATA%\\EchelPrint\\runtime — at startup print_agent.py keeps a persistent copy
    of the essential bundle files here. The same path is built here too
    (not imported, because the panel must not depend on print_agent).
    """
    try:
        import tempfile
        base = os.environ.get("APPDATA") or tempfile.gettempdir()
        return os.path.join(base, "EchelPrint", "runtime")
    except Exception:
        return ""


def panel_html_path():
    """
    Find agent_panel.html — in all three modes: .exe (PyInstaller _MEIPASS), the safe
    copy in APPDATA, and a normal script.

    Why the safe copy: onefile's _MEI folder can be cleaned while the agent runs
    (it happened on 22 Aug 2026). Then the _MEIPASS HTML vanished and the panel
    stopped opening.
    """
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    for cand in (os.path.join(base, "agent_panel.html"),
                 os.path.join(_runtime_dir(), "agent_panel.html"),
                 os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_panel.html")):
        if cand and os.path.exists(cand):
            return cand
    return None


# ══════════════════════════════════════════════════════════════
# SERVER SESSION — agent token → short-lived admin token
# ══════════════════════════════════════════════════════════════
class _Session:
    """
    Admin token cache. Valid for 2 hours; it is refreshed before it
    expires so no 401 appears in the middle of using the panel.
    """

    def __init__(self):
        self.token = None
        self.expires_at = 0
        self.shop_type = "paid"
        self.shop_name = ""
        self._lock = threading.Lock()

    def get(self, force=False):
        with self._lock:
            if not force and self.token and time.time() < self.expires_at - 300:
                return self.token
            try:
                import requests
                r = requests.post(
                    f"{_AGENT.SERVER_URL}/api/jobs/{_AGENT.SHOP_ID}/panel-session",
                    headers=_AGENT.auth_headers(), timeout=15)
                if r.status_code != 200:
                    _log(f"panel-session failed: HTTP {r.status_code}", "WARN")
                    return None
                d = r.json()
                self.token = d.get("token")
                self.expires_at = time.time() + int(d.get("expiresInSec") or 7200)
                self.shop_type = d.get("shopType") or "paid"
                self.shop_name = d.get("shopName") or ""
                return self.token
            except Exception as e:
                _log(f"panel-session error: {e}", "WARN")
                return None


_session = _Session()


def shop_type():
    """'demo' or 'paid' — from the backend. The tray menu decides based on this."""
    try:
        _session.get()
        return _session.shop_type
    except Exception:
        return "paid"


def _api(method, path, payload=None, retry_auth=True):
    """
    Call an existing admin API with the admin token.
    The same endpoints the website dashboard uses — no new API.
    """
    import requests
    token = _session.get()
    if not token:
        return {"ok": False, "error": "Could not reach the server. Check your internet connection."}
    try:
        url = f"{_AGENT.SERVER_URL}{path}"
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        if method == "GET":
            r = requests.get(url, headers=headers, timeout=20)
        elif method == "PUT":
            r = requests.put(url, headers=headers, json=payload or {}, timeout=20)
        else:
            r = requests.post(url, headers=headers, json=payload or {}, timeout=20)

        if r.status_code == 401 and retry_auth:
            _session.get(force=True)                    # token expired — refresh once
            return _api(method, path, payload, retry_auth=False)

        try:
            data = r.json()
        except Exception:
            data = {}
        if r.status_code >= 400:
            return {"ok": False, "error": data.get("error") or f"Server error ({r.status_code})"}
        if isinstance(data, dict):
            data.setdefault("ok", True)
            return data
        return {"ok": True, "data": data}
    except Exception as e:
        return {"ok": False, "error": f"Could not reach the server: {e}"}


class _SavedPrinters:
    """
    Which printer the shop chose for B&W and Color — the one
    saved on the server. NOT the Windows default printer.

    An empty string means "nothing chosen, the Windows default
    applies" — that is an answer in itself, so it is never filled
    with a name.

    It is filled from three places:
      * the server (/api/admin/profile) — every 30 seconds, in a separate thread
        so the panel never blocks
      * save_printers() — immediately after a save, without waiting for the server
      * disk — so the last known value is still at hand when the network is down
    """
    TTL = 30          # second

    def __init__(self):
        self.bw = ""
        self.color = ""
        self.known = False        # has it ever really been known?
        self._at = 0
        self._busy = False
        self._lock = threading.Lock()
        self._load_disk()

    # ── disk ──
    def _path(self):
        try:
            import tempfile
            base = os.environ.get("APPDATA") or tempfile.gettempdir()
            d = os.path.join(base, "EchelPrint")
            if not os.path.isdir(d):
                os.makedirs(d)
            return os.path.join(d, "panel_printers.json")
        except Exception:
            return ""

    def _load_disk(self):
        try:
            path = self._path()
            if not path or not os.path.exists(path):
                return
            with open(path, "r", encoding="utf-8") as f:
                d = json.load(f)
            if isinstance(d, dict):
                self.bw = str(d.get("bw") or "")
                self.color = str(d.get("color") or "")
                self.known = bool(d.get("known"))
        except Exception:
            pass

    def _save_disk(self):
        try:
            path = self._path()
            if not path:
                return
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"bw": self.bw, "color": self.color,
                           "known": self.known}, f)
            os.replace(tmp, path)
        except Exception:
            pass

    # ── server ──
    def _fetch(self):
        try:
            d = _api("GET", "/api/admin/profile")
            if d.get("ok"):
                with self._lock:
                    self.bw = str(d.get("printer_name_bw") or "")
                    self.color = str(d.get("printer_name_color") or "")
                    self.known = True
                    self._at = time.time()
                self._save_disk()
            else:
                # On failure do not throw away the old value — just try again
                # a little later.
                self._at = time.time() - self.TTL + 8
        except Exception as e:
            _log(f"saved printers fetch fail: {e}", "WARN")
            self._at = time.time() - self.TTL + 8
        finally:
            self._busy = False

    def touch(self):
        """If it is stale, refresh it in the background. Never blocks."""
        if self._busy or (time.time() - self._at) < self.TTL:
            return
        self._busy = True
        try:
            threading.Thread(target=self._fetch, daemon=True).start()
        except Exception:
            self._busy = False

    def set(self, bw, color):
        """The save succeeded — this is now what the server holds; update the cache immediately."""
        with self._lock:
            self.bw = str(bw or "")
            self.color = str(color or "")
            self.known = True
            self._at = time.time()
        self._save_disk()


_saved_printers = _SavedPrinters()


# ══════════════════════════════════════════════════════════════
# JS ↔ PYTHON API
# Every panel button ends up here.
# ══════════════════════════════════════════════════════════════
class PanelAPI:

    def __init__(self):
        self._window = None
        self._printers_cache = []
        self._printers_at = 0

    # ── window ──
    def win_minimize(self):
        try:
            self._window.minimize()
        except Exception:
            pass
        return {"ok": True}

    def win_maximize(self):
        try:
            self._window.toggle_fullscreen()
        except Exception:
            pass
        return {"ok": True}

    def win_close(self):
        """X = hide into the tray. The agent does NOT stop."""
        try:
            self._window.hide()
            _log("Panel hidden to tray — agent still running")
        except Exception as e:
            _log(f"hide failed: {e}", "WARN")
        return {"ok": True}

    # ── state ──
    def get_state(self):
        try:
            # Ensure the session first — shopType/shopName come from it.
            # Otherwise the very first time the panel opens, even a DEMO shop shows as "paid"
            # and the upgrade banner disappears.
            _session.get()
            # The chosen printer from the server — it keeps being refreshed
            # in the background; this call never blocks.
            _saved_printers.touch()
            st = _AGENT.agent_state
            conn = st.get("connection", "connecting")
            remote = _AGENT.REMOTE_VERSION_LABEL
            # Compare INTEGER build numbers, not labels — "2.9" > "2.10"
            # comes out wrong in a string compare.
            update_available = bool(getattr(_AGENT, "REMOTE_VERSION_INT", 0) > _AGENT.VERSION)
            return {
                "ok": True,
                "shopId": _AGENT.SHOP_ID,
                "shopName": _session.shop_name or _AGENT.SHOP_ID,
                "shopType": _session.shop_type,
                "connection": conn,
                "version": _AGENT.VERSION_LABEL,
                "latestVersion": remote or _AGENT.VERSION_LABEL,
                "updateAvailable": update_available,
                # ⚠️ This used to return agent_state's "printer" —
                # that is the Windows DEFAULT printer, not the one the shop chose.
                # That is why pressing Refresh Printer List switched the dropdown
                # to the default. Now it is the value saved on the server.
                "printerBw": _saved_printers.bw,
                "printerColor": _saved_printers.color,
                # The panel needs to know whether this value is known or not
                # known yet (network down). If it is not known, the panel
                # does not touch the dropdown.
                "printersKnown": _saved_printers.known,
                "defaultPrinter": st.get("printer") or "",
                # Empty = the Windows default applies, meaning printing still
                # works — so this is false only when there is no printer at all.
                "printerBwReady": bool(_saved_printers.bw or st.get("printer")),
                "printerColorReady": bool(_saved_printers.color or _saved_printers.bw or st.get("printer")),
                "lastSync": time.strftime("%I:%M:%S %p"),
            }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_stats(self):
        """The dashboard numbers — the same endpoint the website uses."""
        d = _api("GET", "/api/admin/stats")
        if not d.get("ok"):
            return {"ok": False, "error": d.get("error")}
        acts = []
        for j in (d.get("recent") or [])[:4]:
            acts.append({
                "id": "#" + str(j.get("id", ""))[-4:],
                "ago": j.get("ago") or "",
                "status": (j.get("status") or "").title() or "Completed",
            })
        return {
            "ok": True,
            "todayPrints": d.get("todayPrints", d.get("today_prints", 0)) or 0,
            "todayEarnings": d.get("todayEarnings", d.get("today_earnings", 0)) or 0,
            "totalOrders": d.get("totalOrders", d.get("total_orders", 0)) or 0,
            "totalEarnings": d.get("totalEarnings", d.get("total_earnings", 0)) or 0,
            "prevPrints": d.get("prevPrints", 0) or 0,
            "prevEarnings": d.get("prevEarnings", 0) or 0,
            "shopOpen": not bool(d.get("paused")),
            # The server sends 'low_ink' / 'no_paper', but the panel buttons
            # understand 'ink' / 'paper'. This used to be passed straight through,
            # so a chosen Low Ink / No Paper was never highlighted
            # — the panel always kept showing "All Good".
            "supply": self._SUPPLY_FROM_SERVER.get(
                str(d.get("supply_warning") or ""), "ok"),
            "activity": acts,
        }

    # ── settings (existing APIs) ──
    def get_settings(self):
        d = _api("GET", "/api/admin/profile")
        if not d.get("ok"):
            return {"ok": False, "error": d.get("error")}
        d["hasKeys"] = bool(d.get("has_razorpay_secret") or d.get("has_cashfree_secret"))
        # Secrets never reach the panel. They are removed by SUFFIX, not by name
        # — so if a new secret column is added tomorrow, it is held back automatically too.
        for k in list(d.keys()):
            lk = str(k).lower()
            if (lk.endswith("_secret") or lk.endswith("secret_key")
                    or lk.endswith("password") or lk.endswith("password_hash")
                    or lk.endswith("_token")):
                d.pop(k, None)
        return d

    def save_settings(self, payload):
        if not isinstance(payload, dict):
            return {"ok": False, "error": "Invalid data"}
        return _api("PUT", "/api/admin/settings", payload)

    def save_payment(self, payload):
        if not isinstance(payload, dict):
            return {"ok": False, "error": "Invalid data"}
        body = {"payment_mode": payload.get("payment_mode"),
                "payment_gateway": payload.get("payment_gateway")}
        gw = (payload.get("payment_gateway") or "").lower()
        key, secret = payload.get("key") or "", payload.get("secret") or ""
        # Left empty = keep the old value
        if key:
            body["razorpay_key_id" if gw == "razorpay" else "cashfree_app_id"] = key
        if secret:
            body["razorpay_key_secret" if gw == "razorpay" else "cashfree_secret_key"] = secret
        return _api("PUT", "/api/admin/settings", body)

    # ── printers ──
    def get_printers(self):
        try:
            now = time.time()
            if not self._printers_cache or now - self._printers_at > 20:
                self._printers_cache = _AGENT.list_all_printers() or []
                self._printers_at = now
            return {"ok": True, "printers": self._printers_cache}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def refresh_printers(self):
        # This only reads the LIST again. The shop's chosen printer
        # never changes through this — it stays saved on the server and
        # comes from _saved_printers.
        self._printers_cache, self._printers_at = [], 0
        try:
            ok, name = _AGENT.check_printer()
            if ok and name:
                # This is the Windows default — only for the tray's "Printer: ..."
                # line. It has no effect on the dropdown.
                _AGENT.agent_state["printer"] = name
            _AGENT.report_printers_to_server()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_printers(self, bw, color):
        r = _api("PUT", "/api/admin/settings",
                 {"printer_name_bw": bw or "", "printer_name_color": color or ""})
        # If the save succeeded, update the cache right now. Otherwise for the next 30
        # seconds get_state would keep returning the old value and in the panel
        # the new printer would look like it "changed back".
        if r.get("ok"):
            _saved_printers.set(bw, color)
        return r

    def test_print(self):
        try:
            fn = getattr(_AGENT, "send_test_print", None)
            if callable(fn):
                fn()
                return {"ok": True}
            return {"ok": False, "error": "Test print is not available in this version"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── shop controls ──
    #
    # WHY THESE TWO GO TO SEPARATE ENDPOINTS:
    # Both used to go to /api/admin/settings. That endpoint had no handler at all
    # for `paused` and `supply_warning` — the server
    # returned { success:true } but wrote NOTHING to the DB.
    # The old value came back on panel refresh, so pressing "Shop
    # Close" made the toggle snap back to where it was (the same action from
    # the website worked, because the website calls these dedicated
    # endpoints). Now the panel uses the same endpoints as the
    # website — one path, one behaviour.
    def set_shop_open(self, is_open):
        return _api("POST", "/api/shop/pause", {"paused": (not bool(is_open))})

    # The panel vocabulary and the DB vocabulary differ — they are converted right here.
    #   panel: ok / ink / paper      DB: '' / low_ink / no_paper
    _SUPPLY_TO_SERVER = {"ok": "", "ink": "low_ink", "paper": "no_paper"}
    _SUPPLY_FROM_SERVER = {"": "ok", "ok": "ok", "low_ink": "ink", "no_paper": "paper"}

    def set_supply(self, status):
        if status not in self._SUPPLY_TO_SERVER:
            return {"ok": False, "error": "Invalid status"}
        return _api("POST", "/api/shop/supply-warning",
                    {"warning": self._SUPPLY_TO_SERVER[status]})

    # ── agent actions (existing functions) ──
    def sync_now(self):
        """
        The status bar's 'Sync Now'.

        LIGHTER than Reconnect: the socket is not reset and the printer is not
        re-detected. It only asks the server whether it is reachable,
        corrects the connection state, and wakes the print loop
        so a pending job does not have to wait for the poll.

        Reloading the numbers is the panel's refresh() job — only the
        truth about the connection is set here.
        """
        try:
            connected = bool(_AGENT.ping_server())
        except Exception as e:
            return {"ok": False, "error": f"Could not reach the server: {e}"}

        _AGENT.agent_state["connection"] = "online" if connected else "offline"

        if not connected:
            _AGENT.update_tray_status("Offline — click Reconnect to Server")
            _log("Sync Now — could not reach the server", "WARN")
            return {"ok": False, "connected": False,
                    "error": "Could not reach the server — check the internet connection"}

        _AGENT.update_tray_status("Running — waiting for jobs")
        try:
            _AGENT.wake_print_loop()      # so a pending job comes out immediately
        except Exception:
            pass
        _log("Sync Now — fetched fresh data from the server")
        return {"ok": True, "connected": True}

    def reconnect(self):
        """
        Reconnect — the result IMMEDIATELY.

        The HTTP check no longer happens again here. reconnect_to_server() itself
        resets the socket, wakes the print loop, pings the server
        and returns True/False. The logic lives in one place — pressed from the tray
        or from the panel, the behaviour is exactly the same.
        """
        try:
            connected = _AGENT.reconnect_to_server()
        except Exception as e:
            return {"ok": False, "error": str(e)}

        printer = _AGENT.agent_state.get("printer") or ""
        if connected:
            return {"ok": True, "connected": True, "printer": printer}
        return {"ok": True, "connected": False,
                "error": "Could not reach the server — check the internet connection"}

    def open_logs(self):
        try:
            _AGENT.open_logs()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def contact_admin(self, message=""):
        try:
            _AGENT.contact_admin()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def change_shop_id(self):
        try:
            threading.Thread(target=_AGENT.change_shop_id, daemon=True).start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def check_update(self):
        try:
            remote = _AGENT.get_remote_version()
            label = _AGENT.REMOTE_VERSION_LABEL or (str(remote) if remote else _AGENT.VERSION_LABEL)
            avail = bool(remote and remote > _AGENT.VERSION)
            return {"ok": True, "updateAvailable": avail, "latestVersion": label}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def do_update(self):
        try:
            fn = getattr(_AGENT, "check_and_update", None) or getattr(_AGENT, "apply_update_and_restart", None)
            if callable(fn):
                threading.Thread(target=fn, daemon=True).start()
                return {"ok": True}
            return {"ok": False, "error": "Update is not available in this build"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── QR & links ──
    def get_qr(self):
        d = _api("GET", "/api/admin/profile")
        if not d.get("ok"):
            return {"ok": False, "error": d.get("error")}
        return {"ok": True,
                "qrUrl": f"{_AGENT.SERVER_URL}/print/{_AGENT.SHOP_ID}",
                "qrCode": d.get("qr_code") or ""}

    def download_qr(self):
        try:
            d = _api("GET", "/api/admin/profile")
            data_uri = (d or {}).get("qr_code") or ""
            if not data_uri.startswith("data:image"):
                return {"ok": False, "error": "QR not available"}
            import base64
            raw = base64.b64decode(data_uri.split(",", 1)[1])
            dest = os.path.join(os.path.expanduser("~"), "Desktop",
                                f"QR_{_AGENT.SHOP_ID}.png")
            if not os.path.isdir(os.path.dirname(dest)):
                dest = os.path.join(_AGENT._APPDATA_DIR, f"QR_{_AGENT.SHOP_ID}.png")
            with open(dest, "wb") as f:
                f.write(raw)
            try:
                os.startfile(os.path.dirname(dest))
            except Exception:
                pass
            return {"ok": True, "path": dest}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def open_url(self, path=""):
        try:
            url = path if str(path).startswith("http") else f"{_AGENT.SERVER_URL}{path}"
            webbrowser.open(url)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # ── DEMO → PAID CONVERSION ──
    def verify_paid_shop(self, paid_shop_id, password):
        """
        Step 1: verify the paid Shop ID + password on the server.
        Nothing changes here — it is only a check.
        """
        import requests
        pid = str(paid_shop_id or "").strip().upper()
        pwd = str(password or "")
        if not pid:
            return {"ok": False, "error": "Please enter your paid Shop ID"}
        if not pwd:
            return {"ok": False, "error": "Please enter your shop password"}
        try:
            r = requests.post(
                f"{_AGENT.SERVER_URL}/api/agent/verify-paid-shop",
                headers=_AGENT.auth_headers(), timeout=20,
                json={"paidShopId": pid, "password": pwd, "demoShopId": _AGENT.SHOP_ID})
            d = r.json() if r.content else {}
            if r.status_code != 200 or not d.get("success"):
                return {"ok": False, "error": d.get("error") or f"Verification failed ({r.status_code})"}
            # Keep the ticket in Python — it is never given to JS
            self._convert_ticket = d.get("ticket")
            return {"ok": True, "shopId": d.get("shopId"), "shopName": d.get("shopName"),
                    "planType": d.get("planType"), "alreadyLinked": bool(d.get("alreadyLinked"))}
        except Exception as e:
            return {"ok": False, "error": f"Could not reach the server: {e}"}

    def convert_to_paid(self):
        """
        Step 2: switch. The server transfers the agent token, then the agent
        changes its Shop ID live — no reinstall, no restart.
        """
        import requests
        ticket = getattr(self, "_convert_ticket", None)
        if not ticket:
            return {"ok": False, "error": "Please verify your paid Shop ID first"}
        try:
            r = requests.post(
                f"{_AGENT.SERVER_URL}/api/agent/convert-to-paid",
                headers=_AGENT.auth_headers(), timeout=25, json={"ticket": ticket})
            d = r.json() if r.content else {}
            if r.status_code != 200 or not d.get("success"):
                return {"ok": False, "error": d.get("error") or f"Switch failed ({r.status_code})"}

            new_id = d.get("shopId")
            switched = _AGENT.switch_shop_id_live(new_id)
            if not switched:
                return {"ok": False,
                        "error": "Your shop was linked on the server, but the Shop ID could not be applied "
                                 "on this PC. Use 'Change Shop ID' from the tray and enter: " + str(new_id)}
            # "memory-only" = the switch happened and printing is running, only the
            # config file was not saved. Tell the customer, but do not fail.
            warn = None
            if switched == "memory-only":
                warn = ("Connected, but the Shop ID could not be saved on this PC. "
                        "If it asks again after a restart, enter: " + str(new_id))

            # Reset the session — the paid shop's data should come in now
            self._convert_ticket = None
            _session.token = None
            _session.expires_at = 0
            _session.get(force=True)
            _log(f"Converted to paid shop {new_id}")
            out = {"ok": True, "shopId": new_id, "shopName": d.get("shopName")}
            if warn:
                out["warning"] = warn
            return out
        except Exception as e:
            return {"ok": False, "error": f"Could not reach the server: {e}"}

    def open_upgrade(self):
        """Take the panel to the upgrade page."""
        try:
            if self._window:
                self._window.evaluate_js("go('upgrade')")
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}


API = PanelAPI()


# ══════════════════════════════════════════════════════════════
# WINDOW LIFECYCLE
#
# IMPORTANT (Windows): a pywebview window can be created ONLY on the main
# thread. Creating it from a background thread fails with:
#     "pywebview must be run on a main thread"
#
# Meanwhile pystray's (tray icon) icon.run() also wants the main thread.
# Both cannot take the same thread, so the work is split like this:
#
#     MAIN thread      ->  pywebview  (webview.start(), blocking)
#     Background thread->  pystray    (icon.run_detached())
#
# The window is created only once and stays hidden. The tray's "Settings"
# only shows/hides it — a new window is not created every time.
# ══════════════════════════════════════════════════════════════
_window = None
_ui_running = False
_unavailable_reason = None
_pending_page = None


def _goto_pending_page():
    """If the tray asked for 'upgrade', the panel opens right there."""
    global _pending_page
    if not _pending_page or _window is None:
        return
    try:
        _window.evaluate_js(f"go('{_pending_page}')")
    except Exception:
        pass
    _pending_page = None


def panel_available():
    """
    Needs both pywebview + agent_panel.html. On an old Windows 10 without the
    WebView2 runtime the panel will not run — the agent then keeps running in the
    tray exactly as before; printing is not affected.
    """
    global _unavailable_reason
    try:
        import webview  # noqa: F401
    except Exception as e:
        _unavailable_reason = f"pywebview not available ({e})"
        return False
    if not panel_html_path():
        _unavailable_reason = "agent_panel.html not found next to the agent"
        return False
    return True


def start_ui_loop(show_now=True):
    """
    Call this ONLY from the MAIN THREAD. It creates the window and runs the webview
    loop — this call blocks (as icon.run() used to).

    True  = the loop ran fine and has now ended (Exit)
    False = it could not even start (the caller should run in tray-only mode)
    """
    global _window, _ui_running

    if not panel_available():
        _log(f"Panel unavailable — {_unavailable_reason}", "WARN")
        return False

    try:
        import webview
        _window = webview.create_window(
            "Echel — Print Agent",
            panel_html_path(),
            js_api=API,
            # v2.3: the panel is now a single small screen (not 9 pages), so the
            # window is smaller too. The height of 760 is deliberate — even on an
            # old 1366x768 shop PC it fits completely together with the taskbar.
            width=900, height=720,
            min_size=(700, 600),
            background_color="#12131a",
            hidden=not show_now,
            confirm_close=False,
        )
        API._window = _window

        def _on_closing():
            """X = hide, do not close. Only Exit stops the agent."""
            try:
                _window.hide()
                _log("Panel hidden to tray — agent still running")
            except Exception:
                pass
            return False        # close cancel

        try:
            _window.events.closing += _on_closing
        except Exception:
            _log("close-to-tray hook unavailable in this pywebview build", "WARN")

        try:
            _window.events.loaded += lambda: _goto_pending_page()
        except Exception:
            pass

        _ui_running = True
        _log("Panel UI loop starting on the main thread")
        webview.start(debug=False)          # blocks here
        _log("Panel UI loop ended")
        return True

    except Exception as e:
        _log(f"Panel UI loop failed: {e} — agent continues in the tray", "ERROR")
        return False
    finally:
        _ui_running = False
        _window = None
        API._window = None


def open_panel(icon=None, item=None, page=None):
    """
    The tray's '⚙ Settings' / double-click lands here.
    The window already exists — it is just shown.
    This is called from the tray thread, so the window is NOT CREATED here.
    """
    global _pending_page
    if page:
        _pending_page = page

    if _window is None:
        _log("Panel is not available on this PC", "WARN")
        try:
            _AGENT._msgbox(
                "The desktop panel could not start on this PC.\n\n"
                "The Print Agent is still running normally and your printing is unaffected.\n\n"
                "Tip: installing the Microsoft Edge WebView2 Runtime enables the panel.",
                "Echel")
        except Exception:
            pass
        return

    try:
        _window.show()
        _goto_pending_page()
        _log("Panel shown")
    except Exception as e:
        _log(f"Could not show the panel: {e}", "WARN")


def shutdown():
    """Close the window on Exit so the main thread's loop ends."""
    try:
        if _window is not None:
            _window.destroy()
    except Exception:
        pass
