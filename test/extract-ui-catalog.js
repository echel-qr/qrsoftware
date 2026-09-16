const fs=require('fs'),path=require('path'),vm=require('vm');
const acorn=require('acorn');
const root=path.resolve(__dirname,'..'),items=[];
const english=JSON.parse(fs.readFileSync(path.join(__dirname,'english-base.json'),'utf8'));
const ctx={window:{QSPi18n:{addDict:(d,l)=>{if(!l||l==='en')Object.assign(english,d);}}}};
vm.runInNewContext(fs.readFileSync(path.join(root,'public/echel-english.js'),'utf8'),ctx);
const flat=node=>{
 if(node.type==='Literal'&&typeof node.value==='string')return node.value;
 if(node.type==='TemplateLiteral')return node.quasis.map((q,i)=>q.value.cooked+(i<node.expressions.length?' %s ':'')).join('');
 if(node.type==='BinaryExpression'&&node.operator==='+')return flat(node.left)+flat(node.right);
 return ' %s ';
};
function parse(code,file,server=false){
 let ast;try{ast=acorn.parse(code,{ecmaVersion:'latest',sourceType:'script',allowReturnOutsideFunction:true});}catch(e){throw new Error(file+': '+e.message);}
 function walk(n,parent){
  if(!n||typeof n!=='object')return;
  if(server){
   if(n.type==='Property'&&['error','message','warning','desc'].includes(n.key?.name||n.key?.value))items.push({file,text:flat(n.value)});
  }else{
   if(n.type==='Literal'&&typeof n.value==='string'&&!(parent?.type==='Property'&&parent.key===n))items.push({file,text:n.value});
   if(n.type==='TemplateLiteral'||(n.type==='BinaryExpression'&&n.operator==='+'&&!(parent?.type==='BinaryExpression'&&parent.operator==='+')))items.push({file,text:flat(n)});
  }
  for(const [k,v] of Object.entries(n)){if(k==='start'||k==='end')continue;if(Array.isArray(v))v.forEach(x=>walk(x,n));else if(v&&typeof v==='object')walk(v,n);}
 }
 walk(ast);
}
for(const file of fs.readdirSync(path.join(root,'public'))){
 if(file.endsWith('.html')){
  const html=fs.readFileSync(path.join(root,'public',file),'utf8');
  for(const [i,m]of [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries())if(!/src=|application\/ld\+json/i.test(m[1]))parse(m[2],file+':'+i);
 }else if(file.endsWith('.js')&&!/i18n|echel-(english|mayek)/.test(file))parse(fs.readFileSync(path.join(root,'public',file),'utf8'),file);
}
parse(fs.readFileSync(path.join(root,'server.js'),'utf8'),'server.js',true);
for(const [source,text]of Object.entries(english)){items.push({file:'english-dictionary',text,source});}
fs.writeFileSync(path.join(__dirname,'ui-strings-raw.json'),JSON.stringify({items,english},null,2));
console.log(items.length+' candidate UI strings extracted.');
