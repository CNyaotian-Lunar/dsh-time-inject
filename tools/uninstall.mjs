#!/usr/bin/env node
/**
 * dsh-time-inject · 卸载 / 回滚器（默认干跑）
 *
 * 用法：
 *   node tools/uninstall.mjs                                  # 干跑
 *   node tools/uninstall.mjs --apply                          # 删 Junction（源码与备份都保留）
 *   node tools/uninstall.mjs --apply --backup <备份目录>       # 额外从备份还原 cordis.patch.yml
 *
 * 安全约束：
 *   · 只删 **Junction**，且必须确认它指向 profiles\web\vendor\dsh-time-inject-src
 *   · 不删 vendor 源码目录、不删备份
 *   · 还原 patch 前先把当前 patch 另存一份到同一备份目录（.before-restore）
 */
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const HOME = homedir()
const PROFILE = join(HOME, '.dsh', 'profiles', 'web')
const VENDOR = join(PROFILE, 'vendor', 'dsh-time-inject-src')
const JUNCTION = join(PROFILE, 'node_modules', 'dsh-time-inject')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const PLUGIN_ID = 'time-inject'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const backupIdx = argv.indexOf('--backup')
const BACKUP_DIR = backupIdx >= 0 ? argv[backupIdx + 1] : null

const say = (msg) => console.log(msg)
const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exit(1) }

function assertUnder(child, parent, label) {
  const c = resolve(child)
  const p = resolve(parent)
  if (child.includes('..')) fail(`${label} 路径含 ..（拒绝）：${child}`)
  if (!c.toLowerCase().startsWith(p.toLowerCase() + '\\')) fail(`${label} 不在预期根之下（拒绝）：${child}`)
}
assertUnder(JUNCTION, join(PROFILE, 'node_modules'), 'JUNCTION')

function linkTarget(path) {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return resolve(readlinkSync(path).replace(/^\\\\\?\\/, ''))
  } catch {
    return null
  }
}

say('== dsh-time-inject 回滚器 ==')
say(`模式：${APPLY ? 'APPLY（真改）' : 'DRY-RUN（只打印）'}`)
say('')

const junctionExists = existsSync(JUNCTION)
const target = junctionExists ? linkTarget(JUNCTION) : null
const isOurs = target !== null && target.toLowerCase() === resolve(VENDOR).toLowerCase()

say('现状：')
say(`  · ${JUNCTION}：${junctionExists ? (target === null ? '存在但不是 Junction（不会删）' : `Junction → ${target}`) : '不存在'}`)
say(`  · vendor 源码 ${VENDOR}：${existsSync(VENDOR) ? '保留（不动）' : '不存在'}`)
if (BACKUP_DIR) {
  const bak = join(BACKUP_DIR, 'cordis.patch.yml')
  say(`  · 待还原 patch：${bak} ${existsSync(bak) ? '(存在)' : '(缺失！)'}`)
} else {
  say('  · patch：未指定 --backup ⇒ 只删 Junction，patch 里的 insert 行保留（如需一并回滚请加 --backup）')
}
say('')

if (!APPLY) {
  say('将要执行：')
  if (junctionExists && isOurs) say(`  ① 删除 Junction：${JUNCTION}（源码目录不受影响）`)
  else if (junctionExists) say('  ① 跳过删除：它不是我们装的 Junction')
  else say('  ① 跳过删除：Junction 不存在')
  if (BACKUP_DIR) say(`  ② 还原 ${PATCH}（先把当前文件另存为 .before-restore）`)
  say('')
  say('这是干跑。确认无误后加 --apply。')
  process.exit(0)
}

// ── 执行 ────────────────────────────────────────────────────────────────
if (junctionExists && isOurs) {
  rmSync(JUNCTION, { recursive: true, force: true })
  say(`[1/2] 已删 Junction：${JUNCTION}`)
} else if (junctionExists) {
  say('[1/2] 跳过：不是我们装的 Junction（拒绝删）')
} else {
  say('[1/2] 跳过：Junction 不存在')
}

if (BACKUP_DIR) {
  const bak = join(BACKUP_DIR, 'cordis.patch.yml')
  if (!existsSync(bak)) fail(`备份里没有 cordis.patch.yml：${bak}`)
  if (existsSync(PATCH)) copyFileSync(PATCH, join(BACKUP_DIR, 'cordis.patch.yml.before-restore'))
  copyFileSync(bak, PATCH)
  if (readFileSync(PATCH, 'utf8').includes(`id: ${PLUGIN_ID}`) && !readFileSync(bak, 'utf8').includes(`id: ${PLUGIN_ID}`)) {
    fail('还原后 patch 里仍有该行（备份本身可能已含），请人工检查')
  }
  say(`[2/2] 已还原 ${PATCH}（原文件另存 .before-restore）`)
} else {
  say('[2/2] 跳过 patch 还原（未指定 --backup）')
}

say('')
say('完成。重启 dsh web 使改动生效。')
say('若要连 patch 一起回滚：node tools/uninstall.mjs --apply --backup <备份目录>')
