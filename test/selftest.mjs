#!/usr/bin/env node
/**
 * dsh-time-inject · 纯函数自测
 *
 * 跑法：`node test/selftest.mjs`（或 `pnpm test` / `npm test`）
 *
 * ⚠️ 本测试**不依赖宿主**：只 import `lib/text.mjs`（无宿主 import）+ 用文本方式读 `lib/index.mjs`。
 *    所以 DSH 没在跑、profile 里没装这个包，也能跑。
 *
 * 两层：
 *   A~H  行为层：中文文案 / 星期 / 时长边界 / 时钟回退 / 偏移 / 非法输入
 *   I    静态层：`lib/index.mjs` 的源码文本断言（把 🩸 硬要求钉成回归网）
 *        —— 这一层**只能证明源码里有这些写法**，不能证明运行时行为；运行时待实机验证。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_TIME_ZONE,
  DURATION_JUST_NOW,
  DURATION_UNKNOWN,
  WEEKDAY_ZH,
  clampElapsed,
  formatClockLine,
  formatDuration,
  formatOffset,
  formatStamp,
  offsetMinutesOf,
  parseOffsetName,
  weekdayOf,
} from '../lib/text.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = join(HERE, '..', 'lib', 'index.mjs')

let passed = 0
const failures = []

/** 相等断言（用 Object.is，严格区分 null / undefined / 0 / -0）。 */
function is(label, actual, expected) {
  if (Object.is(actual, expected)) {
    passed += 1
    return
  }
  failures.push(`${label}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`)
}

/** 真值断言。 */
function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}${detail === '' ? '' : `\n    ${detail}`}`)
}

/** 「不抛错」断言：`fn` 必须正常返回。 */
function noThrow(label, fn) {
  try {
    const value = fn()
    passed += 1
    return value
  } catch (error) {
    failures.push(`${label}\n    不该抛错，但抛了: ${error?.message ?? String(error)}`)
    return undefined
  }
}

const T = Date.UTC(2026, 8, 25, 13, 34, 7) // 上海 2026-09-25 21:34:07（周五）
const LINE_RE = /^\[时钟\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2} 周[日一二三四五六] · 距(?:上条消息|上次读数) (?:刚刚|未知|\d+ (?:天|小时|分|秒)(?: \d+ (?:小时|分|秒))?)$/

// ───────────────────────────── A. 时间戳 / 跨天跨月跨年 ─────────────────────────────
is('A1 基本时间戳（含 UTC 偏移）', formatStamp(T), '2026-09-25 21:34:07 +08:00')
is('A2 跨天：UTC 16:00 = 上海次日 00:00', formatStamp(Date.UTC(2026, 8, 25, 16, 0, 0)), '2026-09-26 00:00:00 +08:00')
is('A3 午夜不渲染成 24 点', formatStamp(Date.UTC(2026, 8, 25, 16, 0, 0)).slice(11, 13), '00')
is('A4 跨月：9/30 16:00Z = 10/01', formatStamp(Date.UTC(2026, 8, 30, 16, 0, 0)), '2026-10-01 00:00:00 +08:00')
is('A5 跨年：12/31 16:00Z = 次年 01/01', formatStamp(Date.UTC(2026, 11, 31, 16, 0, 0)), '2027-01-01 00:00:00 +08:00')
is('A6 跨年（反向）：2025/12/31 16:00Z = 2026/01/01', formatStamp(Date.UTC(2025, 11, 31, 16, 0, 0)), '2026-01-01 00:00:00 +08:00')
is('A7 闰日：2028/02/28 16:00Z = 2028/02/29', formatStamp(Date.UTC(2028, 1, 28, 16, 0, 0)), '2028-02-29 00:00:00 +08:00')
is('A8 UTC 时区固定输出 +00:00', formatStamp(T, 'UTC'), '2026-09-25 13:34:07 +00:00')
is('A9 非半小时偏移（Asia/Kolkata = +05:30）', formatStamp(T, 'Asia/Kolkata'), '2026-09-25 19:04:07 +05:30')
is('A10 半时不存在的时区名 → 降级回默认时区，不抛错', formatStamp(T, 'Not/AZone'), '2026-09-25 21:34:07 +08:00')

// ───────────────────────────── B. 星期 ─────────────────────────────
is('B1 2026-09-25 = 周五', weekdayOf({ year: '2026', month: '09', day: '25' }), '周五')
is('B2 2026-09-26 = 周六', weekdayOf({ year: '2026', month: '09', day: '26' }), '周六')
is('B3 2026-09-27 = 周日', weekdayOf({ year: '2026', month: '09', day: '27' }), '周日')
is('B4 2026-09-28 = 周一', weekdayOf({ year: '2026', month: '09', day: '28' }), '周一')
is('B5 星期表长度 = 7 且首项为周日', WEEKDAY_ZH.length === 7 && WEEKDAY_ZH[0] === '周日', true)
is('B6 星期字段残缺时不抛错', weekdayOf({ year: 'x' }), '星期?')
is('B7 星期字段缺失时不抛错', noThrow('B7 weekdayOf(undefined)', () => weekdayOf(undefined)), '星期?')
is(
  'B8 跨天那一条的星期跟着日期走',
  formatClockLine({ now: Date.UTC(2026, 8, 25, 16, 0, 0) }).includes('2026-09-26 00:00:00 +08:00 周六'),
  true,
)

// ───────────────────────────── C. 时长格式化边界 ─────────────────────────────
is('C1 0 秒 → 刚刚', formatDuration(0), DURATION_JUST_NOW)
is('C2 1 毫秒 → 刚刚', formatDuration(1), DURATION_JUST_NOW)
is('C3 999 毫秒 → 刚刚（不足 1 秒不再凑整到 1 秒）', formatDuration(999), DURATION_JUST_NOW)
is('C4 1000 毫秒 → 1 秒', formatDuration(1000), '1 秒')
is('C5 59 秒', formatDuration(59000), '59 秒')
is('C6 59 秒 999 毫秒 → 59 秒（向下取整）', formatDuration(59999), '59 秒')
is('C7 60000 毫秒 → 1 分', formatDuration(60000), '1 分')
is('C8 59 分', formatDuration(59 * 60000), '59 分')
is('C9 59 分 59 秒（分钟位的上界）', formatDuration(59 * 60000 + 59000), '59 分 59 秒')
is('C10 60 分 → 1 小时', formatDuration(3600000), '1 小时')
is('C11 1 小时 3 分（样例）', formatDuration(3600000 + 3 * 60000), '1 小时 3 分')
is('C12 8 分 12 秒（样例）', formatDuration(8 * 60000 + 12000), '8 分 12 秒')
is('C13 23 小时 59 分 59 秒 → 只保留两个单位', formatDuration(86399000), '23 小时 59 分')
is('C14 24 小时 → 1 天', formatDuration(86400000), '1 天')
is('C15 1 天 2 小时 3 分 → 只保留两个单位', formatDuration(86400000 + 2 * 3600000 + 3 * 60000), '1 天 2 小时')
is('C16 400 天', formatDuration(400 * 86400000), '400 天')

// ───────────────────────────── D. 时钟回退 ⇒ 钳 0 ─────────────────────────────
is('D1 clampElapsed(-1) = 0', clampElapsed(-1), 0)
is('D2 clampElapsed(-99999) = 0', clampElapsed(-99999), 0)
is('D3 clampElapsed(0) = 0', clampElapsed(0), 0)
is('D4 clampElapsed(1500) = 1500', clampElapsed(1500), 1500)
is('D5 clampElapsed(NaN) = 0', clampElapsed(NaN), 0)
is('D6 formatDuration(-5000) → 刚刚', formatDuration(-5000), DURATION_JUST_NOW)
is(
  'D7 基线在未来（时钟回退）→ 刚刚',
  formatClockLine({ now: T, baselineTime: T + 60000 }),
  '[时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上条消息 刚刚',
)
is(
  'D8 基线等于当下 → 刚刚',
  formatClockLine({ now: T, baselineTime: T }),
  '[时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上条消息 刚刚',
)

// ───────────────────────────── E. 非法输入不抛错 ─────────────────────────────
for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'abc', {}, [], true]) {
  is(`E1 formatDuration(${String(bad)}) → 刚刚`, noThrow(`E1 formatDuration(${String(bad)})`, () => formatDuration(bad)), DURATION_JUST_NOW)
}
is('E2 formatStamp(NaN) 不抛错且仍是合法时间戳', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00$/.test(String(noThrow('E2 formatStamp(NaN)', () => formatStamp(NaN)))), true)
is('E3 formatStamp(undefined) 不抛错', typeof noThrow('E3 formatStamp(undefined)', () => formatStamp(undefined)), 'string')
is('E4 formatClockLine() 空参不抛错', typeof noThrow('E4 formatClockLine()', () => formatClockLine()), 'string')
is('E5 formatClockLine() 仍是合法单行', LINE_RE.test(String(noThrow('E5 formatClockLine()', () => formatClockLine()))), true)
is('E6 formatClockLine() 缺省时区 = Asia/Shanghai', String(noThrow('E6', () => formatClockLine())).includes('+08:00'), true)
is('E7 全是垃圾字段也不抛错', typeof noThrow('E7', () => formatClockLine({ now: NaN, timeZone: 123, baselineTime: 'x', baselineKind: 'zzz' })), 'string')
is(
  'E8 垃圾 baselineKind 回落到「距上条消息」',
  String(noThrow('E8', () => formatClockLine({ baselineKind: 'zzz', baselineTime: null }))).endsWith(`· 距上条消息 ${DURATION_UNKNOWN}`),
  true,
)
is('E9 formatOffset(NaN) = +00:00', formatOffset(NaN), '+00:00')
is('E10 parseOffsetName(非字符串) = null', parseOffsetName(123), null)
is('E11 offsetMinutesOf 非法时区不抛错', typeof noThrow('E11', () => offsetMinutesOf(T, 'Not/AZone')), 'number')

// ───────────────────────────── F. UTC 偏移 ─────────────────────────────
is('F1 parseOffsetName(GMT+08:00)', parseOffsetName('GMT+08:00'), '+08:00')
is('F2 parseOffsetName(GMT)', parseOffsetName('GMT'), '+00:00')
is('F3 parseOffsetName(UTC)', parseOffsetName('UTC'), '+00:00')
is('F4 parseOffsetName(GMT-05:00)', parseOffsetName('GMT-05:00'), '-05:00')
is('F5 parseOffsetName(不认识的时区名) = null', parseOffsetName('China Standard Time'), null)
is('F6 formatOffset(480)', formatOffset(480), '+08:00')
is('F7 formatOffset(-330)', formatOffset(-330), '-05:30')
is('F8 formatOffset(0)', formatOffset(0), '+00:00')
is('F9 offsetMinutesOf(Asia/Shanghai) = 480', offsetMinutesOf(T, 'Asia/Shanghai'), 480)
is('F10 offsetMinutesOf(UTC) = 0', offsetMinutesOf(T, 'UTC'), 0)
is('F11 offsetMinutesOf(Asia/Kolkata) = 330', offsetMinutesOf(T, 'Asia/Kolkata'), 330)

// ───────────────────────────── G. 整行文案（逐字对齐样例）─────────────────────────────
is(
  'G1 样例逐字对齐',
  formatClockLine({ now: T, timeZone: DEFAULT_TIME_ZONE, baselineTime: T - (8 * 60000 + 12000), baselineKind: 'message' }),
  '[时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上条消息 8 分 12 秒',
)
is(
  'G2 无基线 → 未知',
  formatClockLine({ now: T, baselineTime: null }),
  '[时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上条消息 未知',
)
is(
  'G3 基线退化到「上一次读数」时前缀跟着变',
  formatClockLine({ now: T, baselineTime: T - 63 * 60000, baselineKind: 'reading' }),
  '[时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上次读数 1 小时 3 分',
)
is(
  'G4 显式 Asia/Shanghai 与缺省等价',
  formatClockLine({ now: T, timeZone: 'Asia/Shanghai', baselineTime: T }),
  formatClockLine({ now: T, baselineTime: T }),
)
is('G5 整行匹配约束正则', LINE_RE.test(formatClockLine({ now: T, baselineTime: T - 13000 })), true)
is('G6 单行（不含换行符）', formatClockLine({ now: T, baselineTime: T - 13000 }).includes('\n'), false)
is('G7 自带 [时钟] 前缀', formatClockLine({ now: T }).startsWith('[时钟] '), true)
is(
  'G8 采样时刻可逆解析回原 epoch',
  Date.parse(`${formatClockLine({ now: T }).slice(5, 24).replace(' ', 'T')}+08:00`),
  T,
)

// ───────────────────────────── H. 静态层：入口源码断言 ─────────────────────────────
const source = readFileSync(INDEX_PATH, 'utf8')
// 注释里为了讲清「别写成什么」会引用坏写法（如 `return next()`），
// 所以所有「不许出现」的断言都在**剥掉注释**的代码文本上做，避免被注释误伤。
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 在源码里找 `source: { ... }` 的**顶层 key 集合**（用于断言 source 恰好 3 个 key）。 */
function sourceObjectKeys(text) {
  const start = text.indexOf('source: {')
  if (start === -1) return null
  const open = text.indexOf('{', start)
  let depth = 0
  let end = -1
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return null
  const body = text.slice(open + 1, end)
  const keys = []
  let level = 0
  let lineStart = 0
  for (let i = 0; i <= body.length; i += 1) {
    const char = body[i]
    if (i === body.length || char === '\n') {
      if (level === 0) {
        const matched = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(lineStart, i))
        if (matched !== null) keys.push(matched[1])
      }
      lineStart = i + 1
      continue
    }
    if (char === '{' || char === '[') level += 1
    else if (char === '}' || char === ']') level -= 1
  }
  return keys
}

ok('H1 插件名 = time-inject', code.includes("export const name = 'time-inject'"))
ok('H2 用自己的 source.kind（不是官方 time-context）', code.includes("export const SOURCE_KIND = 'time-inject'"))
ok('H3 代码里没有 kind: \'time-context\'', !code.includes("kind: 'time-context'"))
ok('H4 注册 agent/pre-step', code.includes("ctx.on('agent/pre-step'"))
ok('H5 waterfall 用 prepend: true', code.includes('{ prepend: true }'))
ok('H6 一律 await next()', code.includes('decision = await next()'))
ok('H7 没有裸 return next()', !/return\s+next\(\)/.test(code))
ok('H8 🩸 空轮保护：messages.length === 0 时原样返回', /decision\.messages\.length === 0\)\s*return decision/.test(code))
ok('H9 触发条件是 step === 1（不是每步）', code.includes('payload?.step !== 1'))
ok('H10 没有官方那套 refreshIntervalMs 节流', !code.includes('refreshIntervalMs'))
ok('H11 sessionProjections 用可选链兜 undefined', code.includes('state?.lastMessageTime') && code.includes('registry?.stateOf?.'))
ok('H12 apply 里再兜一次默认值', code.includes('resolveConfig') && code.includes('FALLBACK_CONFIG'))
ok('H13 handler 整体 try/catch 兜底放行', code.includes("ctx.logger?.warn?.('time-inject: 注入失败，已放行本步：%s'"))
ok('H14 装配期抛错不拖挂 DSH 启动', code.includes('装配失败，插件未生效'))
ok('H15 source.form === snapshot', code.includes("form: 'snapshot'"))
ok('H16 sections 的 name 与内容 text 同源', code.includes('sections: [{ name: SOURCE_KIND, text }]'))
const keys = sourceObjectKeys(code)
ok('H17 source 恰好 3 个 key（kind/form/sections）', keys !== null && keys.slice().sort().join(',') === 'form,kind,sections', `实际解析到: ${JSON.stringify(keys)}`)
ok('H18 投影 stateSchema 自带 parse（schemastery 没有 .parse）', code.includes('parse(value)') && code.includes('timeInjectStateSchema'))
ok('H19 折叠里排除了自己注入的消息', code.includes("event?.data?.source?.kind === SOURCE_KIND"))
ok('H20 时区默认走 DEFAULT_TIME_ZONE', code.includes('timeZone: z.string().default(DEFAULT_TIME_ZONE)'))

// ───────────────────────────── 汇总 ─────────────────────────────
const total = passed + failures.length
if (failures.length === 0) {
  console.log(`dsh-time-inject selftest: 全部通过 — ${passed}/${total}`)
  console.log('  行为层：中文文案 / 星期 / 时长边界 / 时钟回退钳 0 / UTC 偏移 / 非法输入')
  console.log('  静态层：lib/index.mjs 的 🩸 硬要求（空轮保护 / 自有 source.kind / await next / 可选链 …）')
  process.exitCode = 0
} else {
  console.log(`dsh-time-inject selftest: 失败 ${failures.length} 项 / 共 ${total} 项（通过 ${passed}）`)
  for (const [index, failure] of failures.entries()) console.log(`  ✗ ${index + 1}. ${failure}`)
  process.exitCode = 1
}
