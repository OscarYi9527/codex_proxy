const HTTP_ERROR_GUIDES = [
  {
    status: 400,
    title: '请求参数错误',
    meaning: '请求格式、模型名或必填参数不符合接口要求。',
    causes: ['JSON 格式错误或缺少必填字段', '模型名、工具参数或接口路径与当前上游不兼容'],
    actions: ['核对报错正文中指出的字段', '确认客户端使用的是 /v1/responses 或受支持的兼容接口']
  },
  {
    status: 401,
    title: '认证失败',
    meaning: 'API Key、ChatGPT 登录凭据或访问令牌无效。',
    causes: ['API Key 填写错误或已被撤销', 'ChatGPT 登录已过期，需要重新登录'],
    actions: ['在模型服务中重新检查密钥', '在账号池查看“登录失效”状态并重新登录']
  },
  {
    status: 402,
    title: '余额或计费不可用',
    meaning: '上游要求有效余额、套餐或付费权限后才能继续请求。',
    causes: ['OpenAI、DeepSeek 或中转节点余额不足', 'API 账户没有开通计费；ChatGPT 订阅不等于 API 余额', '当前账号或套餐没有对应模型/额度权益'],
    actions: ['先确认报错来自哪个 Provider', '到对应服务商后台检查余额、账单和套餐权限', '若使用 ChatGPT 订阅通道，在账号池刷新额度和登录状态']
  },
  {
    status: 403,
    title: '权限不足',
    meaning: '凭据可能有效，但没有执行当前操作或访问当前模型的权限。',
    causes: ['账号没有模型或项目权限', '管理操作不是从本机控制台发起', '上游地区、组织或安全策略拒绝访问'],
    actions: ['检查模型、Organization 和 Project 配置', '管理操作请通过本机 127.0.0.1 后台执行']
  },
  {
    status: 404,
    title: '资源不存在',
    meaning: '接口路径、模型、账号或中转节点不存在。',
    causes: ['Base URL 拼接错误', '模型已下线或服务商使用了不同模型名', '本地配置引用了已删除的账号/节点'],
    actions: ['核对 API Base URL 和模型列表', '刷新模型目录并检查当前路由配置']
  },
  {
    status: 408,
    title: '请求超时',
    meaning: '客户端或上游在规定时间内没有完成请求。',
    causes: ['网络不稳定或上游响应过慢', '请求内容较大、工具调用耗时较长'],
    actions: ['确认网络后稍后重试一次', '检查 Provider 延迟和最近错误，不要连续快速重试']
  },
  {
    status: 409,
    title: '操作冲突',
    meaning: '当前操作与正在执行的任务或最新状态冲突。',
    causes: ['登录、额度重置或其他管理任务正在进行', '缓存中的重置次数已被使用或发生变化'],
    actions: ['等待当前操作完成后刷新页面', '重新查询最新状态，不要重复提交']
  },
  {
    status: 422,
    title: '内容无法处理',
    meaning: '请求格式合法，但字段组合或内容无法被当前模型处理。',
    causes: ['工具定义、消息角色或多模态内容不受支持', '参数组合超出模型能力'],
    actions: ['根据报错正文简化请求参数', '换用支持该功能的模型或接口']
  },
  {
    status: 429,
    title: '请求过多或额度受限',
    meaning: '触发了请求频率、并发或额度限制。',
    causes: ['短时间请求过多', '账号或模型进入冷却', '额度已接近或达到安全余量'],
    actions: ['停止连续重试并等待冷却结束', '在账号池检查额度、并发和模型冷却状态']
  },
  {
    status: 500,
    title: '代理内部错误',
    meaning: '本地代理处理请求时发生了未预期异常。',
    causes: ['配置、文件或运行时状态异常', '程序缺陷或本机依赖不可用'],
    actions: ['记录 Request ID 并下载脱敏诊断报告', '查看代理日志，必要时优雅重启代理']
  },
  {
    status: 502,
    title: '上游响应失败',
    meaning: '代理已收到请求，但上游连接失败或返回了无法正常处理的响应。',
    causes: ['Provider 网络故障或接口地址错误', '上游返回异常数据', '本机到服务商的连接被中断'],
    actions: ['在模型服务中执行连通性检测', '检查 Base URL、网络和 Provider 最近状态']
  },
  {
    status: 503,
    title: '服务暂不可用',
    meaning: '当前没有可安全处理请求的通道，或上游正在维护。',
    causes: ['ChatGPT 账号池在本地排队超时前没有可用账号', '账号均为仅保存、额度不足、登录失效、冷却中或并发已满', 'Provider 熔断、维护或临时不可用'],
    actions: ['打开账号池，确认至少一个账号已启用、登录有效且高于安全余量', '查看账号冷却、并发和最近路由决策；忙碌时等待后再试', '若来自 API/中转节点，检查 Provider 熔断和服务状态']
  },
  {
    status: 504,
    title: '上游响应超时',
    meaning: '代理已连接上游，但上游没有在超时时间内返回结果。',
    causes: ['服务商响应缓慢或网络链路超时', '长请求在上游排队时间过长'],
    actions: ['稍后重试一次并查看 P95 延迟', '检测其他可用通道，避免持续重复请求同一故障上游']
  }
]

const ERROR_TYPE_OVERRIDES = {
  account_pool_exhausted: {
    title: 'ChatGPT 账号池暂不可用',
    meaning: '本地等待队列超时前，没有任何 ChatGPT 账号恢复为可用状态。',
    causes: ['所有账号均未启用、登录失效、额度达到安全余量、处于冷却或并发已满'],
    actions: ['前往“账号池”检查启用状态、额度、登录、冷却和并发', '有请求仍在运行时先等待，不要连续重试']
  },
  account_pool_attempts_exhausted: {
    title: 'ChatGPT 账号尝试全部失败',
    meaning: '单个请求已按安全上限尝试两个账号，但均因登录、网络或上游错误失败。',
    causes: ['两个候选账号均发生 Token 刷新、网络、鉴权或上游连接错误'],
    actions: ['查看错误详情中的 account_attempts 和 last_error', '检查账号登录状态与网络，不要立即连续重试']
  },
  budget_exceeded: {
    title: '线路预算已达到上限',
    meaning: '本地成本治理阻止继续使用已达到日/月预算的 API 或中转线路。',
    causes: ['对应 Provider 的本地估算成本已达到配置的每日或每月上限'],
    actions: ['在系统设置检查成本报告和预算', '按策略切换到免费订阅线路，或明确调整预算后再继续']
  }
}

function copyGuide(guide) {
  return guide ? {
    ...guide,
    help_path: '/admin#help',
    causes: [...guide.causes],
    actions: [...guide.actions]
  } : null
}

export function getHttpErrorGuide(status, errorType = '') {
  const numericStatus = Number(status)
  const base = HTTP_ERROR_GUIDES.find(item => item.status === numericStatus)
  if (!base) return null
  const override = ERROR_TYPE_OVERRIDES[errorType]
  return copyGuide(override ? { ...base, ...override, status: numericStatus } : base)
}

export function listHttpErrorGuides() {
  return HTTP_ERROR_GUIDES.map(copyGuide)
}

export function attachHttpErrorGuide(status, data) {
  if (Number(status) < 400 || !data?.error || typeof data.error !== 'object') return data
  const guide = getHttpErrorGuide(status, data.error.type)
  if (!guide) return data
  return {
    ...data,
    error: {
      ...data.error,
      guide
    }
  }
}
