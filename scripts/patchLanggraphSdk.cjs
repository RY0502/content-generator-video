const fs = require('fs');
const path = require('path');

const pnpmDir = path.join(
  __dirname,
  '..',
  'node_modules',
  '@langchain',
  'langgraph-sdk',
  'dist',
  'node_modules',
  '.pnpm'
);

if (fs.existsSync(pnpmDir)) {
  const entries = fs.readdirSync(pnpmDir);
  for (const entry of entries) {
    const pkgDir = path.join(pnpmDir, entry, 'node_modules');
    if (fs.existsSync(pkgDir)) {
      const subEntries = fs.readdirSync(pkgDir);
      for (const sub of subEntries) {
        const targetPackage = path.join(pkgDir, sub, 'package.json');
        if (!fs.existsSync(targetPackage)) {
          fs.writeFileSync(targetPackage, JSON.stringify({ type: 'module' }, null, 2));
          console.log(`[postinstall] created ${targetPackage}`);
        }
      }
    }
  }
}

const providerManagerPath = path.join(
  __dirname,
  '..',
  'node_modules',
  'freetier-deepagent-framework',
  'dist',
  'providers',
  'providerManager.js'
);

if (fs.existsSync(providerManagerPath)) {
  const content = fs.readFileSync(providerManagerPath, 'utf8');
  const regex = /export const PROVIDER_ORDER = \[[^\]]+\];/;
  const replacement = "export const PROVIDER_ORDER = ['nvidia', 'requesty', 'openrouter', 'anyapi', 'huggingface'];";
  if (regex.test(content)) {
    fs.writeFileSync(providerManagerPath, content.replace(regex, replacement), 'utf8');
    console.log('[postinstall] patched PROVIDER_ORDER in freetier-deepagent-framework');
  }
}
