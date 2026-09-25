#!/usr/bin/env node
/**
 * dsh-time-inject · 安装器（默认干跑；幂等；只增不删）
 *
 * 用法：
 *   node tools/install.mjs            # 干跑：打印将要做什么 + 现状检查（不改任何东西）
 *   node tools/install.mjs --apply    # 真正执行（先备份 cordis.patch.yml）
 *
 * 它做四件事（全部可回滚，见 tools/uninstall.mjs）：
 *   ① 备份 profile 的 cordis.patch.yml
 *   ② 把插件源码铺到 profiles\web\vendor\dsh-time-inject-src\
 *   ③ 在 profiles\web\node_modules\ 建 Junction → 上述 vendor 目录（等价 pnpm 的 link:，但不触发 install）
 *   ④ 在 profile 的 cordis.patch.yml 末尾追加一行 insert
 *
 * 🩸 绝不跑 `pnpm install`：它会重新解包 `file:vendor/*.tgz` 型依赖，可能覆盖你在本地的改动。
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 插件源 = 本脚本所在目录的上一级（不写死盘符，便于移植）。 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = homedir()
const PROFILE = join(HOME, '.dsh', 'profiles', 'web')
const VENDOR = join(PROFILE, 'vendor', 'dsh-time-inject-src')
const JUNCTION = join(PROFILE, 'node_modules', 'dsh-time-inject')
const PATCH = join(PROFILE, 'cordis.patch.yml')
/** 备份根目录（默认 `~/.dsh-plugin-backups`，可用 `--backups <dir>` 覆盖）。 */
const backupArg = process.argv.indexOf('--backups')
const BACKUPS_ROOT = backupArg >= 0 ? resolve(process.argv[backupArg + 1]) : join(HOME, '.dsh-plugin-backups')
const PLUGIN_ID = 'time-inject'

const APPLY = process.argv.includes('--apply')
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const BACKUP_DIR = join(BACKUPS_ROOT, `dsh-time-inject-install-${STAMP}`)

const say = (msg) => console.log(msg)
const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exit(1) }

// ── 安全约束：覆盖 / 删除类操作前，先就地断言目标 ────────────────────────
function assertUnder(child, parent, label) {
  const c = resolve(child)
  const p = resolve(parent)
  if (child.includes('..')) fail(`${label} 路径含 ..（拒绝）：${child}`)
  if (!c.toLowerCase().startsWith(p.toLowerCase() + '\\')) fail(`${label} 不在预期根之下（拒绝）：${child}`)
  if (c.toLowerCase() === p.toLowerCase()) fail(`${label} 等于根自身（拒绝）：${child}`)
}
assertUnder(VENDOR, PROFILE, 'VENDOR')
assertUnder(JUNCTION, join(PROFILE, 'node_modules'), 'JUNCTION')
assertUnder(BACKUP_DIR, BACKUPS_ROOT, 'BACKUP_DIR')

/** Junction 的 readlink 可能带 \\?\ 前缀 ⇒ 规范化后比较。 */
function linkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return resolve(readlinkSync(path).replace(/^\\\\\?\\/, ''))
  } catch {
    return null
  }
}

const PATCH_BLOCK = `
# ── dsh-time-inject（中文时间注入）· 由 tools/install.mjs 于 ${STAMP} 追加 ──
# 每个 turn 的第一个 step 往上下文追加一条中文时间读数。回滚见 tools/uninstall.mjs。
- insert:
    - id: ${PLUGIN_ID}
      name: 'dsh-time-inject'
`

// ── 预检 ────────────────────────────────────────────────────────────────
say('== dsh-time-inject 安装器 ==')
say(`模式：${APPLY ? 'APPLY（真改）' : 'DRY-RUN（只打印）'}`)
say(`插件源：${SRC}`)
say(`目标 profile：${PROFILE}`)
say('')

if (!existsSync(join(SRC, 'package.json'))) fail(`插件源不完整：${SRC}\\package.json 不存在`)
if (!existsSync(join(SRC, 'lib', 'index.mjs'))) fail(`插件源不完整：${SRC}\\lib\\index.mjs 不存在`)
if (!existsSync(join(SRC, 'cordis.patch.yml'))) fail(`插件源不完整：${SRC}\\cordis.patch.yml 不存在`)
if (!existsSync(PROFILE)) fail(`profile 不存在：${PROFILE}`)
if (!existsSync(PATCH)) fail(`profile patch 不存在：${PATCH}`)

const patchText = readFileSync(PATCH, 'utf8')
const patchHasRow = patchText.includes(`id: ${PLUGIN_ID}`)
const vendorExists = existsSync(VENDOR)
const junctionNow = existsSync(JUNCTION) ? linkTarget(JUNCTION) : null
const junctionOk = junctionNow !== null && junctionNow.toLowerCase() === resolve(VENDOR).toLowerCase()

say('现状：')
say(`  · vendor 目录      ：${vendorExists ? '已存在（将覆盖源码）' : '不存在（将新建）'}`)
say(`  · node_modules 链接：${existsSync(JUNCTION) ? (junctionNow === null ? `已存在但不是 Junction（会拒绝执行）` : `Junction → ${junctionNow}`) : '不存在（将新建）'}`)
say(`  · patch 里的 ${PLUGIN_ID} 行：${patchHasRow ? '已存在（将跳过）' : '不存在（将追加）'}`)
say(`  · 备份目录         ：${BACKUP_DIR}`)
say('')

if (existsSync(JUNCTION) && junctionNow !== null && !junctionOk) {
  fail(`已存在指向别处的链接：${JUNCTION} → ${junctionNow}（拒绝覆盖；请人工确认后先处理）`)
}
if (existsSync(JUNCTION) && junctionNow === null) {
  fail(`${JUNCTION} 已存在且不是 Junction（拒绝覆盖）`)
}

say('将要执行：')
say(`  ① 复制 ${PATCH} → ${join(BACKUP_DIR, 'cordis.patch.yml')}`)
say(`  ② 复制 ${SRC}\\{package.json,lib,test,cordis.patch.yml,README.md} → ${VENDOR}`)
say(`  ③ 建 Junction ${JUNCTION} → ${VENDOR}`)
say(`  ④ ${patchHasRow ? '（跳过）patch 已含该行' : `追加一行 insert 到 ${PATCH}`}`)
say('')
say('不会做：跑 pnpm install / 改动其它插件 / 删任何既有文件。')

if (!APPLY) {
  say('')
  say('这是干跑。确认无误后执行：node tools/install.mjs --apply')
  process.exit(0)
}

// ── 执行 ────────────────────────────────────────────────────────────────
say('')
say('[1/4] 备份 profile patch …')
mkdirSync(BACKUP_DIR, { recursive: true })
cpSync(PATCH, join(BACKUP_DIR, 'cordis.patch.yml'))
say(`      → ${join(BACKUP_DIR, 'cordis.patch.yml')}`)

say('[2/4] 铺插件源码 …')
const EXCLUDE = new Set(['.git', 'notes', 'out', 'tools', 'node_modules'])
mkdirSync(VENDOR, { recursive: true })
cpSync(SRC, VENDOR, { recursive: true, filter: (s) => !EXCLUDE.has(basename(s)) })
say(`      → ${VENDOR}`)

say('[3/4] 建 Junction …')
if (junctionOk) {
  say('      已存在且指向正确，跳过')
} else {
  const { symlinkSync } = await import('node:fs')
  symlinkSync(VENDOR, JUNCTION, 'junction')
  say(`      → ${JUNCTION}`)
}

say('[4/4] 追加 profile patch …')
if (patchHasRow) {
  say('      patch 已含该行，跳过')
} else {
  writeFileSync(PATCH, patchText.replace(/\n*$/, '\n') + PATCH_BLOCK, 'utf8')
  say(`      → ${PATCH}`)
}

say('')
say('完成。接下来（需要你手动）：')
say('  1) 重启 dsh web（重启会掐断正在进行的会话）')
say('  2) 验证：新会话发一句话，看会话日志里是否出现 source.kind === "time-inject"')
say('  3) 回归：宿主 stderr 应为 0 B；其它自研插件的自测应仍全绿')
say(`  4) 回滚：node tools/uninstall.mjs --apply --backup "${BACKUP_DIR}"`)
