#!/usr/bin/env node
/**
 * 读 DSH 会话日志（`session.v*.jsonl.zstd`，多帧 zstd）并统计事件分布。
 *
 * 用法：node tools/scan-session.mjs <session.v4.jsonl.zstd> [--max-frames N]
 *
 * 为什么这么做：官方多帧解码器**没有导出**（打包入口只导出两个东西），
 * 而 `zstdDecompressSync` 对多帧输入只解第一帧 ⇒ 这里按 zstd 帧魔数扫描起点、
 * 逐帧解压，假阳性/残帧解压失败即跳过。**只用于本地诊断，不参与插件运行时。**
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
if (file === undefined) {
  console.error('用法：node tools/scan-session.mjs <session.v4.jsonl.zstd> [--max-frames N]')
  process.exit(2)
}
const maxIdx = args.indexOf('--max-frames')
const MAX = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 5000

const buf = readFileSync(file)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const positions = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) positions.push(i)
}

let decoded = ''
let frames = 0
let failed = 0
for (const pos of positions.slice(0, MAX)) {
  try {
    decoded += zstdDecompressSync(buf.subarray(pos)).toString('utf8')
    frames++
  } catch {
    failed++
  }
}

const types = new Map()
for (const m of decoded.matchAll(/"type":"([^"]+)"/g)) types.set(m[1], (types.get(m[1]) ?? 0) + 1)

console.log(`文件：${file}`)
console.log(`大小：${(buf.length / 1048576).toFixed(2)} MiB`)
console.log(`疑似帧起点：${positions.length} → 成功解出 ${frames} 帧，解压失败跳过 ${failed} 次`)
console.log(`解出文本：${decoded.length} 字符`)
console.log('')
console.log('事件类型分布（前 25）：')
for (const [t, n] of [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${String(n).padStart(6)}  ${t}`)
}
console.log('')
const sourceKinds = new Map()
for (const m of decoded.matchAll(/"source":\{"kind":"([^"]+)"/g)) sourceKinds.set(m[1], (sourceKinds.get(m[1]) ?? 0) + 1)
console.log('注入来源分布（JSON 里的 source.kind，未被文档文本污染）：')
for (const [k, n] of [...sourceKinds.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`)
console.log('')
console.log('关键词命中（含文档/工具输出污染，仅参考）：')
for (const key of ['time-inject', 'time-context', '"type":"user/message"', 'request/header', 'turn/start', 'step/start', 'compaction']) {
  console.log(`  ${key.padEnd(28)} ${decoded.split(key).length - 1} 次`)
}
