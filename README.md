# 科大光荣榜

Dota 2 内战联赛 19224 的公开战绩看板。

- 按时间范围统计玩家胜、负、总场数与胜率
- 只统计 2026-09-13（JST）起的比赛。截至 2026-11-26 出场过的选手为本队选手，此后的比赛至少要有一名本队选手才计入，计入后其中的新选手也成为本队选手。只在 9 月 13 日前出场的为隔壁选手。所有页面只使用计入的比赛
- 用二维矩阵显示两名玩家的共同场数与组队胜率
- [数据页](https://bcszsz.github.io/ustc-dota2-hall-of-fame/stats.html)分比赛、英雄与装备、选手三个标签。采集时把每场摘要写入 `site/data/matches.json`，经济曲线等明细写入 `site/data/matches/{id}.json`，英雄（中文名见 `hero_names_zh.json`）和装备常量写入 `site/data/constants.json`，英雄和用到的装备图片压缩成 WebP 存进 `site/img/`。选手卡片的对线结果按该路双方 10 分钟经济总和比较，领先 10% 以上为优。综合评分是六项能力百分位的平均（OpenDota 同英雄百分位，团战参与和辅助视野用联赛内百分位），每场最高者为 MVP；选手标签顶部有单场纪录墙。OpenDota 尚未解析录像的比赛记在 `site/data/pending.json`，按 1、2、4、8、8…小时由哨兵触发重查，7 天后放弃
- 单场详情有小地图：英雄活动热力图和眼位分布。眼位来自 OpenDota 解析数据，按插眼和消失记录配对算出存活时间，不到满时长（假眼 6 分钟、真眼 7 分钟）就算被排，排眼者取自 `attackername`。热力图先用 OpenDota 的前 10 分钟位置（`lane_pos`）；采集时同时请求 OpenDota 和下载 Valve 录像，录像以 Git LFS 存进 `replays/`（国服集群是 zstd，存为 `.dem.zst`，其余为 `.dem.bz2`），失败同样按 1、2、4、8、8…小时重试，7 天后放弃。工作流用固定版本的 `odota/parser` 镜像解析录像，把每秒的存活位置汇总成 `site/data/heat/{id}.json`，页面检测到它就自动换成整局热力图，可按 10 分钟分段查看。克隆时不想下载录像，可设 `GIT_LFS_SKIP_SMUDGE=1`
- 每 10 分钟由 `watch.yml` 检查 OpenDota 是否列出新比赛，有新比赛才触发增量采集（只抓新比赛）。每天 JST 10:00 另做一次完整刷新（昵称、段位、最近 5 场），并部署到 GitHub Pages
- 默认使用匿名免费接口；匿名日额度耗尽后才使用可选的 `OPENDOTA_API_KEY`

线上地址：<https://bcszsz.github.io/ustc-dota2-hall-of-fame/>

## 本地采集

```powershell
python -m pip install -r requirements.txt
Copy-Item .env.example .env
python collector.py --league-id 19224 --output site/data/league.json --refresh-recent 5
```

OpenDota Key 只保存在本机 `.env` 或 GitHub Actions Secret 中，不会提交到仓库。

### 本地解析录像

工作流用的是 `odota/parser` 的固定镜像。本地用同一时间的源码提交（`51c934f`）编译，需要 Java 21 和 Maven。启动后解析所有还没有热力图的录像，结果应与工作流生成的 `site/data/heat/` 逐字节相同。

```bash
git clone https://github.com/odota/parser.git ~/Development/tools/odota-parser
cd ~/Development/tools/odota-parser && git checkout 51c934fba40858a6061b4b60bc4b79972d420d8a
JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home" mvn -q clean install -U
"$(brew --prefix openjdk@21)/bin/java" -jar target/stats-0.1.0.jar 5600
python replays.py parse --data-dir site/data
```

`tests/fixtures/` 存有一场比赛的真实解析器位置输出，测试据此核对每名选手的存活秒数与 OpenDota 一致，平时不需要启动解析器。



## 天梯分登记和分队

[登记天梯分](https://bcszsz.github.io/ustc-dota2-hall-of-fame/mmr.html)接受按 Account ID 对应的手填 MMR。访客可以修改任意联赛玩家的分数，请只维护自己的。清空后保存会恢复段位估分。分队在打开页面和每次计算时读取共享分数。

基础分优先采用手填 MMR。缺手填分时，用 OpenDota 最近有效段位对应区间的中点粗估。冠绝一世没有固定上限，暂取 6000。缺段位的玩家暂用联赛段位估分的中位数。以基础分为起点回放有效内战，按个人有效场数采纳 Elo 修正，权重为 **min(50%, 场数 ÷ (场数 + 36))**。

共享分数保存在 Sites 的 D1 数据库，和每日生成的联赛快照独立。[服务源码](mmr-api/worker) · [站点身份](mmr-api/.openai/hosting.json) · [数据库迁移](mmr-api/drizzle)

更新服务时在对应的 Sites 源码副本中运行 **node build.mjs**，沿用现有站点身份打包发布。

