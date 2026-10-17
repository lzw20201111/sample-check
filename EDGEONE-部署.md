# 用腾讯云 EdgeOne Pages 部署（国内可直连）

Cloudflare 的 `*.workers.dev` 在国内访问不稳定，实测本机直连超时。EdgeOne Pages 是国内节点，
免费额度足够这个台账用，部署后手机 4G/5G、工地 Wi-Fi 都能直接拉数据。

代码已经写好：`functions/api/[[default]].js`（接口与 Cloudflare Worker 版完全一致，数据仍存飞书多维表格）。
你只需要在腾讯云控制台点几下。

---

## 一、准备（3 分钟）

1. 打开 <https://edgeone.cloud.tencent.com>，用微信/QQ 登录腾讯云；
2. 首次使用需要**实名认证**（个人身份证，几分钟通过）；
3. 进入 **Pages**（边缘 Pages / 全栈部署平台）→ 创建项目。

## 二、方案 A：关联 Git 仓库（推荐，之后推送自动更新）

1. 选择 **导入 Git 仓库** → 授权 GitHub → 选中 `lzw20201111/sample-check`（分支 `main`）；
2. 构建设置：
   - 框架预设：**其他 / 静态站点**（不要选 Next.js）
   - 构建命令：**留空**
   - 输出目录：**`./`**（仓库根目录就是网页）
3. 环境变量（关键，别填错）：

   | 变量名 | 值 |
   | --- | --- |
   | `FEISHU_APP_SECRET` | 飞书应用密钥（值见 `sample-check-worker/worker.js` 里的 `FEISHU_APP_SECRET`） |
   | `FEISHU_APP_ID` | 可不填，默认 `cli_aa59aa3365385bfa` |
   | `BITABLE_APP_TOKEN` | 可不填，默认 `T8F9b18dVa1JjOsN3aucN815n6a` |
   | `BITABLE_TABLE_ID` | 可不填，默认 `tbl7hOyFoOlWy3Hb` |

4. 点**部署**，等 1～2 分钟，拿到形如 `https://sample-check-xxxx.edgeone.app` 的地址。

## 二·B、方案 B：直接上传（不想授权 GitHub 时用）

1. 创建项目时选 **直接上传**；
2. 项目名称：小写字母/数字/连字符，5-50 位（例如 `sample-check`）；
3. 加速区域：选 **全球（含中国内地）**；
4. 把 `sample-check-edgeone.zip`（根目录下，已包含 `functions/`）整个拖进上传区；
5. 项目创建后到 **项目设置 → 环境变量** 加 `FEISHU_APP_SECRET`，然后「新建部署」重新上传一次让变量生效。

> 直接上传的项目以后不会跟随 GitHub 自动更新，改代码要重新打包上传；能授权 GitHub 就用方案 A。

## 三、验证

浏览器打开：

```
https://你的项目.edgeone.app/api/health
```

看到 `{"ok":true,"service":"sample-check-edgeone","secret":true}` 就说明通了。
（如果 `secret` 是 `false`，说明环境变量没生效，回控制台补上后重新部署。）

然后直接访问 `https://你的项目.edgeone.app/mobile.html`，页面上录入一条数据，
到飞书多维表格里能看到，即全链路成功。

页面会自动优先走**同源** `/api`（`cloud.js` 检测到当前站点不是 `*.github.io` 就会把同源排在第一条线路），
所以在 EdgeOne 域名下打开不需要任何额外设置。

## 四、前端切换线路

两种用法，任选：

- **直接用 EdgeOne 域名**：手机/电脑打开 `https://你的项目.edgeone.app/`，接口同源，什么都不用配；
- **继续用 GitHub Pages 地址**：进入页面 → 长按右下角状态角标（电脑上连点 3 下）→「同步设置」→
  中转地址填 `https://你的项目.edgeone.app` → 保存并测试 → 显示"连接成功"即可。

这样即使以后换域名，也只是在「同步设置」里改一行，不用重新发版。

## 五、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `/api/health` 404 | `functions/api/[[default]].js` 没有随仓库部署：确认仓库里有这个文件，且项目重新部署过 |
| `{"ok":false,"error":"未配置环境变量 FEISHU_APP_SECRET"}` | 环境变量漏填或填在错误的项目/环境里 |
| `飞书接口错误[1254005]` 之类 | 飞书应用权限或表格 ID 不对，检查飞书开放平台该应用是否开通了多维表格读写权限 |
| 手机打开很慢 | 首次冷启动正常，之后走边缘缓存；静态页本身没有动态渲染 |
| 想用自己域名 | Pages 项目设置里可以绑定自定义域名，国内访问需域名已备案（用 `*.edgeone.app` 则不需要） |

## 六、两个后端可以并存

`cloud.js` 支持多条候选线路，会自动探测哪条通：

- 默认第一条：Cloudflare Worker（`*.workers.dev`）
- 你可以在「同步设置」里追加：EdgeOne 地址

国内一般 EdgeOne 通、Cloudflare 不通；到境外反过来也能用。数据都写同一张飞书表，不会冲突
（`/api/create` 按芯片号与"检测类型+工程+部位+送检日期"去重）。
