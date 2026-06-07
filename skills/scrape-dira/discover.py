#!/usr/bin/env python3
"""
M2 throwaway discovery script.
READ ONLY — the only form submitted is the login form.
Never clicks enrollment controls. Never leaves ProjectsList / ProjectInfo.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

secrets_path = Path(__file__).parent.parent.parent / "secrets.local.env"
creds = {}
with open(secrets_path) as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip()

DIRA_USER = creds["DIRA_USER"]
DIRA_PASS = creds["DIRA_PASS"]

shots = Path(__file__).parent.parent.parent / "data" / "screenshots"
shots.mkdir(parents=True, exist_ok=True)

BASE = "https://www.dira.moch.gov.il"
SAMPLE = f"{BASE}/79632/2711/ProjectInfo"

def snap(page, name):
    path = shots / name
    page.screenshot(path=str(path), full_page=True)
    print(f"  screenshot → {path}")

def inputs_info(page):
    for el in page.query_selector_all("input:visible"):
        print(f"    input type={el.get_attribute('type')!r:12} "
              f"name={el.get_attribute('name')!r:30} "
              f"id={el.get_attribute('id')!r:30} "
              f"placeholder={el.get_attribute('placeholder')!r}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(locale="he-IL", timezone_id="Asia/Jerusalem")
    page = ctx.new_page()

    # ── Step 1: home page ──────────────────────────────────────────────────
    print("\n[1] Home page")
    page.goto(BASE, wait_until="networkidle", timeout=30000)
    print(f"    url:   {page.url}")
    print(f"    title: {page.title()}")
    snap(page, "01_home.png")

    # ── Step 2: find login link / navigate to login ────────────────────────
    print("\n[2] Looking for login")
    login_link = page.query_selector("a[href*='login'], a[href*='Login'], button:has-text('כניסה'), a:has-text('כניסה'), a:has-text('התחברות')")
    if login_link:
        print(f"    found login element: {login_link.get_attribute('href') or login_link.inner_text()!r}")
        login_link.click()
        page.wait_for_load_state("networkidle", timeout=20000)
    else:
        print("    no login link found — trying /ApplicationLogin directly")
        page.goto(f"{BASE}/ApplicationLogin", wait_until="networkidle", timeout=20000)
    print(f"    url:   {page.url}")
    snap(page, "02_login.png")
    print("    inputs on page:")
    inputs_info(page)

    # ── Step 3: fill login form ────────────────────────────────────────────
    print("\n[3] Logging in")
    # try common selector patterns for username
    user_sel = 'input[name*="user" i], input[id*="user" i], input[name*="tz" i], input[id*="tz" i], input[placeholder*="תעודת זהות" i], input[type="text"]:first-of-type'
    pass_sel = 'input[type="password"]'
    submit_sel = 'button[type="submit"], input[type="submit"], button:has-text("כניסה"), button:has-text("התחבר")'

    user_field = page.query_selector(user_sel)
    pass_field = page.query_selector(pass_sel)
    submit_btn = page.query_selector(submit_sel)

    print(f"    user field found:   {user_field is not None}")
    print(f"    pass field found:   {pass_field is not None}")
    print(f"    submit btn found:   {submit_btn is not None}")

    if user_field:
        user_field.fill(DIRA_USER)
    if pass_field:
        pass_field.fill(DIRA_PASS)
    snap(page, "03_login_filled.png")

    if submit_btn:
        submit_btn.click()
        page.wait_for_load_state("networkidle", timeout=20000)
    elif user_field and pass_field:
        pass_field.press("Enter")
        page.wait_for_load_state("networkidle", timeout=20000)

    print(f"    url after login: {page.url}")
    snap(page, "04_after_login.png")
    logged_in = "login" not in page.url.lower() and "ApplicationLogin" not in page.url
    print(f"    logged in: {logged_in}")

    # ── Step 4: ProjectsList ───────────────────────────────────────────────
    print("\n[4] ProjectsList")
    page.goto(f"{BASE}/ProjectsList", wait_until="networkidle", timeout=30000)
    print(f"    url: {page.url}")
    snap(page, "05_projects_list.png")

    # find lottery links (ProjectInfo links)
    links = page.eval_on_selector_all(
        "a[href*='ProjectInfo']",
        "els => els.map(e => e.href)"
    )
    print(f"    ProjectInfo links found: {len(links)}")
    for lnk in links[:5]:
        print(f"      {lnk}")

    # also try rows/cards that might contain project+lottery ids
    rows = page.eval_on_selector_all(
        "[data-project-id], [data-lottery-id], tr[data-id], .project-row, .lottery-row",
        "els => els.map(e => e.outerHTML.slice(0, 200))"
    )
    print(f"    data-attribute rows: {len(rows)}")
    for r in rows[:3]:
        print(f"      {r}")

    # ── Step 5: sample ProjectInfo ─────────────────────────────────────────
    print(f"\n[5] Sample ProjectInfo — {SAMPLE}")
    page.goto(SAMPLE, wait_until="networkidle", timeout=30000)
    print(f"    url: {page.url}")
    snap(page, "06_project_info.png")

    LABELS = [
        "יישוב", "שכונה", "דירות בפרויקט", "דירות לזכאים",
        "סה\"כ נרשמים", "מילואים לוחמים", "מילואים פעילים", "מחיר למטר",
    ]
    print("\n    scanning for Hebrew labels:")
    findings = {}
    for label in LABELS:
        # find element containing this label, then its sibling/next value
        el = page.query_selector(f"text={label}")
        if el:
            parent = el.evaluate("e => e.parentElement ? e.parentElement.innerText : ''")
            print(f"      '{label}': found — parent text: {parent[:120]!r}")
            findings[label] = parent[:120]
        else:
            print(f"      '{label}': NOT FOUND")

    # dump full text for manual inspection
    body_text = page.inner_text("body")
    (shots / "06_project_info_text.txt").write_text(body_text, encoding="utf-8")
    print(f"\n    full page text saved → {shots}/06_project_info_text.txt")

    # dump all table rows for label mapping
    rows_data = page.eval_on_selector_all(
        "tr, .field-row, .info-row, dl dt, dl dd",
        "els => els.map(e => e.innerText.trim()).filter(t => t.length > 0 && t.length < 300)"
    )
    print(f"\n    table/field rows ({len(rows_data)} total), first 40:")
    for r in rows_data[:40]:
        print(f"      {r!r}")

    browser.close()
    print("\n[done]")
