# 科大光荣榜

Dota 2 内战联赛 19224 的公开战绩看板。

- 按时间范围统计玩家胜、负、总场数与胜率
- 只统计 2026-09-13（JST）起的比赛。截至 2026-11-26 出场过的选手为本队选手，此后的比赛至少要有一名本队选手才计入，计入后其中的新选手也成为本队选手。只在 9 月 13 日前出场的为隔壁选手。所有页面只使用计入的比赛
- 用二维矩阵显示两名玩家的共同场数与组队胜率
- [数据页](https://bcszsz.github.io/ustc-dota2-hall-of-fame/stats.html)分比赛、英雄与装备、选手三个标签。每场比赛和每名选手各有独立页面（`match.html?id=<比赛 ID>`、`player.html?id=<Account ID>`，选手页可带 `from`、`to` 日期），列表里的「详情」和选手卡片会打开它们；旧的 `stats.html#tab=matches&match=…` 链接会自动跳转。三个页面共用 `site/stats-core.js` 里的数据加载、评分和组件。采集时把每场摘要写入 `site/data/matches.json`，经济曲线等明细写入 `site/data/matches/{id}.json`，英雄（中文名见 `hero_names_zh.json`）和装备常量写入 `site/data/constants.json`，英雄和用到的装备图片压缩成 WebP 存进 `site/img/`。选手卡片的对线结果按该路双方 10 分钟经济总和比较，领先 10% 以上为优。综合评分是六项能力的平均：核心看 GPM、正补、英雄伤害、建筑伤害、死亡、击杀的 OpenDota 同英雄百分位，辅助把前两项换成助攻和插眼、建筑伤害换成控制时长（插眼和控制在联赛辅助中比较），再按号位做随样本量收缩的修正（n/(n+50)）。评级 S ≥ 80、A ≥ 65、B ≥ 50、C ≥ 35，其余 D。MVP 是胜方中评分高出同号位平均最多者，高出 30 分以上为 SMVP。每局按优先级发放 21 个称号（规则在 `site/stats-core.js` 的 `TITLES`，页面上悬停可看条件），每个称号每局最多一人、每人最多四个；选手标签顶部有单场纪录墙。OpenDota 尚未解析录像的比赛记在 `site/data/pending.json`，按 1、2、4、8、8…小时由哨兵触发重查，7 天后放弃
- 单场详情有小地图：英雄活动热力图和眼位分布。眼位来自 OpenDota 解析数据，按插眼和消失记录配对算出存活时间，不到满时长（假眼 6 分钟、真眼 7 分钟）就算被排，排眼者取自 `attackername`。热力图先用 OpenDota 的前 10 分钟位置（`lane_pos`）；采集时同时请求 OpenDota 和下载 Valve 录像（国服集群是 zstd，存为 `.dem.zst`，其余为 `.dem.bz2`），下载后上传到当年的 GitHub Release（如 `replays-2026`）归档，并在 `site/data/replays.json` 记下文件名、大小和 SHA-256；下载或上传失败同样按 1、2、4、8、8…小时重试，7 天后放弃。Release 附件不计 LFS 额度，也不限下载流量，以后整批重新解析不花钱。工作流用固定版本的 `odota/parser` 镜像解析录像，把每秒的存活位置汇总成 `site/data/heat/{id}.json`，页面检测到它就自动换成整局热力图，可按 10 分钟分段查看。最早的 14 场曾存在 Git LFS（无法删除，仍占约 0.6 GB 额度），`.lfsconfig` 让旧提交的检出也不下载它们
- 比赛页有死亡复盘表。每次死亡的时间、击杀者、掉钱、复活时长和买活来自 OpenDota 的死亡日志；位置、1200 码内的队友和敌人、死前 10 秒出手的敌方英雄以及当时 10 人的位置来自本站解析的录像（`site/data/replay/{id}.json`，死亡以游戏自己的死亡计数为准）。地图按河道分成己方半场、河道、敌方半场，泉水附近算基地。只标「孤立」（1200 码内没有存活的队友），是否失误不做机械判定。两者在 `replays.py index` 里合成跨场索引 `site/data/deaths.json`。改动录像衍生数据时调高 `replay_events.py` 的 `REPLAY_VERSION`，工作流会对所有归档录像重新解析；本地可用 `replays.py parse --redo`
- 对线：比赛页按上、中、下三路各一张卡，选手页固定优势路、中路、劣势路三个格子（没打过的路留空）。分路取录像里 2:00–8:00 位置中位数最近的一路（`replay_events.py` 的 `LANE_ANCHORS`，由前 14 场校准，与 OpenDota 分路 140 人次全部一致），离三路都远算打野；判错时在 `site/data/lane_overrides.json` 按 `{"比赛 ID": {"player_slot": "top|mid|bot|jungle"}}` 修正。对位按号位把两边同一路的英雄配对；5、10 分钟正补和经济、逐分钟差值来自 OpenDota 每分钟数据（明细文件的 `series`）。对线期（10 分钟前）死亡分单杀（一名同路敌人）、对线（多名同路敌人）、被 gank（有其他路或打野的敌人）；游走是 10 分钟前进入另一条路 30 秒以上。`replays.py index` 生成跨场的 `site/data/lanes.json`
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

工作流用的是 `odota/parser` 的固定镜像。本地用同一时间的源码提交（`51c934f`）编译，需要 Java 21 和 Maven。启动后解析所有还没有热力图的录像，结果应与工作流生成的 `site/data/heat/` 逐字节相同。`replays.py parse` 会按清单从 Release 下载缺少的录像到本地 `replays/`（不进 git），并校验 SHA-256；只想取录像可以用 `python replays.py fetch`（加 `--match <ID>` 只取一场）。

```bash
git clone https://github.com/odota/parser.git ~/Development/tools/odota-parser
cd ~/Development/tools/odota-parser && git checkout 51c934fba40858a6061b4b60bc4b79972d420d8a
JAVA_HOME="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home" mvn -q clean install -U
"$(brew --prefix openjdk@21)/bin/java" -jar target/stats-0.1.0.jar 5600
python replays.py parse --data-dir site/data
```

`tests/fixtures/` 存有一场比赛的真实解析器位置输出，测试据此核对每名选手的存活秒数与 OpenDota 一致，平时不需要启动解析器。



## 玩家登记和分队

[玩家登记](https://bcszsz.github.io/ustc-dota2-hall-of-fame/mmr.html)按 Account ID 保存手填的玩家 ID 和 MMR。访客可以修改任意联赛玩家，请只维护自己的。玩家 ID 最多 16 个字，填了就在首页、数据页和分队页替代 Steam 昵称（登记页仍显示 Steam 昵称以便找人），留空恢复昵称；各页面读不到共享服务时照常用昵称显示。清空 MMR 后保存会恢复段位估分。分队在打开页面和每次计算时读取共享分数。

基础分优先采用手填 MMR。缺手填分时，用 OpenDota 最近有效段位对应区间的中点粗估。冠绝一世没有固定上限，暂取 6000。缺段位的玩家暂用联赛段位估分的中位数。以基础分为起点回放有效内战，按个人有效场数采纳 Elo 修正，权重为 **min(50%, 场数 ÷ (场数 + 36))**。

共享分数和玩家 ID 保存在 AWS 东京区的 DynamoDB，共用一个版本号做冲突检查。GitHub Pages 通过 AWS HTTP API 读取和保存共享数据，联赛快照继续由原来的采集工作流发布。[共享 API](https://408sq8skz1.execute-api.ap-northeast-1.amazonaws.com/api/mmr) · [服务源码和发布说明](mmr-aws)

