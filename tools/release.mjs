import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const owner = 'SPARTANAC95',
  repo = 'slate-music';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = pkg.version,
  tag = `v${version}`;
const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr || 'Git failed');
  return r.stdout.trim();
};
function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  const value = r.stdout
    ?.split(/\r?\n/)
    .find((l) => l.startsWith('password='))
    ?.slice(9);
  if (!value)
    throw Error(
      'GitHub credentials are unavailable. Sign in with Git Credential Manager or provide GITHUB_TOKEN.',
    );
  return value;
}
const api = async (route, method = 'GET', body) => {
  const url = new URL(route.startsWith('/') ? `https://api.github.com${route}` : route);
  if (!['api.github.com', 'uploads.github.com'].includes(url.hostname))
    throw Error('Unexpected API host');
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Slate-Music-release',
      'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
    },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
  if (!r.ok) throw Error(`GitHub ${method} ${url.pathname}: ${r.status}`);
  return r.status === 204 ? null : r.json();
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
async function main() {
  const command = process.argv[2];
  if (command === 'create-repo') {
    const user = await api('/user');
    if (user.login !== owner) throw Error('Authenticated account does not match project owner');
    let exists;
    try {
      exists = await api(`/repos/${owner}/${repo}`);
    } catch (e) {
      if (!e.message.endsWith('404')) throw e;
    }
    if (exists)
      throw Error('Target repository already exists. Refusing to overwrite or repurpose it.');
    const result = await api('/user/repos', 'POST', {
      name: repo,
      description: pkg.description,
      private: true,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    });
    console.log(`Created private repository ${result.html_url}`);
    return;
  }
  const releaseDir = path.resolve(process.env.SLATE_RELEASE_DIR || '../release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const installer = `Slate-Music_${version}_x64-setup.exe`;
  if (command === 'prepare') {
    const head = git(['rev-parse', 'HEAD']);
    if (git(['status', '--porcelain']))
      throw Error('Commit all source changes before preparing a release');
    const from = path.join(
      'src-tauri',
      'target',
      'release',
      'bundle',
      'nsis',
      `Slate Music_${version}_x64-setup.exe`,
    );
    for (const ext of ['', '.sig'])
      fs.copyFileSync(from + ext, path.join(releaseDir, installer + ext));
    const signature = fs.readFileSync(from + '.sig', 'utf8').trim();
    const notes = fs.readFileSync(`docs/releases/${tag}.md`, 'utf8');
    const manifest = {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: {
        'windows-x86_64': {
          signature,
          url: `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(installer)}`,
        },
      },
    };
    fs.writeFileSync(
      path.join(releaseDir, 'latest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    const files = [installer, installer + '.sig', 'latest.json'];
    const hashes = Object.fromEntries(
      files.map((n) => [n, sha256(fs.readFileSync(path.join(releaseDir, n)))]),
    );
    fs.writeFileSync(
      path.join(releaseDir, 'SHA256SUMS.txt'),
      Object.entries(hashes)
        .map(([n, h]) => `${h}  ${n}`)
        .join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(releaseDir, 'build.json'),
      JSON.stringify({ version, commit: head, hashes }, null, 2),
    );
    console.log('Signed installer, manifest and checksums prepared.');
    return;
  }
  if (command === 'publish') {
    const build = JSON.parse(fs.readFileSync(path.join(releaseDir, 'build.json'), 'utf8'));
    const head = git(['rev-parse', 'HEAD']);
    if (build.commit !== head || git(['status', '--porcelain']) || build.version !== version)
      throw Error('Source commit does not match prepared release');
    for (const [name, hash] of Object.entries(build.hashes))
      if (sha256(fs.readFileSync(path.join(releaseDir, name))) !== hash)
        throw Error('Release artifact changed');
    const base = `/repos/${owner}/${repo}/releases`;
    const prior = await api(`${base}?per_page=100`);
    if (prior.some((r) => r.tag_name === tag))
      throw Error('Release tag already exists; refusing to replace it');
    if (!git(['ls-remote', 'origin', `refs/tags/${tag}`]).startsWith(head))
      throw Error('Push the matching version tag before publishing');
    const release = await api(base, 'POST', {
      tag_name: tag,
      target_commitish: head,
      name: `Slate Music ${version}`,
      body: fs.readFileSync(`docs/releases/${tag}.md`, 'utf8'),
      draft: true,
      prerelease: false,
    });
    for (const name of [installer, installer + '.sig', 'latest.json', 'SHA256SUMS.txt'])
      await api(
        release.upload_url.split('{')[0] + `?name=${encodeURIComponent(name)}`,
        'POST',
        fs.readFileSync(path.join(releaseDir, name)),
      );
    const result = await api(`${base}/${release.id}`, 'PATCH', {
      draft: false,
      make_latest: 'true',
    });
    console.log(`Published ${result.html_url}`);
    return;
  }
  throw Error('Usage: node tools/release.mjs create-repo|prepare|publish');
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
