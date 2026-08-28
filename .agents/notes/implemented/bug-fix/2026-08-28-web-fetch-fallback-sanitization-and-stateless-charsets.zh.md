# Agent Note：未转换的 fetch 响应体与已转换者一样被清理，且字符集必须无状态解码

Status: implemented

[English](2026-08-28-web-fetch-fallback-sanitization-and-stateless-charsets.md) | 中文

## Problem

`web_fetch` 中有两条模型可见的路径，把 fetch 路径无法安全处理的标记与字节，当作普通内容对待。

[`dsh-tool-web`](../../../../packages/web/tool-web/src/fetch.ts) 里的 `renderBody` 只有在深度预检通过、且转换正常返回时才会抵达 turndown。`turndown.remove(['script', 'style', 'noscript'])` 是一项 turndown 配置，因此仅在那条路径上生效。两条回退分支——嵌套超过 `MAX_CONVERSION_DEPTH` 的 HTML，以及抛出异常的转换——原样返回源字符串。于是清理恰恰缺席于输入最可能怀有恶意之处：这两条回退几乎只会被对抗性标记触发，因为真实页面只嵌套几十层，且转换不会抛出。一个页面若想让自己的 script 正文原封不动抵达模型，只需嵌套 513 层元素。该文本随后成为工具结果内容，并被持久化到会话日志。

[`dsh-web-fetch-http`](../../../../packages/web/web-fetch-http/src/policy.ts) 里的 `decoderForCharset` 把服务器声明的字符集标签直接交给 `TextDecoder`，平台认得什么就接受什么。它的拒绝分支是为了避免乱码，而不是为了限定一个字符集可以做什么：只要是平台认识的标签，一律照单全收。`iso-2022-jp` 通过带内转义序列切换字符集，因此同样的响应字节会依据其前文解码出不同的文本；而 `x-user-defined` 根本不是一种文本解码，而是把原始字节透传进私用区。两者都让响应自己的 `Content-Type` 头改变了其字节的含义。

这两处缺口来自对 `packages/web/*` seam 的威胁建模，而非生产环境中的故障。

## Decision

两条未转换路径在返回前都会运行 `stripRawTextElements`。它移除 `RAW_TEXT_ELEMENTS`——即深度扫描器已经拥有的那同一个 `script`、`style`、`noscript` 集合——及其内容，因此跳过转换的响应体不会携带已转换响应体本会失去的标记。扫描复用紧邻的词法机制，而不是引入解析器或清理依赖：`findRawTextEnd` 定位结束标签而不解释形似标记的正文文本，且被引号包裹的 `>` 不会结束一个开标签。没有结束标签的元素会连带丢弃直到输入末尾的全部内容，因为没有结束标签的 `<script>` 其内容不可能不是脚本。孤立的结束标签匹配不到任何开标签，仍作为文本保留。

`decoderForCharset` 先构造解码器，再在规范的 `TextDecoder.encoding` 命中有状态编码时拒绝它。该检查读取规范名称而非声明的标签，因此被拒编码的每一个 WHATWG 别名都被覆盖，无需逐一枚举别名。`STATEFUL_ENCODINGS` 恰好只含 `iso-2022-jp` 与 `x-user-defined`：该类别的其余成员——`hz-gb-2312`、`iso-2022-kr`、`iso-2022-cn`、`utf-7`——根本不是 `TextDecoder` 标签，本就构造失败。真实页面会声明的每一种无状态编码仍可解码，包括 `shift_jis`、`euc-jp`、`gbk`、`gb18030`、`big5` 与 `euc-kr`。

两个值都不是 `Config` 字段。若某个部署能够放宽可接受的字符集、或让回退保留 script 正文，它选择的就是不可信输入被允许做什么，而这正是这些常量所陈述的安全不变量；紧邻它们的 `MAX_CONVERSION_DEPTH` 固定不变，理由相同。

## Alternatives considered

- **在回退路径上使用完整的 HTML 清理器（`sanitize-html`、DOMPurify）** —— 换来一份这条路径并不需要的属性与协议白名单。回退输出是给模型看的、近似 markdown 的文本，而不是浏览器会执行的文档，因此值得恢复的性质是与已转换路径保持一致。清理器还会去解析那些*正因为*解析代价高昂才落到回退的标记，重新引入深度守卫本就为规避的同步开销。
- **改为报错而不回退** —— 把降级的页面变成没有页面。既有决策仍然成立：对于 provider 已经解码出来的内容，一份有界的降级响应体优于一个错误；此前不一致的只是它的清理。
- **让回退文本走 turndown 但关闭转换** —— turndown 的 `remove` 清单只有经由真实的 DOM 遍历才可达，而那正是回退存在的意义所在要跳过的工作。
- **采用可接受字符集的白名单，而非拒绝有状态编码** —— 实际的 web 需要大约十几种规范编码及其别名，逐一枚举会把常见情形变成维护面，而被排除的集合只有两个名称。基于解码性质来拒绝，陈述的才是该检查真正执行的规则。
- **对被拒字符集回退到 UTF-8 而不抛出** —— 会静默地弄乱一个诚实声明了 harness 不愿信任之编码的页面。对于无法解码的响应体，`WEB_UNSUPPORTED_CONTENT_TYPE` 已经承载了这一含义。

## Consequences

- 被抓取的页面不再能通过挑选可击败转换的标记，把 `script`、`style` 或 `noscript` 内容送达模型或会话日志。回退中的良性标记不受影响，因此既有的原样透传断言仍然成立。
- `stripRawTextElements` 与 `exceedsConversionDepth` 共享 `RAW_TEXT_ELEMENTS`、`isTagBoundary` 与 `findRawTextEnd`。改变深度扫描器识别这些元素的方式，同时也会改变剥离行为；这种耦合是有意为之，因为两者必须对什么是 raw-text 元素达成一致。
- 声明 `iso-2022-jp` 或 `x-user-defined` 的响应现在会以 `WEB_UNSUPPORTED_CONTENT_TYPE` 失败，而不再返回解码后的文本。对任何会抓取此类页面的部署而言这是行为变更；由于没有任何已发布的组合包挂载该 fetch provider，目前已发布的内容不受影响。
- 两处改动都未触及[web 能力 seam 的 Agent Note](../architecture/2026-06-24-web-capability-seam.zh.md) 所记录的、被推迟的 SSRF 工作。`web_fetch` 仍是一个 SSRF 原语，那里的推迟仍是有效的支配性记录。

## Testing

`tool-web.spec.ts` 覆盖两条回退分支，以及标记可能借以规避剥离的各种方式：开标签中被引号包裹的 `>`、未终止的元素、拼写在 script 正文里的结束标签、孤立的结束标签、仅以 raw-text 名称开头的名称，以及带尾随空格的结束标签。`fetch-http.spec.ts` 通过若干别名覆盖被拒编码，并断言真实页面会声明的无状态编码仍能解析。每个新增测试在此前的行为下都会失败。
