function renderAccounts(){
  const accounts=cfg.chatgptAccounts||[]
  const threshold=Number(cfg.chatgptLowQuotaThreshold??10)
  const remainingOf=a=>{
    const values=[a.usage&&a.usage.primary,a.usage&&a.usage.secondary].filter(Boolean).map(w=>w.remaining_percent==null?(w.used_percent==null?null:100-Number(w.used_percent)):Number(w.remaining_percent)).filter(Number.isFinite)
    return values.length?Math.min(...values):null
  }
  const activeId=cfg.activeChatgptAccountId
  const activeLabel=accounts.find(a=>a.id===activeId)
  const available=accounts.filter(a=>(a.status==='active'||!a.status)&&a.routing_enabled!==false&&(remainingOf(a)==null||remainingOf(a)>threshold)).length
  const resetTotal=accounts.reduce((sum,a)=>sum+Number(a.reset_credits?.available_count||0),0)
  const beijingTime=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})
  const cards=accounts.map((a,index)=>{
    const label=a.label||a.email||'ChatGPT 账号'
    const initials=Array.from(label.trim()).slice(0,2).join('').toUpperCase()||'AI'
    const isActive=a.id===activeId
    const routeEnabled=a.routing_enabled!==false
    const remaining=remainingOf(a)
    const accountReserve=Number(a.low_quota_threshold??threshold),atReserve=remaining!=null&&remaining<=accountReserve
    const usageStale=!a.usage_updated_at||(Date.now()-new Date(a.usage_updated_at).getTime()>30*60*1000)
    const modelCooldownCount=Object.values(a.model_cooldowns||{}).filter(until=>Number(until)>Date.now()).length
    const health=(statsData.accounts||{})[a.id]||{}
    const runtime=(diagnosticsData.accounts||[]).find(item=>item.id===a.id)||{}
    const oneHour=health.windows&&health.windows['1h']
    const day=health.windows&&health.windows['24h']
    const week=health.windows&&health.windows['7d']
    const rangeHealth=health.windows?.[healthRange]||health
    const successRate=rangeHealth.requests?`${Number(rangeHealth.success_rate||0).toFixed(1)}%`:'—'
    const requestCount=rangeHealth.requests?fmt(rangeHealth.requests):'—'
    const p95=rangeHealth.requests?`${fmt(rangeHealth.p95_latency_ms)} ms`:'—'
    const concurrency=`${runtime.active_requests||0}/${runtime.concurrency_limit||3}`
    const routeLabel=!routeEnabled?'仅保存':a.status==='cooldown'?'冷却中':a.status==='auth_error'?'登录失效':atReserve?'额度保护':'参与路由'
    const routeTone=!routeEnabled||a.status==='auth_error'?'off':a.status==='cooldown'||atReserve?'warn':'ok'
    const reset=a.reset_credits
    const resetCount=reset?Number(reset.available_count||0):null
    const resetExpiry=(reset?.expires_at||[])[0]
    const resetDisabled=resetCount==null||resetCount<=0
    const resetDetail=a.reset_credits_error
      ? `查询失败：${esc(a.reset_credits_error)}`
      : resetExpiry
        ? `最近到期：${esc(beijingTime(resetExpiry))}`
        : reset
          ? '当前没有可用重置次数'
          : '尚未查询重置次数'
    const hue=205+(index*47)%120
    return `<article class="account-profile-card ${routeTone==='off'?'is-muted':''}" style="--account-hue:${hue}" draggable="true" data-account-id="${esc(a.id)}" ondragstart="startAccountDrag(event,'${esc(a.id)}')" ondragover="event.preventDefault()" ondrop="dropAccount(event,'${esc(a.id)}')">
      <header class="account-profile-head">
        <div class="account-profile-main">
          <span class="account-rank drag-handle" title="拖拽调整优先级">${index+1}</span>
          <div class="account-avatar">${esc(initials)}</div>
          <div class="account-title">
            <div><strong>${esc(label)}</strong><span class="account-state ${routeTone}"><i></i>${routeLabel}</span></div>
            <small>${esc(a.plan_type||'套餐待同步')} · ${esc((a.account_id||a.id||'-').slice(0,24))}</small>
          </div>
        </div>
        <div class="account-head-actions">
          ${isActive?'<span class="account-local-badge">本机账号</span>':button('切换本机','arrow',`switchAccount('${esc(a.id)}')`,'btn-sm')}
          ${button(routeEnabled?'停用路由':'启用路由',routeEnabled?'x':'check',`toggleAccountRouting('${esc(a.id)}',${routeEnabled?'false':'true'})`,'btn-sm')}
        </div>
      </header>
      <div class="account-profile-body">
        <section class="account-card-section quota-section">
          <div class="account-section-head"><div><span>额度状态</span><small>${usageStale?'数据可能已过期':'最近数据有效'}</small></div><button class="account-link" onclick="refreshAccountUsageOne('${esc(a.id)}')">${svg('refresh')}刷新</button></div>
          <div class="account-quota-grid">
            <div class="account-quota-tile"><div class="account-tile-label"><span>5 小时</span><small>${!a.usage?.primary&&a.usage_sync_status==='synced'?'当前暂停':'短周期'}</small></div>${usageWindowHtml(a.usage&&a.usage.primary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.primary)}</div>
            <div class="account-quota-tile"><div class="account-tile-label"><span>1 周</span><small>长周期</small></div>${usageWindowHtml(a.usage&&a.usage.secondary,a)}${usageForecastHtml(a.usage_forecast&&a.usage_forecast.secondary)}</div>
          </div>
        </section>
        <section class="account-card-section performance-section">
          <div class="account-section-head"><div><span>运行表现</span><small>${rangeHealth.requests?`${healthRange} 真实请求`:'等待请求样本'}</small></div></div>
          <div class="account-kpi-grid">
            <div><small>成功率</small><strong>${successRate}</strong></div>
            <div><small>请求数</small><strong>${requestCount}</strong></div>
            <div><small>P95 延迟</small><strong>${p95}</strong></div>
            <div><small>并发占用</small><strong>${concurrency}</strong></div>
          </div>
          <div class="account-performance-note">${oneHour||day||week?`1h ${oneHour?.success_rate==null?'—':oneHour.success_rate+'%'} · 24h ${day?.success_rate==null?'—':day.success_rate+'%'} · 7d ${week?.success_rate==null?'—':week.success_rate+'%'}`:'暂无分时健康数据'}${health.rate_limited?` · ${health.rate_limited} 次 429`:''}</div>
          ${health.trend_warning?`<div class="account-alert error">${esc(health.trend_warning.message)}</div>`:''}
        </section>
        <section class="account-card-section route-section">
          <div class="account-section-head"><div><span>调度设置</span><small>${isActive?'当前本机登录':'账号池托管账号'}</small></div></div>
          <div class="account-route-summary">
            <div><span class="account-state ${routeTone}"><i></i>${routeLabel}</span><small>${modelCooldownCount?`${modelCooldownCount} 个模型冷却`:'无模型冷却'}</small></div>
            <label><span>路由权重</span><input class="input" type="number" min="1" max="100" value="${Number(a.routing_weight)||1}" onchange="updateAccountWeight('${esc(a.id)}',this.value)" title="weighted 策略下生效"></label>
          </div>
          ${a.cooldown_until?`<div class="account-alert">预计恢复：${esc(beijingTime(a.cooldown_until))}</div>`:''}
          ${health.last_error_type?`<div class="account-alert error" title="${esc(health.last_error_message||health.last_error_type)}">最近错误：${esc(health.last_error_type)}${health.last_status?` · HTTP ${health.last_status}`:''}</div>`:''}
        </section>
      </div>
      <section class="account-reset-strip ${resetCount>0?'has-credit':''}">
        <div class="account-reset-icon">${svg('refresh')}</div>
        <div class="account-reset-copy">
          <span>Codex 额度重置 · <b class="reset-risk-label" style="color:var(--red);font-weight:800">高风险 / 不可撤销</b></span>
          <strong>${resetCount==null?'待查询':`${resetCount} 次可用`}</strong>
          <small>${resetDetail}${reset?.updated_at?` · 查询于 ${esc(beijingTime(reset.updated_at))}`:''}</small>
        </div>
        <div class="account-reset-actions">
          <button class="btn btn-sm" onclick="refreshAccountResetCreditsOne('${esc(a.id)}')">${svg('pulse')}查询次数</button>
          <button class="btn btn-sm btn-danger" ${resetDisabled?'disabled title="请先查询并确认有可用重置次数"':`onclick="openResetQuota('${esc(a.id)}')"`}>${svg('refresh')}重置额度</button>
        </div>
      </section>
      <footer class="account-profile-foot">
        <span>${a.usage_updated_at?`额度更新 ${esc(beijingTime(a.usage_updated_at))}`:'额度尚未同步'}</span>
        <div>
          <button class="account-link" onclick="openAccountPolicy('${esc(a.id)}')">${svg('shield')}额度策略</button>
          <button class="account-link" onclick="openRenameAccount('${esc(a.id)}')">${svg('edit')}修改名称</button>
          <button class="account-link danger" onclick="removeAccount('${esc(a.id)}')">${svg('trash')}移除账号</button>
        </div>
      </footer>
    </article>`
  }).join('')
  const compactRows=accounts.map((a,index)=>{
    const label=a.label||a.email||'ChatGPT 账号'
    const initials=Array.from(label.trim()).slice(0,2).join('').toUpperCase()||'AI'
    const isActive=a.id===activeId
    const routeEnabled=a.routing_enabled!==false
    const remaining=remainingOf(a)
    const accountReserve=Number(a.low_quota_threshold??threshold),atReserve=remaining!=null&&remaining<=accountReserve
    const runtime=(diagnosticsData.accounts||[]).find(item=>item.id===a.id)||{}
    const health=(statsData.accounts||{})[a.id]||{}
    const rangeHealth=health.windows?.[healthRange]||health
    const routeLabel=!routeEnabled?'仅保存':a.status==='cooldown'?'冷却中':a.status==='auth_error'?'登录失效':atReserve?'额度保护':'参与路由'
    const routeTone=!routeEnabled||a.status==='auth_error'?'off':a.status==='cooldown'||atReserve?'warn':'ok'
    const resetCount=a.reset_credits?Number(a.reset_credits.available_count||0):null
    const quotaResetText=window=>{
      if(!window)return '重置时间待同步'
      if(window.reset_after_seconds!=null)return formatDuration(window.reset_after_seconds)
      if(window.resets_at)return `${new Date(window.resets_at*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})} 重置`
      return '重置时间待同步'
    }
    const quotaBar=(name,window)=>{
      if(!window||window.used_percent==null){
        const unavailable=a.usage_sync_status==='synced'&&(a.usage?.primary||a.usage?.secondary)
        return `<div class="compact-quota is-empty"><span><b>${name}</b><em>${unavailable?'未提供':'待同步'}</em></span><i></i><small>${unavailable?'官方当前未提供此窗口':quotaResetText(window)}</small></div>`
      }
      const value=Math.max(0,Math.min(100,window.remaining_percent==null?100-Number(window.used_percent):Number(window.remaining_percent)))
      const tone=value<=10?'var(--red)':value<=30?'var(--amber)':'var(--green)'
      return `<div class="compact-quota" style="--quota-color:${tone}"><span><b>${name}</b><em>${value.toFixed(0)}%</em></span><i><b style="width:${value}%"></b></i><small>${quotaResetText(window)}</small></div>`
    }
    const hue=205+(index*47)%120
    return `<article class="account-compact-row ${routeTone==='off'?'is-muted':''}" style="--account-hue:${hue}" draggable="true" data-account-id="${esc(a.id)}" ondragstart="startAccountDrag(event,'${esc(a.id)}')" ondragover="event.preventDefault()" ondrop="dropAccount(event,'${esc(a.id)}')">
      <div class="compact-identity">
        <span class="account-rank drag-handle" title="拖拽调整优先级">${index+1}</span>
        <div class="account-avatar">${esc(initials)}</div>
        <div><strong>${esc(label)}</strong><small>${esc(a.plan_type||'套餐待同步')} · ${esc((a.account_id||a.id||'-').slice(0,16))}</small></div>
      </div>
      <div class="compact-quota-group">${quotaBar('5 小时',a.usage&&a.usage.primary)}${quotaBar('1 周',a.usage&&a.usage.secondary)}</div>
      <div class="compact-health">
        <div><small>${healthRange} 成功率</small><strong>${rangeHealth.requests?Number(rangeHealth.success_rate||0).toFixed(1)+'%':'—'}</strong></div>
        <div><small>P95 延迟</small><strong>${rangeHealth.requests?fmt(rangeHealth.p95_latency_ms)+' ms':'—'}</strong></div>
        <div><small>并发</small><strong>${runtime.active_requests||0}/${runtime.concurrency_limit||3}</strong></div>
      </div>
      <div class="compact-status">
        <span class="account-state ${routeTone}"><i></i>${routeLabel}</span>
        <small>重置次数 <b>${resetCount==null?'待查询':resetCount}</b>${resetCount>0?' · <em class="reset-risk-label" style="color:var(--red);font-style:normal;font-weight:800">高风险</em>':''}${isActive?' · 本机账号':''}</small>
      </div>
      <div class="compact-actions">
        ${!isActive?`<button title="切换为本机账号" onclick="switchAccount('${esc(a.id)}')">${svg('arrow')}</button>`:''}
        <button title="刷新额度" onclick="refreshAccountUsageOne('${esc(a.id)}')">${svg('refresh')}</button>
        <button title="查询重置次数" onclick="refreshAccountResetCreditsOne('${esc(a.id)}')">${svg('pulse')}</button>
        <button title="额度与预留策略" onclick="openAccountPolicy('${esc(a.id)}')">${svg('shield')}</button>
        ${resetCount>0?`<button class="danger" title="高风险：消耗 1 次并重置额度（不可撤销）" onclick="openResetQuota('${esc(a.id)}')">${svg('refresh')}</button>`:''}
        <button title="${routeEnabled?'停用路由':'启用路由'}" onclick="toggleAccountRouting('${esc(a.id)}',${routeEnabled?'false':'true'})">${svg(routeEnabled?'x':'check')}</button>
      </div>
    </article>`
  }).join('')
  const compactHeader=`<div class="account-compact-header" aria-hidden="true"><span>账号 / 优先级</span><span class="compact-header-quota"><b>额度状态</b><small><i>5 小时周期</i><i>1 周周期</i></small></span><span class="compact-col-health">运行表现</span><span>路由 / 重置次数</span><span>快捷操作</span></div>`
  const viewSwitch=`<div class="account-view-switch" role="group" aria-label="账号展示方式"><button class="${accountViewMode==='compact'?'active':''}" onclick="setAccountViewMode('compact')" title="条状简约型">${svg('list')}<span>简约</span></button><button class="${accountViewMode==='cards'?'active':''}" onclick="setAccountViewMode('cards')" title="卡片全面型">${svg('cards')}<span>全面</span></button></div>`
  const rangeSwitch=`<div class="account-view-switch" role="group" aria-label="健康时间范围">${['1h','24h','7d'].map(range=>`<button class="${healthRange===range?'active':''}" onclick="setHealthRange('${range}')"><span>${range}</span></button>`).join('')}</div>`
  const accountBoard=accounts.length
    ? `<section class="account-board"><div class="account-board-head"><div><span class="eyebrow">ACCOUNT POOL</span><h2>${accountViewMode==='compact'?'账号快速总览':'账号运行面板'}</h2><p>${accountViewMode==='compact'?'按列对齐比较额度、重置时间、性能和路由状态。':'拖拽左上角序号调整优先级；额度、健康度和高风险操作按功能分区。'}</p></div><div class="account-board-tools"><div class="account-board-legend"><span><i class="ok"></i>正常</span><span><i class="warn"></i>受限</span><span><i class="off"></i>停用</span></div>${rangeSwitch}${viewSwitch}</div></div>${accountViewMode==='compact'?`<div class="account-compact-list">${compactHeader}${compactRows}</div>`:`<div class="account-card-grid">${cards}</div>`}</section>`
    : card('账号池', '尚未添加订阅账号', empty('accounts','账号池为空','通过官方登录或导入 auth.json 即可启用自动轮换',button('官方安全登录','shield','openOfficialLogin()','btn-primary')))
  const actions=button('官方安全登录','shield','openOfficialLogin()','btn-primary')+button('导入 auth.json','plus','openAccount()')+button('刷新全部用量','refresh','refreshAllUsage()')+button('查询全部重置次数','pulse','refreshAllResetCredits()')+button('重启 Codex','refresh','restartCodex()')
  const strategyOptions=Object.entries(accountStrategyLabels).map(([value,label])=>`<option value="${value}" ${cfg.chatgptAccountStrategy===value?'selected':''}>${label}</option>`).join('')
  const strategyBody=`<section class="account-strategy-bar"><div class="account-strategy-copy"><span class="eyebrow">ROUTING POLICY</span><strong>请求分配策略</strong><small>控制新请求如何进入账号池</small></div><label><span>账号选择模式</span><select id="f_chatgptAccountStrategy">${strategyOptions}</select></label><label class="strategy-threshold"><span>低额度避让阈值</span><div><input class="input" id="f_chatgptLowQuotaThreshold" type="number" min="0" max="100" value="${Number(cfg.chatgptLowQuotaThreshold??10)}"><small>%</small></div></label>${button('保存策略','check','saveConfig()','btn-primary')}</section>`
  const decisions=diagnosticsData.recent_route_decisions||[]
  const decisionBody=decisions.length?`<div class="table-wrap"><table class="table"><thead><tr><th>时间 / Request ID</th><th>模型</th><th>结果</th><th>选择与跳过原因</th></tr></thead><tbody>${decisions.slice(0,15).map(item=>{const skipped=(item.accounts||[]).filter(account=>account.result==='skipped').slice(0,4);const result=item.selected_account_label?`选择 ${esc(item.selected_account_label)}`:item.outcome==='queue_timeout'?'排队超时':item.outcome==='client_disconnected'?'客户端已断开':'没有可用账号';return `<tr><td><div class="cell-main">${new Date(item.at).toLocaleTimeString('zh-CN')}</div><div class="cell-sub">${esc(item.request_id||'-')}</div></td><td>${esc(item.model||'-')}</td><td><div class="cell-main">${result}</div><div class="cell-sub">${item.queue_wait_ms?`等待 ${fmt(item.queue_wait_ms)} ms`:'无需等待'}</div></td><td>${skipped.length?skipped.map(account=>`<div class="cell-sub"><b>${esc(account.label||account.id)}</b>：${esc(account.reason)}</div>`).join(''):'<span class="cell-sub">没有账号被跳过</span>'}</td></tr>`}).join('')}</tbody></table></div>`:empty('pulse','暂无路由决策','发起一次 ChatGPT 订阅模型请求后，将显示账号选择和跳过原因')
  return pageHead('ChatGPT 账号池','以账号为中心查看额度、性能、调度和重置能力',actions)+`<div class="metrics">${metric('账号总数',accounts.length,'users','全部订阅账号')}${metric('有效账号',available,'check',`${accounts.length-available} 个账号当前不可调度`)}${metric('可用重置次数',resetTotal,'refresh','高风险操作需要二次确认')}${metric('当前本机账号',activeLabel?esc(activeLabel.label||activeLabel.account_id||'已选择'):'未选择','shield',`等待队列 ${Number(diagnosticsData.queue?.depth)||0}`)}</div>`+strategyBody+accountBoard+card('最近路由决策','解释每次请求为什么选择或跳过某个账号',decisionBody)
}

const AdminAccountsUI=Object.freeze({render:renderAccounts})
