// Local, loopback-only QA of the built Worker and assets. Mock identity/storage
// live only in this script; neither is included in a deployed Worker.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import worker from '../dist/server/index.js';
const root=resolve('dist/client'),port=Number(process.argv[2]||4175),objects=new Map();let serial=0;
const env={CAD_EXCHANGE:{
  async get(key){const o=objects.get(key);return o&&{etag:o.etag,json:async()=>JSON.parse(o.text)};},
  async put(key,text,options={}){const old=objects.get(key),c=options.onlyIf;if(c?.etagMatches&&old?.etag!==c.etagMatches||c?.etagDoesNotMatch==='*'&&old)return null;const etag=String(++serial);objects.set(key,{text,etag,customMetadata:options.customMetadata});return{etag};},
  async list({prefix}){return{objects:[...objects].filter(([key])=>key.startsWith(prefix)).map(([key,o])=>({key,customMetadata:o.customMetadata})),truncated:false};}
},ASSETS:{async fetch(request){
  const pathname=decodeURIComponent(new URL(request.url).pathname);let path=resolve(root,'.'+pathname);if(!path.startsWith(root+'/')&&path!==root)return new Response(null,{status:404});if(path===root)path=resolve(root,'index.html');
  try{const body=await readFile(path);const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'};return new Response(body,{headers:{'Content-Type':types[extname(path)]||'application/octet-stream'}});}catch{return new Response(null,{status:404});}
}}};
createServer(async(req,res)=>{
  try{const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks),url=`http://127.0.0.1:${port}${req.url}`;
    const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','local-preview-user');
    const response=await worker.fetch(new Request(url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method)?{}:{body})}),env);
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500);res.end(e.message);}
}).listen(port,'127.0.0.1',()=>process.stdout.write(`Local Site QA: http://127.0.0.1:${port}/\n`));
