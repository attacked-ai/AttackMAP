const http=require('http'),fs=require('fs'),path=require('path');
const T={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png'};
http.createServer((req,res)=>{
  let p=decodeURIComponent(new URL(req.url,'http://x').pathname);
  if(p==='/')p='/dashboard.html';
  const f=path.join(__dirname,p);
  if(!f.startsWith(__dirname)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('not found');}
  res.writeHead(200,{'Content-Type':T[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});
  fs.createReadStream(f).pipe(res);
}).listen(4411,()=>console.log('static preview -> http://localhost:4411/dashboard.html'));
