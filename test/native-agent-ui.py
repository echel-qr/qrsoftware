"""Exercise native agent dialog generation without opening Windows or contacting a server."""
import ast
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[1]
TREE = ast.parse((ROOT / 'print_agent.py').read_text(encoding='utf-8'))

def load_function(name, **bindings):
    node = next(n for n in TREE.body if isinstance(n, ast.FunctionDef) and n.name == name)
    context = {'os': os, 'log': lambda *args: None, **bindings}
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'print_agent.py', 'exec'), context)
    return context[name]

class NativeAgentUiTests(unittest.TestCase):
    def test_first_run_and_fallback_instructions(self):
        calls = []
        prompt = load_function('_ask_shop_id_once', _ps_input_big=lambda **kw: calls.append(kw) or 'SHOP_TEST')
        self.assertEqual(prompt(), 'SHOP_TEST')
        self.assertEqual(calls[0]['head'], 'Welcome to Echel')
        self.assertIn('Enter your Shop ID', calls[0]['sub'])
        self.assertIn('shop dashboard', calls[0]['hint'])
        fallback = load_function('_ask_shop_id_once', _ps_input_big=lambda **kw: None,
                                 _powershell_input=lambda text: calls.append(text) or 'SHOP_FALLBACK')
        self.assertEqual(fallback(), 'SHOP_FALLBACK')
        self.assertIn('Paste your Shop ID', calls[-1])

    def test_windows_dialog_contains_english_buttons_and_preserves_password(self):
        scripts = []
        def run(command, **options):
            scripts.append(Path(command[-1]).read_text(encoding='utf-8-sig'))
            return SimpleNamespace(stdout='shop_test\n password with spaces \n')
        subprocess = SimpleNamespace(run=run, CREATE_NO_WINDOW=0)
        prompt = load_function('_ps_input_big', subprocess=subprocess)
        self.assertEqual(prompt('Welcome to Echel', 'Enter your Shop ID', 'Shop ID', 'Open your dashboard'), 'shop_test')
        login = load_function('_ps_shop_login', subprocess=subprocess)
        self.assertEqual(login('Enter your paid Shop ID and password.'), ('SHOP_TEST', ' password with spaces '))
        for script in scripts:
            self.assertIn("$ok.Text = 'Continue'", script)
            self.assertNotRegex(script, r'Shuru karo|Aage badho|daalo|nahi')
        self.assertIn('UseSystemPasswordChar = $true', scripts[1])

    def test_other_computer_warning_stays_english_with_a_legacy_server(self):
        inputs = iter(['SHOP_TEST', ''])
        messages = []
        response = SimpleNamespace(status_code=409, json=lambda: {'error': 'Purana PC hata kar dobara try karein.'})
        prompt = load_function('_shop_id_without_tkinter', _ask_shop_id_once=lambda: next(inputs),
                               requests=SimpleNamespace(post=lambda *a, **kw: response),
                               SERVER_URL='https://example.test', auth_headers=lambda: {},
                               _machine_name=lambda: 'Test PC', _msgbox=lambda text, *a: messages.append(text), input=lambda _: '')
        self.assertEqual(prompt(), '')
        self.assertIn('disconnect the previous computer', messages[0])
        self.assertNotIn('Purana', messages[0])

    def test_print_approval_and_duplex_dialogs(self):
        dialogs = []
        show = lambda title, **kw: dialogs.append(kw) or True
        approval = load_function('_ask_approval_native', _ps_dialog=show)
        self.assertTrue(approval({'amount': 25, 'file_name': 'document.pdf', 'copies': 2}))
        self.assertEqual(dialogs[0]['yes_label'], 'Approve and Print')
        duplex = load_function('_ask_backside_native', _ps_dialog=show)
        self.assertTrue(duplex())
        self.assertEqual(dialogs[1]['yes_label'], 'Print back side')
        self.assertEqual(dialogs[1]['no_label'], 'Skip back side')

if __name__ == '__main__':
    unittest.main()
