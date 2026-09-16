from pathlib import Path
import re,base64,json
root=Path(__file__).resolve().parents[1]
p=root/'agent_panel.html';old=p.read_text(encoding='utf-8')
script=next(m[1] for m in re.findall(r'<script([^>]*)>(.*?)</script>',old,re.S) if 'function hasPy()' in m[1])
script=re.sub(r'^var PANEL_EN=.*?\nfunction panelEnglish\(s\)\{[^\n]*\}\n','',script,flags=re.S)
translations={
'Is build me ye available nahi: ':'This action is unavailable in this version: ',
'Mahato Net Cafe':'Echel Print Shop','SHOP_ECB1AB8A':'SHOP_PREVIEW',
'Windows ka default printer':'Windows default printer','abhi nahi mila':'currently unavailable',
'Printer save ho gaya — server par yahi set hai':'Printer selection saved and confirmed.',
'Printer save ho gaya':'Printer selection saved.', 'Printer save nahi hua':'Unable to save printer selection.',
'Printer settings server se aa rahi hain — ek pal ruk kar dobara try karo':'Printer settings are loading. Please try again in a moment.',
'Save nahi hua — net check karo':'Could not save. Check your connection and try again.',
'Server se sync ho gaya':'Your workspace is up to date.', 'Server tak nahi pahunche':'Could not reach the server.',
' printer mile':' printers found','Printer list nahi mili':'Unable to load the printer list.',
'Demo se Paid Shop':'Connect a paid shop','Verify karo':'Verify shop','Wapas':'Back',
'Ek minute… server se baat ho rahi hai':'Verifying your shop…',
'Shop mil gayi':'Shop verified','Sahi shop hai? Confirm karo.':'Confirm the shop you want to connect.',
'Paid Shop par switch karo':'Connect this shop','← Doosri Shop ID':'← Use another Shop ID',
'Ho gaya 🎉':'You’re connected','Ye agent ab aapki paid shop par chal raha hai.':'This agent is now connected to your paid shop.',
'Printing chalu hai. Kuch aur karne ki zaroorat nahi.':'Your shop is connected and ready to print.',
'Theek hai':'Back to workspace','Paid Shop ID daalo':'Enter your paid Shop ID.',
'Shop password daalo':'Enter your shop password.','Verify nahi hua — net check karo':'Could not verify the shop. Check your connection.',
'Switch fail hua':'Could not connect this shop.',
}
for a,b in sorted(translations.items(),key=lambda kv:-len(kv[0])):script=script.replace(a,b)
script=script.replace("'<p>Apni <b>paid Shop ID</b> aur password daalo. Yahi agent usi shop par '","'<p>Enter your <b>paid Shop ID</b> and password. This agent will connect to that shop '")
script=script.replace("'chalne lagega — na reinstall, na restart.</p></div>'","'without reinstalling the software.</p></div>'")
script=script.replace("'<div class=\"note\">Is shop par pehle se ek doosra computer juda hai. '","'<div class=\"note\">This shop is already connected to another computer. '")
script=script.replace("'Aage badhoge to wo PC hat jayega aur printing IS PC par aa jayegi.</div>'","'Continuing will disconnect it and move printing to this computer.</div>'")
version=re.search(r'^VERSION_LABEL\s*=\s*"([\d.]+)"',(root/'print_agent.py').read_text(encoding='utf-8'),re.M)[1]
script=re.sub(r"version:'[\d.]+', latestVersion:'[\d.]+'",f"version:'{version}', latestVersion:'{version}'",script)
script=script.replace("py('open_url', 'https://www.echel.in')", "py('open_url', '/')")
# Runtime messages returned by older servers use the bundled English dictionary.
en=json.loads((root/'test/english-base.json').read_text(encoding='utf-8'))
en.update(json.loads((root/'test/remaining-english.json').read_text(encoding='utf-8')))
script='var PANEL_EN='+json.dumps(en,ensure_ascii=False)+';\nfunction panelEnglish(s){var t=String(s||"");return PANEL_EN[t]||t;}\n'+script
script=script.replace("$('toastMsg').textContent = msg;","$('toastMsg').textContent = panelEnglish(msg);")
script=script.replace("esc(UP.err || '')","esc(panelEnglish(UP.err || ''))").replace("esc(UP.warning)","esc(panelEnglish(UP.warning))")
logo='data:image/jpeg;base64,'+base64.b64encode((root/'public/img/echel-logo.jpeg').read_bytes()).decode()
template=(root/'test/desktop-template.html').read_text(encoding='utf-8')
out=template.replace('__LOGO__',logo).replace('__SCRIPT__',script)
for target in [p,root/'agent-template/agent_panel.html',root.parent/'build/echel-client/agent_panel.html']:target.write_text(out,encoding='utf-8')
print('Rebuilt Echel desktop panel with English-only interface.')
