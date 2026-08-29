// PostHog Engineer Impact — pure renderer of scores.json. No other runtime calls.
(function () {
  'use strict'

  function fmtDate(iso) {
    if (!iso) return ''
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v
      else if (k === 'html') e.innerHTML = v
      else e.setAttribute(k, v)
    }
    for (const c of children || []) {
      if (c == null) continue
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    }
    return e
  }

  function renderMethodology(data) {
    const m = data.methodology
    document.getElementById('conceptText').textContent = m.concept

    const weightsList = document.getElementById('weightsList')
    const rows = [
      ['durability', m.weights.durability],
      ['judgment', m.weights.judgment],
      ['breadth', m.weights.breadth],
    ]
    for (const [key, val] of rows) {
      weightsList.appendChild(
        el('li', {}, [el('span', { class: `swatch bar-seg ${key}` }), `${key[0].toUpperCase()}${key.slice(1)} — ${val}%`])
      )
    }

    const formulaList = document.getElementById('formulaList')
    const formulas = [
      ['Durability', m.durabilityFormula],
      ['Judgment', m.judgmentFormula],
      ['Breadth', m.breadthFormula],
      ['Noise filter', m.noiseFilter],
      ['Eligibility floor', `${m.eligibilityFloor}+ merged PRs in the window`],
    ]
    for (const [term, def] of formulas) {
      formulaList.appendChild(el('dt', {}, [term]))
      formulaList.appendChild(el('dd', {}, [def]))
    }

    const dirTableBody = document.querySelector('#dirTable tbody')
    const entries = Object.entries(m.directoryWeights).filter(([k]) => k !== '_default')
    entries.sort((a, b) => b[1] - a[1])
    for (const [dir, weight] of entries) {
      dirTableBody.appendChild(el('tr', {}, [el('td', {}, [String(weight)]), el('td', {}, [dir + '/'])]))
    }
    dirTableBody.appendChild(
      el('tr', {}, [el('td', {}, [String(m.directoryWeights._default)]), el('td', {}, ['everything else (default)'])])
    )

    const limitationsList = document.getElementById('limitationsList')
    for (const l of m.limitations || []) {
      limitationsList.appendChild(el('li', {}, [l]))
    }

    const toggle = document.getElementById('methodologyToggle')
    const body = document.getElementById('methodologyBody')
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true'
      toggle.setAttribute('aria-expanded', String(!expanded))
      body.hidden = expanded
    })
  }

  function segWidth(engineer, key) {
    return Math.max(0, engineer.pillars[key].weightedContribution)
  }

  function renderCard(engineer, rank) {
    const total = Math.round(engineer.total * 10) / 10
    const bar = el('div', { class: 'bar' }, [
      el('div', { class: 'bar-seg durability', style: `flex: ${segWidth(engineer, 'durability') || 0.001} 0 0` }),
      el('div', { class: 'bar-seg judgment', style: `flex: ${segWidth(engineer, 'judgment') || 0.001} 0 0` }),
      el('div', { class: 'bar-seg breadth', style: `flex: ${segWidth(engineer, 'breadth') || 0.001} 0 0` }),
    ])

    const detailRows = ['durability', 'judgment', 'breadth'].map((key) =>
      el('div', { class: 'detail-row' }, [
        el('span', { class: 'label' }, [el('span', { class: `swatch bar-seg ${key}` }), key[0].toUpperCase() + key.slice(1)]),
        el('span', {}, [`raw ${engineer.pillars[key].raw} · p${engineer.pillars[key].percentile}`]),
      ])
    )

    const prList = el(
      'ul',
      { class: 'pr-list' },
      (engineer.topPRs || []).map((pr) =>
        el('li', {}, [el('a', { href: pr.url, target: '_blank', rel: 'noopener' }, [`#${pr.number}`]), ` — ${pr.durabilityContribution} pts`])
      )
    )

    const detail = el('div', { class: 'card-detail', hidden: '' }, [...detailRows, el('div', { style: 'margin-top:6px;font-weight:700;color:var(--text-primary)' }, ['Top PRs']), prList])

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-rank' }, [`#${rank}`]),
      el('div', { class: 'card-name', title: engineer.name }, [engineer.name || engineer.login || engineer.authorEmail]),
      el('div', { class: 'card-total' }, [String(total)]),
      bar,
      detail,
    ])

    card.addEventListener('click', () => {
      detail.hidden = !detail.hidden
    })

    return card
  }

  function renderContextRow(engineer) {
    return el('tr', {}, [
      el('td', {}, [engineer.name || engineer.login || engineer.authorEmail]),
      el('td', {}, [String(Math.round(engineer.total * 10) / 10)]),
      el('td', {}, [String(engineer.pillars.durability.percentile)]),
      el('td', {}, [String(engineer.pillars.judgment.percentile)]),
      el('td', {}, [String(engineer.pillars.breadth.percentile)]),
    ])
  }

  fetch('scores.json')
    .then((r) => r.json())
    .then((data) => {
      document.getElementById('windowLabel').textContent = `${fmtDate(data.windowStart)} – ${fmtDate(data.windowEnd)} · 90-day window`
      document.getElementById('generatedAt').textContent = fmtDate(data.generatedAt)
      document.getElementById('eligibleCount').textContent = `${data.methodology.eligiblePoolSize} eligible engineers`

      renderMethodology(data)

      const top5 = data.engineers.slice(0, 5)
      const rest = data.engineers.slice(5)

      const cardsEl = document.getElementById('topCards')
      top5.forEach((e, i) => cardsEl.appendChild(renderCard(e, i + 1)))

      const contextBody = document.querySelector('#contextTable tbody')
      if (rest.length === 0) {
        document.querySelector('.context-list').hidden = true
      } else {
        rest.forEach((e) => contextBody.appendChild(renderContextRow(e)))
      }
    })
    .catch((err) => {
      document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#900">Failed to load scores.json: ${String(err)}</div>`
    })
})()
