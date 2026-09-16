"""Build-time UI translation, including private admin labels. Requires explicit
approval to send this catalogue to Google. No visitor data or runtime calls."""
from pathlib import Path
import json,re,time,urllib.request,urllib.parse,concurrent.futures,threading,os
root=Path(__file__).resolve().parents[1]
catalog=json.loads((root/'test/ui-catalog.json').read_text(encoding='utf-8'))
cache_path=root/'test/manipuri-translations.json'
cache=json.loads(cache_path.read_text(encoding='utf-8')) if cache_path.exists() else {}
lock=threading.Lock()
keep=re.compile(r'^(?:Echel|PDF|JPG|JPEG|PNG|UPI|QR|A[0-6]|B&W|URL|API|GST|Razorpay|Cashfree|Windows|SumatraPDF|AnyDesk|WhatsApp|Instagram|Facebook|YouTube|LinkedIn|Telegram|X|Pro|Premium|Starter|Demo|English|Manipuri|INR|SQL|SMTP|SSL|TLS|OTP|ID|PC|PNG / JPG|QR Code|Facebook Pixel|Google Analytics|Google Tag Manager|100%|%s|%d)$',re.I)
latin=re.compile(r'[A-Za-z]')
def remote(text):
    query=urllib.parse.urlencode({'client':'gtx','sl':'auto','tl':'mni-Mtei','dt':'t','q':text})
    req=urllib.request.Request('https://translate.googleapis.com/translate_a/single?'+query,headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req,timeout=40) as res:data=json.load(res)
    return ''.join(row[0] or '' for row in data[0])
def translate(batch):
    text='\n'.join('[Q%05d]\n%s'%(i,t) for i,t in enumerate(batch))
    error=None
    for attempt in range(4):
        try:
            result=remote(text)
            chunks=re.split(r'\[\s*Q\s*(\d+)\s*\]',result)
            found={int(chunks[i]):chunks[i+1].strip() for i in range(1,len(chunks)-1,2)}
            if len(found)!=len(batch):raise ValueError('Translation marker mismatch')
            values={}
            for i,source in enumerate(batch):
                target=found[i]
                # Preserve dynamic string slots and formatting exactly.
                target=re.sub(r'%\s+([sd])',r'%\1',target)
                if source.count('%s')!=target.count('%s') or source.count('%d')!=target.count('%d'):
                    raise ValueError('Translation changed a dynamic placeholder')
                if not target:raise ValueError('Empty translation')
                values[source]=target
            with lock:
                cache.update(values)
                cache_path.write_text(json.dumps(cache,ensure_ascii=False,indent=2),encoding='utf-8')
                print('Translated %d/%d phrases'%(len(cache),len(catalog)),flush=True)
            return
        except Exception as e:
            error=e
            if attempt<3:time.sleep(2+attempt*2)
    # Retry short batches independently to avoid losing good translations to
    # a single irregular placeholder or marker.
    if len(batch)>1:
        middle=len(batch)//2;translate(batch[:middle]);translate(batch[middle:]);return
    print('FAILED '+batch[0][:100]+': '+str(error),flush=True)
pending=[]
for item in catalog:
    text=item['text']
    if text in cache:continue
    if keep.fullmatch(text.strip()):cache[text]=text;continue
    pending.append(text)
batches=[];batch=[];size=0
for text in pending:
    if size+len(text)>1500 and batch:batches.append(batch);batch=[];size=0
    batch.append(text);size+=len(text)+15
if batch:batches.append(batch)
print('Translating %d phrases in %d batches'%(len(pending),len(batches)),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:list(executor.map(translate,batches))
cache_path.write_text(json.dumps(cache,ensure_ascii=False,indent=2),encoding='utf-8')
missing=[i['text'] for i in catalog if i['text'] not in cache]
print('Complete. Missing: '+str(len(missing)),flush=True)
if missing:raise SystemExit(1)
