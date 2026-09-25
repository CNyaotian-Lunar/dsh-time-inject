/**
 * dsh-time-inject · 中文文案纯函数层
 *
 * ⚠️ 这一层**故意不 import 任何宿主依赖**（不 import cordis / dsh-llm / schemastery），
 *    因此可以用 `node test/selftest.mjs` 直接跑，不需要 DSH 在跑。
 *
 * 文案契约（「单行紧凑」版）：
 *
 *   [时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上条消息 8 分 12 秒
 *
 * 三个字段：① 时间戳（含 UTC 偏移）② 中文星期（**必须有**）③ 距上一条消息的时长。
 */

/** 固定显示时区。不做官方那套 `user-rpc.clientTimeZone` 三态派生。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** 中文星期。索引 = 某个民用日期的 UTC 星期序号（0 = 周日）——见 {@link weekdayOf}。 */
export const WEEKDAY_ZH = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六'])

/** 「几乎没有经过时间」的文案（含时钟回退钳 0 的情形）。 */
export const DURATION_JUST_NOW = '刚刚'

/** 拿不到任何基线时的文案。 */
export const DURATION_UNKNOWN = '未知'

/** 基线种类 → 文案前缀。 */
const BASELINE_LABELS = Object.freeze({
  /** 上一条**模型可见**消息（user / assistant / tool result）。 */
  message: '距上条消息',
  /** 兜底：本插件上一次注入的时间读数。 */
  reading: '距上次读数',
})

/** 行首标记。 */
export const CLOCK_PREFIX = '[时钟]'

/** 时长最多保留几个单位（`8 分 12 秒` = 2 个，`1 小时 3 分` = 2 个）。 */
const MAX_DURATION_UNITS = 2

/** 里程碑单位的毫秒数（由大到小）。 */
const DURATION_UNITS = Object.freeze([
  ['天', 86400000],
  ['小时', 3600000],
  ['分', 60000],
  ['秒', 1000],
])

/** Intl.DateTimeFormat 实例缓存（按 zone 去重；格式化器构造很贵）。 */
const FORMATTERS = new Map()

/** 补齐两位。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 任意输入 → 有限数字，否则退回当前时刻（保证纯函数永不因 NaN 抛错）。 */
function finiteOrNow(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

/** 任意输入 → 非空时区名，否则退回 {@link DEFAULT_TIME_ZONE}。 */
function safeZone(timeZone) {
  return typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : DEFAULT_TIME_ZONE
}

/**
 * 取（并缓存）一个**字段全显式**的格式化器。
 *
 * 为什么用 `en-US` 而不是 `zh-CN`：星期由 {@link weekdayOf} 自己算（见那里的注释），
 * 于是文案里的中文与 ICU 语言数据无关；剩下的只有数字字段，`en-US` 在任何 ICU 下都稳定。
 * `hourCycle: 'h23'` 是必须的——`hour12: false` 在部分 ICU 下会把午夜渲染成 `24`。
 */
function formatterFor(zone) {
  let formatter = FORMATTERS.get(zone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    })
    FORMATTERS.set(zone, formatter)
  }
  return formatter
}

/** `formatToParts` → 普通对象（丢掉 literal）。 */
function collect(parts) {
  const out = {}
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = part.value
  }
  return out
}

/**
 * 在 `zone` 里渲染 `now`，拆成字段。
 *
 * 时区名非法（如 `'Not/AZone'`）时 `Intl` 会抛 `RangeError` ⇒ **降级到固定时区**，
 * 绝不把异常抛给宿主（这是本层唯一有副作用的兜底）。
 *
 * @param {number} now - epoch 毫秒（调用方已过 {@link finiteOrNow}）。
 * @param {string} timeZone - 时区名。
 * @returns {{parts: Record<string, string>, zone: string, zoneFallback: boolean}}
 */
function stampParts(now, timeZone) {
  const requested = safeZone(timeZone)
  try {
    return { parts: collect(formatterFor(requested).formatToParts(new Date(now))), zone: requested, zoneFallback: false }
  } catch {
    return {
      parts: collect(formatterFor(DEFAULT_TIME_ZONE).formatToParts(new Date(now))),
      zone: DEFAULT_TIME_ZONE,
      zoneFallback: true,
    }
  }
}

/**
 * 星期（中文）。**自己算，不靠 ICU 的 `weekday` 字段**：
 * 拿格式化后的民用日期（年月日）重新在 UTC 里建一个日期，取它的星期序号——
 * 民用日期与星期一一对应，所以这等价于目标时区里那一天的星期，且与 locale 无关。
 *
 * @param {Record<string, string>} parts - {@link stampParts} 的 `parts`。
 * @returns {string} 形如 `周五`；字段缺失时返回 `星期?`（理论上不可达）。
 */
export function weekdayOf(parts) {
  const year = Number(parts?.year)
  const month = Number(parts?.month)
  const day = Number(parts?.day)
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return '星期?'
  return WEEKDAY_ZH[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '星期?'
}

/**
 * 由 `longOffset` 的时区名解析 UTC 偏移文本。
 *
 * @param {string} name - 如 `GMT+08:00` / `GMT+00:00` / `GMT`。
 * @returns {string|null} 如 `+08:00`；无法识别时返回 `null`（调用方改用数值推导）。
 */
export function parseOffsetName(name) {
  if (typeof name !== 'string' || name === '') return null
  if (name === 'GMT' || name === 'UTC') return '+00:00'
  const matched = /^(?:GMT|UTC)([+-])(\d{1,2}):?(\d{2})?$/.exec(name)
  if (matched === null) return null
  return `${matched[1]}${pad2(Number(matched[2]))}:${matched[3] ?? '00'}`
}

/**
 * 数值推导某时区在某时刻的 UTC 偏移（分钟）。
 *
 * 作为 {@link parseOffsetName} 的兜底通道：把该时区的墙钟字段当成 UTC 重建，
 * 与真实时刻相减即得偏移。秒级以下先对齐（`formatToParts` 只到秒）。
 *
 * @param {number} now - epoch 毫秒。
 * @param {string} timeZone - 时区名。
 * @returns {number} 偏移分钟数（如 `Asia/Shanghai` = 480）。
 */
export function offsetMinutesOf(now, timeZone) {
  const at = finiteOrNow(now)
  const { parts } = stampParts(at, timeZone)
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  return Math.round((asUTC - Math.floor(at / 1000) * 1000) / 60000)
}

/** 偏移分钟数 → `+08:00` 文本。 */
export function formatOffset(minutes) {
  const safe = typeof minutes === 'number' && Number.isFinite(minutes) ? Math.round(minutes) : 0
  const sign = safe < 0 ? '-' : '+'
  const abs = Math.abs(safe)
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/**
 * 时间戳（含偏移），形如 `2026-09-25 21:34:07 +08:00`。
 *
 * @param {number} now - epoch 毫秒。
 * @param {string} [timeZone] - 时区名，默认 {@link DEFAULT_TIME_ZONE}。
 * @returns {string}
 */
export function formatStamp(now, timeZone) {
  const at = finiteOrNow(now)
  const { parts, zone } = stampParts(at, timeZone)
  const offset = parseOffsetName(parts.timeZoneName) ?? formatOffset(offsetMinutesOf(at, zone))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`
}

/**
 * 时钟回退钳制：经过时长永远 ≥ 0。
 *
 * @param {number} ms - 原始差值（`now - baseline`）。
 * @returns {number} 有限且非负的毫秒数；非法输入 → 0。
 */
export function clampElapsed(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0
}

/**
 * 中文可读时长。
 *
 * - 不足 1 秒（含时钟回退钳成 0）→ `刚刚`
 * - 否则取**最大的至多两个**非零单位，空格分隔：`8 分 12 秒` / `1 小时 3 分` / `59 分` / `1 天 2 小时`
 * - 非法输入（`NaN` / `Infinity` / 字符串 / `undefined`）**不抛错**，按 0 处理 → `刚刚`
 *
 * @param {number} ms - 经过时长（毫秒）。
 * @returns {string}
 */
export function formatDuration(ms) {
  const safe = clampElapsed(ms)
  let remaining = Math.floor(safe / 1000)
  if (remaining < 1) return DURATION_JUST_NOW
  const pieces = []
  for (const [unit, size] of DURATION_UNITS) {
    const secondsPerUnit = size / 1000
    const value = Math.floor(remaining / secondsPerUnit)
    if (value > 0) {
      pieces.push(`${value} ${unit}`)
      remaining -= value * secondsPerUnit
    }
    if (pieces.length >= MAX_DURATION_UNITS) break
  }
  return pieces.length === 0 ? DURATION_JUST_NOW : pieces.join(' ')
}

/**
 * 渲染整行读数（本插件的**唯一对外文案**）。
 *
 * @param {object} [input]
 * @param {number} [input.now] - epoch 毫秒；缺省 = `Date.now()`。
 * @param {string} [input.timeZone] - 时区名；缺省 = {@link DEFAULT_TIME_ZONE}。
 * @param {number|null} [input.baselineTime] - 基线时刻的 epoch 毫秒；`null`/非法 = 拿不到基线。
 * @param {'message'|'reading'} [input.baselineKind] - 基线种类（决定 `距上条消息` / `距上次读数`）。
 * @returns {string} 形如 `[时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上条消息 8 分 12 秒`
 */
export function formatClockLine(input = {}) {
  const now = finiteOrNow(input?.now)
  const { parts, zone } = stampParts(now, input?.timeZone)
  const offset = parseOffsetName(parts.timeZoneName) ?? formatOffset(offsetMinutesOf(now, zone))
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${offset}`
  const label = BASELINE_LABELS[input?.baselineKind] ?? BASELINE_LABELS.message
  const baseline = input?.baselineTime
  const duration = typeof baseline === 'number' && Number.isFinite(baseline)
    ? formatDuration(clampElapsed(now - baseline))
    : DURATION_UNKNOWN
  return `${CLOCK_PREFIX} ${stamp} ${weekdayOf(parts)} · ${label} ${duration}`
}
