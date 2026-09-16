from pathlib import Path
from html.parser import HTMLParser
import re,json,html
root=Path(__file__).resolve().parents[1]
raw=json.loads((root/'test/ui-strings-raw.json').read_text(encoding='utf-8'))
def norm(s):return re.sub(r'\s+',' ',html.unescape(s)).strip()
english={norm(k):norm(v) for k,v in raw['english'].items()}
entries={}
def add(s,file,source=None):
    s=norm(s)
    if not re.search(r'[A-Za-z]',s) or len(s)>5000:return
    if re.search(r'https?://|data:|[\w.+-]+@[\w.-]+|\b(?:SELECT|INSERT|UPDATE|ALTER|CREATE)\b|\bfunction\b|=>|document\.|window\.|this\.|^--[a-z]|^,|^\)|px\b|\.style|\.value|\.checked|\b(?:onclick|onchange|oninput)=',s):return
    if re.fullmatch(r'[%\s\d,.₹+/()—–:;#*=-]*',s):return
    if re.search(r'[{}]|#[\da-fA-F]{3,8}|\b(?:padding|margin|border|font-size|background|display):|^[/#.]|\.[a-z]{2,4}$',s):return
    if re.fullmatch(r'[a-zA-Z_$][\w$]*',s) and (re.search(r'_|[a-z][A-Z]',s) or s.islower()):return
    if len(s)<2 or s in ['%s','%d','null','undefined','Bearer','POST','GET','PUT','DELETE','true','false','UTF-8']:return
    value=english.get(s,s)
    item=entries.setdefault(value,{'text':value,'sources':[],'files':[]})
    for key in [s,source]:
        if key and key not in item['sources']:item['sources'].append(key)
    if file not in item['files']:item['files'].append(file)
class Reader(HTMLParser):
    def __init__(self,file):super().__init__(convert_charrefs=True);self.file=file;self.raw=0
    def handle_starttag(self,t,attrs):
        if t in ['script','style','code','pre']:self.raw+=1
        if not self.raw:
            for k,v in attrs:
                if k in ['placeholder','title','aria-label','alt'] and v:add(v,self.file)
    def handle_endtag(self,t):
        if t in ['script','style','code','pre']:self.raw=max(0,self.raw-1)
    def handle_data(self,s):
        if not self.raw:add(s,self.file)
for p in (root/'public').glob('*.html'):Reader(p.name).feed(p.read_text(encoding='utf-8'))
for i in raw['items']:
    if re.search(r'<\/?[a-zA-Z]',i['text']):
        try:Reader(i['file']).feed(i['text'])
        except Exception:pass
    else:add(i['text'],i['file'],i.get('source'))
catalog=sorted(entries.values(),key=lambda i:i['text'])
(root/'test/ui-catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'{len(catalog)} unique interface phrases, {sum(len(i["text"]) for i in catalog)} characters.')
