// Rend docs/manuel/manuel-fedo-gestion.html en PDF A4 (couverture + corps numéroté, sommaire avec pages).
// Usage : node docs/manuel/render-manuel.cjs <dossier temporaire> (Playwright installé globalement, pdftotext et pypdf disponibles).
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(execSync('npm root -g').toString().trim() + '/playwright');

const REPO = path.resolve(__dirname, '../..');
const DIR = path.join(REPO, 'docs/manuel');
const HTML = path.join(DIR, 'manuel-fedo-gestion.html');
const OUT = path.join(DIR, 'Manuel-FEDO-Gestion.pdf');
const TMP = process.argv[2];
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'apps/desktop/package.json'), 'utf8')).version;
const norm = (s) => s.normalize('NFC').replace(/[\s  ]+/g, '').replace(/[’']/g, "'").toLowerCase();

(async () => {
  const browser = await chromium.launch({ env: { ...process.env, LANG: 'fr_FR.UTF-8' } });
  const page = await browser.newPage();
  await page.goto('file://' + HTML, { waitUntil: 'load' });
  await page.emulateMedia({ media: 'print' });
  await page.evaluate((v) => document.querySelectorAll('[data-version]').forEach((e) => (e.textContent = v)), version);
  // Sommaire : chapitres et sections, numéros de page à remplir.
  const entries = await page.evaluate(() => {
    const list = [];
    document.querySelectorAll('section.chapitre').forEach((ch) => {
      list.push({ id: ch.id, search: ch.querySelector('.chap-num').textContent + ch.querySelector('h1').textContent });
      ch.querySelectorAll('h2[id]').forEach((h) => list.push({ id: h.id, search: h.textContent }));
    });
    document.querySelectorAll('.toc .pg').forEach((e) => (e.textContent = '00'));
    return list;
  });
  const footer = `<div style="font-family:Inter,Arial,sans-serif;font-size:7.5px;color:#5b6474;width:100%;padding:0 16mm;display:flex;justify-content:space-between;"><span>FEDO Gestion · Manuel d'utilisation · version ${version}</span><span>FEDONG · page <span class="pageNumber"></span></span></div>`;
  const body = async (file) => {
    await page.evaluate(() => document.documentElement.classList.add('no-cover'));
    await page.pdf({
      path: file,
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '17mm', left: '16mm', right: '16mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: footer,
    });
    await page.evaluate(() => document.documentElement.classList.remove('no-cover'));
  };
  const pagesOf = (file) => {
    const n = Number(/Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${file}"`).toString())[1]);
    return Array.from({ length: n }, (_, i) => norm(execSync(`pdftotext -f ${i + 1} -l ${i + 1} -layout "${file}" -`).toString()));
  };
  const locate = (pages) => {
    const found = {};
    let from = 1; // la page 1 est le sommaire
    for (const e of entries) {
      const k = norm(e.search);
      let p = -1;
      for (let i = from; i < pages.length; i++) if (pages[i].includes(k)) { p = i; break; }
      if (p < 0) throw new Error('Titre introuvable dans le PDF : ' + e.search);
      found[e.id] = p + 1;
      from = p;
    }
    return found;
  };
  const pass1 = path.join(TMP, 'corps1.pdf');
  await body(pass1);
  const found = locate(pagesOf(pass1));
  await page.evaluate((f) => document.querySelectorAll('.toc .pg').forEach((e) => (e.textContent = String(f[e.dataset.for]))), found);
  const pass2 = path.join(TMP, 'corps2.pdf');
  await body(pass2);
  const again = locate(pagesOf(pass2));
  for (const k of Object.keys(found)) if (found[k] !== again[k]) throw new Error('Pagination instable pour ' + k);
  // Couverture seule, pleine page.
  await page.evaluate(() => document.documentElement.classList.add('only-cover'));
  const cover = path.join(TMP, 'couverture.pdf');
  await page.pdf({ path: cover, width: '210mm', height: '297mm', printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 }, pageRanges: '1' });
  await browser.close();
  execSync(`python3 - "${cover}" "${pass2}" "${OUT}" "${version}" <<'EOF'
import sys
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for f in sys.argv[1:3]:
    for p in PdfReader(f).pages:
        w.add_page(p)
w.add_metadata({'/Title': "FEDO Gestion : manuel d'utilisation", '/Author': 'FEDONG', '/Subject': 'Version ' + sys.argv[4]})
with open(sys.argv[3], 'wb') as fh:
    w.write(fh)
EOF`);
  console.log('version', version, 'pages corps', Object.values(again).pop(), JSON.stringify(again));
  console.log(execSync(`pdfinfo "${OUT}" | grep -E "Pages|Title|File size"`).toString());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
