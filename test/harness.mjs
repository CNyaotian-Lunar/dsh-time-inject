#!/usr/bin/env node
/**
 * dsh-time-inject · 宿主桩 harness（**真跑 apply() 与 pre-step handler**）
 *
 * 跑法：`node test/harness.mjs`（或 `npm run test:harness`）
 *
 * 与 `test/selftest.mjs` 的分工：
 *   - selftest  ：纯函数 + 源码文本断言，零依赖，进 `npm test`
 *   - harness   ：用 Node 的 **模块解析钩子**（`module.registerHooks`，Node ≥ 22.15）
 *                 把 `schemastery` / `@deepseek-ai/dsh-llm` 换成内存桩，
 *                 于是能在**没有 DSH 的情况下** import 真正的 `lib/index.mjs`，
 *                 用假 ctx / 假 payload 把 7 条 🩸 硬要求逐条跑出来。
 *
 * ⚠️ 诚实边界：schemastery / dsh-llm 是**本 harness 自带的桩**，所以这里验的是「插件自己的逻辑」，
 *    不是那两个包的真实语义。真 schemastery 的 Config 行为需在真实 profile 里另行实测，
 *    本 harness 验的是桩语义。
 */
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

if (typeof registerHooks !== 'function') {
  console.error(`dsh-time-inject harness: 需要 Node ≥ 22.15（module.registerHooks），当前 ${process.version}`)
  process.exit(2)
}

/** 内存 ESM 模块（base64 data: URL，保证可被 import）。 */
function moduleUrl(code) {
  return `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
}

/** schemastery 的最小桩：只实现本插件用到的那点语义（object / default / 类型校验）。 */
const SCHEMASTERY_STUB = `
function field(type) {
  return {
    type,
    _default: undefined,
    default(value) { this._default = value; return this },
  }
}
function object(shape) {
  const schema = function (input) {
    const source = input === undefined || input === null ? {} : input
    if (typeof source !== 'object') throw new TypeError('expected object')
    const out = {}
    for (const [key, spec] of Object.entries(shape)) {
      const value = source[key]
      if (value === undefined || value === null) {
        if (spec._default !== undefined) out[key] = spec._default
        continue
      }
      if (typeof value !== spec.type) throw new TypeError('$.' + key + ' expected ' + spec.type)
      out[key] = value
    }
    for (const [key, value] of Object.entries(source)) if (!(key in shape)) out[key] = value
    return out
  }
  return schema
}
export default { object, boolean: () => field('boolean'), string: () => field('string'), number: () => field('number') }
`

/** dsh-llm 的最小桩：`createUserMessage` 补 id / role（与真实现同款语义）。 */
const LLM_STUB = `
let seq = 0
export function createUserMessage(input) {
  return { role: 'user', id: 'msg-' + (++seq), ...input }
}
`

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'schemastery') return { url: moduleUrl(SCHEMASTERY_STUB), shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-llm') return { url: moduleUrl(LLM_STUB), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const plugin = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.mjs')).href)

let passed = 0
const failures = []

function is(label, actual, expected) {
  if (Object.is(actual, expected)) {
    passed += 1
    return
  }
  failures.push(`${label}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`)
}

function ok(label, condition, detail = '') {
  if (condition) {
    passed += 1
    return
  }
  failures.push(`${label}${detail === '' ? '' : `\n    ${detail}`}`)
}

/** 造一个假 ctx + 假 sessionProjections 注册表。 */
function makeHost() {
  const registrations = []
  const cells = new Map()
  const state = new Map()
  const warns = []
  const listeners = []

  const registry = {
    register(definition) {
      registrations.push(definition)
      return () => {}
    },
    stateOf(session, key) {
      const definition = registrations.find((item) => item.key === key)
      if (definition === undefined) return undefined
      if (cells.get(session)?.explode === true) throw new Error('stateOf boom')
      let current = state.get(session)
      if (current === undefined) {
        current = definition.init({}, 0)
        state.set(session, current)
      }
      return current
    },
    /** 模拟宿主：每 commit 一条事件就 fold 一次。 */
    commit(session, event) {
      const definition = registrations.find((item) => item.key === plugin.PROJECTION_KEY)
      if (definition === undefined) return
      const current = state.get(session) ?? definition.init({}, 0)
      state.set(session, definition.apply(current, event))
    },
  }

  const ctx = {
    logger: { warn: (...args) => warns.push(args.map((x) => String(x)).join(' ')), info() {} },
    get(name) {
      return name === 'sessionProjections' ? registry : undefined
    },
    sessionProjections: registry,
    on(event, handler, options) {
      listeners.push({ event, handler, options })
      return () => {}
    },
  }
  return { ctx, registry, registrations, warns, listeners, cells }
}

/** @returns {Promise<{result: any, error: any}>} */
async function drive(handler, payload, next) {
  try {
    return { result: await handler(payload, next), error: undefined }
  } catch (error) {
    return { result: undefined, error }
  }
}

const LINE_RE = /^\[时钟\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2} 周[日一二三四五六] · 距(?:上条消息|上次读数) (?:刚刚|未知|\d+ (?:天|小时|分|秒)(?: \d+ (?:小时|分|秒))?)$/

// ═════════════════════════ 1. 装配 ═════════════════════════
{
  const { ctx, registrations, listeners } = makeHost()
  plugin.apply(ctx, undefined)
  is('1.1 name = time-inject', plugin.name, 'time-inject')
  is('1.2 SOURCE_KIND = time-inject（不是官方 time-context）', plugin.SOURCE_KIND, 'time-inject')
  is('1.3 inject 声明了 agents + sessionProjections', plugin.inject.join(','), 'agents,sessionProjections')
  is('1.4 注册了 1 个投影', registrations.length, 1)
  is('1.5 投影 key 是自己的 timeInject', registrations[0]?.key, 'timeInject')
  is('1.6 投影 stateVersion = 1', registrations[0]?.stateVersion, 1)
  is('1.7 stateSchema 自带 parse', typeof registrations[0]?.stateSchema?.parse, 'function')
  is('1.8 注册了 1 个监听器', listeners.length, 1)
  is('1.9 监听的是 agent/pre-step', listeners[0]?.event, 'agent/pre-step')
  is('1.10 用了 prepend: true', listeners[0]?.options?.prepend, true)
  // 缺省 config（undefined）必须被兜成默认值而不是崩
  ok('1.11 apply(ctx, undefined) 不抛错', true)
}

// ═════════════════════════ 2. 正常轮：注入一条读数 ═════════════════════════
{
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const handler = host.listeners[0].handler
  const session = { id: 's-normal' }
  const now = Date.now()
  host.registry.commit(session, { type: 'user/message', time: now - 492000, data: { source: { kind: 'user' } } })

  const decision = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }
  const { result } = await drive(handler, { agent: { session }, step: 1, turn: 1, signal: { aborted: false } }, async () => decision)

  is('2.1 注入后 messages 多一条', result.messages.length, 2)
  is('2.2 原始 decision 未被就地修改', decision.messages.length, 1)
  is('2.3 kind 仍是 enter', result.kind, 'enter')
  const message = result.messages[1]
  is('2.4 注入消息 role = user', message.role, 'user')
  is('2.5 content 恰好 1 个 text block', message.content.length, 1)
  is('2.6 content[0].type = text', message.content[0].type, 'text')
  is('2.7 🩸 source 恰好 3 个 key', Object.keys(message.source).length, 3)
  is('2.8 🩸 source.kind = time-inject', message.source.kind, 'time-inject')
  is('2.9 source.form = snapshot', message.source.form, 'snapshot')
  is('2.10 source.sections 恰好 1 项', message.source.sections.length, 1)
  is('2.11 section 恰好 2 个 key', Object.keys(message.source.sections[0]).length, 2)
  is('2.12 section.name = time-inject', message.source.sections[0].name, 'time-inject')
  is('2.13 🩸 section.text === content[0].text', message.source.sections[0].text, message.content[0].text)
  ok('2.14 文案匹配单行契约正则', LINE_RE.test(message.content[0].text), `实际: ${JSON.stringify(message.content[0].text)}`)
  ok('2.15 文案含「距上条消息 8 分 12 秒」', message.content[0].text.includes('· 距上条消息 8 分 12 秒'), `实际: ${JSON.stringify(message.content[0].text)}`)
  ok('2.16 文案含中文星期', /周[日一二三四五六]/.test(message.content[0].text))
  is('2.17 无告警', host.warns.length, 0)
}

// ═════════════════════════ 3. 🩸 空轮保护 ═════════════════════════
{
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const handler = host.listeners[0].handler
  const session = { id: 's-empty' }
  const decision = { kind: 'enter', messages: [] }
  const { result } = await drive(handler, { agent: { session }, step: 1, turn: 1, signal: { aborted: false } }, async () => decision)
  is('3.1 🩸 空轮原样返回同一个对象（不撑成真步骤）', result, decision)
  is('3.2 空轮没有塞消息', result.messages.length, 0)
  is('3.3 空轮不产生告警', host.warns.length, 0)
}

// ═════════════════════════ 4. 触发时机：只有 step === 1 ═════════════════════════
{
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const handler = host.listeners[0].handler
  const session = { id: 's-step2' }
  const decision = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }
  for (const step of [0, 2, 3, 17]) {
    const { result } = await drive(handler, { agent: { session }, step, turn: 1, signal: { aborted: false } }, async () => decision)
    is(`4.${step} step=${step} 不注入（原样返回）`, result, decision)
  }
  const { result: first } = await drive(handler, { agent: { session }, step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }))
  is('4.20 step=1 才注入', first.messages.length, 2)
}

// ═════════════════════════ 5. reject / aborted / 无 session ═════════════════════════
{
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const handler = host.listeners[0].handler
  const session = { id: 's-skip' }
  const rejected = { kind: 'reject' }
  const { result: r1 } = await drive(handler, { agent: { session }, step: 1, turn: 1, signal: { aborted: false } }, async () => rejected)
  is('5.1 reject 原样返回', r1, rejected)

  const aborted = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }
  const { result: r2 } = await drive(handler, { agent: { session }, step: 1, turn: 1, signal: { aborted: true } }, async () => aborted)
  is('5.2 signal.aborted 不注入', r2, aborted)

  const noSession = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }
  const { result: r3 } = await drive(handler, { agent: {}, step: 1, turn: 1, signal: { aborted: false } }, async () => noSession)
  is('5.3 agent 没有 session 不注入', r3, noSession)

  const noPayload = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }
  const { result: r4 } = await drive(handler, undefined, async () => noPayload)
  is('5.4 payload = undefined 不抛错、不注入', r4, noPayload)
}

// ═════════════════════════ 6. 开关 ═════════════════════════
{
  const off = makeHost()
  plugin.apply(off.ctx, { enabled: false })
  const decision = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }
  const { result } = await drive(off.listeners[0].handler, { agent: { session: { id: 's' } }, step: 1, turn: 1, signal: { aborted: false } }, async () => decision)
  is('6.1 enabled=false 不注入', result, decision)

  const subs = makeHost()
  plugin.apply(subs.ctx, { includeSubagents: false })
  const subDecision = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }
  const { result: sub } = await drive(subs.listeners[0].handler, { agent: { session: { id: 's' }, parentAgent: {} }, step: 1, turn: 1, signal: { aborted: false } }, async () => subDecision)
  is('6.2 includeSubagents=false 时子代理不注入', sub, subDecision)

  const subsOn = makeHost()
  plugin.apply(subsOn.ctx, {})
  const { result: onSub } = await drive(subsOn.listeners[0].handler, { agent: { session: { id: 's' }, parentAgent: {} }, step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }))
  is('6.3 默认给子代理也注入', onSub.messages.length, 2)
}

// ═════════════════════════ 7. 🩸 异常语义 ═════════════════════════
{
  const host = makeHost()
  plugin.apply(host.ctx, {})
  const handler = host.listeners[0].handler
  const session = { id: 's-throw' }

  // 7a next() 自己抛 → 必须原样抛出，不许吞
  const boom = new Error('downstream boom')
  const { error: e1 } = await drive(handler, { agent: { session }, step: 1, turn: 1, signal: { aborted: false } }, async () => {
    throw boom
  })
  is('7.1 next() 抛错时原样抛出（不吞）', e1, boom)
  is('7.2 不把下游错误误报成注入失败', host.warns.length, 0)

  // 7b 注入过程自己抛（spread 一个会抛的数组）→ 降级为放行
  const evil = []
  Object.defineProperty(evil, 0, { get() { throw new Error('spread boom') }, enumerable: true })
  evil.length = 1
  const evilDecision = { kind: 'enter', messages: evil }
  const { result: r2 } = await drive(handler, { agent: { session }, step: 1, turn: 1, signal: { aborted: false } }, async () => evilDecision)
  is('7.3 注入路径抛错 → 原样放行', r2, evilDecision)
  ok('7.4 注入失败有告警（fail-loud）', host.warns.some((line) => line.includes('注入失败，已放行本步')), `实际告警: ${JSON.stringify(host.warns)}`)

  // 7c stateOf 抛错 → 单独兜住，仍注入（基线未知）
  const host2 = makeHost()
  plugin.apply(host2.ctx, {})
  const sessionX = { id: 's-explode' }
  host2.cells.set(sessionX, { explode: true })
  const { result: r3 } = await drive(host2.listeners[0].handler, { agent: { session: sessionX }, step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }))
  is('7.5 stateOf 抛错时仍然注入', r3.messages.length, 2)
  ok('7.6 基线退化为「未知」', r3.messages[1].content[0].text.includes('· 距上条消息 未知'), `实际: ${r3.messages[1].content[0].text}`)
}

// ═════════════════════════ 8. sessionProjections 不可用 ═════════════════════════
{
  const warns = []
  const listeners = []
  const ctx = {
    logger: { warn: (...args) => warns.push(args.map(String).join(' ')), info() {} },
    get: () => undefined,
    on(event, handler, options) {
      listeners.push({ event, handler, options })
      return () => {}
    },
  }
  plugin.apply(ctx, {})
  is('8.1 投影不可用时不抛错（只告警）', warns.length, 1)
  ok('8.2 告警说明了降级', warns[0].includes('sessionProjections 不可用'), `实际: ${warns[0]}`)
  const { result } = await drive(listeners[0].handler, { agent: { session: { id: 's' } }, step: 1, turn: 1, signal: { aborted: false } }, async () => ({ kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }))
  is('8.3 没有投影也照样注入时间', result.messages.length, 2)
  ok('8.4 没有投影时基线为「未知」', result.messages[1].content[0].text.includes('· 距上条消息 未知'))
}

// ═════════════════════════ 9. 投影折叠语义 ═════════════════════════
{
  const fresh = plugin.initTimeInjectState()
  is('9.1 初始状态', JSON.stringify(fresh), JSON.stringify({ lastMessageTime: null, lastInjectionTime: null, injections: 0 }))

  is('9.2 不关心的事件返回同一引用', plugin.foldTimeInject(fresh, { type: 'turn/start', time: 1 }), fresh)
  is('9.3 事件缺 time 返回同一引用', plugin.foldTimeInject(fresh, { type: 'user/message', data: { source: { kind: 'user' } } }), fresh)
  is('9.4 事件为 undefined 返回同一引用', plugin.foldTimeInject(fresh, undefined), fresh)

  const s1 = plugin.foldTimeInject(fresh, { type: 'user/message', time: 1000, data: { source: { kind: 'user' } } })
  is('9.5 普通用户消息更新 lastMessageTime', s1.lastMessageTime, 1000)
  is('9.6 普通消息不更新 lastInjectionTime', s1.lastInjectionTime, null)

  const s2 = plugin.foldTimeInject(s1, { type: 'assistant/message', time: 1000, data: {} })
  is('9.7 同一毫秒的后续消息不倒退（>= 判定，非官方的 ===）', s2.lastMessageTime, 1000)

  const s3 = plugin.foldTimeInject(s2, { type: 'user/message', time: 2000, data: { source: { kind: 'time-inject' } } })
  is('9.8 🩸 自己注入的消息不污染 lastMessageTime', s3.lastMessageTime, 1000)
  is('9.9 自己注入的消息记进 lastInjectionTime', s3.lastInjectionTime, 2000)
  is('9.10 注入计数 +1', s3.injections, 1)

  const s4 = plugin.foldTimeInject(s3, { type: 'tool/result', time: 3000, data: {} })
  is('9.11 工具结果更新 lastMessageTime', s4.lastMessageTime, 3000)

  const s5 = plugin.foldTimeInject(s4, { type: 'user/message', time: 500, data: { source: { kind: 'user' } } })
  is('9.12 时间戳倒退的消息不覆盖新基线', s5.lastMessageTime, 3000)

  is('9.13 未被关心的事件仍返回同一引用', plugin.foldTimeInject(s5, { type: 'session/created', time: 9000 }), s5)
}

// ═════════════════════════ 10. stateSchema（宿主直接调 .parse）═════════════════════════
{
  const schema = plugin.timeInjectStateSchema
  ok('10.1 parse(null) 抛错（宿主 viewCheckpoint 会吞）', (() => {
    try {
      schema.parse(null)
      return false
    } catch {
      return true
    }
  })())
  is('10.2 非法字段被就地纠正', JSON.stringify(schema.parse({ lastMessageTime: 'x', lastInjectionTime: NaN, injections: -5 })), JSON.stringify({ lastMessageTime: null, lastInjectionTime: null, injections: 0 }))
  is('10.3 合法字段原样通过', JSON.stringify(schema.parse({ lastMessageTime: 5, lastInjectionTime: 6, injections: 7 })), JSON.stringify({ lastMessageTime: 5, lastInjectionTime: 6, injections: 7 }))
  ok('10.4 ~standard.validate 走 Standard Schema 协议', schema['~standard'].validate({}).value !== undefined)
  ok('10.5 ~standard.validate 对垃圾返回 issues 而不是抛', Array.isArray(schema['~standard'].validate(null).issues))
}

// ═════════════════════════ 11. resolveConfig 兜底 ═════════════════════════
{
  is('11.1 undefined → 默认值', JSON.stringify(plugin.resolveConfig(undefined)), JSON.stringify({ enabled: true, timeZone: 'Asia/Shanghai', includeSubagents: true }))
  is('11.2 null → 默认值', JSON.stringify(plugin.resolveConfig(null)), JSON.stringify({ enabled: true, timeZone: 'Asia/Shanghai', includeSubagents: true }))
  is('11.3 字符串垃圾 → 默认值', JSON.stringify(plugin.resolveConfig('junk')), JSON.stringify({ enabled: true, timeZone: 'Asia/Shanghai', includeSubagents: true }))
  is('11.4 enabled:false 生效', plugin.resolveConfig({ enabled: false }).enabled, false)
  is('11.5 timeZone 走 schema 失败后仍按字段兜底', plugin.resolveConfig({ timeZone: 123 }).timeZone, 'Asia/Shanghai')
  is('11.6 timeZone 空串 → 默认', plugin.resolveConfig({ timeZone: '   ' }).timeZone, 'Asia/Shanghai')
  is('11.7 自定义时区生效', plugin.resolveConfig({ timeZone: 'UTC' }).timeZone, 'UTC')
  is('11.8 includeSubagents:false 生效', plugin.resolveConfig({ includeSubagents: false }).includeSubagents, false)
}

// ═════════════════════════ 12. 装配期异常不拖挂启动 ═════════════════════════
{
  const warns = []
  const ctx = {
    logger: { warn: (...args) => warns.push(args.map(String).join(' ')), info() {} },
    get() {
      throw new Error('registry boom')
    },
    get sessionProjections() {
      throw new Error('registry boom')
    },
    on() {
      throw new Error('on boom')
    },
  }
  let threw = false
  try {
    plugin.apply(ctx, {})
  } catch {
    threw = true
  }
  is('12.1 apply 内部炸了也不往外抛（否则拖挂 DSH 启动）', threw, false)
  ok('12.2 并且留下告警', warns.some((line) => line.includes('装配失败')), `实际: ${JSON.stringify(warns)}`)
}

// ───────────────────────────── 汇总 ─────────────────────────────
const total = passed + failures.length
if (failures.length === 0) {
  console.log(`dsh-time-inject harness: 全部通过 — ${passed}/${total}`)
  console.log('  装配 / 注入形状 / 空轮保护 / step 触发 / reject·aborted / 开关 / 异常语义 / 折叠 / stateSchema / 配置兜底')
  process.exitCode = 0
} else {
  console.log(`dsh-time-inject harness: 失败 ${failures.length} 项 / 共 ${total} 项（通过 ${passed}）`)
  for (const [index, failure] of failures.entries()) console.log(`  ✗ ${index + 1}. ${failure}`)
  process.exitCode = 1
}
