const API='/admin/api/config'
let cfg={}
let activeTab='config'
let statsData=null
let editingRelay=null

const NAV_TABS=[
  {id:'config',icon:'⚙',label:'配置'},
  {id:'relays',icon:'🛰️',label:'中转站'},
  {id:'stats',icon:'📊',label:'统计'}
]

async function load(){
  try{
    const[cfgR,statsR]=await Promise.all([fetch(API),fetch('/admin/api/stats')])
    cfg=(await cfgR.json()).config
    statsData=await statsR.json()
    render()
    document.getElementById('status').innerHTML='<span class="status-dot ok"></span>运行中'
  }catch(e){
    document.getElementById('status').innerHTML='<span class="status-dot err"></span>代理离线'
    document.getElementById('app').innerHTML='<div class="section"><div class="section-body empty-state"><div class="icon">⚠</div><div>无法连接代理服务</div></div></div>'
  }
}

async function pingChannel(type,relayId){
  var btnId='ping_'+type+(relayId?'_'+relayId:'')
  var resId='res_'+btnId
  var btn=document.getElementById(btnId)
  var res=document.getElementById(resId)
  if(btn){btn.className='ping-btn testing';btn.textContent='测试中...'}
  if(res){res.textContent='';res.className='ping-result'}
  try{
    var body={type:type}
    if(relayId)body.relayId=relayId
    var r=await fetch('/admin/api/ping',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    var d=await r.json()
    var ok=d.ok
    if(btn){btn.className='ping-btn '+(ok?'ok':'fail');btn.textContent=ok?'✓ 正常':'✗ 失败'}
    if(res){res.textContent=(ok?(d.note||''):(d.error||''))+' ('+d.latency+'ms)'+(d.status?' HTTP '+d.status:'');res.className='ping-result '+(ok?'ok':'fail')}
  }catch(e){
    if(btn){btn.className='ping-btn fail';btn.textContent='✗ 错误'}
    if(res){res.textContent=e.message;res.className='ping-result fail'}
  }
}

async function pingAll(){
  var btn=document.getElementById('ping_all')
  if(btn){btn.className='ping-btn-all btn testing';btn.textContent='⏳ 全通道测试中...'}
  try{
    var r=await fetch('/admin/api/ping-all',{method:'POST'})
    var d=await r.json()
    if(btn){btn.className='ping-btn-all btn '+(d.allOk?'btn-primary':'btn-danger');btn.textContent=d.allOk?'✓ 全部正常':'✗ '+Object.values(d.results||{}).filter(function(v){return !v.ok}).length+' 个失败'}
    for(var key in d.results||{}){
      var val=d.results[key]
      var type=key.replace(':','_')
      var b=document.getElementById('ping_'+type)
      var r2=document.getElementById('res_ping_'+type)
      if(b){b.className='ping-btn '+(val.ok?'ok':'fail');b.textContent=val.ok?'✓ 正常':'✗ 失败'}
      if(r2){r2.textContent=(val.ok?(val.note||''):(val.error||''))+' ('+val.latency+'ms)';r2.className='ping-result '+(val.ok?'ok':'fail')}
    }
  }catch(e){
    if(btn){btn.className='ping-btn-all btn btn-danger';btn.textContent='✗ 测试失败'}
  }
}

function switchTab(tab){
  activeTab=tab
  editingRelay=null
  if(tab==='stats')load()
  else render()
}

function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function maskKey(k){if(!k||k.length<=6)return k||'';return k.slice(0,6)+'*'.repeat(k.length-6)}

function field(name,label,type,placeholder,hint){
  var val=cfg[name]||''
  var isKey=type==='password'
  var id='f_'+name
  var h='<div class="form-row"><label>'+label+'</label>'
  h+='<input id="'+id+'" type="'+(isKey?'password':'text')+'" value="'+esc(val)+'" placeholder="'+(placeholder||'')+'"'
  h+=(isKey?' class="key-field"':'')+'>'
  if(isKey)h+='<button class="btn btn-sm" type="button" onclick="toggleKey(\x27'+id+'\x27)">显示</button>'
  if(hint)h+='<span style="font-size:10px;color:#484f58">'+hint+'</span>'
  h+='</div>'
  return h
}

function openaiUpstreamField(){
  var current=cfg.openaiApiUpstream||'official'
  var relays=cfg.relays||[]
  var h='<div class="form-row"><label>上游</label>'
  h+='<select id="f_openaiApiUpstream">'
  h+='<option value="official"'+(current==='official'?' selected':'')+'>官方 api.openai.com</option>'
  for(var i=0;i<relays.length;i++){
    var r=relays[i]
    var val='relay:'+r.id
    h+='<option value="'+esc(val)+'"'+(current===val?' selected':'')+'>使用中转站: '+esc(r.name)+'</option>'
  }
  h+='</select>'
  var activeLabel=current==='official'?'官方':(function(){
    var found=relays.find(function(r){return 'relay:'+r.id===current})
    return found?('中转站 · '+found.name):'未知中转站 ('+current+')'
  })()
  h+='<span class="upstream-badge">当前生效: <b>'+esc(activeLabel)+'</b></span>'
  h+='</div>'
  return h
}

function toggleKey(id){
  var el=document.getElementById(id)
  var btn=el.nextElementSibling
  if(el.type==='password'){el.type='text';btn.textContent='隐藏'}
  else{el.type='password';btn.textContent='显示'}
}

function section(icon,title,fields,pingType,extraHtml){
  var h='<div class="section"><div class="section-header">'
  h+='<span class="provider-icon '+icon+'">'+icon[0].toUpperCase()+'</span>'+title
  if(pingType){
    h+='<button id="ping_'+pingType+'" class="ping-btn" onclick="pingChannel(\x27'+pingType+'\x27)">🔍</button>'
    h+='<span id="res_ping_'+pingType+'" class="ping-result"></span>'
  }
  h+='</div><div class="section-body">'
  for(var fi=0;fi<fields.length;fi++){
    var f=fields[fi]
    h+=field(f.name,f.label,f.type||'text',f.placeholder||'',f.hint||'')
  }
  if(extraHtml)h+=extraHtml
  h+='</div></div>'
  return h
}

function renderRelays(){
  var relays=cfg.relays||[]
  var h='<div class="section"><div class="section-header">'
  h+='<span class="provider-icon relay">R</span>中转站管理<span class="badge">'+relays.length+' 个</span>'
  h+='<button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="showAddRelay()">+ 添加中转站</button>'
  h+='</div><div class="section-body">'
  if(relays.length===0){
    h+='<div class="empty-state"><div class="icon">🛰️</div>'
    h+='<div style="color:#8b949e;margin-bottom:8px">还没有配置中转站</div>'
    h+='<div style="font-size:12px;color:#484f58">添加 OpenAI 兼容的第三方 API 端点，实现多线路备份</div>'
    h+='<div style="margin-top:12px"><button class="btn btn-primary btn-sm" onclick="showAddRelay()">+ 添加第一个中转站</button></div></div>'
  }
  for(var ri=0;ri<relays.length;ri++){
    var relay=relays[ri]
    var models=relay.models||['gpt-5.5','gpt-5.4','gpt-5.4-mini']
    h+='<div class="relay-card">'
    h+='<div class="relay-card-header">'
    h+='<span class="provider-icon relay">R</span>'
    h+='<span class="name">'+esc(relay.name)+'</span>'
    h+='<span class="badge">'+esc(relay.id)+'</span>'
    h+='<span class="url">'+esc(relay.base_url)+'</span>'
    h+='<span style="font-size:11px;color:#484f58">Key: '+maskKey(relay.api_key)+'</span>'
    h+='<button class="ping-btn" id="ping_relay_'+relay.id+'" onclick="pingChannel(\x27relay\x27,\x27'+relay.id+'\x27)">🔍</button>'
    h+='<span id="res_ping_relay_'+relay.id+'" class="ping-result"></span>'
    h+='<button class="btn btn-sm" onclick="showEditRelay(\x27'+relay.id+'\x27)">编辑</button>'
    h+='<button class="btn btn-sm btn-danger" onclick="removeRelay(\x27'+relay.id+'\x27)">删除</button>'
    h+='</div>'
    h+='<div class="relay-card-models">'
    h+='<span style="font-size:10px;color:#484f58;margin-right:4px">模型:</span>'
    for(var mi=0;mi<models.length;mi++){
      h+='<span class="model-tag">'+esc(models[mi])+'</span>'
    }
    h+='</div></div>'
  }
  h+='</div></div>'
  return h
}

function showAddRelay(){editingRelay={id:'',name:'',base_url:'https://api.openai.com/v1',api_key:'',models:'gpt-5.5,gpt-5.4,gpt-5.4-mini'};renderRelayModal()}
function showEditRelay(id){
  var relay=(cfg.relays||[]).find(function(r){return r.id===id})
  if(!relay)return
  editingRelay={id:relay.id,name:relay.name,base_url:relay.base_url,api_key:relay.api_key,models:(relay.models||[]).join(',')}
  renderRelayModal()
}

function renderRelayModal(){
  if(!editingRelay)return
  var isNew=!(cfg.relays||[]).find(function(r){return r.id===editingRelay.id})
  var overlay=document.createElement('div')
  overlay.className='modal-overlay'
  overlay.onclick=function(e){if(e.target===overlay){overlay.remove();editingRelay=null}}
  overlay.innerHTML='<div class="modal"><h3>'+(isNew?'添加中转站':'编辑中转站')+'</h3>'
    +'<div class="form-row"><label>标识 ID</label><input id="relay_id" value="'+esc(editingRelay.id)+'" placeholder="如: myproxy" '+(isNew?'':'readonly')+'></div>'
    +'<div class="form-row"><label>名称</label><input id="relay_name" value="'+esc(editingRelay.name)+'" placeholder="如: 我的中转站"></div>'
    +'<div class="form-row"><label>API 地址</label><input id="relay_url" value="'+esc(editingRelay.base_url)+'" placeholder="https://api.openai.com/v1"></div>'
    +'<div class="form-row"><label>API Key</label><input id="relay_key" type="password" class="key-field" value="'+esc(editingRelay.api_key)+'" placeholder="sk-..."></div>'
    +'<div class="form-row"><label>模型列表</label><input id="relay_models" value="'+esc(editingRelay.models)+'" placeholder="gpt-5.5,gpt-5.4,gpt-5.4-mini"><span style="font-size:10px;color:#484f58">逗号分隔</span></div>'
    +'<div class="modal-actions"><button class="btn" onclick="this.closest(\x27.modal-overlay\x27).remove();editingRelay=null">取消</button>'
    +'<button class="btn btn-primary" onclick="saveRelay()">保存</button></div></div>'
  document.body.appendChild(overlay)
}

async function saveRelay(){
  var relay={
    id:document.getElementById('relay_id').value.trim(),
    name:document.getElementById('relay_name').value.trim(),
    base_url:document.getElementById('relay_url').value.trim().replace(/\/+$/,''),
    api_key:document.getElementById('relay_key').value.trim(),
    models:document.getElementById('relay_models').value.split(',').map(function(s){return s.trim()}).filter(Boolean)
  }
  if(!relay.id||!relay.name||!relay.base_url){
    showToast('ID、名称和API地址不能为空','error')
    return
  }
  try{
    var r=await fetch('/admin/api/relays',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(relay)})
    if(!r.ok)throw new Error((await r.json()).error?.message||'保存失败')
    var data=await r.json()
    cfg=data.config
    document.querySelector('.modal-overlay')?.remove()
    editingRelay=null
    render()
    showToast('中转站已保存','success')
  }catch(e){showToast(e.message,'error')}
}

async function removeRelay(id){
  if(!confirm('确定删除 "'+id+'" 吗？'))return
  try{
    var r=await fetch('/admin/api/relays/'+encodeURIComponent(id),{method:'DELETE'})
    if(!r.ok)throw new Error((await r.json()).error?.message||'删除失败')
    var data=await r.json()
    cfg=data.config
    render()
    showToast('中转站已删除','success')
  }catch(e){showToast(e.message,'error')}
}

function fmtTok(n){if(!n||n===0)return'0';if(n>=1000000)return(n/1e6).toFixed(1)+'M';if(n>=1000)return(n/1e3).toFixed(1)+'K';return String(n)}

function statBar(input,output){
  var total=Math.max(1,input+output)
  var inPct=Math.round(input/total*100)
  return '<div class="stat-bar-track"><div class="stat-bar-fill" style="width:'+inPct+'%;background:#58a6ff"></div></div>'
    +'<div style="font-size:10px;color:#484f58">输入 '+inPct+'% · 输出 '+(100-inPct)+'%</div>'
}

// 纵向柱状图：单指标跨通道对比（如各通道请求次数）
function svgBarsVertical(items){
  var W=520,H=200,padL=42,padR=10,padT=14,padB=34
  var max=1
  for(var i=0;i<items.length;i++)max=Math.max(max,items[i].value)
  var innerW=W-padL-padR,innerH=H-padT-padB
  var bw=innerW/Math.max(1,items.length)
  var grid='',bars=''
  var steps=4
  for(var s=0;s<=steps;s++){
    var y=padT+innerH*(1-s/steps)
    var val=Math.round(max*s/steps)
    grid+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="var(--border)" stroke-width="1"/>'
    grid+='<text x="'+(padL-6)+'" y="'+(y+3)+'" font-size="9" fill="var(--text-faint)" text-anchor="end">'+fmtTok(val)+'</text>'
  }
  for(var i=0;i<items.length;i++){
    var it=items[i]
    var h=innerH*(it.value/max)
    var x=padL+i*bw+bw*0.22
    var w=bw*0.56
    var y=H-padB-h
    bars+='<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+Math.max(0,h)+'" rx="3" fill="'+it.color+'"/>'
    bars+='<text x="'+(x+w/2)+'" y="'+(H-padB+14)+'" font-size="9" fill="var(--text-dim)" text-anchor="middle">'+esc(it.label)+'</text>'
    bars+='<text x="'+(x+w/2)+'" y="'+(y-4)+'" font-size="9" fill="var(--text)" text-anchor="middle">'+it.value+'</text>'
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'">'+grid+bars+'</svg>'
}

// 横向柱状图：每行输入/输出 token 双条对比
function svgBarsHorizontal(items){
  var W=520,rowH=36,padL=94,padR=52,padT=10
  var H=padT*2+items.length*rowH
  var max=1
  for(var i=0;i<items.length;i++)max=Math.max(max,items[i].input,items[i].output)
  var scale=(W-padL-padR)/max
  var rows=''
  for(var i=0;i<items.length;i++){
    var it=items[i]
    var y=padT+i*rowH
    var wIn=Math.max(0,it.input*scale)
    var wOut=Math.max(0,it.output*scale)
    rows+='<text x="'+(padL-8)+'" y="'+(y+13)+'" font-size="10" fill="var(--text-dim)" text-anchor="end">'+esc(it.label)+'</text>'
    rows+='<rect x="'+padL+'" y="'+y+'" width="'+wIn+'" height="10" rx="2" fill="var(--accent)"/>'
    rows+='<text x="'+(padL+wIn+5)+'" y="'+(y+9)+'" font-size="9" fill="var(--text-faint)">'+fmtTok(it.input)+'</text>'
    rows+='<rect x="'+padL+'" y="'+(y+15)+'" width="'+wOut+'" height="10" rx="2" fill="var(--ok)"/>'
    rows+='<text x="'+(padL+wOut+5)+'" y="'+(y+24)+'" font-size="9" fill="var(--text-faint)">'+fmtTok(it.output)+'</text>'
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'">'+rows+'</svg>'
}

// 折线图：输入/输出 token 占比跨通道对比（无时间轴，用于多维度对比）
function svgLineChart(items){
  if(items.length<2){
    return '<div style="font-size:12px;color:var(--text-faint);padding:20px 0;text-align:center">通道数不足，暂无法进行趋势对比</div>'
  }
  var W=520,H=180,padL=36,padR=14,padT=14,padB=30
  var innerW=W-padL-padR,innerH=H-padT-padB
  var n=items.length
  var stepX=innerW/(n-1)
  var pts=[]
  for(var i=0;i<n;i++){
    var it=items[i]
    var total=Math.max(1,it.input+it.output)
    pts.push({inPct:it.input/total*100,outPct:it.output/total*100})
  }
  function y(v){return padT+innerH*(1-v/100)}
  var grid=''
  for(var s=0;s<=4;s++){
    var yy=padT+innerH*(1-s/4)
    grid+='<line x1="'+padL+'" y1="'+yy+'" x2="'+(W-padR)+'" y2="'+yy+'" stroke="var(--border)" stroke-width="1"/>'
    grid+='<text x="'+(padL-6)+'" y="'+(yy+3)+'" font-size="9" fill="var(--text-faint)" text-anchor="end">'+(s*25)+'%</text>'
  }
  var pathIn='',pathOut='',dotsIn='',dotsOut='',labels=''
  for(var i=0;i<n;i++){
    var x=padL+i*stepX
    pathIn+=(i===0?'M':'L')+' '+x+' '+y(pts[i].inPct)+' '
    pathOut+=(i===0?'M':'L')+' '+x+' '+y(pts[i].outPct)+' '
    dotsIn+='<circle cx="'+x+'" cy="'+y(pts[i].inPct)+'" r="3" fill="var(--accent)"/>'
    dotsOut+='<circle cx="'+x+'" cy="'+y(pts[i].outPct)+'" r="3" fill="var(--ok)"/>'
    labels+='<text x="'+x+'" y="'+(H-padB+14)+'" font-size="9" fill="var(--text-dim)" text-anchor="middle">'+esc(items[i].label)+'</text>'
  }
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'">'+grid
    +'<path d="'+pathIn+'" fill="none" stroke="var(--accent)" stroke-width="2"/>'+dotsIn
    +'<path d="'+pathOut+'" fill="none" stroke="var(--ok)" stroke-width="2"/>'+dotsOut
    +labels+'</svg>'
}

function renderStats(){
  var h=''
  var provs=statsData?.providers||{}
  var entries=Object.entries(provs)

  if(entries.length===0){
    return '<div class="section"><div class="section-body empty-state">'
      +'<div class="icon">📊</div>'
      +'<div style="color:#8b949e">暂无使用数据</div>'
      +'<div style="font-size:12px;color:#484f58">请求统计将在代理处理请求后自动显示</div>'
      +'</div></div>'
  }

  var totalReq=0,totalIn=0,totalOut=0
  entries.forEach(function(e){totalReq+=e[1].requests||0;totalIn+=e[1].input_tokens||0;totalOut+=e[1].output_tokens||0})

  h+='<div class="kpi-grid">'
  h+='<div class="kpi-card"><div class="label">总请求数</div><div class="value">'+totalReq+'</div></div>'
  h+='<div class="kpi-card"><div class="label">总输入 tokens</div><div class="value">'+fmtTok(totalIn)+'</div></div>'
  h+='<div class="kpi-card"><div class="label">总输出 tokens</div><div class="value">'+fmtTok(totalOut)+'</div></div>'
  h+='<div class="kpi-card"><div class="label">活跃通道数</div><div class="value">'+entries.length+'</div></div>'
  h+='</div>'

  var chartItems=entries.map(function(e){
    return {label:e[0],value:e[1].requests||0,input:e[1].input_tokens||0,output:e[1].output_tokens||0}
  })
  h+='<div class="section"><div class="section-header">📈 通道对比</div><div class="section-body">'
  h+='<div class="chart-row">'
  h+='<div class="chart-col"><div class="chart-title">各通道请求次数对比（柱状图）</div>'
    +svgBarsVertical(chartItems.map(function(c){return{label:c.label,value:c.value,color:'var(--accent)'}}))+'</div>'
  h+='<div class="chart-col"><div class="chart-title">各通道输入/输出 Token 对比（横向柱状图）</div>'
    +svgBarsHorizontal(chartItems)
    +'<div class="chart-legend"><span><span class="dot" style="background:var(--accent)"></span>输入</span><span><span class="dot" style="background:var(--ok)"></span>输出</span></div>'
    +'</div>'
  h+='</div>'
  h+='<div class="chart-title" style="margin-top:6px">各通道输入/输出 Token 占比对比（折线图）</div>'
  h+=svgLineChart(chartItems)
  if(chartItems.length>=2){
    h+='<div class="chart-legend"><span><span class="dot" style="background:var(--accent)"></span>输入占比</span><span><span class="dot" style="background:var(--ok)"></span>输出占比</span></div>'
  }
  h+='</div></div>'

  h+='<div class="chart-title" style="margin:4px 2px 10px;font-size:13px;color:var(--text)">详细数据统计</div>'
  for(var ei=0;ei<entries.length;ei++){
    var name=entries[ei][0]
    var prov=entries[ei][1]
    var icon=name[0].toUpperCase()
    var iconClass=name.includes('relay')?'relay':(['chatgpt-sub','deepseek','openai-api'].includes(name)?name:'relay')
    var totalTokens=(prov.input_tokens||0)+(prov.output_tokens||0)
    h+='<div class="section"><div class="section-header">'
    h+='<span class="provider-icon '+iconClass+'">'+icon+'</span>'
    h+=esc(name)+'<span class="badge">'+prov.requests+' 次</span>'
    h+='<span style="margin-left:auto;font-size:12px;color:#8b949e">合计 '+fmtTok(totalTokens)+' tokens</span>'
    h+='</div><div class="section-body">'
    h+=statBar(prov.input_tokens||0,prov.output_tokens||0)
    h+='<div style="display:flex;gap:24px;margin:12px 0;font-size:12px;color:#8b949e">'
    h+='<span>输入: <b style="color:#c9d1d9">'+fmtTok(prov.input_tokens||0)+'</b></span>'
    h+='<span>输出: <b style="color:#c9d1d9">'+fmtTok(prov.output_tokens||0)+'</b></span>'
    h+='<span>平均: <b style="color:#c9d1d9">'+fmtTok(Math.round(totalTokens/Math.max(1,prov.requests)))+'/次</b></span>'
    h+='</div>'
    var models=Object.entries(prov.models||{}).sort(function(a,b){return(b[1].requests||0)-(a[1].requests||0)})
    if(models.length){
      h+='<table style="width:100%;border-collapse:collapse;font-size:12px">'
      h+='<thead><tr style="color:#8b949e;text-align:left">'
      h+='<th style="padding:4px 8px">模型</th>'
      h+='<th style="padding:4px 8px;text-align:right">请求</th>'
      h+='<th style="padding:4px 8px;text-align:right">输入</th>'
      h+='<th style="padding:4px 8px;text-align:right">输出</th>'
      h+='<th style="padding:4px 8px;text-align:right">合计</th>'
      h+='</tr></thead><tbody>'
      for(var mi=0;mi<models.length;mi++){
        var model=models[mi][0]
        var m=models[mi][1]
        h+='<tr style="border-top:1px solid #21262d">'
        h+='<td style="padding:6px 8px;font-family:monospace">'+esc(model)+'</td>'
        h+='<td style="padding:6px 8px;text-align:right">'+m.requests+'</td>'
        h+='<td style="padding:6px 8px;text-align:right">'+fmtTok(m.input_tokens||0)+'</td>'
        h+='<td style="padding:6px 8px;text-align:right">'+fmtTok(m.output_tokens||0)+'</td>'
        h+='<td style="padding:6px 8px;text-align:right;font-weight:600">'+fmtTok((m.input_tokens||0)+(m.output_tokens||0))+'</td>'
        h+='</tr>'
      }
      h+='</tbody></table>'
    }
    h+='</div></div>'
  }
  h+='<div style="text-align:right;margin-top:8px;font-size:11px;color:#484f58">更新于: '+(statsData?.updated||'').slice(0,19)+'</div>'
  return h
}

function renderNav(){
  var h=''
  for(var i=0;i<NAV_TABS.length;i++){
    var t=NAV_TABS[i]
    h+='<button class="nav-btn'+(activeTab===t.id?' active':'')+'" onclick="switchTab(\x27'+t.id+'\x27)"><span class="nav-icon">'+t.icon+'</span>'+t.label+'</button>'
  }
  var navEl=document.getElementById('nav')
  if(navEl)navEl.innerHTML=h
  var titles={config:'配置',relays:'中转站管理',stats:'使用统计'}
  var titleEl=document.getElementById('topbar-title')
  if(titleEl)titleEl.textContent=titles[activeTab]||''
}

function render(){
  renderNav()
  var html=''
  if(activeTab==='config'){
    html+=section('chatgpt-sub','ChatGPT 订阅通道 (gpt-* 模型)',[
      {name:'chatgptResponsesUrl',label:'Responses URL',placeholder:'https://chatgpt.com/backend-api/codex/responses'}],'chatgpt-sub')
    html+=section('deepseek','DeepSeek 通道 (默认模型)',[
      {name:'deepseekApiKey',label:'API Key',type:'password',placeholder:'sk-...'},
      {name:'upstreamUrl',label:'Anthropic URL',placeholder:'https://api.deepseek.com/anthropic/v1/messages'},
      {name:'defaultModel',label:'默认模型',placeholder:'deepseek-v4-pro'}],'deepseek')
    html+=section('openai-api','OpenAI 官方 API (openai-api-* 模型)',[
      {name:'openaiApiKey',label:'API Key (官方)',type:'password',placeholder:'sk-...'},
      {name:'openaiOrgId',label:'组织 ID',placeholder:'org-...'},
      {name:'openaiProjectId',label:'项目 ID',placeholder:'proj-...'},
      {name:'openaiApiBaseUrl',label:'Base URL (官方)',placeholder:'https://api.openai.com/v1'},
      {name:'openaiApiResponsesUrl',label:'Responses URL',placeholder:'留空 = Base URL + /responses'},
      {name:'openaiApiChatCompletionsUrl',label:'Chat Completions URL',placeholder:'留空 = Base URL + /chat/completions'}],'openai-api',openaiUpstreamField())
    html+='<div class="actions"><button class="btn btn-primary" onclick="save()">💾 保存并热重载</button></div>'
  }else if(activeTab==='relays'){
    html+=renderRelays()
  }else{
    html+=renderStats()
  }
  document.getElementById('app').innerHTML=html
}

function collect(){
  var fields={}
  document.querySelectorAll('input[id^="f_"]').forEach(function(el){fields[el.id.slice(2)]=el.value})
  document.querySelectorAll('select[id^="f_"]').forEach(function(el){fields[el.id.slice(2)]=el.value})
  return fields
}

async function save(){
  try{
    var r=await fetch('/admin/api/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(collect())})
    if(!r.ok)throw new Error((await r.json()).error?.message||'保存失败')
    var data=await r.json()
    cfg=data.config
    render()
    showToast('配置已保存并热重载','success')
  }catch(e){showToast(e.message,'error')}
}

function showToast(msg,type){
  var t=document.createElement('div')
  t.className='toast '+type
  t.textContent=msg
  document.body.appendChild(t)
  setTimeout(function(){t.remove()},3000)
}

load()
