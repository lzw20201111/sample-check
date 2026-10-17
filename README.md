# 试件送检清单

混凝土试件送检登记、扫码核验、归档管理，三端自适应。

- 电脑版：`index.html`（入口，自动按设备跳转）/ `desktop.html`
- 手机版：`mobile.html`
- 归档库：`archive.html`

## 架构

```
浏览器（GitHub Pages 静态页）
        ↓  /api/*
Cloudflare Worker 中转（sample-check-worker）
        ↓  飞书开放平台 API
飞书多维表格（tbl7hOyFoOlWy3Hb）
```

前端的增删改先写浏览器 localStorage（断网也能用），随后进入同步队列，
由 Worker 中转写入飞书多维表格；打开页面时从云端拉取一次并按飞书记录 ID 对齐。
接口不通时右下角角标显示「离线（已存本地）」，恢复网络后自动补传。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/list` | 列出记录，可传 `keyword` / `status` / `archived` |
| POST | `/api/create` | 新增 |
| POST | `/api/update` | 更新（需 `rid`） |
| POST | `/api/delete` | 删除（需 `rid`，或 `rids` 批量） |
| POST | `/api/import` | 批量导入（按 芯片号 或 检测类型+工程+部位+送检日期 去重） |

非 `/api/` 的请求由 Worker 反向代理本仓库的静态文件，因此 Worker 域名也能直接打开站点。

另有腾讯云 EdgeOne Pages 版本（国内节点，推荐国内使用）：`functions/api/[[default]].js`，
接口与 Worker 完全一致，数据同样写飞书。部署步骤见 [EDGEONE-部署.md](EDGEONE-部署.md)。

## 数据字段

| 列 | 说明 |
| --- | --- |
| 序号 | 行号，自动生成 |
| 送检日期 | **自动计算**：标准养护 / 同条件养护 = 成型日期 + 龄期；其他养护类型可手动填 |
| 检测类型 | 混凝土抗压 / 混凝土抗折 / 砂浆抗压 …… |
| 工程名称 | 必填 |
| 部位 | 如 四层梁板 |
| 等级 | C30 / M10 等 |
| 规格型号 | 150×150×150mm 等 |
| 成型日期 | 制作日期 |
| 芯片号1 / 2 / 3 | 试件芯片，任一即可核验 |
| 温度(℃) | 现场温度 |
| 龄期(d) | 养护天数，参与送检日期计算 |
| 养护类型 | 标准养护 / 同条件养护 / 现场养护 / 蒸压养护 / 其他 |
| 状态 | 待核实 / 已核实 |
| 备注 | 可选 |

## 扫码核验规则

1. 扫二维码或手动输入芯片号，依次比对 **芯片号1 / 芯片号2 / 芯片号3**，任意一项命中即算匹配；
2. 命中后该芯片号单元格**高亮标黄**，状态列置为「已核实」，并记录命中的是第几号芯片；
3. 编号未被登记时提示「➕ 登记为新试件」，点一下自动把该芯片号填进新增表单，保存即入飞书；
4. 长串内容（如 `XYZ-3884100381-QR`）会自动提取其中包含的芯片号。

## 免费域名：Cloudflare Pages（推荐，国内可直连，0 成本）

`*.workers.dev` 在国内被阻断，`*.pages.dev` 实测可解析可访问，且 Pages 能把**静态站和 /api 放在同一个域名**下，不需要买域名、不需要备案。

仓库根目录的 `_worker.js` 就是 Pages「高级模式」入口：`/api/*` 走飞书中转，其余请求交给静态资源（找不到回退 `index.html`）。

部署（网页操作，2 分钟）：

1. Cloudflare 控制台 → **Workers & Pages** → **创建** → **Pages** → **上传资产**；
2. 项目名填 `sample-check`（决定域名 `sample-check.pages.dev`），上传 `sample-check-pages.zip`；
3. 项目 **Settings → 变量和机密** 添加 `FEISHU_APP_SECRET`（飞书应用密钥），保存后**重新部署**一次；
4. 访问 `https://sample-check.pages.dev/api/health`，返回 `{"ok":true,"secret":true}` 即成功；
5. 手机/电脑直接打开 `https://sample-check.pages.dev/mobile.html`，同源调用接口，无需任何设置。

若项目名不是 `sample-check`，把 `assets/cloud.js` 里 `DEFAULT_ENDPOINTS` 的第一条改成实际域名即可。

## 切换后端地址（国内网络必看）

Cloudflare 默认域名 `*.workers.dev` 在国内经常被阻断（实测本机直连超时）。因此前端支持**多条候选线路自动探测**：

1. **页面内改（推荐，最省事）**：长按右下角状态角标（电脑上连点 3 下）→「同步设置」→ 填写中转地址（每行一条）→ 保存并测试。地址存在本机，立即生效，不必重新发版。
2. **临时切换**：页面地址后加 `?api=https://你的域名`。
3. **代码默认值**：`assets/cloud.js` 顶部的 `DEFAULT_ENDPOINTS`。

能连上的判定：访问 `/api/health` 返回 `{"ok":true}`。任何一条通就自动记住它；当前线路连不上会自动换下一条重试（`/api/create` 在 Worker 侧按业务键去重，换线路重发不会重复入库）。

要让国内网络稳定访问，推荐给 Worker 绑一个**自己的域名**（Cloudflare 免费套餐即可，不需要备案：域名托管在 Cloudflare、解析到海外节点）：

```
Cloudflare Dashboard → Workers & Pages → sample-check-worker → Settings → Domains & Routes → Add Custom Domain
```

绑定后把 `https://api.你的域名.com` 填进「同步设置」即可。

完全没有网络时还可以用「同步设置 → 导出 JSON / 导入 JSON」，通过微信、QQ、U 盘在手机与电脑之间对传数据。
