# sing-box gstatic `ERR_CONNECTION_CLOSED` 排查总结

- 日期：2026-11-21
- 环境：FlClash / sing-box，TUN 模式，iPhone 配置，局域网代理 `192.168.1.111:7890`
- 现象：Google / Antigravity 登录页加载到一半，`www.gstatic.com` 和 `fonts.gstatic.com` 报 `net::ERR_CONNECTION_CLOSED`

## 现象

Google OAuth 页面主体能打开，但静态资源加载失败：

```text
GET https://www.gstatic.com/... net::ERR_CONNECTION_CLOSED
GET https://fonts.gstatic.com/... net::ERR_CONNECTION_CLOSED
```

`accounts.google.com` 有时能打开，但登录流程无法完成。

同一个代理用 `curl` 显式走 HTTP 代理时却正常：

```bash
curl -x http://192.168.1.111:7890 https://www.gstatic.com/generate_204
# 204
```

说明代理本身可用，问题出在 TUN 模式下的 DNS 解析和路由组合。

## 关键日志

```text
dns: cached A www.gstatic.com. 3 IN A 120.232.233.162
dns: cached A fonts.gstatic.com. 164 IN A 120.233.71.226

outbound/hysteria2[新加坡专线03]: outbound connection to 120.232.233.162:443
outbound/hysteria2[新加坡专线03]: outbound connection to 120.233.71.226:443

dns: exchanged A accounts.google.com. 1 IN A 198.19.0.17
outbound/hysteria2[新加坡专线03]: outbound connection to accounts.google.com:443
```

对比：

- `accounts.google.com` 解析到 fake-IP `198.19.0.17`，正常走代理。
- `t1.gstatic.com` / `t3.gstatic.com` 解析到 fake-IP `198.19.0.30` / `198.19.0.31`，正常。
- `www.gstatic.com` / `fonts.gstatic.com` 解析成了真实国内 IP，再被送到新加坡/日本节点，失败。

## 根因

配置中的 DNS `evaluate` 规则带有国内 ECS：

```json
{
  "type": "logical",
  "mode": "and",
  "rules": [
    {
      "query_type": ["A", "AAAA"]
    },
    {
      "rule_set": "geosite-geolocation-!cn",
      "invert": true
    }
  ],
  "action": "evaluate",
  "server": "google",
  "client_subnet": "223.5.5.0/24",
  "timeout": "2s"
}
```

`client_subnet: 223.5.5.0/24` 会让 Google DNS 认为客户端在中国大陆，从而返回国内 CDN IP。

完整链路：

```text
www.gstatic.com
  -> google DNS + ECS 223.5.5.0/24
  -> 202.101.48.34（国内 IP）
  -> match_response geoip-cn
  -> ali DNS
  -> 120.232.233.162（国内 IP）
  -> route geosite-google
  -> 新加坡/日本代理节点
  -> 海外节点连接国内 IP 失败
  -> ERR_CONNECTION_CLOSED
```

核心问题：**DNS 用国内 ECS 解析，但连接却走海外代理，DNS 结果和出口路由不一致。**

## 验证

通过 `dns.google` DoH 查询：

```text
www.gstatic.com（不带 ECS）
  -> 142.251.157.120
  -> 142.251.156.120
  -> 142.251.152.120

www.gstatic.com（ECS 223.5.5.0/24）
  -> 202.101.48.34

fonts.gstatic.com（不带 ECS）
  -> 142.251.12.94

fonts.gstatic.com（ECS 223.5.5.0/24）
  -> 202.101.48.66
```

其他验证：

```bash
# 代理接收域名时正常
curl -x http://192.168.1.111:7890 \
  -o /dev/null -w '%{http_code}\n' \
  https://www.gstatic.com/generate_204
# 204

# 直接连接国内解析 IP 失败
curl --resolve www.gstatic.com:443:120.232.233.162 \
  https://www.gstatic.com/generate_204
# SSL_ERROR_SYSCALL
```

## 已应用的修复

在 DNS 规则中、国内规则之前加入 `gstatic.com` 专用规则：

```json
{
  "domain_suffix": [
    "gstatic.com"
  ],
  "server": "google"
}
```

这样 `www.gstatic.com` 和 `fonts.gstatic.com` 会直接使用 Google DNS，不再经过带国内 ECS 的 `evaluate` 规则，返回 `142.251.x.x`。

涉及文件：

- 修改后：`/Users/leon/Library/Application Support/alma/herdr/uploads/20261121-003115-4affd660/iPhone.json`
- 原文件备份：`/Users/leon/Library/Application Support/alma/herdr/uploads/20261121-003115-4affd660/iPhone.json.bak-20261121-083141`
- 桌面副本：`/Users/leon/Desktop/iPhone.json`

JSON 语法已通过 `python3 -m json.tool` 校验。

## 源头修复（Sub-Store 模板）

问题实际来自模板 `iphone.json` 的 DNS 规则；Sub-Store 脚本只负责把节点插入 `outbounds`，不会修改 DNS。因此只改生成后的配置，下次重新生成还会复现。

修好的模板：

`/Users/leon/sync/singbox/iphone-gstatic-fix.json`

改动是在模板的 DNS 规则中、国内规则之前插入：

```json
{"domain_suffix": ["gstatic.com"], "server": "google"},
```

使用方式：

1. 在 Sub-Store 中把模板文件替换为 `iphone-gstatic-fix.json`。
2. 保持原来的 `template.js` 脚本和 `outbound` 参数不变。
3. 重新生成订阅，确认输出里包含上面的 `gstatic.com` 规则。

## 备选修复

如果不希望保留任何国内 ECS 对 Google 域名的影响，可以删除：

```json
"client_subnet": "223.5.5.0/24",
```

如果其他 Google 子域也出现类似问题，可以扩展域名列表：

```json
{
  "domain_suffix": [
    "gstatic.com",
    "googleapis.com",
    "googleusercontent.com",
    "googlevideo.com"
  ],
  "server": "google"
}
```

## 应用与验证

1. 将修改后的 `iPhone.json` 重新导入 FlClash / sing-box。
2. 重启代理，清除 DNS 缓存。
3. 检查解析结果：

   ```bash
   dig +short www.gstatic.com
   ```

   期望是 `142.251.x.x`，不应出现 `120.232.x.x` 或 `202.101.x.x`。

4. 检查代理连通性：

   ```bash
   curl -x http://192.168.1.111:7890 \
     -o /dev/null -w '%{http_code}\n' \
     https://www.gstatic.com/generate_204
   ```

   期望 `204`。

5. 重新尝试 Google / Antigravity 登录。

## 经验总结

- DNS ECS 和代理出口必须一致：不要让走海外代理的域名使用国内 ECS 解析。
- `ERR_CONNECTION_CLOSED` 通常表示 TCP 连接被重置或主动断开，常见于 IP 不可达、路由不一致或代理节点拒绝，不一定是代理本身挂了。
- `accounts.google.com` 正常而 `gstatic.com` 失败，是典型的 DNS 分流/路由不一致症状。
- TUN 模式下客户端可能先拿到真实 IP；如果 DNS 返回国内 IP，后续域名规则即使命中，也可能已经无法挽回。

## 上游模板修复（本地克隆）

仓库：`/Users/leon/sync/sourceCode/qichiyuhub-rule`
范围：仅 `config/singbox/1.14X/` 下 6 个文件（`iphone`、`linux`、`linux_mini`、`momo`、`reF1nd`、`windows`）。

每个文件统一三处修改：

1. DNS 规则在 `clash_mode Global` 之后加入同花顺域名走 `ali`、`gstatic.com` 走 `google`：

   ```json
   {"domain_suffix": ["123ths.com", "10jqka.com", "iwencai.com", "hexin.com"], "server": "ali"},
   {"domain_suffix": ["gstatic.com"], "server": "google"},
   ```

2. Route 规则在 `geosite-private → 直连` 之后加入同花顺域名直连：

   ```json
   {"domain_suffix": ["123ths.com", "10jqka.com", "iwencai.com", "hexin.com"], "outbound": "直连"},
   ```

3. `dns.strategy` 由 `ipv4_only` 改为 `prefer_ipv4`，修复只有 AAAA 记录的域名无法解析的问题。

校验：6 个文件均通过 `python3 -m json.tool`。
