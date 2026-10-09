import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const require = createRequire(import.meta.url);

/** Use an existing local installation or the Codex runtime. Never download browser dependencies. */
export function browserRuntime() {
  const candidates = process.env.SHOPPING_PLAYWRIGHT_PATH ? [process.env.SHOPPING_PLAYWRIGHT_PATH] : [
    'playwright', 'playwright-core',
    join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'),
  ];
  let chromium;
  for (const candidate of candidates) {
    try { ({ chromium } = require(candidate)); if (chromium) break; } catch { /* Try the next existing runtime. */ }
  }
  if (!chromium) throw new Error('浏览器验收需要已有的 Playwright。请设置 SHOPPING_PLAYWRIGHT_PATH 指向已安装的 playwright 包，或在本地开发环境安装 playwright；此脚本不会自动下载依赖。');
  const executable = process.env.SHOPPING_BROWSER_EXE || [
    chromium.executablePath(),
    ...(process.platform === 'win32' ? [
      join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ] : []),
  ].find(path => existsSync(path));
  if (!executable || !existsSync(executable)) throw new Error('未找到可用的 Chrome / Chromium 浏览器。请将 SHOPPING_BROWSER_EXE 设置为已安装浏览器的完整路径。');
  return { chromium, launchOptions: { headless: true, executablePath: executable } };
}
