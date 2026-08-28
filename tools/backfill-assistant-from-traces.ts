#!/usr/bin/env bun
/**
 * 从 trace 回填 transcript 中丢失的 assistant text 块。
 *
 * 背景：openaiResponsesStreamToAnthropic 转换器在部分上游不发送最后一个
 * content_block 的 stop 事件时，CLI 永远不会把该 text block 落成 transcript
 * 条目（UI 靠 delta 流渲染所以当时可见，trace 里则是完整响应体）。
 *
 * 用法：
 *   bun run tools/backfill-assistant-from-traces.ts                 # dry-run 全部会话
 *   bun run tools/backfill-assistant-from-traces.ts --session <id>  # 指定会话
 *   bun run tools/backfill-assistant-from-traces.ts --apply         # 真正写入（自动 .bak）
 *   bun run tools/backfill-assistant-from-traces.ts --apply --force # 允许写入 mtime<10min 的活跃会话
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

const apply = process.argv.includes('--apply')
const force = process.argv.includes('--force')
const sessionArg = (() => {
  const i = process.argv.indexOf('--session')
  return i >= 0 ? process.argv[i + 1] : undefined
})()

const tracesDir = path.join(homedir(), '.claude', 'cc-haha', 'traces')
const projectsDir = path.join(homedir(), '.claude', 'projects')

type Block = { index: number; type: string; text: string; closed: boolean }
type ParsedMessage = {
  id: string
  model: string
  blocks: Map<number, Block>
  usage: Record<string, unknown> | null
  stopReason: string | null
  sawMessageStop: boolean
}

import { existsSync, statSync, copyFileSync, readdirSync, readFileSync } from 'node:fs'
function parseSse(preview: string): ParsedMessage[] {
  const messages: ParsedMessage[] = []
  let current: ParsedMessage | null = null
  let event = ''
  let dataLines: string[] = []

  const flush = () => {
    if (!event || dataLines.length === 0) { event = ''; dataLines = []; return }
    const payload = dataLines.join('\n')
    dataLines = []
    const prevEvent = event
    event = ''
    let data: any
    try { data = JSON.parse(payload) } catch { return }
    switch (prevEvent) {
      case 'message_start':
        current = {
          id: data.message?.id ?? `msg_orphan_${messages.length}`,
          model: data.message?.model ?? 'unknown',
          blocks: new Map(),
          usage: null,
          stopReason: null,
          sawMessageStop: false,
        }
        messages.push(current)
        break
      case 'content_block_start':
        current?.blocks.set(data.index ?? 0, {
          index: data.index ?? 0,
          type: data.content_block?.type ?? 'text',
          text: data.content_block?.type === 'text' ? (data.content_block?.text ?? '') : '',
          closed: false,
        })
        break
      case 'content_block_delta': {
        const b = current?.blocks.get(data.index ?? 0)
        if (!b) break
        if (data.delta?.type === 'text_delta') b.text += data.delta.text ?? ''
        else if (data.delta?.type === 'thinking_delta') b.text += data.delta.thinking ?? ''
        break
      }
      case 'content_block_stop': {
        const b = current?.blocks.get(data.index ?? 0)
        if (b) b.closed = true
        break
      }
      case 'message_delta':
        if (current) {
          current.usage = data.usage ?? null
          current.stopReason = data.delta?.stop_reason ?? null
        }
        break
      case 'message_stop':
        if (current) current.sawMessageStop = true
        break
    }
  }

  for (const rawLine of preview.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('event:')) {
      flush()
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      let v = line.slice(5)
      if (v.startsWith(' ')) v = v.slice(1)
      dataLines.push(v)
    } else if (line === '') {
      flush()
    }
  }
  flush()
  return messages
}

function buildFromTrace(tracePath: string): Map<string, ParsedMessage> {
  const out = new Map<string, ParsedMessage & { _truncated: boolean }>()
  const seen = new Map<string, number>() // record.id -> rank (prefer completed)
  for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    if (entry?.type !== 'call') continue
    const rec = entry.record
    const preview = rec?.response?.body?.preview as string | undefined
    if (!preview) continue
    const rank = rec.status === 'pending' ? 0 : 1
    if (seen.get(rec.id) !== undefined && seen.get(rec.id)! > rank) continue
    seen.set(rec.id, rank)
    const truncated = Boolean(rec?.response?.body?.truncated)
    for (const msg of parseSse(preview)) {
      const existing = out.get(msg.id)
      if (!existing || (rank === 1 && existing._truncated !== truncated && !msg.sawMessageStop)) {
        // keep the most complete representation
      }
      if (!existing || msg.sawMessageStop || existing.blocks.size < msg.blocks.size) {
        out.set(msg.id, { ...msg, _truncated: truncated } as any)
      }
    }
  }
  return out
}

// ── transcript ────────────────────────────────────────────────────
function findTranscript(sessionId: string): string | null {
  if (!existsSync(projectsDir)) return null
  const dirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name)
  for (const d of dirs) {
    const p = path.join(projectsDir, d, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

function contentTypes(message: any): string[] {
  const content = message?.content
  if (typeof content === 'string') return ['text']
  return Array.isArray(content) ? content.map((b: any) => b?.type).filter(Boolean) : []
}

// ── main ──────────────────────────────────────────────────────────
const sessionIds = existsSync(tracesDir)
  ? readdirSync(tracesDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace(/\.jsonl$/, ''))
  : []

let totalInserted = 0
for (const sessionId of sessionIds) {
  if (sessionArg && sessionId !== sessionArg) continue
  const transcriptPath = findTranscript(sessionId)
  if (!transcriptPath) continue

  const trace = buildFromTrace(path.join(tracesDir, `${sessionId}.jsonl`))
  if (trace.size === 0) continue

  const stat = statSync(transcriptPath)
  const active = Date.now() - stat.mtimeMs < 10 * 60 * 1000
  if (active && !force) {
    console.log(`[skip] ${sessionId}: transcript 最近 10 分钟内有写入（活跃会话？），--force 可覆盖`)
    continue
  }

  const lines = readFileSync(transcriptPath, 'utf8').split('\n')
  const trailingNewline = lines[lines.length - 1] === ''
  const entries = lines.filter(l => l.trim() !== '')

  // 每条 transcript assistant 条目按 message.id 归组
  const byMsgId = new Map<string, { lineIdx: number; uuid: string; types: string[]; ts: number }[]>()
  for (let i = 0; i < entries.length; i++) {
    let e: any
    try { e = JSON.parse(entries[i]) } catch { continue }
    if (e?.type !== 'assistant' || !e?.message?.id) continue
    const arr = byMsgId.get(e.message.id) ?? []
    arr.push({
      lineIdx: i,
      uuid: e.uuid,
      types: contentTypes(e.message),
      ts: Date.parse(e.timestamp ?? '') || 0,
    })
    byMsgId.set(e.message.id, arr)
  }

  const insertions: { afterLineIdx: number; newLines: string[] }[] = []
  const warnings: string[] = []
  for (const [msgId, parsed] of trace) {
    const existing = byMsgId.get(msgId) ?? []
    const haveText = existing.reduce((n, x) => n + x.types.filter(t => t === 'text').length, 0)
    const haveThinking = existing.reduce((n, x) => n + x.types.filter(t => t === 'thinking').length, 0)
    const haveTool = existing.reduce((n, x) => n + x.types.filter(t => t === 'tool_use').length, 0)
    const want = [...parsed.blocks.values()].sort((a, b) => a.index - b.index)
    const wantText = want.filter(b => b.type === 'text')
    const wantThinking = want.filter(b => b.type === 'thinking')
    const wantTool = want.filter(b => b.type === 'tool_use')

    let missingText = wantText.length - haveText
    let missingThinking = wantThinking.length - haveThinking
    let missingTool = wantTool.length - haveTool
    if (missingText <= 0 && missingThinking <= 0 && missingTool <= 0) continue

    if (parsed._truncated) {
      warnings.push(`  [warn] ${sessionId} ${msgId}: trace body 被截断，跳过（内容不完整）`)
      continue
    }
    if (!parsed.sawMessageStop) {
      warnings.push(`  [warn] ${sessionId} ${msgId}: trace 流未见到 message_stop，跳过）`)
      continue
    }

    // 插入位置：该 message 最后一个已有条目之后；若完全没有则跳过（无法安全定位）
    if (existing.length === 0) {
      warnings.push(`  [warn] ${sessionId} ${msgId}: transcript 中没有任何该消息的条目，跳过`)
      continue
    }
    const last = existing[existing.length - 1]
    const model = (JSON.parse(entries[last.lineIdx]).message?.model) ?? parsed.model
    const newLines: string[] = []
    let parentUuid = last.uuid
    let ts = last.ts || Date.parse(JSON.parse(entries[last.lineIdx]).timestamp ?? '') || Date.now()
    const orderedMissing = want.filter(b => {
      if (b.type === 'text' && missingText-- > 0) return true
      if (b.type === 'thinking' && missingThinking-- > 0) return true
      if (b.type === 'tool_use' && missingTool-- > 0) return true
      return false
    })
    for (const block of orderedMissing) {
      const uuid = crypto.randomUUID()
      ts += 1
      const entry = {
        parentUuid,
        isSidechain: false,
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          content: [block.type === 'thinking'
            ? { type: 'thinking', thinking: block.text, signature: '' }
            : { type: 'text', text: block.text }],
          model,
          stop_reason: block === orderedMissing[orderedMissing.length - 1] ? parsed.stopReason : null,
          stop_sequence: null,
          usage: parsed.usage ?? { input_tokens: 0, output_tokens: 0 },
        },
        type: 'assistant',
        uuid,
        timestamp: new Date(ts).toISOString(),
      }
      newLines.push(JSON.stringify(entry))
      parentUuid = uuid
      totalInserted++
      console.log(`  [insert] ${sessionId} ${msgId} ${block.type}(${block.text.length} chars) after ${last.uuid.slice(0, 8)}`)
    }
    insertions.push({ afterLineIdx: last.lineIdx, newLines })
  }

  if (insertions.length === 0 && warnings.length === 0) continue
  console.log(`\n=== ${sessionId} → ${transcriptPath}`)
  for (const w of warnings) console.log(w)

  if (apply && insertions.length > 0) {
    // 从后往前插入避免索引位移
    insertions.sort((a, b) => b.afterLineIdx - a.afterLineIdx)
    for (const ins of insertions) entries.splice(ins.afterLineIdx + 1, 0, ...ins.newLines)
    const bak = transcriptPath + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(transcriptPath, bak)
    const content = entries.join('\n') + (trailingNewline ? '\n' : '')
    Bun.write(transcriptPath, content)
    console.log(`  [done] 写入 ${insertions.reduce((n, x) => n + x.newLines.length, 0)} 条，备份: ${path.basename(bak)}`)
  } else if (!apply) {
    console.log(`  (dry-run，加 --apply 写入)`)
  }
}

console.log(`\n计划插入 ${totalInserted} 条 assistant 块；${apply ? '已写入' : 'dry-run 未写入'}`)
