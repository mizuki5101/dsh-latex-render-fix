/**
 * dsh LaTeX 兼容补丁 —— asar 补丁核心（纯 JS，零外部依赖）
 *
 * 这是 guard.py 的 1:1 移植。行为目标：对同一份输入，产出与 python 版**逐字节相同**
 * 的 asar。任何算法改动都必须先跑「备份原版 → 打补丁 → 与 python 产出比对 sha256」。
 *
 * 设计要点（踩过的坑，别改）：
 * - 状态就地判断：直接看 bundle 里有没有规范化代码，不依赖外部台账。
 *   这样手动打过补丁、或升级覆盖，都能被正确识别。
 * - 任何异常都不阻断 dsh 启动：打不上补丁最多公式标红，不能让人开不了 app。
 * - 锚点只用「属性名 + 逻辑结构」（this.lastText / this.lastRendered / f.current=null），
 *   不依赖 minified 变量名，能扛版本变化。
 * - 插点只有两处：pK.render 入口 + fK 调用处的实参。
 *   ⛔ 绝不能插 Vb（两个 parse 函数）—— hW.update 的 tailStart 基于原始文本偏移，
 *      parse 内部改长度会让节点 offset 落到另一个坐标系，流式渲染切错位置。
 * - 全部用异步 IO（fs.promises / 异步子进程）。⛔ 绝不能用同步阻塞：
 *   cordis 的插件加载并发推进，冻住事件循环会让别的插件等不到 service，
 *   整个启动审计超时（实测整台 dsh 起不来）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

/** asar integrity 的分块大小（electron-builder 固定 4 MiB）。 */
const BLOCK = 4194304
/** 保留的备份份数。 */
const KEEP_BACKUPS = 2
/** 已 patch 的行内特征。 */
const MARK = 'e=e.replace(/^'
/** 目标 bundle 的路径特征（找不到时回退全扫大 .js）。 */
const BUNDLE_HINT = '/dsh-web-frontend/dist/assets/'
/** 候选 bundle 的最小体积。 */
const MIN_BUNDLE_SIZE = 300000

/** 锚点 1：流式渲染器入口（pK.render） */
const RE_RENDER = /render\((\w+)\)\{if\(\1===this\.lastText\)return this\.lastRendered;/
/** 锚点 2：非流式调用处（Bp 组件里的 fK(t,...)，前面紧跟 f.current=null） */
const RE_FK = /\(f\.current=null,(\w+)\((\w+),/

/**
 * 规范化片段（插在参数自身上）。
 * 用 replace 的**回调**而不是替换串：替换串里 `$$` 会被当成转义的 `$`。
 * 只匹配行首 `$$`+`\begin{` 与行尾 `\end{env}$$`，句中 `$$` 不受影响。幂等。
 */
const NORM_BODY = String.raw`.replace(/^\$\$(?=\\begin\{)/gm,()=>"$$\n").replace(/\\end\{([a-z*]+)\}\$\$$/gm,(m,a)=>"\\end{"+a+"}\n$$")`

/** 与 python 版 norm_expr 一致：把参数自身就地规范化。 */
function normExpr(p) {
  return `${p}=${p}${NORM_BODY}`
}

const ALIGN = (n) => (n + 3) & ~3

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 与 python 的 integrity_of 一致。 */
function integrityOf(data) {
  const blocks = []
  for (let i = 0; i < data.length; i += BLOCK) {
    blocks.push(sha256(data.subarray(i, Math.min(i + BLOCK, data.length))))
  }
  return { algorithm: 'SHA256', hash: sha256(data), blockSize: BLOCK, blocks }
}

/** 依序精确读取，直到读满。 */
async function readExact(fh, length, position) {
  const buf = Buffer.allocUnsafe(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got)
    if (bytesRead === 0) throw new Error(`unexpected EOF (${got}/${length})`)
    got += bytesRead
  }
  return buf
}

/** 读 asar 头：16 字节 pickle 前缀 + JSON。dataStart = 8 + pickleSize。 */
async function readHeader(file) {
  const fh = await fsp.open(file, 'r')
  try {
    const b = await readExact(fh, 16, 0)
    const pickleSize = b.readUInt32LE(4)
    const jlen = b.readUInt32LE(12)
    const raw = await readExact(fh, jlen, 16)
    const rawText = raw.toString('utf8')
    return { header: JSON.parse(rawText), dataStart: 8 + pickleSize, rawText }
  } finally {
    await fh.close()
  }
}

/** 遍历所有带 offset 的文件节点：[相对路径, 节点]。 */
function iterFiles(node, prefix = '', out = []) {
  const files = node && node.files ? node.files : {}
  for (const [name, v] of Object.entries(files)) {
    const p = `${prefix}/${name}`
    if (v && v.files) iterFiles(v, p, out)
    else if (v && v.offset !== undefined) out.push([p, v])
  }
  return out
}

function findNode(header, relPath) {
  let node = header
  for (const part of relPath.split('/')) {
    if (!part) continue
    node = node.files[part]
    if (!node) throw new Error(`header 里找不到 ${relPath}`)
  }
  return node
}

function decode(buf) {
  return buf.toString('utf8')
}

/** 定位含 markdown 渲染器的 bundle。 */
async function locateBundle(file, header, dataStart, log) {
  const nodes = iterFiles(header)
  let cands = nodes.filter(
    ([p, v]) => p.includes(BUNDLE_HINT) && p.endsWith('.js') && Number(v.size) > MIN_BUNDLE_SIZE,
  )
  if (cands.length === 0) {
    log(`  按布局未找到候选，回退全扫 .js > ${MIN_BUNDLE_SIZE}`)
    cands = nodes.filter(([p, v]) => p.endsWith('.js') && Number(v.size) > MIN_BUNDLE_SIZE)
  }
  const fh = await fsp.open(file, 'r')
  try {
    for (const [p, v] of cands) {
      const off = dataStart + Number(v.offset)
      const size = Number(v.size)
      const data = await readExact(fh, size, off)
      if (data.includes('this.lastRendered') && data.includes('mathFlow')) {
        return { relPath: p, node: v, data }
      }
    }
  } finally {
    await fh.close()
  }
  return null
}

/** 两处插入。返回 { content, hits, detail }；命中不足 2 处时 hits !== 2。 */
export function applyPatch(content) {
  const detail = []
  let hits = 0
  let out = content

  const m1 = RE_RENDER.exec(out)
  if (!m1) return { content: out, hits: 0, detail: ['render 锚点未命中'] }
  const p = m1[1]
  if (!/^[A-Za-z_$][\w$]*$/.test(p)) return { content: out, hits: 0, detail: ['render 参数名非常规标识符'] }
  const newRender = `render(${p}){${normExpr(p)};if(${p}===this.lastText)return this.lastRendered;`
  out = out.slice(0, m1.index) + newRender + out.slice(m1.index + m1[0].length)
  hits += 1
  detail.push(`render 入口已插入（参数名 ${p}）`)

  const m2 = RE_FK.exec(out)
  if (!m2) return { content: out, hits: 0, detail: [...detail, 'fK 调用锚点未命中'] }
  const [, fn, arg] = m2
  for (const id of [fn, arg]) {
    if (!/^[A-Za-z_$][\w$]*$/.test(id)) {
      return { content: out, hits: 0, detail: [...detail, 'fK 锚点标识符非常规'] }
    }
  }
  const newFk = `(f.current=null,${fn}(${normExpr(arg)},`
  out = out.slice(0, m2.index) + newFk + out.slice(m2.index + m2[0].length)
  hits += 1
  detail.push(`fK 非流式入口已插入（${fn}/${arg}）`)

  return { content: out, hits, detail }
}

/** 把 JSON 头序列化成与原始文件同一风格（紧凑、非 ASCII 原样）。 */
function ser(h) {
  return Buffer.from(JSON.stringify(h), 'utf8')
}

/** 深拷贝（等价于 python 的 json round-trip）。 */
function cloneJson(v) {
  return JSON.parse(JSON.stringify(v))
}

/**
 * 重排生成新 asar：目标文件换成 newBytes，其余原样平移。
 * offset 位数跨 10^n 会让 header 变长，需迭代求 shift。
 */
async function buildPatched(src, dst, relPath, newBytes, log) {
  const { header, dataStart } = await readHeader(src)
  const total = (await fsp.stat(src)).size
  const dataLen = total - dataStart

  const node = findNode(header, relPath)
  const tOff = Number(node.offset)
  const tSize = Number(node.size)
  const delta = newBytes.length - tSize

  node.size = newBytes.length
  node.integrity = integrityOf(newBytes)

  let moved = 0
  for (const [, v] of iterFiles(header)) {
    const o = Number(v.offset)
    if (o > tOff) {
      v.offset = String(o + delta)
      moved += 1
    }
  }

  const buildShifted = (shift) => {
    const h = cloneJson(header)
    if (shift) {
      for (const [, v] of iterFiles(h)) v.offset = String(Number(v.offset) + shift)
    }
    return h
  }

  let shift = 0
  let converged = false
  for (let i = 0; i < 20; i += 1) {
    const L = ser(buildShifted(shift)).length
    const ns = 16 + ALIGN(L) - dataStart
    if (ns === shift) {
      converged = true
      break
    }
    shift = ns
  }
  if (!converged) throw new Error('shift 未收敛')

  const finalHeader = buildShifted(shift)
  const jb = ser(finalHeader)
  if (16 + ALIGN(jb.length) !== dataStart + shift) throw new Error('header 长度自检失败')

  const pad = ALIGN(jb.length) - jb.length
  const payload = 4 + ALIGN(jb.length)
  const pickle = 4 + payload
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(pickle, 4)
  prefix.writeUInt32LE(payload, 8)
  prefix.writeUInt32LE(jb.length, 12)

  const srcFh = await fsp.open(src, 'r')
  const outFh = await fsp.open(dst, 'w')
  try {
    let pos = 0
    const put = async (buf) => {
      let written = 0
      while (written < buf.length) {
        const { bytesWritten } = await outFh.write(buf, written, buf.length - written, pos + written)
        written += bytesWritten
      }
      pos += buf.length
    }
    const copyRange = async (start, length) => {
      const CHUNK = 8 << 20
      let done = 0
      while (done < length) {
        const n = Math.min(CHUNK, length - done)
        const buf = await readExact(srcFh, n, start + done)
        await put(buf)
        done += n
      }
    }

    await put(prefix)
    await put(jb)
    if (pad > 0) await put(Buffer.alloc(pad))
    await copyRange(dataStart, tOff)
    await put(newBytes)
    await copyRange(dataStart + tOff + tSize, dataLen - tOff - tSize)
  } finally {
    await srcFh.close()
    await outFh.close()
  }

  const expect = 16 + ALIGN(jb.length) + dataLen + delta
  const actual = (await fsp.stat(dst)).size
  if (actual !== expect) throw new Error(`新 asar 大小不符：${actual} != ${expect}`)

  log(`重排完成：delta=${delta >= 0 ? '+' : ''}${delta} shift=${shift >= 0 ? '+' : ''}${shift} 平移节点=${moved}`)
  return { delta, shift, moved }
}

/** 用当前 exe 做一次 ESM 语法检查（异步；跑不起来就跳过，不阻断）。 */
function syntaxCheck(file, log) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), 20000)
    execFile(
      process.execPath,
      ['--check', file],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000, windowsHide: true },
      (error, _stdout, stderr) => {
        clearTimeout(timer)
        if (!error) return resolve(true)
        // 解释器本身跑不起来（ENOENT/EACCES）视为"无法检查"，与 python 版一致
        if (error.code === 'ENOENT' || error.code === 'EACCES') {
          log('  无法启动语法检查，跳过')
          return resolve(true)
        }
        log(`  语法检查失败：${String(stderr || error.message).slice(0, 600)}`)
        return resolve(false)
      },
    )
  })
}

async function pruneBackups(asarPath, log) {
  const dir = path.dirname(asarPath)
  let names
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const baks = names
    .filter((n) => n.startsWith('app.asar.bak-'))
    .map((n) => path.join(dir, n))
  const stat = await Promise.all(
    baks.map(async (p) => ({ p, t: (await fsp.stat(p).catch(() => ({ mtimeMs: 0 }))).mtimeMs })),
  )
  stat.sort((a, b) => b.t - a.t)
  for (const { p } of stat.slice(KEEP_BACKUPS)) {
    try {
      await fsp.unlink(p)
      log(`  清理旧备份 ${path.basename(p)}`)
    } catch (e) {
      log(`  清理备份失败 ${path.basename(p)}: ${e.message}`)
    }
  }
}

function isPermissionError(e) {
  return e && (e.code === 'EPERM' || e.code === 'EACCES' || /EACCES|EPERM|permission/i.test(String(e.message)))
}

/** 本地时间戳，与 python 版 %Y%m%d-%H%M%S 同格式。 */
function localStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 确保 asar 已打补丁。永不抛异常 —— 返回值说明结果。
 * @returns {Promise<{status: string, detail?: string}>}
 * status: already | patched | no-bundle | anchor-miss | no-permission | failed | no-asar
 */
export async function ensurePatched(asarPath, log = () => {}) {
  const t0 = Date.now()
  let tmp = null
  try {
    if (!fs.existsSync(asarPath)) {
      log(`找不到 ${asarPath}`)
      return { status: 'no-asar' }
    }

    const { header, dataStart, rawText } = await readHeader(asarPath)
    const found = await locateBundle(asarPath, header, dataStart, log)
    if (!found) {
      log('未定位到 markdown 渲染 bundle（结构可能已变），跳过')
      return { status: 'no-bundle' }
    }
    const { relPath, node, data } = found
    const sizeBefore = Number(node.size)
    log(`目标 bundle: ${relPath}  size=${sizeBefore}`)

    // 序列化一致性自检：能原样 round-trip 才说明我们的 JSON.stringify 与原文同风格
    try {
      if (JSON.stringify(JSON.parse(rawText)) !== rawText) log('  提示：header 序列化风格与原文不完全一致（不影响功能）')
    } catch {
      /* 自检失败不影响主流程 */
    }

    const text = decode(data)
    if (text.includes(MARK) && text.includes('this.lastText)return this.lastRendered;')) {
      log('已是补丁版本，无需处理')
      return { status: 'already' }
    }

    const { content, hits, detail } = applyPatch(text)
    for (const d of detail) log(`  ${d}`)
    if (hits !== 2) {
      log(`锚点命中 ${hits}/2，结构可能已变 —— 跳过（不阻断启动）`)
      return { status: 'anchor-miss', detail: detail.join('; ') }
    }

    const newBytes = Buffer.from(content, 'utf8')
    tmp = `${asarPath}.guard-new`
    await buildPatched(asarPath, tmp, relPath, newBytes, log)

    // 回读自检：新 asar 里目标文件的字节必须与 newBytes 完全一致
    const h2 = await readHeader(tmp)
    const n2 = findNode(h2.header, relPath)
    const fh2 = await fsp.open(tmp, 'r')
    let extracted
    try {
      extracted = await readExact(fh2, Number(n2.size), h2.dataStart + Number(n2.offset))
    } finally {
      await fh2.close()
    }
    if (!extracted.equals(newBytes)) throw new Error('回读校验失败：目标文件字节不一致')

    const probe = path.join(path.dirname(asarPath), '.guard-probe.mjs')
    await fsp.writeFile(probe, extracted)
    let ok
    try {
      ok = await syntaxCheck(probe, log)
    } finally {
      await fsp.unlink(probe).catch(() => {})
    }
    if (!ok) {
      log('语法检查未通过，放弃写入')
      return { status: 'failed', detail: 'syntax-check' }
    }

    // 备份（内容与原件一致才开始覆盖）
    const bak = path.join(path.dirname(asarPath), `app.asar.bak-${localStamp()}`)
    await fsp.copyFile(asarPath, bak)
    const [szBak, szOrig] = [(await fsp.stat(bak)).size, (await fsp.stat(asarPath)).size]
    if (szBak !== szOrig) {
      log('备份大小不符，放弃')
      return { status: 'failed', detail: 'backup-size' }
    }

    // 就地覆盖（运行中的 asar 无法原子替换：Electron 持有句柄，os.replace 会 WinError 5）
    const newSize = (await fsp.stat(tmp)).size
    const dfh = await fsp.open(asarPath, 'r+')
    const sfh = await fsp.open(tmp, 'r')
    try {
      const CHUNK = 8 << 20
      let pos = 0
      for (;;) {
        const buf = Buffer.allocUnsafe(CHUNK)
        const { bytesRead } = await sfh.read(buf, 0, CHUNK, pos)
        if (bytesRead === 0) break
        let written = 0
        while (written < bytesRead) {
          const { bytesWritten } = await dfh.write(buf, written, bytesRead - written, pos + written)
          written += bytesWritten
        }
        pos += bytesRead
      }
      await dfh.truncate(newSize)
      await dfh.sync()
    } finally {
      await dfh.close()
      await sfh.close()
    }

    if ((await fsp.stat(asarPath)).size !== newSize) {
      log('写入后大小不符，正在还原')
      await fsp.copyFile(bak, asarPath)
      return { status: 'failed', detail: 'post-write-size' }
    }

    log(`补丁已应用（备份 ${path.basename(bak)}，耗时 ${Date.now() - t0}ms）`)
    await pruneBackups(asarPath, log)
    return { status: 'patched', detail: `delta=+${newBytes.length - sizeBefore}` }
  } catch (e) {
    if (isPermissionError(e)) {
      log(`没有写入权限：${e.message}`)
      log('  → dsh 若装在 C:\\Program Files 等受保护目录，请以管理员身份启动一次；或改装到用户目录')
      return { status: 'no-permission', detail: e.message }
    }
    log(`补丁过程异常：${(e && e.stack ? e.stack : String(e)).slice(0, 800)}`)
    return { status: 'failed', detail: e && e.message ? e.message : String(e) }
  } finally {
    if (tmp) await fsp.unlink(tmp).catch(() => {})
  }
}
