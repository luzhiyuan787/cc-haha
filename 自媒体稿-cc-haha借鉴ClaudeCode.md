# 一篇讲透:cc-haha 抄了 Claude Code 哪些"看不见的功夫"

大家好,上次跟大家说准备分享一个让我挺有感触的开源项目——cc-haha,全名 Claude Code Haha。

今天跟大家汇报一下。

它的来头很有意思。它的底子,来自 2026 年 3 月底那波 Claude Code 源码泄露事件之后的"修复版"。开发者把泄露出来的 Claude Code 源码打补丁、修漏洞,然后把它做成一个跨平台桌面工作台。

这个项目对我最大的冲击,不是它实现了多少花哨的功能,而是它把 Claude Code 那些写在源码深处的工程哲学,原原本本地摆在了你面前。

今天这一期,我不想给你罗列功能列表。我想带你看三件事:它怎么接收你的请求、请求进入后怎么被处理、为什么它处理得又快又稳。

---

## 一、五条路,都能进

cc-haha 第一个让我意外的地方,是它的入口特别多。

我之前以为,Claude Code 这种东西,不就是个命令行嘛,你在终端里敲一下,完事。但 cc-haha 把它做成了"五条腿走路"。

第一条,命令行,也就是 CLI。这是最经典的玩法,本地终端一敲,直接进 REPL。

第二条,桌面端。这是最重磅的形态。macOS、Windows、Linux 三端原生安装包,跨平台。

第三条,H5 远程访问。桌面端起来后,它会同时开一个 Web 端口。你的手机、另一台电脑、甚至公司里没装客户端的同事,都能通过浏览器远程访问这个桌面实例。这个能力在很多场景下极其有用——比如你在地铁上用手机让 Claude Code 帮你改个 Bug。

第四条,定时任务。你可以在桌面端配置 cron 表达式,让 Claude Code 在每天早上 9 点、每周五下午 5 点自动跑某个任务。这就是个"AI 定时闹钟",可以做日报、做 PR 审查、做监控巡检。

第五条,即时通讯。飞书、Telegram、微信、WhatsApp、钉钉,五个平台全做了。用户在 IM 里私聊 bot,bot 就把消息透传到本机正在运行的 Claude Code 会话,执行完再把结果发回 IM。

你注意这五条路的设计哲学——底层跑的是同一个 Claude Code 内核,前端只是不同的"皮"。这就是"输入端多路化、核心引擎单一化"的经典架构。

---

## 二、桌面端:它不是"前端套壳"那么简单

你刚才听到"桌面端"三个字,可能下意识会想:哦,那不就是用 Electron 把前端包起来嘛。

不全对。

cc-haha 的桌面端当前主版本是 Electron,早期版本也有 Tauri,迁移期两者并存。但它绝不是单纯的前端套壳。它的内部架构是这样的。

第一层,Electron Host。管窗口、管 IPC、管 Sidecar 进程的生命周期。它通过 preload 暴露一个 host 接口给前端,前端只调它,不直接碰 Electron API。这样做的好处是,前端代码可以脱离 Electron 单独跑,比如纯开发模式。

第二层,Server Sidecar。这才是关键。它不是"前端 + 客户端",而是真正跑了一个 Bun HTTP 加 WebSocket 服务。这个服务管会话、管权限审批、管协议代理、管 IM 适配器调度。端口是动态分配的,Electron 起来之后帮它启。

第三层,CLI 子进程。Server 为每个会话 spawn 一个 Claude Code CLI 子进程,通过 stdin 加 stdout JSON 通信。这其实就是把命令行 Claude Code 当作一个黑盒"引擎"来用。

第四层,Adapter Sidecar,可选的。当你启用 IM 接入后,Electron 会额外拉起 Telegram、飞书、微信这些适配器进程。它们通过 WebSocket 桥接到 Server,再被 Server 路由到具体的会话。

所以,cc-haha 桌面端正确的理解是:Electron 是个壳,壳里跑着一个完整的 Bun Server,Server 再去驱动真正的 Claude Code 引擎。

打包的时候,Electron Builder 会把这些 Sidecar 二进制打到 app.asar.unpacked 里,所以你装好之后双击图标,这一整套就起来了。

---

## 三、请求进了之后:它不是"想、做、看"

接下来是最硬核的部分。当用户的请求真的进来后,Claude Code 是怎么处理的?

很多人对 Agent 的认知,停留在 ReAct 模式:思考、行动、观察、再思考、再行动、再观察。LangChain 那一票框架基本都是这么干的。

Claude Code 没有用 ReAct。它用的是 AsyncGenerator 驱动的流式状态机。这两件事有什么区别?

ReAct 是一步一步"想好了再做",每一步是独立的 LLM 调用。它有几个固有问题。第一,不能流式执行——必须等模型把整个响应吐出来,才能开始跑工具。第二,没有统一状态——每一步的状态散落在 Memory 对象里,出错很难恢复。第三,缓存不友好——每一步的 prompt 长得都不一样,API 缓存利用率低。

Claude Code 的解法是:把整个 Agent 循环写成一个异步生成器,驱动一个 while (true) 的状态机。这个状态机有五个阶段。

阶段一,消息准备与智能压缩。在调用 API 之前,对话历史会过一遍四级压缩——先把旧消息里的冗余 token 剪掉,这叫 snip。再调整缓存消息,这叫 micro。再分阶段折叠,这叫 collapse。实在不行就让 Claude 自己生成摘要,这叫 auto compact。

阶段二,流式 API 调用。这一段特别优雅——模型在生成响应的时候,工具就开始执行了。不是等模型说完整段话才开始跑工具,而是模型一边生成 tool_use 块,工具一边启动。

阶段三,决策点。这一步是状态机的"咽喉"——模型这一轮到底是在调用工具,还是在给最终答案?机制特别简单:每轮循环开头,系统设一个布尔位 needsFollowUp 等于 false,默认意思是"这一轮是答案"。模型流式响应过程中,只要检测到 tool_use 块,就把这个布尔位置为 true。这一行布尔位翻转,就是"工具 vs 答案"的全部判定逻辑。如果你写过 ReAct,你可能会惊掉下巴——就这么一句?是的,就这么一句。但它的精妙不在判定本身,而在判定完之后的状态机编排。

阶段四,工具编排。工具不是一个个傻傻串行跑的——只读工具并行,最多 10 个并发;写入工具串行,防止互相覆盖。这个细节看似不起眼,但在长对话里它能省一半时间。

阶段五,状态更新。这是整个设计最妙的地方。它通过状态赋值而不是递归调用来驱动循环:state 等于 next,改一下状态,然后 continue。没有递归、没有回调地狱。栈不会爆,每一轮的状态转换原因都被记录,任何阶段的错误都能通过修改 state 来恢复。

这五段构成一个流式状态机,响应是流出来的,工具是流出来的,进度是流出来的,压缩也是渐进式的。你看到的 Claude Code,不是"做完一步再做下一步",而是所有事情都在同时往前走。

### 小插曲:如果你想看得再细一点,这个状态机非常厚

刚才讲的是"长什么样"。但如果你真的打开 src/query.ts 看那个状态机,你会发现它远比我刚才讲的复杂。

第一个细节,State 对象有十个字段。这个状态机不是只存一个 messages 数组,它用一整个对象把"所有需要记住的东西"打包。最重要的几个——messages 是完整对话历史,toolUseContext 是工具执行上下文,autoCompactTracking 是自动压缩的状态机,tokens 计数器记录撞到输出上限重试了多少次,turnCount 是已完成轮数,配合 maxTurns 硬刹车,transition 是"为什么跳到这一轮",这是关键,我下面讲。

每次循环结束,系统会重新组装一个新 state,state 等于 next,然后 continue。你会发现——这个状态机没有任何隐式变量,所有的"记忆"都显式存在 State 里。这意味着任意时刻你都能 dump 这个对象,然后从那一帧恢复对话。这就是 ReAct 模式根本做不到的事。

第二个细节,transition.reason 有十七种以上的取值。State 里最容易被忽略的字段,是最后一个 transition。它不存数据,只存一个枚举值,告诉你"这一轮为什么走到这里"。

它有七种"继续"取值,意思是本轮没结束、继续循环。最常见的是 next_turn,正常路径,本轮有工具,准备进下一轮。collapse_drain_retry 是 API 报 413,先做一轮 context collapse drain 再试。reactive_compact_retry 是 drain 救不回来,跑 reactive compact 后重试。max_output_tokens_escalate 是输出撞上限,临时放大预算再发。max_output_tokens_recovery 是放大预算后的重试计数。stop_hook_blocking 是 Stop hook 拦截了"想结束"的意图,再来一轮。token_budget_continuation 是用户设了 token 预算,进度小于 90% 注入"继续"提示。

还有十多种"终止"取值:completed 是正常结束,max_turns 是撞轮数硬刹车,aborted_streaming 是用户中断流,aborted_tools 是工具阶段中断,hook_stopped 是被 hook 停掉,prompt_too_long 是真救不回来了,等等。

这套枚举有什么实际价值?它让测试可以直接断言——"这一轮必须经过 reactive compact 才能继续"、"被 Stop hook 拦截必须走 stop_hook_blocking"。你写断言的时候,可以用这一行枚举值精确卡死一个恢复路径。这是工程上的"行为级单元测试",而不是黑盒断言。

第三个细节,generator yield 出来的东西远不止"工具、答案"。我刚才说"工具 vs 答案",是为了让你快速抓住状态机的咽喉。但实际跑起来,generator yield 出去的事件类型很多。

一次完整的 query 会 yield 出这些:stream_request_start,UI 显示"thinking";压缩边界消息,UI 显示"正在压缩";模型的流式 token,UI 的实时打字效果;工具结果消息,UI 显示"工具跑了,结果是 X";Haiku 工具摘要消息,"本轮工具小结";还有各种 attachment,错误、警告、系统提醒。

只有最后那个 return,带着 reason 字段的值,才真正结束整个流。这才是 AsyncGenerator 协议意义上的"结束"。这就是为什么 Claude Code 看上去很"通透"——它的状态机不是两步、不是三步,而是一整套精心命名的状态迁移,每一种都对应一种业务含义。

---

## 四、状态机派生出四条"生娃"路径

刚才讲的是"一个 Agent 怎么转"。但 Claude Code 真正的杀手锏,是它能生成子 Agent。

在主循环跑着跑着,模型会决定:这件事太大了,我得叫几个帮手。这时候,主循环会调用 AgentTool 工具,根据参数不同,会走上四条完全不同的派生路径。

第一条,Teammate,也就是队友。触发条件是 team_name 和 name 同时存在。这是真的"团队协作"——每个队友有自己独立的 agentId,有自己的邮箱通信,通过 TeamFile 协调工作,可以跨 tmux pane、跨 iTerm2 窗口、甚至跨进程运行。

第二条,Async Subagent,异步子代理。触发条件是 run_in_background 等于 true,或者 Agent 定义里直接写死了 background 等于 true——比如一些内置 Agent 默认就是后台跑。这条路径专门用来处理"扔出去就别管"的任务——主代理立刻返回,子代理在后台跑,跑完通过 task-notification 通知回来。

第三条,Fork Subagent,分叉子代理。触发条件是省略 subagent_type 参数,并且 Fork 实验开关开启。这条路径是为"缓存复用"而生的,我下面单独讲。

第四条,Sync Subagent,同步子代理。默认路径。模型说"给我跑个探查任务",主代理就阻塞等它跑完,直接拿结果。

这四条路径共同的设计,是把"启动一个 agent"这件事,统一变成一个可追踪、可中断、可恢复的后台任务。每个子代理都有自己的 AbortController、ProgressTracker、状态机,运行中、完成、失败、被杀。父代理可以用 abortController 干掉任何一个不听话的子代理,可以用 ProgressTracker 看每个子代理跑了多少 token、用了几次工具、最近五个活动是什么。

这一套组合拳,就是 cc-haha 抄得最精髓的地方。一个主循环加上一棵动态生长的 Agent 树,这就是 Claude Code 在做复杂任务时游刃有余的根本原因。

### 顺便聊聊"执行风格的多种分类"

在社区里,大家聊起 Claude Code 的子代理生态,经常会把这些 Agent 类别笼统地叫做几种"执行风格"。比如 Local,默认在本地进程内跑,无隔离;Worktree,用 git worktree 拉一个独立分支出来跑,改的东西不会污染主工作区;Remote,通过 CCR 也就是 Claude Code Remote,把任务丢到远端跑;Fork,字节级一致前缀,复用 prompt cache;Auto-background,某些 Agent 跑着跑着会被 tengu_auto_background_agents 这个特性自动转成后台任务,默认阈值是 120 秒。

这几个名词不是某个文档里明确定义的"标准分类",而是开发者社区在聊的时候常用的几种"执行语义"的口语化命名。它们的共同特点是,都对应到 Claude Code 源码里某个具体的模块、某个具体的 Feature Flag。你想精确了解的话,看 src/tools/AgentTool/ 和 src/bootstrap/state.ts 里的相关实现就一目了然。

类似地,在权限和执行门控层面,也有一些常被提到的开关值得提一下。

KAIROS 是一个编译时 feature flag。它不是某种"权限决策",而是控制是否启用 cwd 参数,以及一些相关执行路径。它在仓库里以 getKairosActive、setKairosActive 的形式出现。tengu_harbor、tengu_harbor_ledger、tengu_harbor_permissions 是 channel 与权限相关的一组特性开关,集中在 docs/channel/01-channel-system.md 里有详细讲解。还有一个特别值得说的是 bubble 权限模式——Fork 子代理需要权限时,会自动冒泡到父代理的权限审批框,子代理不会卡死,用户审批也不需要切窗口。

---

## 五、并发不是简单 fork,字节级一致才是真功夫

接下来重点讲 Fork Subagent 这条路径,因为它是 Claude Code 最工程化的优化。

你想想看:主代理跑了几十步,积累了大量的 system prompt、user context、tool definitions、对话历史。如果这时候它要 spawn 一个子代理,子代理的 API 请求前缀是不是和主代理几乎完全一样?

Claude Code 的答案是:是的,而且要让它字节级一样。

具体怎么做的呢?主代理调用 AgentTool 时,如果省略 subagent_type 且 Fork 实验开启,它会进入 buildForkedMessages 这个函数。它保留父代理完整的 assistant message,包括所有 tool_use 块;它为每个 tool_use 创建占位 tool_result,是字节一致的占位符;它在末尾追加子代理独有的 directive,也就是任务说明。

这样一来,父代理和子代理的 API 请求前缀,在 Anthropic 看来是字节完全一致的。

字节一致意味着什么?意味着 Anthropic API 的 prompt cache 命中。

我必须澄清一个事:这**不是项目自己实现的 KV 缓存**。这是 Anthropic API 自带的 prompt caching 能力——当你的请求前缀和之前的请求完全一致或高度相似时,API 会复用之前算好的前缀结果,直接跳过这些 token 的预处理和计算。

对于一个 100k token 的 system prompt 加长对话历史,如果 cache 命中,你可能只需要为最后几十行 directive 付费。前缀处理的算力、token 计费,大头都省了。

这就是为什么 Fork Subagent 在 cc-haha 里跑得那么快——它没有重新计算 100k token 的前缀。

当然,这种优化是有代价的:Fork 子代理不能"自由对话"。它被强制约束成"接到指令、跑工具、报告"的工作模式,响应必须以 Scope: 开头,长度不超过 500 词。它的行为模式通过 FORK_BOILERPLATE_TAG 注入。

---

## 六、你看不见的"工程防御术"

最后我想聊几个用户不会直接感知到,但决定 Claude Code 体验下限的设计。

第一,CLAUDE.md 的分层加载。你可以在六个地方写 CLAUDE.md:全局系统级、用户级、项目根、项目 .claude/、项目 rules 目录、项目 local。Claude Code 按优先级合并加载,项目 local 最高,全局最低。它还支持 @path 引用、自动防循环引用。

第二,三级提示词缓存。System prompt 不再每次重算——静态部分用 scope 是 global 的缓存,跨组织复用;动态部分用 scope 是 ephemeral 的缓存,会话级复用;section 级别用 systemPromptSection 记忆化,轮级复用。

第三,六加二,共八种恢复机制。这是 Claude Code 几乎不会因为技术问题打断你的根本原因。

先说状态机层面那六种——它们都通过改 state 里的 transition 字段驱动循环继续:prompt 过长?触发 collapse_drain_retry,排空已暂存的上下文折叠,再试一次;还不够?触发 reactive_compact_retry,让 Claude 自己对历史生成摘要,再试一次;触及 8k 输出限制?触发 max_output_tokens_escalate,临时放大到 64k 预算再发;放大预算后还撞上限?触发 max_output_tokens_recovery,注入"继续"提示,最多重试 3 次;Stop 钩子想拦你?触发 stop_hook_blocking,把钩子的反馈注入上下文,再来一轮;用户设了 token 预算但还没用完?触发 token_budget_continuation,注入"继续"提示,接着走。

再说另外两种独立的兜底恢复。模型降级——主模型流式传输失败时,自动清理孤立的未完成消息,切到备用模型重试。媒体大小恢复——图片等媒体内容撞到 token 上限时,自动剥离图片、保留文本信息,接着重试。

这还没算上网络层的 API 超时自动重试、工具层的失败后记录错误继续对话——Claude Code 把"故障恢复"这件事,做到了贯穿整个状态机的每一层。

每一种恢复都是改一下 state、continue,不用重启对话、不用重新加载历史。

---

## 七、小结:cc-haha 带给我们了什么

回到主题——cc-haha 这个项目,真正有价值的是它完整地保留并暴露了 Claude Code 的核心架构。

它把一个原本只能在命令行里跑的东西,做成了:五种入口汇聚到同一个内核;桌面端不是简单前端套壳,而是 Electron 加 Server Sidecar 加 CLI 子进程加 Adapter Sidecar 的完整多层架构;主循环不是 ReAct,而是 AsyncGenerator 流式状态机,用 state 等于 next 优雅驱动——一个 State 十个字段、转义原因十七种以上枚举值、yield 多种事件类型的"厚"状态机;子代理不是简单 fork,而是 Teammate、Async、Fork、Sync 四条路径,各有触发条件、各有缓存策略;Fork 通过字节级一致的 API 前缀,复用 Anthropic prompt cache,既省 token 又省时间;背后还有 CLAUDE.md 分层加载、三级缓存、六加二共八种恢复、bubble 权限等一整套工程防御术。

如果你看完这期内容,想自己动手把 Claude Code 跑起来试试,cc-haha 这个项目是个很好的入口——它已经把所有复杂度都封装好了,你只需要装个桌面端就能用。

我是赛博知源,我们下期见。
