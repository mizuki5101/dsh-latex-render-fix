# dsh-latex-render-fix

修掉 dsh 对话框里 LaTeX 公式标红的问题：`$$\begin{aligned} … \end{aligned}$$` 这种写法会被渲染成一片红色的

```
KaTeX parse error: Expected 'EOF', got '&' at position 35
```

同一份内容在 VSCode / Typora / Obsidian 里都是正常的。**不是公式写错了，也不是模型写错了。**

---

## 原因

dsh 的 markdown 渲染走 remark / micromark，它把块级公式建模成**和代码围栏同构**的东西：

- `$$` 相当于 ` ``` `
- `$$` 后面紧跟的那串相当于「语言标识」（`mathFlowFenceMeta`），**会被丢弃**
- 结束 fence **必须在行首**

于是 `$$\begin{aligned}` 里的 `\begin{aligned}` 被当 info string 吃掉，公式体从 `\frac…&=` 开始 —— 顶层出现 `&`，KaTeX 直接报错。而结尾的 `\end{aligned}$$` 因为 `$$` 不在行首**闭合不了**，那个公式节点会一路吞到文件末尾，把后面整段内容都变成裸源码。

---

## 做法

插件在 dsh 启动时（窗口加载前端之前）检查 `resources/app.asar` 里的前端 bundle，
如果还没打过补丁，就在 markdown 渲染入口插两条正则，把文本**规范化成 remark 能正确解析的写法**：

```
$$
\begin{aligned}
a &= b \\
\end{aligned}
$$
```

也就是把 `$$` 后面的内容和结尾的 `$$` 各挪到独立一行。改动等价于你手工把这几个字符换行，**不触碰解析器本身**。

两条正则都是幂等的，流式渲染每帧重跑不会累积插入：

```js
.replace(/^\$\$(?=\\begin\{)/gm, () => '$$\n')
.replace(/\\end\{([a-z*]+)\}\$\$$/gm, (m, a) => `\\end{${a}}\n$$`)
```

只命中**行首**的 `$$`+`\begin{` 与**行尾**的 `\end{env}$$`，句中出现的 `$$` 不受影响。

---

## 行为与边界

| 场景 | 结果 |
|---|---|
| 已经是安全写法（`$$` 独占行） | 不受影响 |
| dsh 升级覆盖了 asar | 下一次启动自动重打 |
| **升级后第一次启动** | **公式仍标红** |
| **第二次启动** | 正常 |

「第一次仍标红」是上游机制决定的：cordis 加载插件时只注册、**不 await** 插件的 `apply`，
所以补丁来不及赶在窗口加载之前完成（重排 209 MB 约 0.8~1.2 秒）。改不动这一点 ——
除非去改 asar 里的 ready 逻辑，那就成了另一个补丁。

另外：只有**含 `\begin{...}`** 的公式会被拆成块级（居中显示，和 VSCode 一致）。
不含 `\begin` 的单行 `$$x$$` 仍是行内公式（不居中），这是有意选择的保守范围。

---

## 安装

插件市场安装即可。手动安装的话，profile 里要同时满足三件事：

1. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里声明
2. 同一文件的 `dsh.profile.bundles` 里列出插件名
3. `node_modules/<插件名>` 可解析

```json
{
  "dependencies": {
    "dsh-latex-render-fix": "link:./path/to/dsh-latex-render-fix"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-latex-render-fix"]
    }
  }
}
```

> 只塞进 `node_modules` 而没在 `dependencies` 声明的话，包管理器和升级流程会把它当冗余清掉。

---

## 日志

```
~/.dsh/dsh-guard/plugin.log
```

可用环境变量 `DSH_LATEX_GUARD_HOME` 改到别处。手动跑一次：

```
node lib/index.js            # 自动定位 app.asar
node lib/index.js --asar "<path>/app.asar"
```

日志里正常的一次打补丁长这样：

```
target bundle: /dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-xxxxxxxx.js
  render 入口已插入（参数名 e）
  fK 非流式入口已插入（fK/t）
重排完成：delta=+218 shift=+0 平移节点=10104
补丁已应用（备份 app.asar.bak-20261119-164225）
```

看到 `锚点命中 0/2` 说明这版 dsh 的压缩结构变了、锚点失效 —— 需要更新锚点，插件会跳过而不会写坏文件。

---

## 权限

- **dsh 官方安装包是单用户安装**（装到 `%LOCALAPPDATA%\Programs\DeepSeek Harness`），普通用户可写，**不需要管理员**。
- 若你把 dsh 装在 `C:\Program Files` 等受保护目录，需要**以管理员身份启动一次 dsh**；否则插件会记一条
  `没有写入权限` 然后跳过（不会影响 dsh 正常使用，只是公式照旧标红）。

---

## 回滚

插件每次打补丁前都会把原 asar 备份成 `app.asar.bak-<时间戳>`，只保留最近 2 份。
还原：

```
copy /Y "<dsh>/resources/app.asar.bak-<最新>" "<dsh>/resources/app.asar"
```

（还原后是原版，下次启动插件会重新打。）

彻底卸载：从 `dsh.profile.bundles` 里移除 `dsh-latex-render-fix`，删除
`node_modules/dsh-latex-render-fix`，再按上面的方式还原一次 asar 即可。

---

## 风险声明

这个插件会**改写 dsh 安装目录下的 `app.asar`**（+218 字节，其余字节原样平移）。
做到的安全措施：

- 状态就地判断：已在 bundle 里看到规范化代码就不再动
- 锚点用「属性名 + 逻辑结构」（`this.lastText` / `this.lastRendered` / `f.current=null`），不依赖压缩后的变量名
- 写入前先做语法检查（`node --check`），不通过就放弃
- 写入前备份，写完校验大小，不符自动还原
- 任何异常都只记日志，**不阻断 dsh 启动**

仍然建议：改动前自己留一份 `resources` 目录的副本。

---

## License

MIT
