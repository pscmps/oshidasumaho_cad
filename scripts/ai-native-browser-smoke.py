"""Optional browser regression check. Requires Playwright + Chromium.

Run a Vite server first, then:
  python scripts/ai-native-browser-smoke.py --chromium /usr/bin/chromium
"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://localhost:5173/oshidasumaho_cad/')
parser.add_argument('--chromium', default='/usr/bin/chromium')
args = parser.parse_args()
base = args.url
fixture = {'schemaVersion': 5, 'partName': 'native-smoke', 'shapes': [], 'cad': {
    'schemaVersion': 1, 'suppressedProjection': False,
    'features': [{'id': 'extrude-1', 'type': 'extrude', 'profile': {'type': 'rectangle', 'width': 40, 'height': 30}, 'distance': 10, 'origin': [0, 0, 0]}],
    'selectionGroups': {'red': [], 'green': [], 'blue': []}}}

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader'])
    context = browser.new_context(viewport={'width': 390, 'height': 844}, accept_downloads=True)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.add_init_script("window.cadTools={};document.modelContext={registerTool(t,o){cadTools[t.name]=t;o.signal.addEventListener('abort',()=>delete cadTools[t.name]);}}")
    page.goto(base + '?' + urlencode({'json': json.dumps(fixture), 'ai': '1'}))
    page.get_by_role('button', name='extrude-1 · extrude · 10mm', exact=True).wait_for()
    page.wait_for_function("document.querySelector('.native-viewer-note')?.textContent.startsWith('タップ')", timeout=30000)
    page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    box = page.locator('canvas').bounding_box()
    x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    page.mouse.click(x, y - 14)
    page.get_by_role('button', name='赤 / A (1)').wait_for()
    page.locator('select').select_option('mock')
    page.locator('#cad-prompt').fill('少し丸く')
    page.get_by_role('button', name='実行', exact=True).click()
    page.get_by_role('button', name='緑 / B (0)').click()
    page.mouse.click(x - 14, y + 8)
    page.get_by_role('button', name='緑 / B (1)').wait_for()
    page.get_by_role('button', name='適用', exact=True).wait_for()
    page.get_by_role('button', name='適用', exact=True).click()
    page.get_by_role('button', name='fillet-1 · fillet · R2', exact=True).wait_for(timeout=30000)
    page.get_by_role('button', name='fillet-1 · fillet · R2', exact=True).click()
    page.get_by_label('R (mm)').fill('3')
    page.get_by_label('R (mm)').press('Enter')
    page.get_by_role('button', name='fillet-1 · fillet · R3', exact=True).wait_for()
    doc = page.evaluate('cadTools.read_cad_document.execute({})')
    assert doc['cad']['features'][-1]['radius'] == 3
    assert len(doc['cad']['selectionGroups']['green']) == 1
    assert page.evaluate("async()=>{try{await cadTools.stage_cad_commands.execute({commands:[{operation:'eval'}]});return false}catch{return true}}")
    assert page.evaluate("async()=>{const r=await cadTools.stage_cad_commands.execute({commands:[{operation:'modifyFeature',featureId:'fillet-1',changes:{radius:2}}]});return r.status==='staged'}")
    assert page.evaluate('cadTools.read_cad_document.execute({}).cad.features.at(-1).radius') == 3
    page.get_by_role('button', name='キャンセル', exact=True).click()
    # Text parameter edits use the same local command path and no LLM.
    page.locator('#cad-prompt').fill('R4')
    page.get_by_role('button', name='実行', exact=True).click()
    page.get_by_role('button', name='fillet-1 · fillet · R4', exact=True).wait_for()
    doc = page.evaluate('cadTools.read_cad_document.execute({})')
    # Reload without URL import tests localStorage rather than reimporting fixture.
    page.goto(base + '?ai=1')
    page.get_by_role('button', name='fillet-1 · fillet · R4', exact=True).wait_for()
    page.close()
    # URL automation must export the final feature geometry, even without legacy shapes.
    for format in ['step', 'stl']:
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        with page.expect_download(timeout=30000) as download:
            page.goto(base + '?' + urlencode({'json': json.dumps(doc), 'format': format, 'download': '1', 'mode': 'automation'}))
        path = download.value.path()
        content = Path(path).read_text()
        assert ('ISO-10303-21' if format == 'step' else 'facet normal') in content, (format, download.value.suggested_filename, content[:160])
        page.close()
    # Legacy projections and their existing STL/STEP path remain available.
    bracket = json.loads((Path(__file__).resolve().parents[1] / 'examples' / 'three-face-bracket.json').read_text())
    for format in ['stl', 'step']:
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        with page.expect_download(timeout=30000) as download:
            page.goto(base + '?' + urlencode({'json': json.dumps(bracket), 'format': format, 'download': '1', 'mode': 'automation'}))
        assert Path(download.value.path()).stat().st_size > 100
        page.close()
    assert not errors, errors
    print('PASS: mobile selection, async mock/ghost, live groups, parameter edit, WebMCP registry shim, localStorage, native + legacy URL STL/STEP')
    browser.close()
