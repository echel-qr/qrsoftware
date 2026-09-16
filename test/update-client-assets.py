"""Synchronize client source assets; never touches the original nested project."""
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=root/'server.js'
s=p.read_text(encoding='utf-8')
start=s.index('    const readme = `',s.index("app.get('/api/download/agent-package/:shopId'"))
end=s.index('`;\n',start)+3
s=s[:start]+'''    const readme = `ECHEL — PRINT CONNECT

Shop: ${shopName}
Shop ID: ${shopId}

1. Display QR-Code.png at your shop counter.
2. Right-click INSTALL.bat and choose Run as Administrator.
3. Start RUN_AGENT.bat, then select your printers in the Echel panel.
4. Scan the QR code, upload a test document, complete payment and check the print.

Keep the computer and printer switched on while accepting print jobs.
Use the tray icon to open the panel or exit the agent.
Choose the startup option during installation to launch Echel automatically.
The agent checks for updates while it is running.

Dashboard: ${BASE_URL}/admin
Setup guide: ${BASE_URL}/setup-guide
Support: ${BASE_URL}/contact
`;
'''+s[end:]
s=s.replace('qrseprint-backup-', 'echel-backup-').replace('QR-Se-Print-Setup-', 'Echel-Setup-')
p.write_text(s,encoding='utf-8')
for name in ['INSTALL.bat','agent-template/INSTALL.bat']:
    p=root/name
    p.write_text(p.read_text(encoding='utf-8').replace('QRSePrint.bat','EchelPrint.bat'),encoding='utf-8')
p=root/'test/desktop-template.html'
p.write_text(p.read_text(encoding='utf-8').replace('Files are deleted after printing.','Connected printing for your shop.'),encoding='utf-8')
