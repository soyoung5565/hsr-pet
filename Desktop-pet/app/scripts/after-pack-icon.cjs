/**
 * electron-builder 的 afterPack 钩子 —— 给打包出来的 exe 补图标和版本信息。
 *
 * ★ 为什么需要这个:
 *   electron-builder 的 `win.signAndEditExecutable` 被我们关掉了 ——
 *   那一步要解压 winCodeSign 工具包,而包里带 darwin 的 **符号链接**
 *   (darwin/10.12/lib/libcrypto.dylib)。Windows 上解压符号链接需要
 *   「创建符号链接」特权(开发者模式或管理员),普通用户会报:
 *     ERROR: Cannot create symbolic link : 客户端没有所需特权
 *   darwin 目录在 Windows 打包里根本用不上,但 7za 会因为这两个符号链接整体失败
 *   → 打包 100% 挂掉。
 *
 *   代价:exe 只有 Electron 默认图标,没有产品名/版本号。
 *   这个钩子用 electron-builder 自己缓存里的 rcedit 补回去 ——
 *   rcedit 是纯 exe,不涉及符号链接,普通用户能跑。
 *
 * ★ 为什么必须是 afterPack 而不是「打包完再手动跑」:
 *   NSIS 安装包是在 win-unpacked **之后**才生成的,它打包的是 win-unpacked 里的文件。
 *   手动补图标的话,得跑两轮(先 --dir 打包 → 补图标 → 再打包生成安装器),
 *   而第二轮会重新生成 win-unpacked,把图标又冲掉。
 *   afterPack 正好卡在这两步中间 —— 补完图标,安装器才去打包含 icon 的 exe。
 *
 *   手动跑法(补完已经生成好的 exe):
 *   powershell -ExecutionPolicy Bypass -File scripts/set-exe-icon.ps1
 *
 * ★ 必须是 .cjs:
 *   项目 package.json 里是 "type": "module",.js 后缀会被当 ES module,
 *   而 electron-builder 用 require() 加载这个钩子 → "require is not defined"。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** 在 electron-builder 缓存里找 rcedit-x64.exe(下载 winCodeSign 时会一起带下来)。 */
function findRcedit() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cacheRoot)) return null;

  // 扫所有子目录找 rcedit-x64.exe,取最新修改的那个
  const candidates = [];
  for (const entry of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, entry, 'rcedit-x64.exe');
    if (!fs.existsSync(candidate)) continue;
    try {
      candidates.push({ file: candidate, mtime: fs.statSync(candidate).mtimeMs });
    } catch {
      /* ignore */
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].file;
}

exports.default = async function afterPack(context) {
  const appOutDir = context?.appOutDir;
  if (!appOutDir) return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(appOutDir, exeName);
  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] 找不到 ${exePath},跳过图标设置`);
    return;
  }

  const rcedit = findRcedit();
  if (!rcedit) {
    // 不致命:图标只是锦上添花,打包产物仍然可用
    console.warn('[after-pack] 找不到 rcedit-x64.exe(electron-builder 缓存里没有),跳过图标设置');
    return;
  }

  // 图标:优先用 build/icon.ico,找不到就用 electron 自带的
  const buildDir = context.packager.info?.config?.directories?.buildResources;
  const iconPath = buildDir
    ? path.join(buildDir, 'icon.ico')
    : path.join(appOutDir, '..', '..', 'build', 'icon.ico');
  if (!fs.existsSync(iconPath)) {
    console.warn(`[after-pack] 找不到图标 ${iconPath},跳过图标设置`);
    return;
  }

  const info = context.packager.appInfo;
  const version = info.version || '0.0.0';
  const productName = info.productFilename || 'DesktopPet';

  const run = (args) => {
    const r = spawnSync(rcedit, [exePath, ...args], { stdio: 'pipe' });
    return r.status === 0;
  };

  const ok =
    run(['--set-icon', iconPath]) &&
    run(['--set-version-string', 'ProductName', productName]) &&
    run(['--set-version-string', 'FileDescription', info.description || productName]) &&
    run(['--set-file-version', version]) &&
    run(['--set-product-version', version]);

  if (ok) {
    console.log(`[after-pack] ✅ 图标和版本信息已写入 ${exePath}`);
  } else {
    console.warn(`[after-pack] ⚠ rcedit 执行失败(不影响打包产物)`);
  }
};
