#!/usr/bin/env python3
"""Bake The Grid's font atlases (kit/runtime/fonts/grid*.json) from the OFL fonts in
kit/fonts-src/grid: Orbitron (titles, numbers), Rajdhani (labels), Share Tech Mono (system text).

The renderer keeps every glyph atlas in one shared texture for as long as it runs (two 1024 x 4096
columns, first come first served, kit/renderd/src/gfx.c), so the big sizes carry digits only.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_fonts as bf

bf.FONTDIR = os.path.join(bf.HERE, '..', 'fonts-src', 'grid')
TEXT = bf.TEXT + '▸◂▴▾◆'
NUM = '0123456789.,:-+%° NRPDSM'
BIG = '0123456789-'

FAMILIES = {
    'gridhead': ('Orbitron-wght.ttf', (700,), [(20, TEXT), (28, TEXT), (40, TEXT)]),
    'gridnum':  ('Orbitron-wght.ttf', (600,), [(56, NUM), (90, NUM), (132, NUM), (172, BIG)]),
    'gridlbl':  ('Rajdhani-SemiBold.ttf', None, [(18, TEXT), (24, TEXT), (32, TEXT)]),
    'gridmono': ('ShareTechMono-Regular.ttf', None, [(16, TEXT), (22, TEXT)]),
}


def main():
    rows = 0
    for fam, (fname, var, sizes) in FAMILIES.items():
        data = {'family': fam, 'source': fname, 'sizes': [bf.bake(fname, var, s, cs) for s, cs in sizes]}
        p = os.path.join(bf.OUT, fam + '.json')
        json.dump(data, open(p, 'w', encoding='utf-8', newline='\n'), separators=(',', ':'))
        h = [s['atlasH'] for s in data['sizes']]
        rows += sum(h)
        print(f'{fam}: {[s for s, _ in sizes]} rows {h} -> {os.path.getsize(p) // 1024} KiB')
    print('atlas rows in all:', rows)


if __name__ == '__main__':
    main()
