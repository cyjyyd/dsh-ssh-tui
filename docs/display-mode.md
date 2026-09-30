# 管道宿主模式(`DSH_TUI_DISPLAY=stdio`)

> 这个插件是**终端 UI**:它要在一个真实 TTY 里画。桌面版 Harness 的启动器是 Electron-as-Node,
> 没有 console,所以**它不需要这个插件**,插件在那边保持惰性(`docs/desktop.md`)。
> 这份文档讲的是**另一条路**:宿主自己会开终端控件(PTY 面板、xterm.js、GUI 里嵌的终端),
> 它可以把插件当成"一个在管道上说话的子进程"来用。

## 一句话

父进程声明 `DSH_TUI_DISPLAY=stdio`,插件就不再要求 TTY:它把 stdin 当**输入通道**、stdout 当
**画面通道**、并接受父进程用 `CSI 8 ; rows ; cols t` 报告的面板尺寸。父进程只要会"喂字节 + 解 ANSI",
就能承载完整 TUI——包括会话续接、断线重连、`/exit`。

## 两个入口(机制 + 语法糖)

| 入口 | 用途 |
|---|---|
| `DSH_TUI_DISPLAY=stdio`(环境变量) | **机制**。父进程设置它,等于声明"stdin/stdout 是显示通道",插件的无终端保护会照此放行 |
| `--display stdio`(命令行) | **语法糖**。写在 profile 行里时 `--help` 会显示它,拼错是报错而不是静默惰性 |

两者同时存在时**环境变量优先**(父进程描述的是它马上要用的通道;标志可能来自包装脚本的残留)。
不认识的值会打印一行说明,然后按没有终端处理——不会静默变惰性。

## 父进程要做的五件事

1. **管道起进程**(不要 PTY)。`dsh --profile tui` 用 `spawn(..., { stdio: ['pipe','pipe','pipe'] })`;
   顺带一句话:能开 PTY 的宿主**不需要这个模式**——直接给真 TTY,走默认路径即可。
2. **声明初始尺寸**:管道不报告尺寸,插件读 `COLUMNS` / `LINES`(没给就是 80×24)。
   建议同时给 `TERM=xterm-256color`、`COLORTERM=truecolor`:能力表(alt-screen、颜色、鼠标、
   OSC 8)都从环境推出来,`TERM` 缺失会退化成"哑终端"。
3. **把按键写成字节**到子进程 stdin(UTF-8)。字节流就是终端输入:普通字符、`\r`、`\x03`(Ctrl+C)、
   方向键的 `ESC [ A` 之类都原样可用。
4. **把 stdout 解成画面**:输出就是 ANSI(绝对定位 + 只画脏行 + `DEC 2026` 同步刷新)。
   喂给 xterm.js 之类即可;**不要**自己做行缓冲或重排——它们假定了固定宽度和行地址。
5. **报告尺寸变化**:管道没有 `resize` 事件,也没有 `SIGWINCH`。面板变大变小时,往 stdin 写

   ```
   CSI 8 ; <rows> ; <cols> t        例:\x1b[8;40;120t
   ```

   这就是终端回答"窗口多少格"的序列,插件把它当尺寸帧转给绘制的 Host,并以新宽度重画。
   它**不会**被当成输入(半个到达的序列会被暂存到下次读取,不会把 `ESC` 泄进提示词)。
   一次写完整条序列:拆成两次写时,前半段会被暂存,但"暂存"只保证不泄成按键。

## 光标探测(可选,但建议)

插件会通过 `CSI 6n` 问光标位置,用来(1)测链路往返、(2)判断 `①`/`—` 这类**歧义宽度**字形在这个
字体里占几格。父进程如果像终端模拟器那样回答:

```
CSI <row> ; <col> R           例:\x1b[1;1R
```

那么接入是快的,并且宽度能按真实字体判定。**不回答也能用**:测量会在采样预算(约 0.7s)后放弃,
歧义宽度退回按 locale 推断,字形探针直接跳过。需要彻底关掉字形探针(`DSH_TUI_NO_GLYPH_PROBE=1`)
的场合是"断言 attach 字节流"的测试。

## 退出与清理

- 用户在 TUI 里 `/exit`,或按 Ctrl+C,子进程自己收尾:恢复管道上的终端模式(管道上没有可恢复的
  东西,所以是空操作)、写 goodbye 帧、退出码 0。
- 插件会**短暂保持 raw 模式一个往返**再放开终端,用来吞掉"还在路上的光标回答"——否则慢链路上
  这个回答会被 tty 回显成 `^[[25;1R` 文本留在提示符旁。宿主不需要配合,只要别在这几百毫秒里
  强杀进程。
- 会话本身在 Host 进程里,窗口/管道断开不等于会话结束:重新按同一个 session id 接入即可续上。

## 最小示例(Node)

```js
import { spawn } from 'node:child_process'

const child = spawn(process.execPath, [cliPath, '--profile', 'tui', `--resume=${sessionId}`], {
  env: {
    ...process.env,
    DSH_HOME: home,
    DSH_TUI_DISPLAY: 'stdio',      // 父进程声明:我在管道上说话
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    COLUMNS: '100',                // 管道不报尺寸,父进程声明
    LINES: '30',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

// 画面 → 终端控件
child.stdout.on('data', bytes => terminal.write(bytes))
// 按键 → 子进程
terminal.onData(text => child.stdin.write(text))
// 探测 → 像终端模拟器那样回答(不回答也能跑,只是慢)
let seen = ''
child.stdout.on('data', chunk => {
  seen += chunk
  let at = seen.indexOf('\x1b[6n')
  while (at !== -1) {
    child.stdin.write('\x1b[1;1R')
    seen = seen.slice(at + 4)
    at = seen.indexOf('\x1b[6n')
  }
})
// 面板尺寸变化 → 报告给子进程
resizeObserver(size => child.stdin.write(`\x1b[8;${size.rows};${size.cols}t`))
```

## 可执行的规格

| 位置 | 覆盖内容 |
|---|---|
| `tests/stdio-pipe-e2e.test.mjs` | 真 relay + 真 Host,**两端都是管道**:attach 不报 `setRawMode`、初始尺寸、按键、`CSI 8 t` 重画、goodbye 退出 |
| `tests/display-mode.test.mjs` | 模式解析(env/标志/拼错)、尺寸报告的解析与跨读暂存 |
| `scripts/tui-stdio-probe.mjs` | 端到端:起真 profile、走管道,断言画面、输入回显、`CSI 8 t` 后按新宽度重画、`/exit` 干净退出。CI 的 Linux 与 Windows 两条腿都跑 |
| `tests/no-terminal.test.mjs` | 没有终端时插件惰性(桌面版那条路),以及 `requireTerminal: true` 是唯一会抛错的路径 |

## 限制(写清楚,免得宿主踩)

- **没有真实 `resize`**:只能靠 `CSI 8 ; rows ; cols t`。不发的宿主会一直停在 `COLUMNS`/`LINES` 声明的尺寸。
- **没有 `SIGWINCH`**:同上。
- **能力表来自环境**:`TERM`/`COLORTERM` 没给,就没有 alt-screen、没有颜色、没有鼠标——画面能跑,
  但不是用户期待的样子。用 `DSH_TUI_TERM_CAPS` 可以显式覆盖(见 `docs/terminals.md`)。
- **只读诊断**:`DSH_TUI_LINE_MODE=1` 是给日志型面板的另一条路——每个事件一行纯文本,不画屏。
- **桌面版进程本身**:如果宿主是那个 Electron-as-Node 启动器,**它开不出这条通道**(没有 console,
  但真正的问题在它自己的子进程模型)。这种情况请用 npm 安装的 CLI 在真终端/SSH 里跑
  `dsh --profile tui`,见 `docs/desktop.md`。
