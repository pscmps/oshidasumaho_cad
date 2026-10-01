"""Browser regression for mobile editing. Requires Playwright, Pillow and Chromium.

Run a Vite server, then use --url for its address (or the built preview).
"""
import argparse
import base64
import io
import json
from pathlib import Path
from urllib.parse import urlencode
from PIL import Image
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


def frames(page, count=3):
    page.evaluate('(n)=>new Promise(resolve=>{function next(){if(--n<=0)resolve();else requestAnimationFrame(next)}requestAnimationFrame(next)})', count)


def ready(page):
    page.wait_for_function("document.querySelector('.native-viewer-note')?.textContent.match(/^(タップ|3面図も)/)", timeout=30000)
    frames(page)


def layout(page):
    result = page.evaluate("""() => {
      const shell = document.querySelector('.native-shell').getBoundingClientRect();
      const canvas = document.querySelector('canvas').getBoundingClientRect();
      const prompt = document.querySelector('#cad-prompt').getBoundingClientRect();
      const send = document.querySelector('.command-form button[type=submit]').getBoundingClientRect();
      const controls = document.querySelector('.control-panel');
      return {width:innerWidth, height:visualViewport.height, scroll:document.documentElement.scrollWidth,
        shell:shell.toJSON(), canvas:canvas.toJSON(), prompt:prompt.toJSON(), send:send.toJSON(),
        controlWidth:controls.clientWidth, controlScroll:controls.scrollWidth};
    }""")
    assert result['scroll'] <= result['width'] + 1, result
    assert result['controlScroll'] <= result['controlWidth'] + 1, result
    for name in ['shell', 'canvas', 'prompt', 'send']:
        box = result[name]
        assert box['left'] >= -1 and box['right'] <= result['width'] + 1, (name, result)
        assert box['top'] >= -1 and box['bottom'] <= result['height'] + 1, (name, result)
    assert result['canvas']['height'] > 50, result


def model_box(page, quadrant=None):
    # Read during the render frame, before WebGL discards its drawing buffer.
    # Unlike an element screenshot this excludes the DOM labels/buttons above it.
    data = page.evaluate("()=>new Promise(resolve=>requestAnimationFrame(()=>resolve(document.querySelector('canvas').toDataURL())))")
    image = Image.open(io.BytesIO(base64.b64decode(data.split(',')[1]))).convert('RGB')
    width, height = image.size
    if quadrant is None:
        region = (0, 0, width, height)
    else:
        x, y = quadrant
        region = (int(x * width / 2), int(y * height / 2), int((x + 1) * width / 2), int((y + 1) * height / 2))
    pixels = image.load()
    points = [(x, y) for y in range(region[1], region[3]) for x in range(region[0], region[2])
              if sum(abs(pixels[x, y][i] - (241, 245, 250)[i]) for i in range(3)) > 70]
    assert points, 'Expected visible model geometry'
    xs, ys = zip(*points)
    return (min(xs), min(ys), max(xs), max(ys))


def center(box):
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox', '--enable-unsafe-swiftshader'])
    context = browser.new_context(viewport={'width': 390, 'height': 700}, is_mobile=True, has_touch=True, accept_downloads=True)
    context.add_init_script("window.cadTools={};document.modelContext={registerTool(t,o){cadTools[t.name]=t;o.signal.addEventListener('abort',()=>delete cadTools[t.name]);}}")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '?' + urlencode({'json': json.dumps(fixture), 'ai': '1'}))
    ready(page)
    layout(page)
    assert not page.locator('.feature-tree').evaluate('(e)=>e.open')
    assert not page.get_by_role('button', name='extrude', exact=False).count()
    original = model_box(page)
    canvas = page.locator('canvas').bounding_box()
    assert abs(center(original)[0] - canvas['width'] / 2) < 15, (original, canvas)
    x, y = canvas['x'] + canvas['width'] / 2, canvas['y'] + canvas['height'] / 2
    page.touchscreen.tap(x, y - 10)
    page.get_by_role('button', name='赤の対象（1件）', exact=True).wait_for()
    assert page.evaluate("cadTools.read_cad_document.execute({}).cad.selectionGroups.red[0].entityType") == 'face'

    # Two parallel fingers must translate, preserving orientation and selection.
    client = context.new_cdp_session(page)
    def touches(dx):
        return [{'x': x - 45 + dx, 'y': y - 30, 'id': 1}, {'x': x + 25 + dx, 'y': y - 30, 'id': 2}]
    before = model_box(page)
    client.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': touches(0)})
    for dx in [10, 20, 30, 40]:
        client.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': touches(dx)})
        frames(page)
    client.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    frames(page, 35)
    moved = model_box(page)
    assert center(moved)[0] - center(before)[0] > 25, (before, moved)
    assert abs((moved[2]-moved[0]) - (before[2]-before[0])) < 3, (before, moved)
    assert page.evaluate("cadTools.read_cad_document.execute({}).cad.selectionGroups.red.length") == 1
    page.get_by_role('button', name='部品を中央に戻す').click()
    frames(page, 35)
    reset = model_box(page)
    assert abs(center(reset)[0] - center(before)[0]) < 2, (before, reset)
    # Recenter while pan still has damping left; it must not drift back.
    client.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': touches(0)})
    client.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': touches(40)})
    client.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
    page.get_by_role('button', name='部品を中央に戻す').click()
    frames(page, 35)
    assert abs(center(model_box(page))[0] - center(before)[0]) < 2

    # Final solid in all projections, also with touch selection in each view.
    page.get_by_role('button', name='3面図', exact=True).click()
    frames(page)
    top_before = model_box(page, (0, 1))
    front_before = model_box(page, (0, 0))
    for i, (px, py) in enumerate([(0.25, 0.25), (0.25, 0.75), (0.75, 0.75)]):
        group = ['green', 'blue', 'red'][i]
        label = {'red':'赤', 'green':'緑', 'blue':'青'}[group]
        if group == 'red':
            page.get_by_role('button', name='赤の対象（1件）', exact=True).click()
            page.get_by_role('button', name='解除', exact=True).click()
        else:
            page.get_by_role('button', name=f'{label}の対象（0件）', exact=True).click()
        page.touchscreen.tap(canvas['x']+canvas['width']*px, canvas['y']+canvas['height']*py)
        page.get_by_role('button', name=f'{label}の対象（1件）', exact=True).wait_for()
    # Blue is the top face, so its local shave must visibly change front height.
    page.locator('#cad-prompt').fill('青いところを3ミリ削ってください')
    page.get_by_role('button', name='変更する', exact=True).click()
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.at(-1).type==='faceExtrude'")
    ready(page)
    front_after = model_box(page, (0, 0))
    assert front_after[3]-front_after[1] < (front_before[3]-front_before[1])*0.8, (front_before, front_after)
    assert abs((top_before[2]-top_before[0])-(model_box(page,(0,1))[2]-model_box(page,(0,1))[0])) <= 2
    page.get_by_role('button', name='元に戻す', exact=True).click()
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.length===1")
    ready(page)
    # Edge / whole part references are real CAD entities, not image markers.
    page.get_by_role('button', name='緑の対象（1件）', exact=True).click()
    page.get_by_role('button', name='解除', exact=True).click()
    page.get_by_role('button', name='ふち', exact=True).click()
    edge_bounds = model_box(page, (0, 1))
    page.touchscreen.tap(canvas['x']+edge_bounds[0],canvas['y']+(edge_bounds[1]+edge_bounds[3])/2)
    page.get_by_role('button', name='緑の対象（1件）', exact=True).wait_for()
    assert page.evaluate("cadTools.read_cad_document.execute({}).cad.selectionGroups.green[0].entityType") == 'edge'
    page.get_by_role('button', name='解除', exact=True).click()
    page.get_by_role('button', name='部品', exact=True).click()
    page.touchscreen.tap(canvas['x']+canvas['width']/4,canvas['y']+canvas['height']*3/4)
    page.get_by_role('button', name='緑の対象（1件）', exact=True).wait_for()
    assert page.evaluate("cadTools.read_cad_document.execute({}).cad.selectionGroups.green[0].entityType") == 'body'
    page.get_by_role('button', name='厚さを変える', exact=True).click()
    assert page.locator('#cad-prompt').input_value() == '緑の厚さを3ミリにして'
    page.get_by_role('button', name='変更する', exact=True).click()
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features[0].distance===3")
    ready(page)
    page.get_by_role('button', name='元に戻す', exact=True).click()
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features[0].distance===10")
    ready(page)

    # Expand every old source of intrinsic overflow, then shrink/restore viewport.
    page.locator('.feature-tree summary').click()
    page.get_by_role('button', name='四角い板 1 · 厚さ10mm', exact=True).click()
    page.locator('.ai-settings > summary').click()
    page.locator('.ai-settings details summary').click()
    for width, height in [(320, 568), (375, 667), (430, 932), (700, 390), (390, 400), (390, 700)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.locator('.control-panel').evaluate('(e)=>e.scrollTop=0')
        frames(page)
        layout(page)
        page.locator('#cad-prompt').focus()
        frames(page)
        layout(page)
        page.locator('#cad-prompt').blur()
    page.get_by_role('button', name='部品を中央に戻す').click()
    page.screenshot(path='/tmp/oshida-mobile-ui-fixed.png')

    # Async mock is explicit; live marks and gestures remain available.
    page.locator('.ai-settings select').select_option('mock')
    page.get_by_role('button', name='面', exact=True).click()
    page.get_by_role('button', name='青の対象（1件）', exact=True).click()
    page.locator('#cad-prompt').fill('少し丸く')
    page.get_by_role('button', name='変更する', exact=True).click()
    page.get_by_role('button', name='緑の対象（1件）', exact=True).click()
    page.get_by_role('button', name='解除', exact=True).click()
    page.get_by_role('button', name='立体', exact=True).click()
    ready(page)
    canvas = page.locator('canvas').bounding_box()
    page.touchscreen.tap(canvas['x']+canvas['width']/2-20,canvas['y']+canvas['height']/2+12)
    page.get_by_role('button', name='緑の対象（1件）', exact=True).wait_for()
    page.get_by_role('button', name='適用', exact=True).wait_for()
    page.get_by_role('button', name='適用', exact=True).click()
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.at(-1).radius===2")
    ready(page)
    page.get_by_role('button', name='角を丸める · 半径2mm', exact=True).click()
    page.get_by_label('丸みの半径 (mm)').fill('3')
    page.get_by_label('丸みの半径 (mm)').press('Enter')
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.at(-1).radius===3")
    doc = page.evaluate('cadTools.read_cad_document.execute({})')
    assert len(doc['cad']['selectionGroups']['green']) == 1
    assert page.evaluate("async()=>{try{await cadTools.stage_cad_commands.execute({commands:[{operation:'eval'}]});return false}catch{return true}}")
    assert page.evaluate("async()=>{const r=await cadTools.stage_cad_commands.execute({commands:[{operation:'modifyFeature',featureId:'fillet-1',changes:{radius:2}}]});return r.status==='staged'}")
    assert page.evaluate('cadTools.read_cad_document.execute({}).cad.features.at(-1).radius') == 3
    page.get_by_role('button', name='キャンセル', exact=True).click()
    page.locator('#cad-prompt').fill('R4')
    page.get_by_role('button', name='変更する', exact=True).click()
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.at(-1).radius===4")
    doc = page.evaluate('cadTools.read_cad_document.execute({})')
    page.goto(base + '?ai=1')
    ready(page)
    assert page.evaluate('cadTools.read_cad_document.execute({}).cad.features.at(-1).radius') == 4
    page.close()

    for format in ['step', 'stl']:
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        with page.expect_download(timeout=30000) as download:
            page.goto(base + '?' + urlencode({'json': json.dumps(doc), 'format': format, 'download': '1', 'mode': 'automation'}))
        content = Path(download.value.path()).read_text()
        assert ('ISO-10303-21' if format == 'step' else 'facet normal') in content
        page.close()
    bracket = json.loads((Path(__file__).resolve().parents[1] / 'examples' / 'three-face-bracket.json').read_text())
    for format in ['stl', 'step']:
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        with page.expect_download(timeout=30000) as download:
            page.goto(base + '?' + urlencode({'json': json.dumps(bracket), 'format': format, 'download': '1', 'mode': 'automation'}))
        assert Path(download.value.path()).stat().st_size > 100
        page.close()
    # Previously added coincident bodies must still show the chosen face mark.
    duplicate = json.loads(json.dumps(fixture))
    duplicate['cad']['features'].append({**duplicate['cad']['features'][0], 'id': 'extrude-2'})
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base + '?' + urlencode({'json': json.dumps(duplicate), 'ai': '1'}))
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.length===2")
    ready(page)
    canvas = page.locator('canvas').bounding_box()
    page.touchscreen.tap(canvas['x']+canvas['width']/2,canvas['y']+canvas['height']/2-10)
    page.get_by_role('button', name='赤の対象（1件）', exact=True).wait_for()
    frames(page)
    data = page.evaluate("()=>new Promise(r=>requestAnimationFrame(()=>r(document.querySelector('canvas').toDataURL())))")
    image = Image.open(io.BytesIO(base64.b64decode(data.split(',')[1]))).convert('RGB')
    assert sum(r > 150 and r-g > 40 for r,g,b in image.getdata()) > 500, 'Selected face must be visible over coincident geometry'
    page.get_by_role('button', name='保存・読込・その他').click()
    page.get_by_role('button', name='保存・書き出し', exact=True).click()
    page.get_by_role('heading', name='保存', exact=True).first.wait_for()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    page.get_by_role('button', name='← 変更指示へ戻る', exact=True).click()
    page.locator('#cad-prompt').wait_for()
    layout(page)
    page.get_by_role('button', name='保存・読込・その他').click()
    page.get_by_role('button', name='部品を開く', exact=True).click()
    page.get_by_role('heading', name='呼び出し', exact=True).wait_for()
    page.get_by_role('button', name='← 変更指示へ戻る', exact=True).click()
    layout(page)
    page.get_by_role('button', name='保存・読込・その他').click()
    page.get_by_role('button', name='元の3面編集', exact=True).click()
    page.locator('.tri-view').wait_for()
    page.get_by_role('button', name='AIで編集・3Dで選択', exact=True).click()
    ready(page)
    assert page.evaluate('cadTools.read_cad_document.execute({}).cad.features.length') == 2
    page.close()
    assert not errors, errors
    print('PASS: mobile overflow/resize/focus, two-finger pan/recenter, Face/Edge/Body touch, final 3 projections, natural examples, async proposals, parameters, WebMCP shim, localStorage, native + legacy URL STL/STEP')
    browser.close()
