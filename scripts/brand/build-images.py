#!/usr/bin/env python3
"""Build Echel's pictures from the logo: link-preview image, app icons,
favicon and the shop wall poster.

    python scripts/brand/build-images.py

Needs Pillow, and Chrome or Edge for the two pictures with text
(share.html and poster.html are rendered by the browser, because only a
browser shapes Meitei Mayek correctly). Set ECHEL_BROWSER to use another
browser. Run it again whenever the logo or the wording changes, then commit
the files it writes into public/.
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
PUBLIC = os.path.join(ROOT, 'public')
LOGO = os.path.join(PUBLIC, 'img', 'echel-logo.jpeg')
MEITEI_FONT = os.path.join(PUBLIC, 'fonts', 'NotoSansMeeteiMayek.ttf')

# The poster's white QR box, in poster pixels (2480x3508). poster.html puts
# the frame there; downloadPoster() in public/admin.html draws the QR into it.
POSTER_SIZE = (2480, 3508)
QR_BOX = (638, 1178, 1842, 2382)
NAME_MIDDLE = 3405


def browser():
    candidates = [os.environ.get('ECHEL_BROWSER', '')]
    for base in (os.environ.get('PROGRAMFILES', ''), os.environ.get('PROGRAMFILES(X86)', ''),
                 os.environ.get('LOCALAPPDATA', '')):
        candidates += [os.path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                       os.path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
    candidates += [shutil.which(n) or '' for n in ('google-chrome', 'chromium', 'chromium-browser', 'msedge')]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    sys.exit('Chrome or Edge is needed to draw the share image and the poster (or set ECHEL_BROWSER).')


def sphere():
    """Cut the round logo out of its square photo, with a clean soft edge."""
    img = Image.open(LOGO).convert('RGB')
    w, h = img.size
    bg = img.getpixel((4, 4))

    def differs(p):
        return sum(abs(a - b) for a, b in zip(p, bg)) > 24

    row = [img.getpixel((x, h // 2)) for x in range(w)]
    left = next(x for x in range(w) if differs(row[x]))
    right = next(x for x in range(w - 1, 0, -1) if differs(row[x]))
    col = [img.getpixel((w // 2, y)) for y in range(h)]
    top = next(y for y in range(h) if differs(col[y]))
    radius = (right - left) / 2 - 3
    cx, cy = (left + right) / 2, top + (right - left) / 2
    scale = 4
    mask = Image.new('L', (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).ellipse(
        [(cx - radius) * scale, (cy - radius) * scale, (cx + radius) * scale, (cy + radius) * scale], fill=255)
    out = img.convert('RGBA')
    out.putalpha(mask.resize((w, h), Image.LANCZOS))
    return out.crop((round(cx - radius), round(cy - radius), round(cx + radius), round(cy + radius)))


def icon(logo, size, scale, background=(255, 255, 255)):
    img = Image.new('RGBA', (size, size), background + (255,) if background else (0, 0, 0, 0))
    d = round(size * scale)
    img.alpha_composite(logo.resize((d, d), Image.LANCZOS), ((size - d) // 2, (size - d) // 2))
    return img


def render(template, width, height, scale, work, logo_path):
    """Draw an HTML template with the browser and return the screenshot."""
    html = pathlib.Path(HERE, template).read_text(encoding='utf-8')
    html = html.replace('{{LOGO}}', pathlib.Path(logo_path).as_uri())
    html = html.replace('{{MEITEI_FONT}}', pathlib.Path(MEITEI_FONT).as_uri())
    page = os.path.join(work, template)
    pathlib.Path(page).write_text(html, encoding='utf-8')
    shot = os.path.join(work, template + '.png')
    subprocess.run([browser(), '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
                    '--user-data-dir=' + os.path.join(work, 'profile'),
                    '--force-device-scale-factor=%s' % scale, '--window-size=%d,%d' % (width, height),
                    '--virtual-time-budget=3000', '--screenshot=' + shot, pathlib.Path(page).as_uri()],
                   check=True, capture_output=True, timeout=120)
    img = Image.open(shot).convert('RGB')
    expected = (round(width * scale), round(height * scale))
    if img.size != expected:
        sys.exit('%s came out %s, expected %s' % (template, img.size, expected))
    return img


def main():
    logo = sphere()
    work = tempfile.mkdtemp(prefix='echel-brand-')
    try:
        logo_path = os.path.join(work, 'logo.png')
        logo.resize((800, 800), Image.LANCZOS).save(logo_path)

        share = render('share.html', 1200, 630, 1, work, logo_path)
        share.save(os.path.join(PUBLIC, 'img', 'echel-share.png'), optimize=True)
        # Old links and caches still ask for /og-image.png — give them the same picture.
        share.save(os.path.join(PUBLIC, 'og-image.png'), optimize=True)

        poster = render('poster.html', 1240, 1754, 2, work, logo_path)
        poster.save(os.path.join(PUBLIC, 'poster.jpg'), quality=90, optimize=True, dpi=(300, 300))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    icon(logo, 180, 0.86).convert('RGB').save(os.path.join(PUBLIC, 'apple-touch-icon.png'), optimize=True)
    # 78% keeps the round logo inside the safe zone of a maskable app icon.
    icon(logo, 192, 0.78).convert('RGB').save(os.path.join(PUBLIC, 'icon-192.png'), optimize=True)
    icon(logo, 512, 0.78).convert('RGB').save(os.path.join(PUBLIC, 'icon-512.png'), optimize=True)
    icon(logo, 256, 1.0, background=None).save(
        os.path.join(PUBLIC, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])

    w, h = POSTER_SIZE
    x0, y0, x1, y1 = QR_BOX
    print('Poster QR box: left %.4f  top %.4f  width %.4f  height %.4f  (shop name at %.4f)' % (
        x0 / w, y0 / h, (x1 - x0) / w, (y1 - y0) / h, NAME_MIDDLE / h))


if __name__ == '__main__':
    main()
