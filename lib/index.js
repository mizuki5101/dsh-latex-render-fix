/**
 * dsh-latex-render-fix — 在窗口加载前端之前，确保 asar 里已打好 LaTeX 语法规范化补丁。
 *
 * 【为什么能自动重打】
 * 主进程顺序是 spawn host → await host.start()（等 ready）→ 才 createMainWindow /
 * navigateMain。所以插件在 apply 里打完补丁，下一次窗口加载读到的就是新代码。
 *
 * 【已知边界】cordis 并不 await 每个插件的 apply（runProfile 里 hostCtx.plugin()
 * 只注册不等），补丁往往晚于窗口加载 ⇒ 升级后第一次启动公式仍标红，第二次才生效。
 * dsh-unlag 的刷新按钮也救不了（它只重建 React 树，不重载主 bundle）。
 *
 * 【为什么必须 async】cordis 的插件加载并发推进，同步阻塞会冻住事件循环，其他插件
 * 等待的 service 永远注册不上，整个启动审计超时（实测 dsh 完全起不来）。异步失败
 * 则无害："Optional plugin failures do not suppress readiness"。
 *
 * 纯 JS 实现，无 python / 无外部依赖。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensurePatched } from './patch-asar.js'

export const name = 'dsh-latex-render-fix'

const LOG_DIR = process.env.DSH_LATEX_GUARD_HOME || path.join(os.homedir(), '.dsh', 'dsh-guard')
const LOG = path.join(LOG_DIR, 'plugin.log')

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG, line, 'utf8')
  } catch {
    /* 日志失败不影响主流程 */
  }
}

/** 候选 asar 路径，按可靠性排序。 */
function candidates() {
  const out = []
  if (process.env.DSH_ASAR) out.push(process.env.DSH_ASAR)

  // 1) 由当前可执行文件推导（最可靠：host 进程的 execPath 就是 dsh 的 exe）
  const exe = process.execPath
  if (typeof exe === 'string' && exe !== '') {
    out.push(path.join(path.dirname(exe), 'resources', 'app.asar'))
  }

  // 2) 从 argv 里扫（launcher 会把 .../resources/app.asar 放进参数）
  for (const a of process.argv) {
    if (typeof a !== 'string') continue
    const i = a.indexOf('app.asar')
    if (i >= 0) out.push(a.slice(0, i + 'app.asar'.length))
  }

  // 3) 常见安装位置兜底
  const local = process.env.LOCALAPPDATA
  if (local) out.push(path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
  const pf = process.env.ProgramFiles
  if (pf) out.push(path.join(pf, 'DeepSeek Harness', 'resources', 'app.asar'))

  return [...new Set(out)]
}

function resolveAsar() {
  for (const p of candidates()) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* 不存在，试下一个 */
    }
  }
  return undefined
}

export async function apply() {
  const t0 = Date.now()
  try {
    log('=== apply start')
    log(`  process.type=${String(process.type)} pid=${process.pid}`)
    const asar = resolveAsar()
    if (!asar) {
      log('  未找到 app.asar，跳过')
      return
    }
    log(`  asar=${asar}`)
    const r = await ensurePatched(asar, log)
    log(`  result=${r.status}${r.detail ? ` (${r.detail})` : ''}`)
  } catch (error) {
    log('  apply error: ' + (error?.stack ?? error?.message ?? String(error)).slice(0, 800))
  } finally {
    log(`=== apply done in ${Date.now() - t0}ms`)
  }
}

/* ---- 手动调用：node lib/index.js [--asar <path>] ---- */
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  const i = process.argv.indexOf('--asar')
  const asar = i >= 0 ? process.argv[i + 1] : resolveAsar()
  if (!asar) {
    console.log('未找到 app.asar；可用 --asar <path> 指定')
    process.exitCode = 1
  } else {
    const r = await ensurePatched(asar, log)
    console.log(`result=${r.status}${r.detail ? ` (${r.detail})` : ''}`)
    process.exitCode = r.status === 'failed' || r.status === 'no-permission' ? 1 : 0
  }
}
