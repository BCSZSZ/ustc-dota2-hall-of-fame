# 科大光荣榜

Dota 2 内战联赛 19224 的公开战绩看板。

- 按时间范围统计玩家胜、负、总场数与胜率
- 用二维矩阵显示两名玩家的共同场数与组队胜率
- 每天 JST 10:00 从 OpenDota 自动刷新并部署到 GitHub Pages
- 默认使用匿名免费接口；匿名日额度耗尽后才使用可选的 `OPENDOTA_API_KEY`

线上地址：<https://bcszsz.github.io/ustc-dota2-hall-of-fame/>

## 本地采集

```powershell
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python collector.py --league-id 19224 --output site/data/league.json --refresh-recent 5
```

OpenDota Key 只保存在本机 `.env` 或 GitHub Actions Secret 中，不会提交到仓库。



## 天梯分登记和分队

[登记天梯分](https://bcszsz.github.io/ustc-dota2-hall-of-fame/mmr.html)接受按 Account ID 对应的手填 MMR。访客可以修改任意联赛玩家的分数，请只维护自己的。清空后保存会恢复段位估分。分队在打开页面和每次计算时读取共享分数。

基础分优先采用手填 MMR。缺手填分时，用 OpenDota 最近有效段位对应区间的中点粗估。冠绝一世没有固定上限，暂取 6000。缺段位的玩家暂用联赛段位估分的中位数。以基础分为起点回放有效内战，按个人有效场数采纳 Elo 修正，权重为 **min(50%, 场数 ÷ (场数 + 36))**。

共享分数保存在 Sites 的 D1 数据库，和每日生成的联赛快照独立。[服务源码](mmr-api/worker) · [站点身份](mmr-api/.openai/hosting.json) · [数据库迁移](mmr-api/drizzle)

更新服务时在对应的 Sites 源码副本中运行 **node build.mjs**，沿用现有站点身份打包发布。

