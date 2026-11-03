# 科大光荣榜

Dota 2 内战联赛 19224 的公开战绩看板。

- 按时间范围统计玩家胜、负、总场数与胜率
- 用二维矩阵显示两名玩家的共同场数与组队胜率
- 每天 JST 10:00 从 OpenDota 自动刷新并部署到 GitHub Pages
- 默认使用匿名免费接口；匿名日额度耗尽后才使用可选的 `OPENDOTA_API_KEY`

线上地址：<https://bcszsz.github.io/keda-dota-honor-roll/>

## 本地采集

```powershell
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python collector.py --league-id 19224 --output site/data/league.json --refresh-recent 5
```

OpenDota Key 只保存在本机 `.env` 或 GitHub Actions Secret 中，不会提交到仓库。

