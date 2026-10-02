/**
 * The grader review page: one self-contained HTML file (no network, works
 * from file://) where a human labels eval answers with the full context next
 * to them: the task, the evidence the skill came from, the skill itself, and
 * both answers side by side. The grader's verdict stays hidden until the human
 * has labeled, so it cannot anchor the label. Labels are exported as JSON and
 * imported with `/autoharness labels <file>`.
 *
 * @module dsh-autoharness/review
 */

/**
 * Render the review page.
 * @param {{ project: string, generatedAt: string, skills: object[] }} data - skills with scored cases, evidence text, and existing labels.
 * @returns {string} HTML.
 */
export function renderReviewPage(data) {
  const json = JSON.stringify({ format: 'autoharness-review', version: 1, ...data }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>autoharness review</title>
<style>
:root {
  --bg: #fafaf9; --panel: #ffffff; --ink: #1c1917; --muted: #78716c; --line: #e7e5e4;
  --accent: #2563eb; --pass: #15803d; --pass-bg: #dcfce7; --fail: #b91c1c; --fail-bg: #fee2e2; --code: #f5f5f4;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0c0a09; --panel: #1c1917; --ink: #e7e5e4; --muted: #a8a29e; --line: #292524;
    --accent: #60a5fa; --pass: #4ade80; --pass-bg: #14532d; --fail: #f87171; --fail-bg: #7f1d1d; --code: #292524; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
header h1 { font-size: 16px; margin: 0; }
header .grow { flex: 1; }
.meta { color: var(--muted); font-size: 13px; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
section.skill { margin-bottom: 32px; }
section.skill > h2 { font-size: 18px; margin: 0 0 4px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
details > summary { cursor: pointer; color: var(--muted); }
pre { background: var(--code); border-radius: 6px; padding: 10px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; margin: 8px 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.task { font-weight: 600; margin: 4px 0 8px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 760px) { .pair { grid-template-columns: 1fr; } }
.answer h4 { margin: 4px 0; font-size: 14px; }
.check { border-top: 1px solid var(--line); padding: 8px 0; }
.criterion { font-size: 14px; margin-bottom: 6px; }
.kind { font-size: 12px; color: var(--muted); }
button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 6px; padding: 4px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.on.pass { background: var(--pass-bg); color: var(--pass); border-color: var(--pass); }
button.on.fail { background: var(--fail-bg); color: var(--fail); border-color: var(--fail); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.judge { font-size: 13px; color: var(--muted); margin-top: 6px; }
.agree { color: var(--pass); } .disagree { color: var(--fail); font-weight: 600; }
label.toggle { font-size: 13px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.empty { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <span class="meta" id="progress"></span>
  <span class="grow"></span>
  <label class="toggle"><input type="checkbox" id="blind" checked> <span id="blind-label"></span></label>
  <button class="primary" id="download"></button>
</header>
<main id="root"></main>
<script type="application/json" id="data">${json}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('data').textContent)
  const zh = (navigator.language || '').toLowerCase().startsWith('zh')
  const T = zh ? {
    title: 'autoharness 评分复核', blind: '标注前隐藏评分器结论', download: '下载标签', withSkill: '带技能的回答 (A)', baseline: '不带技能的回答 (B)',
    pass: '通过', fail: '不通过', task: '任务', evidence: '学到这条技能时的证据', skill: '技能内容', judge: '评分器', agree: '和你一致', disagree: '和你不一致',
    progress: (n, t) => '已标注 ' + n + ' / ' + t, hint: '按每条标准判断这条回答，评分器的结论会在你标完后显示。', saved: '没有新标签可下载。', none: '没有可复核的评估结果。',
    graders: (g) => g.labeled ? '评分器与已有标签一致 ' + g.agreed + '/' + g.labeled : '还没有人工标签',
    agentic: 'agent 回放', answerMode: '一次性回答', runA: '带技能的运行 (A)', runB: '不带技能的运行 (B)',
    stats: (t) => '工具调用 ' + t.calls + ' 次，失败 ' + t.failed + ' 次，' + t.seconds + ' 秒' + (t.error ? '，出错：' + t.error : ''),
  } : {
    title: 'autoharness grader review', blind: 'Hide grader verdicts until I label', download: 'Download labels', withSkill: 'Answer with the skill (A)', baseline: 'Answer without it (B)',
    pass: 'Pass', fail: 'Fail', task: 'Task', evidence: 'Evidence the skill was learned from', skill: 'Skill', judge: 'Grader', agree: 'agrees with you', disagree: 'disagrees with you',
    progress: (n, t) => n + ' / ' + t + ' labeled', hint: 'Judge each answer against each criterion. The grader verdict appears after you label.', saved: 'No new labels to download.', none: 'No eval results to review.',
    graders: (g) => g.labeled ? 'graders agree with ' + g.agreed + '/' + g.labeled + ' existing labels' : 'no human labels yet',
    agentic: 'agent replay', answerMode: 'one-shot answer', runA: 'Run with the skill (A)', runB: 'Run without it (B)',
    stats: (t) => t.calls + ' tool calls, ' + t.failed + ' failed, ' + t.seconds + 's' + (t.error ? ', error: ' + t.error : ''),
  }
  document.documentElement.lang = zh ? 'zh' : 'en'
  document.getElementById('title').textContent = T.title
  document.getElementById('blind-label').textContent = T.blind
  document.getElementById('download').textContent = T.download

  const storeKey = 'autoharness-review:' + data.project + ':' + data.skills.map((s) => s.run).join(',')
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem(storeKey) || '{}') } catch (e) { saved = {} }
  const prior = {}
  const keyOf = (skill, c, k, variant, answer) => [skill, c, k, variant, answer].join('\\u0000')
  for (const s of data.skills) for (const l of s.labels || []) prior[keyOf(s.skill, l.case, l.check, l.variant, l.answer)] = l.human
  const labels = Object.assign({}, prior, saved)
  const persist = () => { try { localStorage.setItem(storeKey, JSON.stringify(saved)) } catch (e) { /* storage may be unavailable on file:// */ } }

  const el = (tag, props, ...children) => {
    const node = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') node.className = v
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
      else node.setAttribute(k, v)
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child.nodeType ? child : document.createTextNode(String(child)))
    return node
  }

  const root = document.getElementById('root')
  const blind = document.getElementById('blind')
  const verdictNodes = []
  let total = 0

  function progress() {
    let n = 0
    for (const s of data.skills) for (const c of s.cases) for (const k of c.checks) for (const v of ['withSkill', 'baseline']) if (labels[keyOf(s.skill, c.id, k.id, v, c.hashes[v])] !== undefined) n++
    document.getElementById('progress').textContent = T.progress(n, total)
  }

  function judgeLine(verdict, key) {
    const node = el('div', { class: 'judge' })
    const render = () => {
      node.textContent = ''
      const human = labels[key]
      if (blind.checked && human === undefined) return
      node.append(T.judge + ': ' + (verdict.pass ? T.pass : T.fail) + ' · ' + verdict.why)
      if (human !== undefined) node.append(' ', el('span', { class: human === verdict.pass ? 'agree' : 'disagree' }, '(' + (human === verdict.pass ? T.agree : T.disagree) + ')'))
    }
    verdictNodes.push(render)
    render()
    return node
  }

  function checkRow(s, c, k, variant) {
    total++
    const key = keyOf(s.skill, c.id, k.id, variant, c.hashes[variant])
    const passBtn = el('button', { class: 'pass' }, T.pass)
    const failBtn = el('button', { class: 'fail' }, T.fail)
    const paint = () => {
      passBtn.classList.toggle('on', labels[key] === true)
      failBtn.classList.toggle('on', labels[key] === false)
    }
    const set = (value) => {
      if (labels[key] === value) { delete labels[key]; delete saved[key] } else { labels[key] = value; saved[key] = value }
      persist(); paint(); progress(); verdictNodes.forEach((f) => f())
    }
    passBtn.addEventListener('click', () => set(true))
    failBtn.addEventListener('click', () => set(false))
    paint()
    return el('div', { class: 'check' },
      el('div', { class: 'criterion' }, k.check, ' ', el('span', { class: 'kind' }, '(' + k.kind + ')')),
      el('div', {}, passBtn, ' ', failBtn),
      judgeLine(k.verdicts[variant], key))
  }

  if (data.skills.length === 0) root.append(el('p', { class: 'empty' }, T.none))
  root.append(el('p', { class: 'meta' }, T.hint))
  for (const s of data.skills) {
    const section = el('section', { class: 'skill' },
      el('h2', {}, s.skill),
      el('div', { class: 'meta' }, s.layer + ' · ' + (s.mode === 'agentic' ? T.agentic : T.answerMode) + ' · run ' + s.run + ' · ' + T.graders(s.graders || { labeled: 0 })),
      el('div', { class: 'meta' }, s.description),
      el('details', {}, el('summary', {}, T.skill), el('pre', {}, s.body)))
    for (const c of s.cases) {
      section.append(el('div', { class: 'card' },
        el('div', { class: 'meta' }, T.task + ' · ' + c.id),
        el('div', { class: 'task' }, c.task),
        c.evidenceText ? el('details', {}, el('summary', {}, T.evidence), el('pre', {}, c.evidenceText)) : null,
        el('div', { class: 'pair' },
          ['withSkill', 'baseline'].map((variant) => el('div', { class: 'answer' },
            el('h4', {}, s.mode === 'agentic' ? (variant === 'withSkill' ? T.runA : T.runB) : (variant === 'withSkill' ? T.withSkill : T.baseline)),
            c.traces ? el('div', { class: 'meta' }, T.stats(c.traces[variant])) : null,
            el('pre', {}, c.answers[variant]),
            c.checks.map((k) => checkRow(s, c, k, variant)))))))
    }
    root.append(section)
  }
  blind.addEventListener('change', () => verdictNodes.forEach((f) => f()))
  progress()

  document.getElementById('download').addEventListener('click', () => {
    const out = []
    for (const s of data.skills) for (const c of s.cases) for (const k of c.checks) for (const variant of ['withSkill', 'baseline']) {
      const key = keyOf(s.skill, c.id, k.id, variant, c.hashes[variant])
      if (labels[key] === undefined || prior[key] === labels[key]) continue
      out.push({ skill: s.skill, layer: s.layer, run: s.run, case: c.id, check: k.id, variant, answer: c.hashes[variant], human: labels[key], judge: k.verdicts[variant].pass })
    }
    if (out.length === 0) { alert(T.saved); return }
    const blob = new Blob([JSON.stringify({ format: 'autoharness-labels', version: 1, project: data.project, exportedAt: new Date().toISOString(), labels: out }, null, 2)], { type: 'application/json' })
    const a = el('a', { href: URL.createObjectURL(blob), download: 'autoharness-labels.json' })
    document.body.append(a); a.click(); a.remove()
  })
})()
</script>
</body>
</html>
`
}
