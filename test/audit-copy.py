from pathlib import Path
from html.parser import HTMLParser
import re,json
root=Path(__file__).resolve().parents[1]
dictionary=json.loads((root/'test/english-base.json').read_text(encoding='utf-8'))
known={re.sub(r'\s+',' ',s).strip() for s in dictionary}
class Copy(HTMLParser):
    def __init__(self):super().__init__();self.raw=0;self.found=[]
    def handle_starttag(self,t,a):
        if t in ['script','style']:self.raw+=1
    def handle_endtag(self,t):
        if t in ['script','style']:self.raw=max(0,self.raw-1)
    def handle_data(self,s):
        s=re.sub(r'\s+',' ',s).strip()
        if not self.raw and s not in known and re.search(r'\b(karo|karein|hai|hoga|nahi|aap|neeche|yahan|wale|kaise|chahiye|karke|hota|karna|raha|jaata|kya|sakta|diya)\b',s,re.I):self.found.append(s)
for p in (root/'public').glob('*.html'):
    c=Copy();c.feed(p.read_text(encoding='utf-8'))
    if c.found:print(p.name,json.dumps(c.found,ensure_ascii=False))
