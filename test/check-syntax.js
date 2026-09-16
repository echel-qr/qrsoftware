const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'..');let count=0;
for(const file of fs.readdirSync(path.join(root,'public')).filter(x=>x.endsWith('.html')).map(x=>'public/'+x).concat(['agent_panel.html','agent-template/agent_panel.html'])){
 const html=fs.readFileSync(path.join(root,file),'utf8');
 for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(/application\/ld\+json|\bsrc\s*=/.test(match[1])||!match[2].trim())continue;
  new vm.Script(match[2],{filename:file+':script-'+(++count)});
 }
}
console.log(count+' inline scripts parsed successfully.');
