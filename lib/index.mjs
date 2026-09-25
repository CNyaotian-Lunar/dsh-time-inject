/**
 * dsh-time-inject · Node half（host 侧 · 接线层）
 *
 * 「中文时间注入」：在**每个 turn 的第一个 step 之前**，往模型上下文里追加一条
 * 中文时间读数，让 agent 永远知道「现在几点、距上一条消息过了多久」。
 *
 * ── 与官方 `@deepseek-ai/dsh-time-context` 的差异 ──
 *   1. 文案：**单行紧凑中文**（官方是三行英文）。
 *      `[时钟] 2026-09-25 21:34:07 +08:00 周五 · 距上条消息 8 分 12 秒`
 *   2. 触发：**每个 turn 的第一个 step 注入一次**（不是每步、不是固定间隔）
 *      ⇒ 官方那套 `refreshIntervalMs` 节流逻辑**整体不要**。
 *   3. 时区：固定 `Asia/Shanghai`（不做浏览器时区三态派生 / 不读 `user-rpc.clientTimeZone`）。
 *   4. 时钟回退：elapsed 钳 0（与官方一致，但只有这一条被保留）。
 *
 * ── 一条必须记住的宿主事实（源码级证据，行号对应 DSH 0.1.7-rc.2）──
 *   `agent/pre-step` payload 里的 `step` **从 1 起**（= 本 turn 的第几个 step）：
 *     - `dsh-agent-loop/lib/index.js:865` 运行相位初始化 `step: 0`
 *     - `dsh-agent-loop/lib/index.js:953` `const step = phase.step + 1;` → 首次派发 = 1
 *     - `dsh-agent-loop/lib/index.js:963` `if (phase.step === 0 && ...)` = 判「本轮第一步」
 *     - `dsh-agent-loop/lib/index.js:972` `phase.step = step;`（进入后才推进）
 *     - `dsh-agent-loop/lib/index.js:1020-1023` 一个 turn 结束后、要开新 turn 才 `phase.step = 0`
 *   ⇒ `step === 1` 恰好等价于「本 turn 的第一个 step」，一个 turn 只出现一次。
 *
 * ── 其余若干宿主 API 陷阱都在这份文件里逐条防住（对应注释标了 [坑N]）──
 */
import z from 'schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_TIME_ZONE, formatClockLine } from './text.mjs'

/** Cordis 插件名（loader 诊断用；**不是**模块名，也不是 `source.kind`）。 */
export const name = 'time-inject'

/** [坑2] 自己的来源标识：**绝不**复用官方的 `'time-context'`。 */
export const SOURCE_KIND = 'time-inject'

/** 本插件自己的会话投影键（不要撞官方的 `timeContext`）。 */
export const PROJECTION_KEY = 'timeInject'

/**
 * 投影状态版本。改动 `init` / `apply`（折叠语义）或状态字段时**必须 +1**，
 * 否则旧的持久 cache 会被前向应用成垃圾（`dsh-session-projection\lib\types\index.d.ts:73-79`）。
 */
export const PROJECTION_STATE_VERSION = 1

/** 依赖的服务：缺任一则本插件不加载（与官方 `lib\index.js:111-112` 同款）。 */
export const inject = ['agents', 'sessionProjections']

/**
 * 配置 schema（schemastery）。
 *
 * ⚠️ 为什么不用 zod：DSH 的第三方 profile 可解析依赖里通常只有 `schemastery` / `cosmokit`，
 * 没有 `zod`（官方那些用 zod 的包是自带依赖）。本插件的 `Config` 走 cordis 的
 * Standard Schema 校验，schemastery 完全够用。
 */
export const Config = z.object({
  /** 总开关。关掉后 handler 一律原样放行。 */
  enabled: z.boolean().default(true),
  /**
   * 显示时区（IANA 名）。默认 `Asia/Shanghai`。
   * 填了非法名不会炸——`lib/text.mjs` 会降级回默认时区（见 `stampParts`）。
   */
  timeZone: z.string().default(DEFAULT_TIME_ZONE),
  /** 是否连子代理的轮次也注入（默认开：子代理同样需要知道时间）。 */
  includeSubagents: z.boolean().default(true),
})

/** [坑6] `apply` 内的兜底默认值：不走 schema 的调用路径（测试 / 直接调用）也要安全。 */
const FALLBACK_CONFIG = Object.freeze({
  enabled: true,
  timeZone: DEFAULT_TIME_ZONE,
  includeSubagents: true,
})

/** 模型可见的消息事件（决定 elapsed 基线的那些）。 */
const MODEL_VISIBLE_EVENTS = Object.freeze(new Set(['user/message', 'assistant/message', 'tool/result']))

/** 任意输入 → 有限数字或 `null`（用于投影状态的 JSON 往返）。 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 投影状态 schema。
 *
 * 🩸 **必须自己写，不能用 schemastery 的 schema**：宿主**直接调** `stateSchema.parse(...)`——
 * `dsh-session-projection\lib\index.js:255`（`viewCheckpoint`）与 `:297`（`restore`，**没有 try/catch**），
 * 而 schemastery 的 `Schema` **没有 `.parse` 方法**（实测 `@deepseek-ai/schemastery@3.18.4`
 * 只提供可调用 + `~standard`，全仓 grep `parse` 只命中 `JSON.parse`）。
 * 若不补这一手，**一旦存在持久 checkpoint 行，会话 restore 会直接抛 TypeError**。
 *
 * 行为：形状不对就抛（宿主在 `viewCheckpoint` 里会吞掉它），字段非法就**就地纠正**，
 * 保证返回的一定是「纯 JSON + 字段齐备」的状态。
 */
export const timeInjectStateSchema = {
  parse(value) {
    if (typeof value !== 'object' || value === null) {
      throw new TypeError('time-inject: projection state must be a non-null object')
    }
    return {
      lastMessageTime: finiteOrNull(value.lastMessageTime),
      lastInjectionTime: finiteOrNull(value.lastInjectionTime),
      injections: Number.isSafeInteger(value.injections) && value.injections >= 0 ? value.injections : 0,
    }
  },
  /** 顺带满足 Standard Schema（目前宿主不读，留着不亏）。 */
  '~standard': {
    version: 1,
    vendor: 'dsh-time-inject',
    validate(value) {
      try {
        return { value: timeInjectStateSchema.parse(value) }
      } catch (error) {
        return { issues: [{ message: error?.message ?? String(error) }] }
      }
    },
  },
}

/**
 * 空状态工厂。`init(header, inheritedEventCount)` 的两个参数本插件用不到。
 *
 * @returns {{lastMessageTime: number|null, lastInjectionTime: number|null, injections: number}}
 */
export function initTimeInjectState() {
  return { lastMessageTime: null, lastInjectionTime: null, injections: 0 }
}

/**
 * 投影折叠：纯同步、纯 JSON、**不关心的事件必须返回同一个引用**
 * （`dsh-session-projection\lib\types\index.d.ts:50-58`：`Object.is` 相同 ⇒ 零下游工作）。
 *
 * 只记两件事：
 *   - `lastMessageTime`：最近一条**模型可见且不是本插件注入**的事件时间
 *   - `lastInjectionTime` / `injections`：本插件自己的注入时间与条数
 *
 * ⚠️ 与官方的一处**有意差异**：官方把注入消息也算进 `lastMessageTime`
 * （`lib\index.js:190-212`，行号对应 `@deepseek-ai/dsh-time-context@0.1.7-rc.2`），
 * 我们用 `event.data.source.kind === SOURCE_KIND` 把它排除掉——
 * 这样「距上条消息」量的确实是**用户的消息 / 模型的回复 / 工具结果**，而不是自问自答。
 * 另外官方用 `=== event.time` 判是否更新（`lib\index.js:197,208`），同一毫秒内的两条消息会漏更新；
 * 这里改成严格单调递增判定，避免同毫秒漏更新。
 *
 * @param {object} state - 折叠前状态（已过 `stateSchema.parse`）。
 * @param {object} event - 一条 committed session 事件。
 * @returns {object} 新状态；不关心该事件时**原样返回入参**。
 */
export function foldTimeInject(state, event) {
  const type = event?.type
  if (!MODEL_VISIBLE_EVENTS.has(type)) return state
  const time = finiteOrNull(event?.time)
  if (time === null) return state

  const injected = type === 'user/message' && event?.data?.source?.kind === SOURCE_KIND
  // 只有**不是自己注入**的消息才构成「上条消息」基线；`>=` 是修官方 `===` 的漏更新。
  let lastMessageTime = state.lastMessageTime
  if (!injected && (lastMessageTime === null || time >= lastMessageTime)) lastMessageTime = time
  const lastInjectionTime = injected ? time : state.lastInjectionTime
  const injections = injected ? state.injections + 1 : state.injections

  if (
    lastMessageTime === state.lastMessageTime
    && lastInjectionTime === state.lastInjectionTime
    && injections === state.injections
  ) {
    return state
  }
  return { lastMessageTime, lastInjectionTime, injections }
}

/**
 * [坑6] 配置归一化：先过 schema（补默认值），失败或字段残缺都退回安全默认值。
 *
 * @param {unknown} raw - `apply` 收到的原始 config（可能来自 schema，也可能没有）。
 * @returns {{enabled: boolean, timeZone: string, includeSubagents: boolean}}
 */
export function resolveConfig(raw) {
  let resolved
  try {
    resolved = Config(raw ?? {})
  } catch {
    // schema 校验失败（字段类型错等）：退回用户给的原始对象，再逐字段兜底。
    resolved = typeof raw === 'object' && raw !== null ? raw : {}
  }
  const source = typeof resolved === 'object' && resolved !== null ? resolved : {}
  return {
    enabled: source.enabled !== false,
    timeZone: typeof source.timeZone === 'string' && source.timeZone.trim() !== ''
      ? source.timeZone.trim()
      : FALLBACK_CONFIG.timeZone,
    includeSubagents: source.includeSubagents !== false,
  }
}

/**
 * 装配插件。
 *
 * [坑5] 整个 `apply` 包 try/catch：装配期抛错会**拖挂整个 DSH 启动**
 * 。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文。
 * @param {unknown} config - 该插件行的 config（schema 默认值 + profile patch 覆盖）。
 */
export function apply(ctx, config) {
  try {
    const cfg = resolveConfig(config)

    // ── ① 会话投影：持久折叠「最近一条模型可见消息 / 最近一次自己的注入」─────────
    const registry = ctx.sessionProjections ?? ctx.get?.('sessionProjections')
    if (registry?.register !== undefined) {
      registry.register({
        key: PROJECTION_KEY,
        stateVersion: PROJECTION_STATE_VERSION,
        stateSchema: timeInjectStateSchema,
        init: () => initTimeInjectState(),
        apply: (state, event) => foldTimeInject(state, event),
      })
    } else {
      // 投影不可用不算致命：handler 会退化成「基线未知」，照样能报时间。
      ctx.logger?.warn?.('time-inject: sessionProjections 不可用，elapsed 基线将退化为「未知」。')
    }

    // ── ② pre-step waterfall ────────────────────────────────────────────────
    // `prepend: true` ⇒ 排到已有同名监听器之前，成为 waterfall 最外层。
    ctx.on('agent/pre-step', async (payload, next) => {
      let decision
      let decided = false
      try {
        // [坑5] 一律 `await next()`（写成 `return next()` 会让宿主抛错**穿透** handler）。
        decision = await next()
        decided = true

        if (!cfg.enabled) return decision
        // reject / 未知形状：所有权不在我们手里，原样放行。
        if (decision?.kind !== 'enter') return decision
        // 中止的轮次不注入。
        if (payload?.signal?.aborted === true) return decision

        // 🩸 [坑1 空轮保护] `decision.messages.length === 0` 时必须**原样返回**：
        // `dsh-agent-loop\lib\index.js:963` 靠它判「本轮没有内容 ⇒ 正常收尾」，
        // 我们往 messages 里塞一条就会把那一步变成**真步骤**（白烧一次模型请求）。
        if (!Array.isArray(decision.messages) || decision.messages.length === 0) return decision

        // 🩸 触发时机：每个 turn 的第一个 step（见文件头证据链），一个 turn 只注入一次。
        if (payload?.step !== 1) return decision

        const agent = payload?.agent
        if (!cfg.includeSubagents && agent?.parentAgent !== undefined) return decision
        const session = agent?.session
        if (session === undefined) return decision

        // [坑4] `stateOf()` 可能返回 `undefined`（`dsh-session-projection\lib\types\index.d.ts:167-175`）
        // ⇒ 一律可选链；官方参考实现没防这一手（`dsh-time-context\lib\index.js:219-221`）。
        let state
        try {
          state = registry?.stateOf?.(session, PROJECTION_KEY)
        } catch (error) {
          state = undefined
          ctx.logger?.warn?.('time-inject: 读取投影失败，本次按「无基线」处理：%s', error?.message ?? String(error))
        }

        const now = Date.now()
        const lastMessageTime = finiteOrNull(state?.lastMessageTime)
        const lastInjectionTime = finiteOrNull(state?.lastInjectionTime)
        // 基线优先级：上一条模型可见消息 →（退化）上一次自己的注入读数 → 未知。
        // 标签按**实际给出基线的那一方**选：谁都没给出时用中性标签，避免出现「距上次读数 未知」这种自相矛盾。
        const text = formatClockLine({
          now,
          timeZone: cfg.timeZone,
          baselineTime: lastMessageTime ?? lastInjectionTime,
          baselineKind: lastMessageTime !== null ? 'message' : lastInjectionTime !== null ? 'reading' : 'message',
        })

        // [坑3] `source` 必须**恰好 3 个 key**、`form: 'snapshot'`、`sections` 恰好 1 项、
        // section 恰好 `{name, text}`，且 `section.text === content[0].text`
        // （官方 invariant 的反向契约：`dsh-time-context\lib\invariant.js:146,160`）。
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: SOURCE_KIND,
            form: 'snapshot',
            sections: [{ name: SOURCE_KIND, text }],
          },
        })

        return { ...decision, messages: [...decision.messages, message] }
      } catch (error) {
        // [坑5] 兜底：我们自己的异常一律降级为「放行」。
        // ⚠️ 例外：`next()` 自己抛的错（`decided === false`）**必须原样抛出**——
        // 那是宿主/下游的错，既不是我们能吞的，吞了也造不出一个合法的 decision。
        if (!decided) throw error
        ctx.logger?.warn?.('time-inject: 注入失败，已放行本步：%s', error?.message ?? String(error))
        return decision
      }
    }, { prepend: true })
  } catch (error) {
    // 装配期绝不抛：宁可这插件不生效，也不能拖挂 DSH 启动。
    ctx.logger?.warn?.('time-inject: 装配失败，插件未生效（DSH 启动不受影响）：%s', error?.message ?? String(error))
  }
}
