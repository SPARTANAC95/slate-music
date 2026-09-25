import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('site');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'site.js'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
let localLinks = 0;
for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  const url = match[1];
  if (url.startsWith('https://')) continue;
  assert(!/^(?:http:|javascript:|data:)/.test(url), `Unexpected public URL: ${url}`);
  if (url.startsWith('#')) assert(ids.has(url.slice(1)), `Missing anchor: ${url}`);
  else {
    const target = path.resolve(root, url.split('#')[0]);
    assert(target === root || target.startsWith(root + path.sep), 'Asset leaves website root');
    assert(fs.existsSync(target), `Missing local asset: ${url}`);
  }
  localLinks++;
}
for (const match of css.matchAll(/url\(['"]?([^'"\)]+)['"]?\)/g))
  assert(fs.existsSync(path.join(root, match[1])), `Missing CSS asset: ${match[1]}`);
for (const match of js.matchAll(/file: '([^']+)'/g))
  assert(fs.existsSync(path.join(root, 'assets', match[1])), `Missing screenshot: ${match[1]}`);
for (const image of html.matchAll(/<img\b[^>]*>/g))
  assert(/\balt="[^"]*"/.test(image[0]), 'Image requires alt text');
assert.equal((html.match(/<h1\b/g) || []).length, 1, 'Use one main page heading');
assert(!html.includes('D:\\Music') && !html.includes('C:\\Users'), 'Do not expose local paths');
assert(html.includes('demo'), 'Disclose demonstration screenshots');
assert(fs.existsSync(path.join(root, 'assets', 'social-preview.png')), 'Missing social preview');
for (const file of ['README.md', 'CONTRIBUTING.md', 'docs/GUIDE.md', 'docs/PRESENTATION.md']) {
  const content = fs.readFileSync(file, 'utf8');
  for (const m of content.matchAll(/\]\(([^)]+)\)/g)) {
    const link = m[1];
    if (link.includes('://') || link.startsWith('#')) continue;
    assert(
      fs.existsSync(path.resolve(path.dirname(file), link.split('#')[0])),
      `Broken documentation link in ${file}: ${link}`,
    );
  }
}
console.log(
  `Website validation passed: ${localLinks} local references, screenshot assets, font, accessibility basics and documentation links.`,
);
