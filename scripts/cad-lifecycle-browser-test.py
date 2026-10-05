"""Synthetic, loopback-only regression through the built Site Worker and real UI.

Run scripts/preview-site.mjs first. Nothing is sent to a production Site or LLM.
Each browser context has isolated local storage; the preview Worker uses memory.
"""
import argparse
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:4199/')
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--scenario', default='all')
    args = parser.parse_args()
    parsed = urlparse(args.base_url)
    if parsed.scheme != 'http' or parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
        parser.error('Only an HTTP loopback QA server is allowed')
    base = args.base_url.rstrip('/') + '/'
    output = args.output_dir or Path(tempfile.mkdtemp(prefix='cad-lifecycle-'))
    output.mkdir(parents=True, exist_ok=True)
    key = 'oshidasumaho-cad-document-v1'
    notes = '幅30mm、奥行き20mm、高さ7mmの四角い部品。文章の寸法を使ってください。'
    command = {'operation': 'addSketchSolid', 'origin': [0, 0, 0],
               'dimensions': {'width': 30, 'depth': 20, 'height': 7},
               'profiles': {'top': {'outer': {'type': 'polygon', 'points': [[0, 0], [1, 0], [1, 1], [0, 1]]}, 'holes': []}}}
    errors, results = [], []

    with sync_playwright() as p:
        edge = Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
        executable = os.environ.get('CAD_BROWSER') or (str(edge) if edge.exists() else None)
        browser = p.chromium.launch(executable_path=executable, headless=True, args=['--enable-unsafe-swiftshader'])

        def setup():
            context = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
            context.add_init_script("window.cadTools={};document.modelContext={registerTool(t,o){cadTools[t.name]=t;o.signal.addEventListener('abort',()=>delete cadTools[t.name]);}}")
            context.on('page', lambda page: page.on('pageerror', lambda e: errors.append(str(e))))
            # A browser redirect or accidental external request cannot reach production.
            context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).netloc == parsed.netloc else route.abort())
            page = context.new_page()
            page.goto(base + '?ai=1')
            page.get_by_label('部品の説明', exact=True).fill(notes)
            # Deliberately conflict with the explicit prose: these are fallback fields.
            for label, value in [('幅', '80'), ('奥行き', '50'), ('高さ', '20')]:
                page.get_by_label(label + ' (mm)', exact=True).fill(value)
                page.get_by_label(label + ' (mm)', exact=True).press('Tab')
            return context, page

        def read(page):
            return page.evaluate('cadTools.read_cad_document.execute({})')

        def stored(page):
            return page.evaluate('(key)=>JSON.parse(localStorage.getItem(key))', key)

        def call(context, name, arguments):
            response = context.request.post(base + 'mcp', data={
                'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                'params': {'name': name, 'arguments': arguments}})
            assert response.status == 200, response.text()
            return response.json()['result']

        def data(result):
            assert not result.get('isError'), result
            return json.loads(result['content'][0]['text'])

        def submit(page):
            page.get_by_role('button', name='Codexでモデル化', exact=True).click()
            page.wait_for_function('new URL(location.href).searchParams.has("cadRequest")')
            return parse_qs(urlparse(page.url).query)['cadRequest'][0]

        def propose(context, request_id, **extra):
            return call(context, 'propose_cad_commands', {'requestId': request_id,
                        'commands': [command], 'explanation': '文章を優先した30×20×7mmの未適用提案です。', **extra})

        def ready(page):
            expect(page.get_by_text('提案の形状を準備できました', exact=True)).to_be_visible(timeout=30000)
            expect(page.get_by_text('提案をプレビュー中 · 適用すると選択できます', exact=True)).to_be_visible(timeout=30000)
            assert page.locator('.native-viewer canvas').count() == 1
            assert read(page)['cad']['features'] == []
            expect(page.get_by_role('button', name='適用', exact=True)).to_be_enabled()

        def stage():
            context, page = setup()
            request_id = submit(page)
            assert data(propose(context, request_id))['applied'] is False
            ready(page)
            return context, page, request_id

        def unchanged(page):
            assert read(page)['cad']['features'] == []
            assert stored(page)['cad']['features'] == []
            assert not stored(page)['cad'].get('appliedRequestIds')

        def capture(page, name):
            page.screenshot(path=str(output / (name + '.png')))

        def run(name, scenario):
            if args.scenario not in ('all', name):
                return
            scenario()
            results.append(name)
            print('PASS ' + name, flush=True)

        def complete_lifecycle():
            context, page = setup()
            request_id = submit(page)
            saved = data(call(context, 'read_cad_request', {'requestId': request_id}))
            assert saved['request']['sketchDraft']['dimensions'] == {'width': 80, 'depth': 50, 'height': 20}
            assert saved['request']['sketchDraft']['notes'] == notes
            unchanged(page)
            question = data(call(context, 'propose_cad_commands', {'requestId': request_id, 'clarification': '穴は不要ですか？'}))
            assert question['responseRevision'] == 1
            expect(page.get_by_text('確認質問が届いています', exact=True)).to_be_visible(timeout=10000)
            rejected = propose(context, request_id, clarificationAnswer='穴は不要です。', expectedResponseRevision=2)
            assert rejected.get('isError')
            assert data(call(context, 'read_cad_request', {'requestId': request_id}))['responseRevision'] == 1
            accepted = data(propose(context, request_id, clarificationAnswer='穴は不要です。', expectedResponseRevision=1))
            assert accepted['responseRevision'] == 2 and accepted['applied'] is False
            ready(page)
            capture(page, 'proposal-visible-before-apply')
            page.reload()
            ready(page)
            before = data(call(context, 'read_cad_request', {'requestId': request_id}))
            assert data(propose(context, request_id))['responseRevision'] == 2
            assert data(call(context, 'read_cad_request', {'requestId': request_id})) == before
            page.evaluate("()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='適用');b.click();b.click();}")
            expect(page.get_by_text('変更を適用しました', exact=True)).to_be_visible(timeout=30000)
            applied = stored(page)
            assert len(applied['cad']['features']) == 1
            assert applied['cad']['features'][0]['dimensions'] == command['dimensions']
            assert applied['cad']['appliedRequestIds'] == [request_id]
            page.reload()
            expect(page.get_by_role('button', name='適用', exact=True)).to_be_disabled(timeout=30000)
            assert read(page)['cad']['features'] == applied['cad']['features']
            capture(page, 'applied-reload-receipt')
            context.close()

        def cancelled_after_preview():
            context, page, request_id = stage()
            # Another tab can still be waiting when this tab has already received a reply.
            assert context.request.post(base + 'api/cad/requests/' + request_id + '/cancel').status == 200
            page.get_by_role('button', name='適用', exact=True).click()
            expect(page.get_by_text('この依頼は取り消し済みです', exact=True).first).to_be_visible(timeout=10000)
            unchanged(page)
            capture(page, 'cancelled-preview-not-applied')
            context.close()

        def failed_apply_check():
            context, page, request_id = stage()
            pattern = '**/api/cad/requests/' + request_id + '*'
            page.route(pattern, lambda route: route.fulfill(status=503, json={'error': 'テスト用の通信障害'}))
            page.get_by_role('button', name='適用', exact=True).click()
            expect(page.get_by_text('テスト用の通信障害', exact=True).first).to_be_visible(timeout=10000)
            unchanged(page)
            page.unroute(pattern)
            page.get_by_role('button', name='同じ依頼を確認', exact=True).click()
            ready(page)
            page.get_by_role('button', name='適用', exact=True).click()
            expect(page.get_by_text('変更を適用しました', exact=True)).to_be_visible(timeout=30000)
            assert stored(page)['cad']['appliedRequestIds'] == [request_id]
            context.close()

        def stale_response():
            context, page, request_id = stage()
            saved = context.request.get(base + 'api/cad/requests/' + request_id).json()
            # Existing commands are immutable on the Worker. Inject a stale read to
            # exercise client revision verification without changing saved data.
            saved['responseRevision'] = 0
            page.route('**/api/cad/requests/' + request_id + '*', lambda route: route.fulfill(json=saved))
            page.get_by_role('button', name='適用', exact=True).click()
            expect(page.get_by_text('提案の応答が変わっています。同じ依頼を確認してから適用してください。', exact=True).first).to_be_visible(timeout=10000)
            unchanged(page)
            context.close()

        def two_tabs():
            context, page, request_id = stage()
            other = context.new_page()
            other.goto(page.url)
            ready(other)
            page.get_by_role('button', name='適用', exact=True).click()
            expect(page.get_by_text('変更を適用しました', exact=True)).to_be_visible(timeout=30000)
            expected = stored(page)
            other.get_by_role('button', name='適用', exact=True).click()
            expect(other.get_by_text('別のタブで保存内容が更新されています。保存済みの作業を開き直してから操作してください。', exact=True).first).to_be_visible(timeout=10000)
            assert stored(other) == expected
            assert read(other)['cad']['features'] == []
            other.reload()
            expect(other.get_by_role('button', name='適用', exact=True)).to_be_disabled(timeout=30000)
            assert read(other)['cad']['features'] == expected['cad']['features']
            context.close()

        def cancel_waiting_tabs():
            context, page = setup()
            request_id = submit(page)
            other = context.new_page()
            other.goto(page.url)
            button = other.locator('.request-progress').get_by_role('button', name='依頼を取り消す', exact=True)
            expect(button).to_be_visible(timeout=10000)
            button.click()
            for tab in (page, other):
                expect(tab.locator('.request-progress').get_by_text('依頼を取り消しました', exact=True)).to_be_visible(timeout=10000)
                unchanged(tab)
            assert propose(context, request_id).get('isError')
            assert data(call(context, 'read_cad_request', {'requestId': request_id}))['cancelled'] is True
            context.close()

        run('request-clarification-revision-preview-manual-apply-reload', complete_lifecycle)
        run('cancel-after-preview', cancelled_after_preview)
        run('communication-failure-at-apply-and-recovery', failed_apply_check)
        run('stale-response-at-apply', stale_response)
        run('two-tabs-preserve-newer-saved-model', two_tabs)
        run('two-waiting-tabs-explicit-cancel', cancel_waiting_tabs)
        browser.close()
    assert not errors, errors
    assert results, 'No matching scenario'
    summary = {'passed': True, 'localOnly': True, 'syntheticData': True, 'scenarios': results, 'pageErrors': errors}
    (output / 'results.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
