"""Small headless browser smoke test for the local OAuth integrations surface."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = os.environ.get("SECOND_BRAIN_URL", "http://127.0.0.1:8799")
OUT = Path(os.environ.get("SECOND_BRAIN_SMOKE_OUT", "local-oauth-ui.png"))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1200, "height": 900})
    page.add_init_script(f"localStorage.setItem('sb_url', {BASE!r}); localStorage.setItem('sb_token', 'dev-token');")
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT), full_page=True)
    buttons = page.locator("button").all_text_contents()
    if page.locator("#auth-overlay").is_visible():
        raise AssertionError("local auth session did not start")
    page.locator("button.sb-footer-btn").filter(has_text="Settings").click()
    page.locator("button.menu-item").filter(has_text="Integrations").click()
    page.locator("button.integration-category-row").filter(has_text="Knowledge").click()
    page.wait_for_timeout(250)
    body = page.locator("body").inner_text()
    required = ["GitHub", "Google Drive", "OAuth"]
    missing = [value for value in required if value not in body]
    if missing:
        raise AssertionError(f"OAuth integrations surface missing: {missing}")
    print(json.dumps({"url": page.url, "buttons": buttons, "required": required, "screenshot": str(OUT)}, ensure_ascii=False))
    browser.close()
