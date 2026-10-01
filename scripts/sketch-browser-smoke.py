"""Mobile sketch + real local Worker/MCP exchange regression (no LLM simulation in product).

npm run build:site; node scripts/preview-site.mjs 4186
python scripts/sketch-browser-smoke.py --url http://127.0.0.1:4186/
Requires Playwright and Chromium. MCP replies below are explicit test fixtures.
"""
import argparse,json
from playwright.sync_api import sync_playwright
parser=argparse.ArgumentParser();parser.add_argument('--url',default='http://127.0.0.1:4186/');args=parser.parse_args()

with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--enable-unsafe-swiftshader'])
    context=browser.new_context(viewport={'width':390,'height':700},is_mobile=True,has_touch=True)
    context.add_init_script("window.cadTools={};document.modelContext={registerTool(t,o){cadTools[t.name]=t;o.signal.addEventListener('abort',()=>delete cadTools[t.name]);}}")
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(args.url);page.get_by_label('部品の説明').wait_for()
    read=lambda:page.evaluate('cadTools.read_cad_document.execute({})')
    assert read()['cad']['features']==[], 'Start with an empty sketch, not a default box'
    assert page.locator('.rough-pane').count()==3
    def check_layout():
        result=page.evaluate("""()=>{const shell=document.querySelector('.native-shell'),panel=document.querySelector('.control-panel');return {w:innerWidth,sw:document.documentElement.scrollWidth,cw:panel.clientWidth,cs:panel.scrollWidth,top:shell.getBoundingClientRect().top}}""")
        assert result['sw']<=result['w']+1 and result['cs']<=result['cw']+1 and abs(result['top'])<1,result
    check_layout()
    client=context.new_cdp_session(page)
    def svg(view):return page.get_by_label(f'{view}のスケッチ',exact=True)
    def draw(view,points):
        box=svg(view).bounding_box()
        def touch(point):return {'x':box['x']+box['width']*point[0],'y':box['y']+box['height']*(1-point[1]),'id':1}
        client.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[touch(points[0])]})
        for point in points[1:]:client.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[touch(point)]})
        client.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    page.get_by_role('button',name='四角',exact=True).click()
    for view in ['上から','正面','右から']:draw(view,[[.15,.15],[.85,.85]])
    page.wait_for_function("cadTools.read_cad_document.execute({}).cad.draft.views.right.strokes.length===1")
    page.get_by_role('button',name='円',exact=True).click();page.get_by_label('線の用途').select_option('cut');draw('上から',[[.4,.4],[.6,.6]])
    page.get_by_role('button',name='コメント',exact=True).click();box=svg('上から').bounding_box();page.touchscreen.tap(box['x']+box['width']*.5,box['y']+box['height']*.5)
    page.get_by_label('選んだ場所のコメント').fill('この穴は直径8mm')
    page.get_by_label('部品の説明').fill('幅40mm 奥行き30mm 厚さ10mmの板。中央に穴')
    page.get_by_label('部品の説明').blur()
    assert read()['cad']['draft']['dimensions']=={'width':40,'depth':30,'height':10}
    assert read()['cad']['draft']['views']['top']['comments'][0]['text']=='この穴は直径8mm'
    page.screenshot(path='/tmp/oshida-sketch-drawn.png')
    page.get_by_role('button',name='描いた形だけプレビュー',exact=True).click()
    page.get_by_role('button',name='適用',exact=True).wait_for(timeout=30000)
    assert read()['cad']['features']==[]
    page.screenshot(path='/tmp/oshida-sketch-ghost.png')
    page.get_by_role('button',name='適用',exact=True).click();page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.length===1")
    page.wait_for_function("document.querySelector('.native-viewer-note')?.textContent.startsWith('タップ')")
    assert read()['cad']['features'][0]['type']=='sketchSolid'
    page.get_by_role('button',name='部品',exact=True).click();canvas=page.locator('canvas').bounding_box();page.touchscreen.tap(canvas['x']+canvas['width']*.5-35,canvas['y']+canvas['height']*.5+12)
    page.get_by_role('button',name='赤の対象（1件）',exact=True).wait_for()
    page.locator('#cad-prompt').fill('厚さを3ミリにして');page.get_by_role('button',name='変更する',exact=True).click();page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features[0].dimensions.height===3")
    page.get_by_role('button',name='3面図',exact=True).click();assert page.locator('.native-projections').count()==1
    page.get_by_role('button',name='スケッチ',exact=True).click();page.get_by_role('button',name='Codexでモデル化',exact=True).click()
    page.wait_for_function("document.querySelector('.codex-connection')?.textContent.includes('依頼を送信済み')")
    def rpc(name,arguments={}):
        response=context.request.post(args.url+'mcp',data={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':arguments}});assert response.ok,response.text();value=response.json()['result'];assert not value.get('isError'),value;return json.loads(value['content'][0]['text'])
    pending=rpc('list_cad_requests')['requests'];assert len(pending)==1
    request_id=pending[0]['requestId'];queued=rpc('read_cad_request',{'requestId':request_id})
    assert queued['request']['sketchDraft']['views']['top']['comments'][0]['text']=='この穴は直径8mm'
    # While waiting, switch to the CAD view and select a different actual entity.
    page.get_by_role('button',name='立体',exact=True).click();page.get_by_role('button',name='緑の対象（0件）',exact=True).click();canvas=page.locator('canvas').bounding_box();page.touchscreen.tap(canvas['x']+canvas['width']*.5-35,canvas['y']+canvas['height']*.5+12)
    page.get_by_role('button',name='緑の対象（1件）',exact=True).wait_for()
    fixture={'operation':'addSketchSolid','origin':[55,0,0],'dimensions':{'width':40,'depth':30,'height':10},'profiles':{'top':{'outer':{'type':'polygon','points':[[0,0],[1,0],[1,1],[0,1]]},'holes':[{'type':'ellipse','center':[.5,.5],'radii':[.1,8/60]}]}}}
    rpc('propose_cad_commands',{'requestId':request_id,'commands':[fixture],'explanation':'テスト用のCodex提案：中央に直径8mmの穴'})
    page.get_by_role('button',name='適用',exact=True).wait_for(timeout=30000);assert len(read()['cad']['features'])==1
    page.get_by_role('button',name='適用',exact=True).click();page.wait_for_function("cadTools.read_cad_document.execute({}).cad.features.length===2")
    assert len(read()['cad']['selectionGroups']['green'])==1
    # A newer sketch must not silently receive a response made for old geometry.
    page.get_by_role('button',name='スケッチ',exact=True).click();page.get_by_role('button',name='Codexでモデル化',exact=True).click();page.wait_for_function("document.querySelector('.codex-connection')?.textContent.includes('依頼を送信済み')")
    request_id=rpc('list_cad_requests')['requests'][0]['requestId'];page.get_by_label('部品の説明').fill('幅60mmに変更')
    rpc('propose_cad_commands',{'requestId':request_id,'commands':[fixture]})
    page.wait_for_function("document.querySelector('.sketch-panel')?.textContent.includes('スケッチが変更されています')",timeout=30000);assert len(read()['cad']['features'])==2
    page.reload();page.get_by_label('部品の説明').wait_for();assert page.get_by_label('部品の説明').input_value()=='幅60mmに変更';assert len(read()['cad']['features'])==2
    for width,height in [(320,700),(360,740),(430,880),(700,390),(390,400)]:
        page.set_viewport_size({'width':width,'height':height});page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');check_layout();assert svg('上から').bounding_box()['height']>30, (width,height,svg('上から').bounding_box())
    assert not errors,errors
    browser.close()
    print('PASS: empty mobile sketch, touch drawing, anchored comments, mm dimensions, BRep ghost/apply, local numeric edit, shared projections, real local MCP/Codex exchange, nonblocking selection, stale draft protection, persistence and responsive widths')
