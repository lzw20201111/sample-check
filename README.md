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
| POST | `/api/import` | 批量导入（按 试件编号+送检日期 去重） |

非 `/api/` 的请求由 Worker 反向代理本仓库的静态文件，因此 Worker 域名也能直接打开站点。

## 数据字段

试件编号、工程名称、规格型号、养护类型、成型日期、送检日期、芯片号1~3、核验状态、归档、备注。

## 切换后端地址

默认中转地址写在 `assets/cloud.js` 的 `DEFAULT_API`。
临时切换：在页面地址后加 `?api=https://你的域名`；
永久切换：在控制台执行 `SampleCloud.setApi('https://你的域名')`。
