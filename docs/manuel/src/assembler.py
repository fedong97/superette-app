# Assemble docs/manuel/manuel-onix-360.html à partir des morceaux de src/ (python3 -I docs/manuel/src/assembler.py).
import os
d = os.path.dirname(os.path.abspath(__file__))
parts = ['00-debut.html', '10-demarrer.html', '20-parametrer.html', '30-vendre.html', '31-gerer.html', '32-suivre.html', '40-entretenir.html', '99-fin.html']
html = ''.join(open(os.path.join(d, p), encoding='utf-8').read() for p in parts)
html = html.replace('/*CSS*/', open(os.path.join(d, 'style.css'), encoding='utf-8').read())
html = html.replace('<!--COVER-->', open(os.path.join(d, 'couverture.html'), encoding='utf-8').read())
open(os.path.join(d, '..', 'manuel-onix-360.html'), 'w', encoding='utf-8').write(html)
print('manuel-onix-360.html', len(html))
