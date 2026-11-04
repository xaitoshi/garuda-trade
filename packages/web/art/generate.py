"""Rasterise the landing-page knight and Phoenix SVGs into the per-state PNGs the web app uses.

Source of truth for the artwork: /workspace/garuda-landing/src/build.py (knight(), boss()). Run:
    python3 art/generate.py
Needs python3 + playwright (chromium). Writes public/art/knights/{level}-{state}.png (4 levels x 4 states)
and public/art/boss/{state}.png. Drop real per-state art over these files (same names) to replace them.
"""
import os, re, sys
B = '/workspace/garuda-landing/'
src = open(B + 'src/build.py').read().split("tpl=open")[0]
ns = {}
exec(src, ns)
knight, boss, feather = ns['knight'], ns['boss'], ns['feather']
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'art')

DEFS = ('<defs><filter id="sg" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" result="b"/>'
        '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
        '<filter id="desat"><feColorMatrix type="saturate" values="{sat}"/><feComponentTransfer><feFuncR type="linear" slope="{br}"/><feFuncG type="linear" slope="{br}"/><feFuncB type="linear" slope="{br}"/></feComponentTransfer></filter></defs>')

BANDAGE = ('<rect x="20" y="26" width="60" height="9" rx="2" fill="#f2f0f0" transform="rotate(-18 50 46)"/>'
           '<path d="M44 24 l4 12 M52 20 l4 12" stroke="#c9c3c4" stroke-width="1.5" transform="rotate(-18 50 46)"/>'
           '<rect x="62" y="64" width="16" height="7" rx="2" fill="#f2f0f0" transform="rotate(20 70 68)"/>'
           '<path d="M71 54 q3 6 0 9 q-3 -3 0 -9z" fill="#8fd3ff"/>')
SPARKLES = ('<g fill="#ffc24a"><path d="M96 4 l3 9 9 3 -9 3 -3 9 -3 -9 -9 -3 9 -3z"/></g>'
            '<g fill="#bbb4fb"><path d="M2 20 l2 6 6 2 -6 2 -2 6 -2 -6 -6 -2 6 -2z"/><path d="M92 96 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" opacity=".8"/></g>')
ZZZ = '<g fill="#948f90" font-family="sans-serif" font-weight="700"><text x="78" y="10" font-size="14">z</text><text x="88" y="-2" font-size="10">z</text></g>'

def knight_svg(level, state):
    k = knight(level, 512)
    inner = re.search(r'<svg[^>]*>(.*)</svg>', k, re.S).group(1)
    extra, flt = '', None
    if state == 'wounded':
        extra, flt = BANDAGE, DEFS.format(sat=.45, br=.88)
    elif state == 'victory':
        extra = SPARKLES
        flt = DEFS.format(sat=1, br=1)
    elif state == 'dormant':
        extra, flt = ZZZ, DEFS.format(sat=0.15, br=.6)
    else:
        flt = DEFS.format(sat=1, br=1)
    g = f'<g filter="url(#desat)">{inner}{extra if state=="wounded" else ""}</g>' + (extra if state != 'wounded' else '')
    if state in ('active', 'victory'):
        g = f'<g>{inner}</g>' + extra
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="614" viewBox="-6 -14 112 134">{flt}{g}</svg>'

def boss_svg(state):
    b = boss(512)
    inner_open = re.match(r'<svg[^>]*>', b).group(0)
    rest = b[len(inner_open):-len('</svg>')]
    cfg = {'full': (1, 1, None), 'hurt': (.85, .85, None), 'low': (.55, .6, 'cracks'), 'defeated': (.05, .5, 'ash')}[state]
    sat, br, ex = cfg
    filt = (f'<defs><filter id="bs"><feColorMatrix type="saturate" values="{sat}"/><feComponentTransfer><feFuncR type="linear" slope="{br}"/><feFuncG type="linear" slope="{br}"/><feFuncB type="linear" slope="{br}"/></feComponentTransfer></filter></defs>')
    extra = ''
    if ex == 'cracks':
        extra = '<path d="M96 70 l6 10 -5 6 7 9" stroke="#110f10" stroke-width="2" fill="none"/>'
    if ex == 'ash':
        extra = '<circle cx="100" cy="82" r="15" fill="none" stroke="#110f10" stroke-width="0"/><path d="M96 78 l8 8 M104 78 l-8 8" stroke="#110f10" stroke-width="2"/>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="512" height="563" viewBox="0 0 200 220">{filt}<g filter="url(#bs)">{rest}</g>{extra}</svg>'

jobs = []
for lv in (1, 2, 3, 4):
    for st in ('active', 'wounded', 'victory', 'dormant'):
        jobs.append((os.path.join(OUT, 'knights', f'{lv}-{st}.png'), knight_svg(lv, st), 512, 614))
for st in ('full', 'hurt', 'low', 'defeated'):
    jobs.append((os.path.join(OUT, 'boss', f'{st}.png'), boss_svg(st), 512, 563))

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    br = p.chromium.launch()
    for path, svg, w, h in jobs:
        pg = br.new_page(viewport={'width': w, 'height': h})
        pg.set_content(f'<html><body style="margin:0;background:transparent">{svg}</body></html>')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        pg.screenshot(path=path, omit_background=True)
        pg.close()
    br.close()
print(len(jobs), 'png written')
