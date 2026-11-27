# 科大光荣榜

Dota 2 内战联赛 19224 的公开战绩看板。

- 按时间范围统计玩家胜、负、总场数与胜率
- 只统计 2026-09-13（JST）起的比赛。截至 2026-11-26 出场过的选手为本队选手，此后的比赛至少要有一名本队选手才计入，计入后其中的新选手也成为本队选手。只在 9 月 13 日前出场的为隔壁选手。所有页面只使用计入的比赛
- 用二维矩阵显示两名玩家的共同场数与组队胜率
- [数据页](https://bcszsz.github.io/ustc-dota2-hall-of-fame/stats.html)分比赛、英雄与装备、选手三个标签。每场比赛和每名选手各有独立页面（`match.html?id=<比赛 ID>`、`player.html?id=<Account ID>`，选手页可带 `from`、`to` 日期），列表里的「详情」和选手卡片会打开它们；旧的 `stats.html#tab=matches&match=…` 链接会自动跳转。三个页面共用 `site/stats-core.js` 里的数据加载、评分和组件。采集时把每场摘要写入 `site/data/matches.json`，经济曲线等明细写入 `site/data/matches/{id}.json`，英雄（中文名见 `hero_names_zh.json`）和装备常量写入 `site/data/constants.json`，英雄和用到的装备图片压缩成 WebP 存进 `site/img/`。选手卡片的对线结果按该路双方 10 分钟经济总和比较，领先 10% 以上为优。评分、评级和 MVP 来自 [STRATZ](https://stratz.com) 的 IMP（与同段位、同英雄、同号位玩家相比，0 为平均）。联赛 IMP 接近以 0 为中心、标准差约 20 的正态分布，页面显示的百分制评分按分段正态换算后整体加 10 分、在高分端逐渐收窄：IMP < 0 时为 10 + 100 × Φ(IMP ÷ 30)（10–60），IMP ≥ 0 时为 60 + 80 × (Φ(IMP ÷ 20) − 0.5)（60–100），在 0（60 分）处衔接，不会超过 100。评级 S ≥ 92、A ≥ 80、B ≥ 60、C ≥ 40，其余 D（即 IMP +25.6、+13.5、0、−15.7）；MVP 是胜方评分最高者，达到 95（IMP +30）为 SMVP，MVP 标签注明按 IMP 还是按六项能力评选。选手卡片底部按荣誉、数据、吐槽汇总所选时间内的全部称号。STRATZ 从不给有凯（Kez）的比赛算 IMP，这类比赛用本地模型估算，在时长旁标“估算”。采集时对还没有 IMP 的比赛另取一次 STRATZ 的逐分钟数据，压成 5、10、15、20、25、30 分钟和终局的快照（正补、经验、净值、英雄伤害、建筑伤害、击杀、死亡、助攻、治疗，各配 STRATZ 同英雄同号位的平均曲线，加对线结果），存进 `site/data/stratz.json` 的 `minute`；不需要下载录像。`fit_imp.py` 从 STRATZ 拉取联赛选手近期公开比赛（约 6500 场，带逐分钟数据），训练两个同形式的模型写入 `site/data/imp-model.json`：「逐分钟」模型（留出比赛上与 STRATZ IMP 的相关系数 0.954、RMSE 6.6，联赛比赛 0.95、RMSE 6.1）和只用赛后数据的「赛后」模型（0.905 / 0.88），STRATZ 连逐分钟数据都没有时才用后者。两者都是分块惩罚的岭回归：按号位 × 胜负的每分钟数据、对数、队内占比和两队对比，减去该英雄该号位期望值后的数据，队友和对手的同类数据，关键特征的两两乘积，英雄 × 号位修正，场上其他英雄的阵容项，最后用交叉验证的预测做两端校准；逐分钟模型再加快照与平均曲线的差和比值。2026-11 在赛后数据上比较过线性、梯度提升树和整场神经网络三种独立方案，这一种最好，三者混合只多 0.002；加入逐分钟数据后才明显提高。页面用 `site/imp-model.js` 按同样的特征计算，只在有比赛需要估算时才读取模型文件。更新模型时运行 `STRATZ_TOKEN=… uv run --with numpy --with-requirements requirements.txt python fit_imp.py`（下载约 20 分钟）。六项能力（核心看 GPM、正补、英雄伤害、建筑伤害、死亡、击杀的 OpenDota 同英雄百分位，辅助把前两项换成助攻和插眼、建筑伤害换成控制时长）只在雷达图里描述打法风格。采集时用 `STRATZ_TOKEN`（本机 `.env` 或 GitHub Actions Secret，Steam 登录 STRATZ 即可免费获取）逐场请求 IMP、段位和每分钟胜率，写入 `site/data/stratz.json`；还没评分的比赛请 STRATZ 重新下载一次录像，并按 1、2、4、8、8…小时重查，7 天后放弃。胜方胜率曾跌到 20% 以下的比赛标“翻盘”，其中胜方 IMP 最高者得【带队翻盘】。每局按优先级发放 22 个称号（规则在 `site/stats-core.js` 的 `TITLES`，页面上悬停可看条件），每个称号每局最多一人、每人最多四个；选手标签顶部有单场纪录墙。OpenDota 尚未解析录像的比赛记在 `site/data/pending.json`，按 1、2、4、8、8…小时由哨兵触发重查，7 天后放弃
- 单场详情有小地图：英雄活动热力图和眼位分布。眼位来自 OpenDota 解析数据，按插眼和消失记录配对算出存活时间，不到满时长（假眼 6 分钟、真眼 7 分钟）就算被排，排眼者取自 `attackername`。热力图先用 OpenDota 的前 10 分钟位置（`lane_pos`）；采集时同时请求 OpenDota 和下载 Valve 录像（国服集群是 zstd，存为 `.dem.zst`，其余为 `.dem.bz2`），下载后上传到当年的 GitHub Release（如 `replays-2026`）归档，并在 `site/data/replays.json` 记下文件名、大小和 SHA-256；下载或上传失败同样按 1、2、4、8、8…小时重试，7 天后放弃。Release 附件不计 LFS 额度，也不限下载流量，以后整批重新解析不花钱。工作流用固定版本的 `odota/parser` 镜像解析录像，把每秒的存活位置汇总成 `site/data/heat/{id}.json`，页面检测到它就自动换成整局热力图，可按 10 分钟分段查看。最早的 14 场曾存在 Git LFS（无法删除，仍占约 0.6 GB 额度），`.lfsconfig` 让旧提交的检出也不下载它们
- 比赛页有死亡复盘表。每次死亡的时间、击杀者、掉钱、复活时长和买活来自 OpenDota 的死亡日志；位置、1200 码内的队友和敌人、死前 10 秒出手的敌方英雄以及当时 10 人的位置来自本站解析的录像（`site/data/replay/{id}.json`，死亡以游戏自己的死亡计数为准）。地图按河道分成己方半场、河道、敌方半场，泉水附近算基地。只标「孤立」（1200 码内没有存活的队友），是否失误不做机械判定。两者在 `replays.py index` 里合成跨场索引 `site/data/deaths.json`。改动录像衍生数据时调高 `replay_events.py` 的 `REPLAY_VERSION`，工作流会对所有归档录像重新解析；本地可用 `replays.py parse --redo`
- 对线：比赛页按上、中、下三路各一张卡，选手页固定优势路、中路、劣势路三个概况格子（没打过的路留空）。分路取录像里 2:00–8:00 位置中位数最近的一路（`replay_events.py` 的 `LANE_ANCHORS`，由前 14 场校准，与 OpenDota 分路 140 人次全部一致），离三路都远算打野；判错时在 `site/data/lane_overrides.json` 按 `{"比赛 ID": {"player_slot": "top|mid|bot|jungle"}}` 修正。对位按号位把两边同一路的英雄配对；5、10 分钟正补和经济、逐分钟差值来自 OpenDota 每分钟数据（明细文件的 `series`）。对线期（10 分钟前）死亡分单杀（一名同路敌人）、对线（多名同路敌人）、被 gank（有其他路或打野的敌人）；游走是 10 分钟前进入另一条路 30 秒以上。打野归入本队少人的那一路，名字旁标「打野」，在那一路里按核心或辅助对位和计入合计；号位一般用 OpenDota 的估计；打野和那一路留下的队友比 10 分钟经济，高的算这一路的核心（优势路 1、劣势路 3 号位），另一个算辅助（5、4 号位）。例外（比如送神杖的辅助炼金）在 `site/data/position_overrides.json` 按 `{"比赛 ID": {"player_slot": 号位}}` 修正；最终号位写进 `site/data/positions.json`，页面加载时覆盖 OpenDota 的号位，评分、MVP、称号都按它算；比赛页每一路分「核心对核心」（5、10 分钟正补，反补，10 分钟经济、经验，对线期参与击杀和死亡）、「辅助对辅助」（不比正补：10 分钟经验、经济，参与击杀，死亡，10 分钟前插眼和排眼，游走或进路）和「2 对 2」合计，左天辉右夜魇，领先一方绿底；选手页先是「三路概况」（每路场次、优均劣、打过的号位），再按实际打过的号位各一块「号位表现」（`site/positions.js`）：对线结果和与对位的主要差距、0–12 分钟逐分钟差值曲线（叠加联赛同号位平均）、补刀与等级（含 6 级时间）、对线期死亡与击杀（类型、时段、地点、损失金钱、一血）、核心看出鞋和第一件大件时间、赏金符和中路能量符，辅助看同路核心的正补差、视野（假眼存活和被排、排眼）、堆野、赏金符和水符、游走及其效果，最后是英雄与对位英雄统计和逐场列表；每项都对照对位和联赛同号位平均，相差 5% 以上才着色，少于 5 场标「样本少」；列出 10 分钟前进入各路 30 秒以上的时段及其中的击杀和阵亡，以及本队单人路的对线结果。`replays.py index` 生成跨场的 `site/data/lanes.json`
- 页面加载：每个页面在 HTML 里用 `<link rel="preload" as="fetch" crossorigin>` 发起它要用的数据文件请求（比赛页按网址里的 ID 再加明细和热力图），并用 `modulepreload` 同时下载全部模块，不必等脚本逐层导入。网页只读 `site/data/names.json`（英雄和装备中文名，采集时由 `constants.json` 生成；天赋、图片路径等只有采集脚本用）。Service Worker（`site/sw.js`，本机 localhost 不启用）把站内文件存进浏览器：图片和带 `?v=` 的文件按网址永久缓存，页面和数据先用缓存显示、后台再取新版，所以新采集的比赛下次打开才出现。因此改了模块或样式必须改 `?v=` 版本号，并同步改 HTML 里的 `modulepreload`（`tests/test_site_modules.mjs` 会检查）；替换同名图片或改了数据格式时把 `sw.js` 的 `CACHE` 加一
- 数据来源规定（见 `CLAUDE.md`）：OpenDota 和 STRATZ 都能提供的数据每次都两边都取、合并，互相不是备用；只有一边有的（STRATZ 的 IMP、逐分钟数据和胜率曲线，OpenDota 的排行榜名次和录像解析）才只用那一边。联赛比赛 ID 取两边的并集（STRATZ 目前不收录联赛 19224，返回 0 场）；每场比赛的胜负、英雄、账号和号位都和 STRATZ 交叉核对，完整刷新的日志里列出所有不一致。某个来源当次失败时保留它上一次的数据，不用单一来源的更少数据覆盖。STRATZ 的 token 15 分钟内最多 2 个 IP 使用，GitHub Actions 每次运行的 IP 都不同，所有请求都经过 `stratz.post_graphql`，遇到这种 403 会按提示等一次（最多 6 分钟）。
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

[玩家登记](https://bcszsz.github.io/ustc-dota2-hall-of-fame/mmr.html)按 Account ID 保存手填的玩家 ID 和 MMR。访客可以修改任意联赛玩家，请只维护自己的。玩家 ID 最多 16 个字，填了就在首页、数据页和分队页替代 Steam 昵称（登记页仍显示 Steam 昵称以便找人），留空恢复昵称；各页面先用这台浏览器上次读到的玩家 ID 立即显示，共享服务返回不同结果时再刷新（首次访问最多等 1.5 秒），读不到共享服务时照常用昵称显示。清空 MMR 后保存会恢复段位估分。分队在打开页面和每次计算时读取共享分数。

基础分优先采用手填 MMR。缺手填分时，用 OpenDota 最近有效段位对应区间的中点粗估。段位同时取 OpenDota 资料和 STRATZ 的 `seasonRank`（分别存为 `opendota_rank_tiers`、`stratz_rank_tiers`），两边都有时取两个估分的平均，页面上不一致时两个都显示；排行榜名次只有 OpenDota 有（STRATZ 的 `seasonLeaderboardRank` 对联赛选手都是空的），两边都是冠绝一世时按 OpenDota 的名次估分。冠绝一世在区域排行榜前 5000 名时按名次在第 1 名 9500、第 5000 名 6200 之间取对数插值：2026-07 Valve 把冠绝分数压到 9500 以内并保持榜单顺序，但不公布名次对应的分数，各区也不同，这只是粗估；不在榜上的冠绝一世暂取 6000。缺段位的玩家暂用联赛段位估分的中位数。以基础分为起点回放有效内战，按个人有效场数采纳 Elo 修正，权重为 **min(50%, 场数 ÷ (场数 + 36))**。

选马工具先选两位队长和八名队员（这一步只显示综合分），点「计算分队」后依次给出「选马建议」（两位队长的卡片和他们选完后打的号位，每一轮选的人用小卡片表示，标出选完后打的号位和该号位估分，先选方可随时切换）、「自动分队」和「选手介绍」（十张卡片：综合分、各号位天梯估分、主打号位和近 100 场最常用的五个英雄）。每天的完整刷新用 `position_stats.py` 同时请求 OpenDota 和 STRATZ：从 OpenDota 取每名联赛选手最近 300 场公开比赛，留下一年内、普通模式、10 分钟以上、能判断号位的最近 100 场，按号位记场数和胜场，连同这些比赛里最常用的五个英雄写入 `site/data/position-stats.json`。号位优先用 STRATZ 的判断；STRATZ 没有（或像有的账号那样整个查不到）时，按 OpenDota 的分路加每分钟正补（≥ 3.5 为核心）推断，在 537 场重叠比赛上与 STRATZ 一致 96%。STRATZ 那次请求失败时（比如同一个 token 15 分钟内被超过两个 IP 使用，GitHub Actions 每次运行的 IP 都不同；遇到这种 403 时会按提示等一次，最多 6 分钟），保留上一次带 STRATZ 号位的记录，不用只有 OpenDota 的稀疏数据覆盖。页面把每个号位的胜率向本人总胜率收缩（50 场虚拟比赛；2026-11 联赛选手的号位胜率在二项噪声之外只差约 0.06，约合 40–50 分）后按 Elo 换成分差，加在综合分上；少于 10 场的号位算“玩的少”，按综合分减 500；总场数不足 30 的选手不分号位。阵容分按优先级 2 > 1 > 3 > 5 > 4 加权（1.3 / 1.2 / 1.0 / 0.85 / 0.75），取 120 种号位分配里最高的一种，自动分配和选马建议都按它算胜率。选马建议按 1-2-2-2-1 轮流，每方可选策略：「预判对手」知道对面的策略，推演到选完后取最终胜率最好的一手（双方都用时即双方最优）；「按综合分从高到低」每次取剩余最高分。策略在 `site/matchmaker-model.js` 的 `PICK_STRATEGIES` 里，可继续增加。

[BP 建议](https://bcszsz.github.io/ustc-dota2-hall-of-fame/bp.html)给两边各选五个人（也可以从选马工具的自动分队和选马建议直接跳转，网址带 `?a=…&b=…` 的十个 Account ID），先按阵容分分配号位、列出双方每个号位的绝活英雄，再依次站在甲队、乙队的立场推荐优先 ban 和优先 pick 各最多 5 个（不够不凑）。联赛是队长模式（每方 7 ban、5 pick 交替，先 ban 的一方也先选），顺序交给队长，两个列表互不排除：双方都想要的英雄会同时出现在 ban 和 pick 里，标“两边都想要”。英雄池来自 `position_stats.py`：每人近一年最多 300 场公开比赛按号位统计的英雄场数和胜场（`pool`）。版本强势来自 `hero_meta.py`：每天从 STRATZ 取超凡入圣和冠绝一世最近两周排位里每个号位每个英雄的场数和胜场，同时从 OpenDota 取同分段不分号位的胜率，写入 `site/data/hero-meta.json`；某号位的版本优势按 STRATZ 这个号位的数字，再向 OpenDota 的整体水平移一半，两个来源都算；哪个来源失败就沿用它上一次的数据。评分都在 `site/bp-model.js`，单位是胜率百分点：拿手值 = 熟练度（场数 ÷（场数 + 8））×（4 + 本人这个英雄的胜率减本人总胜率）+ 这个号位的版本优势；ban 看对面最拿手的人（加第二个会玩的人的 25%），对面没人玩的版本强势英雄按版本优势的 70% 计；pick 看本方最拿手的人，再加对面拿手值的 50%。

共享分数和玩家 ID 保存在 AWS 东京区的 DynamoDB，共用一个版本号做冲突检查。GitHub Pages 通过 AWS HTTP API 读取和保存共享数据，联赛快照继续由原来的采集工作流发布。[共享 API](https://408sq8skz1.execute-api.ap-northeast-1.amazonaws.com/api/mmr) · [服务源码和发布说明](mmr-aws)

