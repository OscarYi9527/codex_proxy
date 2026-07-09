const fs = require('fs')
let c = fs.readFileSync('F:/AI/codex_proxy/src/admin_app.js', 'utf8')

// Find the relay card loop: for(var ri=0;ri<relays.length;ri++){...}
// Replace the entire loop body with clean multi-line version

const oldLoopStart = "for(var ri=0;ri<relays.length;ri++){var relay=relays[ri],models=relay.models||['gpt-5.5','gpt-5.4','gpt-5.4-mini'];"
const newLoopStart = `for(var ri=0;ri<relays.length;ri++){` +
`var relay=relays[ri]` +
`,models=relay.models||['gpt-5.5','gpt-5.4','gpt-5.4-mini'];` +
`h+='<div class="relay-card"><div class="relay-card-header">';` +
`h+='<span class="provider-icon relay">R</span>';` +
`h+='<span class="name">'+esc(relay.name)+'</span>';` +
`h+='<span class="badge">'+esc(relay.id)+'</span>';` +
`h+='<span class="url">'+esc(relay.base_url)+'</span>';` +
`h+='<span style="font-size:11px;color:#484f58">Key: '+maskKey(relay.api_key)+'</span>';` +
`h+='<button class="ping-btn" id="ping_relay_'+relay.id+'" onclick="pingChannel(\\x27relay\\x27,\\x27'+relay.id+'\\x27)">🔍</button> <span id="res_ping_relay_'+relay.id+'" class="ping-result"></span>';` +
`h+='<button class="btn btn-sm btn-danger" onclick="removeRelay(\\x27'+relay.id+'\\x27)">删除</button>';` +
`h+='</div><div class="relay-card-models">';` +
`h+='<span style="font-size:10px;color:#484f58;margin-right:4px">模型:</span>';` +
`for(var mi=0;mi<models.length;mi++)h+='<span class="model-tag">'+esc(models[mi])+'</span>';` +
`h+='</div></div>'}`

// Find end of the old relay loop
const oldLoopEnd = "h+='</div></div>'}"
const idxEnd = c.indexOf(oldLoopEnd)
const idxStart = c.indexOf(oldLoopStart)

if (idxStart > 0 && idxEnd > 0) {
  const before = c.substring(0, idxStart)
  const after = c.substring(idxEnd + oldLoopEnd.length)
  c = before + newLoopStart + after
  fs.writeFileSync('F:/AI/codex_proxy/src/admin_app.js', c, 'utf8')
  console.log('Relay loop rewritten')
} else {
  console.log('Could not find loop boundaries. Start:', idxStart, 'End:', idxEnd)
}