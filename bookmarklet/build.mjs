// ブックマークレットのビルド: node build.mjs
// src/core.js + src/<entry>.js を1つの即時関数にまとめて minify → dist/ に出力
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { minify } from 'terser';

const ENTRIES = [
  { id: 'all', name: '① note全期間取得' },
  { id: 'custom', name: '② note期間指定取得' },
  { id: 'daily', name: '③ note日次連続取得' },
];
const PLACEHOLDER = 'YOUR_GAS_URL_HERE';
const core = readFileSync(new URL('./src/core.js', import.meta.url), 'utf8');
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });

const built = [];
for (const e of ENTRIES) {
  const entry = readFileSync(new URL(`./src/${e.id}.js`, import.meta.url), 'utf8');
  const src = `(async()=>{const GAS_URL="${PLACEHOLDER}";\n${core}\n${entry}\nawait main();})();`;
  const { code } = await minify(src, { compress: { passes: 2 }, mangle: true, format: { comments: false } });
  // javascript: URL では % がURLデコードされるため %25 にエスケープ
  const bookmarklet = 'javascript:' + code.replace(/%/g, '%25');
  writeFileSync(new URL(`./dist/${e.id}.txt`, import.meta.url), bookmarklet);
  built.push({ ...e, code: bookmarklet });
  console.log(`${e.id}: ${bookmarklet.length} chars`);
}

// インストールページ（GAS URL を入れるとドラッグ用リンクを生成）
const tpl = readFileSync(new URL('./install.template.html', import.meta.url), 'utf8');
writeFileSync(
  new URL('./dist/install.html', import.meta.url),
  tpl.replace('/*__BOOKMARKLETS__*/[]', JSON.stringify(built.map(({ id, name, code }) => ({ id, name, code }))))
);
console.log('dist/install.html');
