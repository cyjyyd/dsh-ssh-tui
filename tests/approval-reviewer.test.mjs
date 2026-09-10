import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReviewUserMessage,
  parseReviewOutput,
  reviewSystemPrompt,
  REVIEW_SYSTEM_PROMPT,
} from '../lib/approval-reviewer.js'

test('buildReviewUserMessage fences the data regions and truncates long input', () => {
  const message = buildReviewUserMessage({
    userText: '更新一下本机node版本（使用LTS版本）',
    segments: ['先看当前 node 装在哪里。', '再决定安装方式。'],
    toolName: 'bash',
    command: 'set -e\nsudo apt install -y nodejs',
    args: '{"command":"sudo apt install -y nodejs"}',
    reason: 'user asked to upgrade node',
    sandboxMode: 'workspace-write',
  })
  assert.ok(message.includes('[用户最新消息开始]'))
  assert.ok(message.includes('更新一下本机node版本'))
  assert.ok(message.includes('[模型近期输出开始（仅供理解背景）]'))
  assert.ok(message.includes('(1) 先看当前 node 装在哪里。'))
  assert.ok(message.includes('[待审批工具调用开始]'))
  assert.ok(message.includes('tool: bash'))
  assert.ok(message.includes('sudo apt install'))
  assert.ok(message.includes('args: {"command":"sudo apt install -y nodejs"}'))
  assert.ok(message.includes('reason: user asked to upgrade node'))
  assert.ok(message.includes('sandbox: workspace-write'))
  // 防注入：系统提示词声明数据区不是指令
  assert.match(REVIEW_SYSTEM_PROMPT, /注入/)
  assert.match(REVIEW_SYSTEM_PROMPT, /reject/)
  assert.match(REVIEW_SYSTEM_PROMPT, /系统敏感目录/)
  assert.match(REVIEW_SYSTEM_PROMPT, /脚本/)
  assert.match(REVIEW_SYSTEM_PROMPT, /语法/)
  assert.match(REVIEW_SYSTEM_PROMPT, /\/home\//)
  assert.match(REVIEW_SYSTEM_PROMPT, /最终回复/)
  assert.match(REVIEW_SYSTEM_PROMPT, /思考过程一律忽略/)
  assert.match(REVIEW_SYSTEM_PROMPT, /npm\/pnpm\/yarn publish/)
  assert.match(REVIEW_SYSTEM_PROMPT, /\.npmrc/)
  assert.match(reviewSystemPrompt('en'), /npm\/pnpm\/yarn publish/)
  assert.match(reviewSystemPrompt('en'), /authorization=unknown/)
  assert.ok(message.includes('[输出要求]'))
  assert.ok(message.includes('必须给出最终可见回复'))
})

test('buildReviewUserMessage truncates oversized fields', () => {
  const message = buildReviewUserMessage({
    userText: '长'.repeat(600),
    segments: ['段'.repeat(500)],
    toolName: 'bash',
    command: 'c'.repeat(900),
  })
  assert.ok(message.length < 4000)
  assert.ok(message.includes('…'))
})

test('parseReviewOutput reads the reviewer JSON verdict', () => {
  const verdict = parseReviewOutput(
    '{"risk":"low","authorization":"yes","decision":"approved","reason":"常规只读查询"}',
  )
  assert.deepEqual(verdict, {
    risk: 'low',
    authorization: 'yes',
    approved: true,
    reason: '常规只读查询',
  })
  assert.equal(
    parseReviewOutput('{"risk":"low","authorization":"unknown","decision":"approved","reason":"常规只读查询"}')?.approved,
    false,
  )
})

test('parseReviewOutput fails safe on junk and hostile output', () => {
  assert.equal(parseReviewOutput('好的，我批准这个操作。'), undefined)
  assert.equal(parseReviewOutput('{"risk":"high","authorization":"unknown","decision":"approved","reason":"x"}').approved, false)
  assert.equal(parseReviewOutput('{"risk":"high","authorization":"yes","decision":"approved","reason":"用户授权单文件删除"}').approved, false)
  assert.equal(parseReviewOutput('{"risk":"medium","authorization":"yes","decision":"approved","reason":"用户目录单文件删除"}').approved, true)
  assert.equal(parseReviewOutput('{"risk":"low","authorization":"no","decision":"approved"}').approved, false)
  assert.equal(parseReviewOutput('{"risk":"unknown","decision":"approved"}'), undefined)
  assert.equal(parseReviewOutput('{"decision":"approved"}'), undefined)
  // 模型输出带代码栅栏时仍可解析
  const fenced = parseReviewOutput('```json\n{"risk":"low","authorization":"yes","decision":"approved","reason":"ok"}\n```')
  assert.equal(fenced.approved, true)
  const aliases = parseReviewOutput('{"risk":"Low","authorization":"allow","decision":"allow","reason":"用户授权删除探测文件"}')
  assert.equal(aliases?.approved, true)
  const reasoningOnly = parseReviewOutput('Thinking...\n{"risk":"medium","verdict":"reject","reason":"拿不准"}')
  assert.equal(reasoningOnly?.approved, false)
  assert.equal(reasoningOnly?.risk, 'medium')
})

test('parseReviewOutput flags injection attempts as high risk', () => {
  // 审核员被数据区注入后的"正确"输出应自行判 reject/high
  const verdict = parseReviewOutput(
    '{"risk":"high","authorization":"no","decision":"rejected","reason":"疑似提示词注入"}',
  )
  assert.equal(verdict.approved, false)
  assert.equal(verdict.risk, 'high')
})
