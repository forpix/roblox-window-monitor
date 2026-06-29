#!/usr/bin/env python3
"""Roblox window-monitor alerts -> email (local, launchd cron).

Reuses the game-monitor Gmail-SMTP setup. Creds via env, never in git:
  GM_SMTP_USER  sender Gmail
  GM_SMTP_PASS  Gmail app password (Google account -> Security -> App passwords)
  GM_MAIL_TO    recipient (default = GM_SMTP_USER)
  GM_SMTP_HOST  default smtp.gmail.com
  GM_SMTP_PORT  default 465 (SSL)
Missing USER/PASS -> silently skip sending (still updates seen-state / prints).

The cloud Actions cron commits state/alerts.json every 2h; a candidate is
TRANSIENT (gate B only fires the run its spike beats the rolling avg), so we
scan the git history of alerts.json since the last processed commit, not just
the latest file -> never miss one between polls.

Usage:
  python3 alert.py            # pull, email NEW GREEN/YELLOW since last run
  python3 alert.py --print    # pull, just print recent actionable candidates, no email
"""
import json
import os
import smtplib
import ssl
import subprocess
import sys
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ALERTS = "state/alerts.json"
SEEN_FILE = ROOT / ".alert-seen.json"  # gitignored, local only
ACTIONABLE = ("GREEN", "YELLOW")
PRINT_WINDOW = 12  # commits to scan in --print mode (~last day at 2h cadence)


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args],
                          capture_output=True, text=True).stdout.strip()


def alerts_at(sha):
    out = git("show", f"{sha}:{ALERTS}")
    try:
        return json.loads(out) if out else {}
    except json.JSONDecodeError:
        return {}


def commits_touching_alerts():  # newest first
    out = git("log", "--format=%H", "--", ALERTS)
    return out.splitlines() if out else []


def actionable_from(data):
    return [c for c in (data.get("candidates") or []) if c.get("verdict") in ACTIONABLE]


def load_seen():
    try:
        return json.loads(SEEN_FILE.read_text())
    except Exception:
        return {"lastCommit": None, "emailed": {}}


def save_seen(s):
    SEEN_FILE.write_text(json.dumps(s, indent=2))


def fmt(c):
    return f"[{c['verdict']}] {c['name']} — CCU {c['ccu']}, {c.get('gate', '')}, {c.get('detail', '')}"


def send_email(subject, body):
    user = (os.environ.get("GM_SMTP_USER") or "").strip()
    pw = (os.environ.get("GM_SMTP_PASS") or "").replace(" ", "")  # app pw shows with spaces
    if not user or not pw:
        print("alert: no GM_SMTP_USER/PASS, skip sending")
        return False
    to = os.environ.get("GM_MAIL_TO", user)
    host = os.environ.get("GM_SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("GM_SMTP_PORT", "465"))
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to
    msg.set_content(body)
    try:
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context()) as s:
            s.login(user, pw)
            s.send_message(msg)
    except Exception as exc:
        print(f"alert: send failed {exc}")
        return False
    print(f"alert: emailed {to}")
    return True


def main():
    printonly = "--print" in sys.argv[1:]
    git("pull", "--quiet")
    commits = commits_touching_alerts()
    if not commits:
        print("alert: no alerts.json history yet")
        return 0

    if printonly:
        latest = {}  # name -> candidate, newest commit wins
        for sha in commits[:PRINT_WINDOW]:
            for c in actionable_from(alerts_at(sha)):
                latest.setdefault(c["name"], c)
        items = sorted(latest.values(), key=lambda c: ACTIONABLE.index(c["verdict"]))
        print(f"Recent actionable (last {min(PRINT_WINDOW, len(commits))} runs): {len(items)}")
        for c in items:
            print("  " + fmt(c))
        return 0

    seen = load_seen()
    last = seen.get("lastCommit")
    emailed = seen.get("emailed", {})

    if last is None:  # first run: latest commit only, don't flood with history
        scan = commits[:1]
    else:
        scan = []
        for sha in commits:
            if sha == last:
                break
            scan.append(sha)

    found = {}  # name -> candidate, newest wins
    for sha in scan:
        for c in actionable_from(alerts_at(sha)):
            found.setdefault(c["name"], c)

    new = [c for name, c in found.items() if emailed.get(name) != c["verdict"]]

    sent = True
    if new:
        new.sort(key=lambda c: ACTIONABLE.index(c["verdict"]))
        g = sum(1 for c in new if c["verdict"] == "GREEN")
        y = sum(1 for c in new if c["verdict"] == "YELLOW")
        subject = f"Roblox EMD: {len(new)} new (GREEN {g} / YELLOW {y})"
        body = ("New open/closing domain windows from the Roblox monitor:\n\n"
                + "\n".join(fmt(c) for c in new)
                + "\n\nGREEN = a domain is free, grab it. YELLOW = recently taken, window closing.\n"
                + "Repo: https://github.com/forpix/roblox-window-monitor\n")
        sent = send_email(subject, body)
        if sent:  # only mark emailed on success — a failed send must retry, not vanish
            for c in new:
                emailed[c["name"]] = c["verdict"]
    else:
        print("alert: no new actionable candidates")

    if sent:  # advance the scan pointer only when nothing is left pending resend
        seen["lastCommit"] = commits[0]
    seen["emailed"] = emailed
    save_seen(seen)
    return 0


if __name__ == "__main__":
    sys.exit(main())
