import argparse
import json
import os
import tempfile
from copy import deepcopy
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

parser=argparse.ArgumentParser(description='Loopback-only CAD proposal lifecycle smoke test; no production authentication or writes.')
parser.add_argument('--base-url', default='http://127.0.0.1:4199/')
parser.add_argument('--fixture', type=Path, help='Optional read_cad_request JSON export; kept local and never submitted.')
parser.add_argument('--output-dir', type=Path)
args=parser.parse_args()
if urlparse(args.base_url).hostname not in ['127.0.0.1','localhost','::1']:
    parser.error('Only a loopback QA server is allowed')
base=args.base_url.rstrip('/')+'/'
root=args.output_dir or Path(tempfile.mkdtemp(prefix='cad-exchange-smoke-'))
(root/'output/playwright').mkdir(parents=True,exist_ok=True)
draft={'schemaVersion':1,'views':{v:{'strokes':[],'comments':[]} for v in ['top','front','right']},'dimensions':{'width':80,'depth':50,'height':20},'notes':'外径30 内径20 高さ30 横穴φ3'}
document={'schemaVersion':5,'shapes':[],'cad':{'schemaVersion':2,'features':[],'selectionGroups':{'red':[],'green':[],'blue':[]},'suppressedProjection':False,'draft':draft}}
rectangle={'type':'polygon','points':[[0,0],[1,0],[1,1],[0,1]]}
command={'operation':'addSketchSolid','origin':[0,0,0],'dimensions':{'width':30,'depth':30,'height':30},'profiles':{
    'top':{'outer':{'type':'ellipse','center':[.5,.5],'radii':[.5,.5]},'holes':[{'type':'ellipse','center':[.5,.5],'radii':[1/3,1/3]}]},
    'front':{'outer':rectangle,'holes':[{'type':'ellipse','center':[.5,.5],'radii':[.05,.05]}]},'right':{'outer':rectangle,'holes':[]}}}
saved=json.loads(args.fixture.read_text(encoding='utf-8')) if args.fixture else {'requestId':'7f88431e-e627-4b67-9e9a-27eed6387457','createdAt':'2026-10-02T00:00:00.000Z','cancelled':False,'responseRevision':2,'request':{'task':'sketch','prompt':draft['notes'],'document':document,'sketchDraft':draft},'response':{'commands':[command],'explanation':'中心高さ15mm・両壁貫通と仮定した未適用プレビュー'}}
key='oshidasumaho-cad-document-v1'
results=[]
with sync_playwright() as p:
    edge=Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
    executable=os.environ.get('CAD_BROWSER') or (str(edge) if edge.exists() else None)
    browser=p.chromium.launch(executable_path=executable,headless=True,args=['--enable-unsafe-swiftshader'])
    def setup(record=saved):
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
        context.add_init_script("window.cadTools={};document.modelContext={registerTool(t,o){cadTools[t.name]=t;o.signal.addEventListener('abort',()=>delete cadTools[t.name]);}}")
        context.route('**/api/cad/connection',lambda route:route.fulfill(json={'connected':True,'subscriptions':1}))
        context.route('**/api/cad/requests',lambda route:route.fulfill(json={'requests':[{'requestId':record['requestId'],'createdAt':record['createdAt'],'state':'answered','prompt':record['request']['prompt']}]}))
        context.route('**/api/cad/requests/'+record['requestId']+'*',lambda route:route.fulfill(json={**record,'webhook':{'connected':True,'subscriptions':1}}))
        page=context.new_page()
        page.goto(base+'?ai=1')
        page.evaluate('(v)=>localStorage.setItem(v.key,JSON.stringify(v.doc))',{'key':key,'doc':record['request']['document']})
        page.goto(base+'?ai=1&cadRequest='+record['requestId'])
        expect(page.get_by_role('button',name='適用',exact=True)).to_be_enabled(timeout=30000)
        return context,page
    def read(page):return page.evaluate('cadTools.read_cad_document.execute({})')
    def applied(page):page.wait_for_function('cadTools.read_cad_document.execute({}).cad.features.length===1',timeout=30000)
    def ghost(page):page.get_by_text('提案をプレビュー中 · 適用すると選択できます',exact=True).wait_for(timeout=30000)
    def screenshot(page,name):
        page.locator('.control-panel').evaluate_all('(els)=>els.forEach(el=>el.scrollTop=0)')
        page.wait_for_timeout(250)
        page.screenshot(path=str(root/'output/playwright'/('night-'+name+'.png')))

    context,page=setup();ghost(page)
    page.evaluate("()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='適用');b.click();b.click();}")
    applied(page)
    expect(page.get_by_text('変更を適用しました',exact=True)).to_be_visible()
    original_applied=read(page)
    assert original_applied['cad']['appliedRequestIds']==[saved['requestId']]
    page.reload();expect(page.get_by_role('button',name='適用',exact=True)).to_be_disabled(timeout=30000)
    assert read(page)['cad']['features']==original_applied['cad']['features']
    page.get_by_text('提案をプレビュー中 · 青が現在、黄が提案です',exact=True).wait_for(timeout=30000)
    screenshot(page,'receipt-blocks-reapply')
    results.append({'scenario':'double-apply-and-reload','features':1,'receiptRetained':True,'reapplyBlocked':True})
    context.close()

    context,page=setup();ghost(page)
    page.evaluate("()=>{const bs=[...document.querySelectorAll('button')];bs.find(b=>b.textContent==='適用').click();bs.find(b=>b.textContent==='キャンセル').click();}")
    page.wait_for_timeout(1200)
    assert read(page)['cad']['features']==[]
    assert not read(page)['cad'].get('appliedRequestIds')
    results.append({'scenario':'apply-then-cancel-same-turn','features':0})
    context.close()

    context,page=setup();ghost(page)
    page.get_by_role('button',name='適用',exact=True).click();applied(page)
    page.get_by_role('button',name='元に戻す',exact=True).click()
    page.wait_for_function('cadTools.read_cad_document.execute({}).cad.features.length===0')
    assert not read(page)['cad'].get('appliedRequestIds')
    page.reload();expect(page.get_by_role('button',name='適用',exact=True)).to_be_enabled(timeout=30000)
    assert read(page)['cad']['features']==[]
    results.append({'scenario':'apply-undo-reload','undoPersisted':True,'reapplyAllowed':True})
    context.close()

    context,a=setup();ghost(a)
    b=context.new_page();b.goto(base+'?ai=1&cadRequest='+saved['requestId']);ghost(b)
    a.get_by_role('button',name='適用',exact=True).click();applied(a)
    b.get_by_role('button',name='適用',exact=True).click()
    b.get_by_text('別のタブで保存内容が更新されています。保存済みの作業を開き直してから操作してください。',exact=True).first.wait_for(timeout=30000)
    assert read(b)['cad']['features']==[]
    stored=b.evaluate('(key)=>JSON.parse(localStorage.getItem(key))',key)
    assert len(stored['cad']['features'])==1
    screenshot(b,'stale-tab-preserves-saved-model')
    b.reload();expect(b.get_by_role('button',name='適用',exact=True)).to_be_disabled(timeout=30000)
    assert len(read(b)['cad']['features'])==1
    results.append({'scenario':'two-tabs','newerSavedModelPreserved':True,'staleApplyBlocked':True})
    context.close()

    edit=deepcopy(saved);edit['requestId']='b7c7c4a8-9005-49e2-91e8-568cd4b68212'
    edit['request']={'task':'edit','prompt':'高さを35mmに変更','document':original_applied}
    edit['response']={'commands':[{'operation':'modifyFeature','featureId':original_applied['cad']['features'][0]['id'],'changes':{'dimensions':{'width':30,'depth':30,'height':35}}}],'explanation':'高さを35mmにする未適用の編集案です。'}
    context,page=setup(edit)
    expect(page.get_by_role('button',name='適用',exact=True)).to_be_visible()
    page.get_by_text('提案をプレビュー中 · 青が現在、黄が提案です',exact=True).wait_for(timeout=30000)
    assert read(page)['cad']['features'][0]['dimensions']['height']==30
    assert page.locator('.native-viewer canvas').count()==1
    screenshot(page,'saved-edit-opens-3d')
    results.append({'scenario':'saved-edit','modelViewVisible':True,'unappliedHeight':30,'proposedHeight':35})
    context.close()

    context=browser.new_context();page=context.new_page();page.goto(base+'?ai=1')
    page.evaluate('(key)=>localStorage.setItem(key,"broken JSON retained for test")',key)
    page.reload()
    page.get_by_text('既存の保存データを読み取れないため、自動保存を停止しました。保存データは上書きしていません。',exact=True).wait_for(timeout=10000)
    assert page.evaluate('(key)=>localStorage.getItem(key)',key)=='broken JSON retained for test'
    results.append({'scenario':'invalid-local-data','originalBytesPreserved':True})
    context.close();browser.close()
print(json.dumps({'passed':True,'localOnly':True,'fixtureRequest':saved['requestId'],'artifacts':str(root),'scenarios':results},ensure_ascii=False))
