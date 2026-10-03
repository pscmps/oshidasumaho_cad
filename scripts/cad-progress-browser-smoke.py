import argparse,json,os,time
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
parser=argparse.ArgumentParser(description='Loopback-only mobile CAD progress regression using a local read-only request fixture.')
parser.add_argument('--base-url',default='http://127.0.0.1:4199/')
parser.add_argument('--fixture',type=Path,required=True)
parser.add_argument('--output-dir',type=Path,required=True)
a=parser.parse_args()
if urlparse(a.base_url).hostname not in ['localhost','127.0.0.1','::1']:parser.error('Loopback QA only')
base=a.base_url.rstrip('/')+'/'
saved=json.loads(a.fixture.read_text(encoding='utf-8'));a.output_dir.mkdir(parents=True,exist_ok=True)
results=[];errors=[]
with sync_playwright() as p:
 edge=os.environ.get('CAD_BROWSER') or r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
 browser=p.chromium.launch(executable_path=edge,headless=True,args=['--enable-unsafe-swiftshader'])
 def setup(long=False):
  state={'record':{**deepcopy(saved),'response':None,'responseRevision':0,'createdAt':(datetime.now(timezone.utc)-timedelta(minutes=5 if long else 0)).isoformat()},'webhook':{'connected':True,'pending':1},'http':200,'posts':[],'gets':0}
  c=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
  c.add_init_script('localStorage.setItem("oshidasumaho-cad-document-v1",'+json.dumps(json.dumps(saved['request']['document']))+');window.cadTools={};document.modelContext={registerTool(t,o){cadTools[t.name]=t;o.signal.addEventListener("abort",()=>delete cadTools[t.name]);}};')
  c.route('**/api/cad/connection',lambda r:r.fulfill(json={'connected':True,'subscriptions':1}))
  def list_or_submit(r):
   if r.request.method=='POST':
    body=r.request.post_data_json;state['posts'].append(body);state['record']={**state['record'],'requestId':body['requestId'],'request':body['request'],'response':None,'responseRevision':0}
    r.fulfill(status=201,json={'requestId':body['requestId'],'createdAt':state['record']['createdAt'],'webhook':state['webhook']})
   else:r.fulfill(json={'requests':[]})
  c.route('**/api/cad/requests',list_or_submit)
  def request_route(r):
   if r.request.method=='POST':
    assert r.request.url.endswith('/cancel');state['posts'].append('cancel');state['record']['cancelled']=True;r.fulfill(json={'cancelled':True})
   else:
    state['gets']+=1
    r.fulfill(status=state['http'],json={'error':'一時的な通信障害'} if state['http']!=200 else {**state['record'],'webhook':state['webhook']})
  c.route('**/api/cad/requests/**',request_route)
  page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(base+'?ai=1&cadRequest='+saved['requestId'])
  expect(page.locator('.request-progress').get_by_role('status').filter(has_text='受付済み・dotの応答待ち')).to_be_visible(timeout=10000)
  return c,page,state
 def capture(page,name):
  progress=page.get_by_role('region',name='依頼の進捗');expect(progress).to_be_visible()
  box=progress.bounding_box();assert box['x']>=0 and box['y']>=0 and box['x']+box['width']<=391 and box['y']+box['height']<=844
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(a.output_dir/(name+'.png')))
 def read(page):return page.evaluate('cadTools.read_cad_document.execute({})')
 c,page,s=setup(long=True)
 expect(page.get_by_text('応答に時間がかかっています。実行中かは確認できず、完了時刻は未定です。',exact=True)).to_be_visible()
 expect(page.locator('.request-progress progress')).to_have_count(1)
 assert page.locator('.request-progress progress').get_attribute('value') is None
 page.get_by_label('部品の説明',exact=True).fill('待機中に編集した未送信メモ')
 capture(page,'long-wait-input-preserved')
 s['webhook']={'connected':True,'delivered':1}
 expect(page.get_by_text('通知先が受信しました。dotの実行開始は未確認です。',exact=True)).to_be_visible(timeout=10000)
 assert page.get_by_label('部品の説明',exact=True).input_value()=='待機中に編集した未送信メモ'
 s['record']['response']={'clarification':'横穴は両壁を貫通しますか？'};s['record']['responseRevision']=1
 expect(page.get_by_text('確認質問が届いています',exact=True)).to_be_visible(timeout=10000)
 expect(page.locator('.request-progress progress')).to_have_count(0)
 capture(page,'clarification')
 s['record']['response']=saved['response'];s['record']['responseRevision']=2;s['record']['responseAt']=datetime.now(timezone.utc).isoformat()
 expect(page.get_by_text('提案の形状を準備できました',exact=True)).to_be_visible(timeout=30000)
 expect(page.get_by_role('button',name='適用',exact=True)).to_be_disabled()
 assert read(page)['cad']['draft']['notes']=='待機中に編集した未送信メモ';assert read(page)['cad']['features']==[];assert s['posts']==[]
 capture(page,'received-proposal-stale-input-protected')
 # Reload the saved request; the fixture restores its original local draft.
 page.reload();expect(page.get_by_text('提案の形状を準備できました',exact=True)).to_be_visible(timeout=30000)
 assert read(page)['cad']['features']==[];assert s['posts']==[]
 capture(page,'reload-ready')
 results.append({'scenario':'long-wait-notification-question-response-reload','inputPreserved':True,'modelUnapplied':True,'postCount':0});c.close()
 c,page,s=setup();s['webhook']={'connected':True,'failed':1}
 expect(page.get_by_text('通知に失敗しました。保存済みの依頼をdotに伝えてください。',exact=True)).to_be_visible(timeout=10000)
 expect(page.locator('.request-progress progress')).to_have_count(0);capture(page,'delivery-failed')
 s['http']=503
 expect(page.get_by_text('状態を確認してください',exact=True)).to_be_visible(timeout=10000)
 capture(page,'communication-error')
 s['http']=200;s['webhook']={'connected':True,'delivered':1}
 page.get_by_role('button',name='同じ依頼を確認',exact=True).click()
 expect(page.locator('.request-progress').get_by_role('status').filter(has_text='受付済み・dotの応答待ち')).to_be_visible(timeout=10000)
 assert s['posts']==[]
 b=c.new_page();b.goto(page.url);expect(b.locator('.request-progress').get_by_role('status').filter(has_text='受付済み・dotの応答待ち')).to_be_visible(timeout=10000)
 page.locator('.request-progress').get_by_role('button',name='依頼を取り消す',exact=True).click()
 expect(page.locator('.request-progress').get_by_role('status').filter(has_text='依頼を取り消しました')).to_be_visible(timeout=10000)
 expect(b.locator('.request-progress').get_by_role('status').filter(has_text='依頼を取り消しました')).to_be_visible(timeout=10000)
 assert s['posts']==['cancel'];assert read(page)['cad']['features']==[];capture(page,'cancelled')
 results.append({'scenario':'failure-retry-same-request-two-tab-cancel','cancelPosts':1,'newSubmissions':0});c.close()
 c,page,s=setup();page.get_by_label('部品の説明',exact=True).fill('高さ30の新しい部品')
 page.get_by_role('button',name='新しい依頼をCodexへ送る',exact=True).click()
 page.wait_for_function('(old)=>new URL(location.href).searchParams.get("cadRequest")!==old',arg=saved['requestId'])
 expect(page.locator('.request-progress').get_by_role('status').filter(has_text='受付済み・dotの応答待ち')).to_be_visible(timeout=10000)
 assert len(s['posts'])==1;assert s['posts'][0]['request']['sketchDraft']['notes']=='高さ30の新しい部品'
 assert read(page)['cad']['features']==[]
 results.append({'scenario':'explicit-new-request-during-wait','newSubmissions':1,'inputPreserved':True});c.close()
 browser.close()
assert not errors,errors
print(json.dumps({'passed':True,'localOnly':True,'mobile':'390x844','scenarios':results,'pageErrors':errors},ensure_ascii=False))
